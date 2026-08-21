/**
 * The transport half of web_fetch: the connect-time guard and the node adapter
 * that carries it.
 *
 * These tests talk to real sockets on purpose. The address check only means
 * something if the address the socket uses is the one that was checked, and no
 * stub can show that. Every server here is a real one on 127.0.0.1, which is an
 * address the guard refuses, so the tests that exercise a successful read hand
 * the adapter a lookup that answers loopback deliberately. The tests that prove
 * the guard use the real one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer, get as httpGet, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createRawServer, type AddressInfo, type LookupFunction, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { vettingLookup, type HostResolver } from "../src/research/safe-url.js";
import { nodeFetch, nodeFetchWithLookup } from "../src/research/node-fetch.js";
import {
  fetchPage,
  FETCH_TIMEOUT_MS,
  MAX_PAGE_CHARS,
  type FetchPageDeps,
} from "../src/research/fetch-page.js";

const servers: Server[] = [];
/** Shutdowns for the raw net servers, which close differently. */
const rawCleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  while (rawCleanups.length > 0) await rawCleanups.pop()?.();
});

/** Starts one server on loopback and returns its port. */
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return (server.address() as AddressInfo).port;
}

/** A lookup that sends every name to the local server, guard bypassed. */
const toLoopback: LookupFunction = (_hostname, options, callback) => {
  if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};

/** A resolver whose answers are public, so the pre-check never fires. */
const publicResolver: HostResolver = async () => ["93.184.216.34"];

/** Runs a lookup and reports what it called back with. */
function runLookup(
  lookup: LookupFunction,
  hostname: string,
  all: boolean,
): Promise<{ err: Error | null; address: unknown; family: number | undefined }> {
  return new Promise((done) => {
    lookup(hostname, { all, family: 0 } as never, ((
      err: Error | null,
      address: unknown,
      family?: number,
    ) => {
      done({ err, address, family });
    }) as never);
  });
}

describe("vettingLookup", () => {
  it("answers in the shape the caller asked for", async () => {
    const lookup = vettingLookup(async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);

    const all = await runLookup(lookup, "acme.test", true);
    expect(all.err).toBeNull();
    expect(all.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    // Node rejects the request with "Invalid IP address: undefined" if a
    // single-answer caller gets an array back.
    const one = await runLookup(lookup, "acme.test", false);
    expect(one.err).toBeNull();
    expect(one.address).toBe("93.184.216.34");
    expect(one.family).toBe(4);
  });

  it("fails the whole answer when any single address is blocked", async () => {
    const lookup = vettingLookup(async () => ["93.184.216.34", "127.0.0.1"]);
    const { err } = await runLookup(lookup, "split.test", true);
    expect(err?.message).toMatch(
      /url resolves to a blocked address: split.test -> 127\.0\.0\.1 \(loopback\)/,
    );
  });

  it("names the rule that caught the address", async () => {
    const cases: [string, RegExp][] = [
      ["10.1.2.3", /\(private\)/],
      ["169.254.169.254", /\(link-local or cloud metadata\)/],
      ["::1", /\(loopback\)/],
      ["fd00::1", /\(unique local\)/],
      ["not-an-ip", /\(unparseable address\)/],
    ];
    for (const [address, expected] of cases) {
      const { err } = await runLookup(vettingLookup(async () => [address]), "x.test", true);
      expect(err?.message).toMatch(expected);
    }
  });

  it("reports a resolver that fails or answers with nothing", async () => {
    const failing = vettingLookup(async () => {
      throw new Error("SERVFAIL");
    });
    expect((await runLookup(failing, "nowhere.test", true)).err?.message).toBe(
      "url host could not be resolved: nowhere.test",
    );

    const empty = vettingLookup(async () => []);
    expect((await runLookup(empty, "nowhere.test", true)).err?.message).toBe(
      "url host could not be resolved: nowhere.test",
    );
  });

  it("strips the brackets an IPv6 literal arrives with", async () => {
    const seen: string[] = [];
    const lookup = vettingLookup(async (hostname) => {
      seen.push(hostname);
      return ["93.184.216.34"];
    });
    await runLookup(lookup, "[::1]", true);
    expect(seen).toEqual(["::1"]);
  });
});

describe("nodeFetch address vetting", () => {
  it("refuses a name that turns private between the check and the connect", async () => {
    // The rebinding attack, whole. The first answer is what the pre-check sees
    // and it is public. The second is what the socket would connect to.
    let hits = 0;
    const port = await listen(
      createHttpServer((_req, res) => {
        hits += 1;
        res.end("<p>private page</p>");
      }),
    );
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    const resolve: HostResolver = async () => answers.shift() ?? ["127.0.0.1"];

    await expect(fetchPage(`http://rebind.test:${port}/`, { resolve })).rejects.toThrow(
      /url resolves to a blocked address: rebind\.test -> 127\.0\.0\.1 \(loopback\)/,
    );
    expect(hits).toBe(0);
  });

  it("proves that server would otherwise have answered", async () => {
    // Without this the test above passes just as well against a dead port.
    let hits = 0;
    const port = await listen(
      createHttpServer((_req, res) => {
        hits += 1;
        res.end("<p>private page</p>");
      }),
    );
    const status = await new Promise<number>((done, fail) => {
      httpGet({ host: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).on("error", fail);
    });
    expect(status).toBe(200);
    expect(hits).toBe(1);
  });

  it("re-vets on a redirect hop, rebinding included", async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(302, { location: "http://hop2.test/secrets" });
        res.end();
      }),
    );
    // Public first, so the pre-check on hop two passes, then private. Only the
    // connect-time lookup can catch this one.
    const answers = [["93.184.216.34"], ["10.0.0.1"]];
    const resolve: HostResolver = async (hostname) =>
      hostname === "hop1.test" ? ["93.184.216.34"] : (answers.shift() ?? ["10.0.0.1"]);
    const hybrid: LookupFunction = (hostname, options, callback) => {
      if (hostname === "hop1.test") return toLoopback(hostname, options, callback);
      return vettingLookup(resolve)(hostname, options, callback);
    };

    await expect(
      fetchPage(`http://hop1.test:${port}/`, { fetch: nodeFetchWithLookup(hybrid), resolve }),
    ).rejects.toThrow(/url resolves to a blocked address: hop2\.test -> 10\.0\.0\.1 \(private\)/);
  });

  it("runs the lookup once per request, so no pooled socket skips it", async () => {
    const port = await listen(createHttpServer((_req, res) => res.end("<p>ok</p>")));
    let lookups = 0;
    const counting: LookupFunction = (hostname, options, callback) => {
      lookups += 1;
      return toLoopback(hostname, options, callback);
    };
    const deps: FetchPageDeps = { fetch: nodeFetchWithLookup(counting), resolve: publicResolver };

    await fetchPage(`http://acme.test:${port}/one`, deps);
    await fetchPage(`http://acme.test:${port}/two`, deps);
    expect(lookups).toBe(2);
  });

  it("still refuses an IP literal, which never reaches the lookup at all", async () => {
    const port = await listen(createHttpServer((_req, res) => res.end("<p>ok</p>")));
    await expect(fetchPage(`http://127.0.0.1:${port}/`, { fetch: nodeFetch(publicResolver) })).rejects.toThrow(
      /blocked address: 127\.0\.0\.1 \(loopback\)/,
    );
  });
});

describe("nodeFetch transport", () => {
  it("keeps the host name, the path and the query, and reads the page", async () => {
    let seenHost: string | undefined;
    let seenUrl: string | undefined;
    let seenAgent: string | undefined;
    const port = await listen(
      createHttpServer((req, res) => {
        seenHost = req.headers.host;
        seenUrl = req.url;
        seenAgent = req.headers["user-agent"];
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Anvils</title></head><body><p>We make anvils.</p></body></html>");
      }),
    );

    const page = await fetchPage(`http://acme.test:${port}/about?ref=x%20y`, {
      fetch: nodeFetchWithLookup(toLoopback),
      resolve: publicResolver,
    });

    // Virtual hosts depend on this: the name, not the address it resolved to.
    expect(seenHost).toBe(`acme.test:${port}`);
    expect(seenUrl).toBe("/about?ref=x%20y");
    expect(seenAgent).toMatch(/^Boxaide\/\d+\.\d+\.\d+ /);
    expect(page.title).toBe("Anvils");
    expect(page.text).toContain("We make anvils.");
  });

  it("decompresses a gzipped body", async () => {
    const body = gzipSync("<html><head><title>Zipped</title></head><body><p>packed</p></body></html>");
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(body);
      }),
    );
    const page = await fetchPage(`http://acme.test:${port}/z`, {
      fetch: nodeFetchWithLookup(toLoopback),
      resolve: publicResolver,
    });
    expect(page.title).toBe("Zipped");
    expect(page.text).toBe("packed");
  });

  it("cuts a body that never ends and drops the socket", async () => {
    let closed: () => void = () => {};
    const socketClosed = new Promise<void>((done) => {
      closed = done;
    });
    const chunk = `<p>${"anvil ".repeat(10_000)}</p>`;
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.on("close", () => closed());
        const pump = () => {
          while (!res.destroyed && res.write(chunk)) {
            /* until the socket says wait, or dies */
          }
        };
        res.on("drain", pump);
        pump();
      }),
    );

    const page = await fetchPage(`http://acme.test:${port}/endless`, {
      fetch: nodeFetchWithLookup(toLoopback),
      resolve: publicResolver,
    });
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(MAX_PAGE_CHARS);
    await socketClosed;
  });

  it("cuts a compressed bomb at the decompressed size, not the wire size", async () => {
    // Two hundred megabytes of prose in a few kilobytes on the wire. A cap that
    // counted wire bytes would let all of it through.
    const body = gzipSync(Buffer.from(`<p>${"anvil ".repeat(30_000_000)}</p>`));
    expect(body.byteLength).toBeLessThan(1024 * 1024);
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(body);
      }),
    );
    const page = await fetchPage(`http://acme.test:${port}/bomb`, {
      fetch: nodeFetchWithLookup(toLoopback),
      resolve: publicResolver,
    });
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(MAX_PAGE_CHARS);
  });

  it("aborts on the signal it is given, which is how the deadline works", async () => {
    const port = await listen(createHttpServer(() => {
      /* accepts and never answers */
    }));
    const doFetch = nodeFetchWithLookup(toLoopback);
    await expect(
      doFetch(`http://acme.test:${port}/hang`, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow(/abort/i);
  });

  /**
   * Answers every connection with one hand-written response, status line and
   * all. node:http would not let a test write `HTTP/1.1 999 Nope`, and the
   * status line is written by whoever owns the page the agent was pointed at.
   */
  async function listenRaw(response: string): Promise<number> {
    const live = new Set<Socket>();
    const raw = createRawServer((sock) => {
      live.add(sock);
      sock.on("close", () => live.delete(sock));
      sock.on("data", () => sock.write(response));
      sock.on("error", () => {});
    });
    // net.Server has no closeAllConnections, so it cannot go in `servers`.
    rawCleanups.push(async () => {
      for (const sock of live) sock.destroy();
      await new Promise<void>((done) => raw.close(() => done()));
    });
    await new Promise<void>((done) => raw.listen(0, "127.0.0.1", () => done()));
    return (raw.address() as AddressInfo).port;
  }

  it("survives a status line no Response can be built from", async () => {
    // The whole finding: this ran inside the "response" event, so the throw
    // escaped the promise and killed the process rather than failing the fetch.
    const port = await listenRaw("HTTP/1.1 999 Nope\r\ncontent-length: 2\r\n\r\nhi");
    const res = await nodeFetchWithLookup(toLoopback)(`http://acme.test:${port}/`);
    expect(res.status).toBe(502);
  });

  it("survives a reason phrase with a control byte in it", async () => {
    const port = await listenRaw("HTTP/1.1 200 O\u0001K\r\ncontent-length: 2\r\n\r\nhi");
    const res = await nodeFetchWithLookup(toLoopback)(`http://acme.test:${port}/`);
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("");
    expect(await res.text()).toBe("hi");
  });

  it("drops the socket of a body it refuses to read", async () => {
    // Nothing reads the body of an HTTP 500, so nothing used to close it. A
    // hostile URL in a loop then ate file descriptors until the server stalled.
    const open = new Set<Socket>();
    const chunk = "x".repeat(64 * 1024);
    const server = createHttpServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      const pump = () => {
        while (!res.destroyed && res.write(chunk)) {
          /* until the socket says wait, or dies */
        }
      };
      res.on("drain", pump);
      pump();
    });
    server.on("connection", (sock) => {
      open.add(sock);
      sock.on("close", () => open.delete(sock));
    });
    const port = await listen(server);

    await expect(
      fetchPage(`http://acme.test:${port}/boom`, {
        fetch: nodeFetchWithLookup(toLoopback),
        resolve: publicResolver,
      }),
    ).rejects.toThrow(/fetch failed with HTTP 500/);
    await vi.waitFor(() => expect(open.size).toBe(0));
  });

  it("reports a 204 without trying to give it a body", async () => {
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(204);
        res.end();
      }),
    );
    const res = await nodeFetchWithLookup(toLoopback)(`http://acme.test:${port}/none`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});

describe("the fetch deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("covers name resolution, not just the request", async () => {
    // The abort signal only ever reached the HTTP request, so a name whose
    // nameserver never answers ran past the deadline with a libuv threadpool
    // thread held for as long as it took.
    vi.useFakeTimers();
    const never: HostResolver = () => new Promise<string[]>(() => {});
    const pending = fetchPage("http://blackhole.test/", { resolve: never });
    const rejects = expect(pending).rejects.toThrow(/fetch timed out after 15s/);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    await rejects;
  });
});

/** A throwaway self-signed cert, or null where openssl is not installed. */
function selfSignedCert(name: string): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "boxaide-tls-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"),
        "-out", join(dir, "cert.pem"), "-days", "1", "-subj", `/CN=${name}`],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return {
    key: readFileSync(join(dir, "key.pem"), "utf8"),
    cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    dir,
  };
}

const tls = selfSignedCert("tls.test");

describe.skipIf(!tls)("nodeFetch over TLS", () => {
  afterEach(() => {
    if (tls) rmSync(tls.dir, { recursive: true, force: true });
  });

  it("sends the host name as SNI and still verifies the certificate", async () => {
    let servername: string | undefined;
    const server = createHttpsServer(
      {
        key: tls?.key,
        cert: tls?.cert,
        SNICallback: (name, done) => {
          servername = name;
          done(null, undefined);
        },
      },
      (_req, res) => res.end("<p>should never be read</p>"),
    ) as unknown as Server;
    const port = await listen(server);

    // Self-signed and not in any trust store, so a client that verifies fails.
    // The failure is the assertion: verification is still on.
    await expect(
      nodeFetchWithLookup(toLoopback)(`https://tls.test:${port}/`),
    ).rejects.toThrow(/self[- ]signed|unable to verify/i);
    // And the name went out as a name, not as the address it resolved to.
    expect(servername).toBe("tls.test");
  });
});

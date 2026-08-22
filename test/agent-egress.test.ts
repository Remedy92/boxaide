/**
 * The network boundary around a scheduled run: what the loopback proxy lets
 * out, what it refuses, and what it writes down about the refusal.
 *
 * The sandbox half is asserted in test/agent-sandbox.test.ts; here the proxy
 * is exercised directly, with a plain TCP server standing in for the model
 * provider so nothing in these tests reaches the internet.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowedHostsFor,
  EgressProxy,
  egressDisabled,
  egressEnv,
  hostAllowed,
  MAX_REFUSALS_KEPT,
} from "../src/agent/egress.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A stand-in for the far end of a tunnel: says hello, echoes nothing. */
async function upstream(): Promise<number> {
  const server = net.createServer((socket) => socket.end("PROVIDER\n"));
  cleanups.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

async function proxy(allow: string[]): Promise<EgressProxy> {
  const egress = new EgressProxy(allow);
  await egress.start();
  cleanups.push(() => egress.stop());
  return egress;
}

/** Sends one CONNECT and resolves with everything the proxy answered. */
function connect(proxyUrl: string, target: string): Promise<string> {
  const port = Number(new URL(proxyUrl).port);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let seen = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      seen += chunk;
    });
    socket.on("close", () => resolve(seen));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 2_000).unref?.();
  });
}

describe("hostAllowed", () => {
  it("matches a bare domain exactly", () => {
    expect(hostAllowed("api.x.ai", ["api.x.ai"])).toBe(true);
    expect(hostAllowed("evil.api.x.ai", ["api.x.ai"])).toBe(false);
  });

  it("matches a dotted rule as a suffix, and the domain itself", () => {
    expect(hostAllowed("api.anthropic.com", [".anthropic.com"])).toBe(true);
    expect(hostAllowed("anthropic.com", [".anthropic.com"])).toBe(true);
    // The trap a suffix match invites: a host that merely ends in the string.
    expect(hostAllowed("notanthropic.com", [".anthropic.com"])).toBe(false);
  });

  it("ignores case and a trailing root dot", () => {
    expect(hostAllowed("API.Anthropic.COM.", [".anthropic.com"])).toBe(true);
  });

  it("refuses everything when nothing is allowed", () => {
    expect(hostAllowed("api.anthropic.com", [])).toBe(false);
    expect(hostAllowed("api.anthropic.com", [""])).toBe(false);
  });
});

describe("allowlists", () => {
  it("gives each CLI its own provider and nobody else's", () => {
    expect(allowedHostsFor("codex", {})).toContain(".openai.com");
    expect(allowedHostsFor("codex", {})).not.toContain(".x.ai");
    const antigravityAllow = allowedHostsFor("antigravity", {});
    expect(antigravityAllow).toContain(".googleusercontent.com");
    expect(antigravityAllow).toContain(".goog");
    expect(hostAllowed("lh3.googleusercontent.com", antigravityAllow)).toBe(true);
    expect(hostAllowed("antigravity-unleash.goog", antigravityAllow)).toBe(true);
  });

  it("takes extra hosts from the operator, for the CLI nobody guessed right", () => {
    const allow = allowedHostsFor("claude-code", {
      BOXAIDE_RUN_NETWORK_ALLOW: "proxy.corp.example, cdn.example ",
    });
    expect(hostAllowed("proxy.corp.example", allow)).toBe(true);
    expect(hostAllowed("cdn.example", allow)).toBe(true);
  });

  it("knows an unlisted CLI gets nothing rather than everything", () => {
    expect(allowedHostsFor("some-new-cli", {})).toEqual([]);
  });

  it("reads the operator's escape hatch", () => {
    expect(egressDisabled({ BOXAIDE_RUN_NETWORK: "open" })).toBe(true);
    expect(egressDisabled({ BOXAIDE_RUN_NETWORK: "OPEN" })).toBe(true);
    expect(egressDisabled({})).toBe(false);
  });
});

describe("EgressProxy", () => {
  it("tunnels to an allowed host", async () => {
    const port = await upstream();
    const egress = await proxy(["127.0.0.1"]);
    const answer = await connect(egress.url(), `127.0.0.1:${port}`);
    expect(answer).toContain("200 Connection Established");
    expect(answer).toContain("PROVIDER");
    expect(egress.refusals()).toEqual([]);
  });

  /* The whole point: a run told to post the mailbox somewhere cannot. */
  it("refuses a host nobody listed, and writes it down", async () => {
    const egress = await proxy([".anthropic.com"]);
    const answer = await connect(egress.url(), "mallory.example:443");
    expect(answer).toContain("403 Forbidden");
    expect(answer).not.toContain("200 Connection Established");
    expect(egress.refusals()).toEqual(["mallory.example:443"]);
  });

  it("refuses a look-alike of an allowed host", async () => {
    const egress = await proxy([".anthropic.com"]);
    const answer = await connect(egress.url(), "api.anthropic.com.evil.example:443");
    expect(answer).toContain("403 Forbidden");
  });

  it("answers a plain proxied request with a refusal, and records it", async () => {
    const egress = await proxy(["127.0.0.1"]);
    const res = await fetch(`${egress.url()}/`, {
      method: "GET",
      headers: { host: "mallory.example" },
    });
    expect(res.status).toBe(405);
    // http:// is the same attempt as https:// and must read the same later.
    expect(egress.refusals().length).toBe(1);
    expect(egress.refusedTotal()).toBe(1);
  });

  /* A run told to loop over random hosts must not be able to push the log
     itself out of the 64 KiB tail the run keeps. */
  it("stops collecting refused names at the cap but keeps counting", async () => {
    const egress = await proxy([".anthropic.com"]);
    for (let i = 0; i < MAX_REFUSALS_KEPT + 5; i += 1) {
      await connect(egress.url(), `h${i}.mallory.example:443`);
    }
    expect(egress.refusals().length).toBe(MAX_REFUSALS_KEPT);
    expect(egress.refusedTotal()).toBe(MAX_REFUSALS_KEPT + 5);
  });

  it("closes its listener and its tunnels when the run ends", async () => {
    const port = await upstream();
    const egress = await proxy(["127.0.0.1"]);
    const url = egress.url();
    await connect(url, `127.0.0.1:${port}`);
    egress.stop();
    // Nothing is accepting any more: a connection after the run cannot get a
    // tunnel out of it.
    await expect(connect(url, `127.0.0.1:${port}`)).rejects.toThrow();
  });

  it("tells Node to read the proxy variables at all", () => {
    // Node ignores HTTPS_PROXY unless asked, and two run-capable CLIs are
    // Node programs: without this they bypass the proxy and die on the
    // sandbox instead, with nothing of ours in the log.
    expect(egressEnv("http://127.0.0.1:1").NODE_USE_ENV_PROXY).toBe("1");
  });

  it("keeps Boxaide's own loopback call off the proxy", () => {
    const env = egressEnv("http://127.0.0.1:1234");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1234");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.no_proxy).toContain("localhost");
  });
});

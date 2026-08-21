/**
 * The network boundary around a scheduled run.
 *
 * `src/agent/sandbox.ts` says plainly that it is not one: it confines what an
 * agent reaches on disk, and the network is open at both of its levels. That
 * was the honest position while a person watched every launch. A scheduled
 * automation is the case where nobody does, and it reads mail strangers wrote
 * — so an instruction landing in that mail, or in a note built from it, had a
 * whole machine's network to carry a mailbox out on. Refusing one MCP tool
 * would have answered nothing: three of the launched CLIs run shell commands
 * with approval off, and `curl` is not a tool this server hands out.
 *
 * So the boundary is put where the CLI cannot argue with it, the same place
 * the disk boundary is. Two halves, and both are needed:
 *
 *  - The sandbox denies the run every outbound connection except loopback
 *    (`network: "loopback"` in sandbox.ts). Seatbelt cannot express "this
 *    host": it accepts only `*` or `localhost` as an address, which is what
 *    makes the second half necessary rather than a nicety.
 *  - This proxy listens on loopback and is the only way out of the sandbox.
 *    It reads the hostname off the CONNECT line and refuses every host that
 *    is not on the run's allowlist. No certificate is forged and no body is
 *    read: a proxy that terminated TLS would be a second place holding the
 *    user's mail.
 *
 * The sandbox is not the whole perimeter, and the third piece is in
 * src/mcp/scope.ts: an MCP tool is executed by the SERVER process, which is
 * not confined, so a tool whose argument names an address would fetch it from
 * outside all of this. `web_fetch` is exactly that tool, and a `run` no longer
 * has it. Any future tool that takes a URL has to answer the same question
 * before it is given to a run.
 *
 * What that leaves reachable is the model provider the CLI must talk to, and
 * Boxaide itself. A run can still say anything it likes TO the model — that is
 * the conversation it exists to have — but it cannot post a mailbox to an
 * address a stranger chose.
 *
 * What it does NOT reach: a CLI that never consults the proxy variables goes
 * straight at the network and is refused by the sandbox instead, which means
 * the failure arrives as that CLI's own connection error and never as a
 * refusal here. `NODE_USE_ENV_PROXY` below buys the Node CLIs back; the rest
 * is answered by the run log announcing the boundary before the CLI starts
 * (`egressActiveNote`), not by pretending every attempt is recorded.
 *
 * The allowlist is per CLI and written from what each one needs to sign in and
 * run. It is the part most likely to be wrong for a CLI nobody here has run in
 * a year, so every refusal is recorded and lands in the run's own log: a run
 * broken by this says which host it wanted, and BOXAIDE_RUN_NETWORK_ALLOW
 * takes the answer without waiting for a release. BOXAIDE_RUN_NETWORK=open
 * turns the whole thing off, and says so in the log rather than passing for
 * confinement.
 */
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import net from "node:net";

/**
 * Where each CLI is allowed to reach. A leading dot means "and anything under
 * it", so `.anthropic.com` covers the API, the console a token refresh uses,
 * and the telemetry endpoint a CLI hangs its startup on.
 *
 * Deliberately per CLI rather than one union: a run launched with Codex has no
 * business reaching x.ai, and the union would be the list every future CLI
 * inherited without anybody deciding it should.
 */
const ALLOW_BY_AGENT: Record<string, readonly string[]> = {
  "claude-code": [".anthropic.com", ".claude.com", ".claude.ai"],
  codex: [".openai.com", ".chatgpt.com"],
  opencode: [".opencode.ai", ".anthropic.com", ".openai.com", ".x.ai"],
  grok: [".x.ai", ".grok.com"],
  antigravity: [".googleapis.com", ".google.com", ".gstatic.com"],
};

/** Every CLI reaches its own provider; nothing reaches a host nobody named. */
export function allowedHostsFor(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const extra = (env.BOXAIDE_RUN_NETWORK_ALLOW ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [...(ALLOW_BY_AGENT[agentId] ?? []), ...extra];
}

/** True when the operator has turned the whole boundary off. */
export function egressDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BOXAIDE_RUN_NETWORK ?? "").trim().toLowerCase() === "open";
}

/**
 * Does `host` match one of `allow`? An entry with a leading dot matches the
 * suffix and the bare domain; anything else must match exactly. Compared
 * lowercased, because a CONNECT line is written by the client.
 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) {
      return name === rule.slice(1) || name.endsWith(rule);
    }
    return name === rule;
  });
}

/**
 * How many distinct refused hosts are kept. A run told to loop over random
 * addresses would otherwise build a set with no ceiling, and the line it
 * produces in the run log would evict the log — the evidence of what the run
 * actually did — through the 64 KiB tail cap. The count keeps going up after
 * this; only the names stop being collected.
 */
export const MAX_REFUSALS_KEPT = 20;

export class EgressProxy {
  private server: Server | null = null;
  private sockets = new Set<Duplex>();
  private upstreams = new Set<Duplex>();
  private refused = new Set<string>();
  private refusedCount = 0;

  constructor(private allow: readonly string[]) {}

  /** The address a child should be pointed at, once listening. */
  url(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("egress proxy is not listening");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /**
   * Listens on loopback, on a port the OS picks: a fixed one would collide
   * between two runs and hand the second run the first's allowlist.
   */
  async start(): Promise<void> {
    const server = createServer((req, res) => {
      // Only CONNECT is proxying here. A plain proxied request would mean an
      // http:// target, which no CLI needs and which this would have to read
      // to forward. Recorded like any other refusal: `curl http://…` is the
      // same attempt as `curl https://…` and must read the same in the log.
      this.refuse(plainTarget(req.url ?? "", req.headers.host));
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("this proxy only tunnels https\n");
    });
    server.on("connect", (req, client, head) => this.tunnel(req.url ?? "", client, head));
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();
    this.server = server;
  }

  private tunnel(target: string, client: Duplex, head: Buffer): void {
    const [host, rawPort] = splitAuthority(target);
    const port = Number(rawPort);
    // The host is the boundary, not the port: a provider that answers on 8443
    // is a provider, and a port list would refuse it while stopping nothing —
    // a host nobody named is already refused on every port.
    if (!host || !Number.isInteger(port) || port <= 0 || !hostAllowed(host, this.allow)) {
      this.refuse(`${host || "?"}:${rawPort || "?"}`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    // Tracked, because destroying the client does not end this: a quiet TLS
    // tunnel to a provider survives its own run otherwise, and notices only
    // when the far end next writes into a socket nobody is reading.
    this.upstreams.add(upstream);
    const drop = () => {
      this.upstreams.delete(upstream);
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", drop);
    upstream.on("close", () => this.upstreams.delete(upstream));
    client.on("error", drop);
  }

  /** One refusal, remembered up to the cap and counted past it. */
  private refuse(what: string): void {
    this.refusedCount += 1;
    if (this.refused.size < MAX_REFUSALS_KEPT) this.refused.add(what);
  }

  /** Hosts this run asked for and did not get. The run log's evidence. */
  refusals(): string[] {
    return [...this.refused].sort();
  }

  /** How many attempts were refused, including the ones past the cap. */
  refusedTotal(): number {
    return this.refusedCount;
  }

  /**
   * Closes the door behind the run. The listener goes first: destroying
   * sockets while it is still accepting leaves a window where a connection
   * arriving in between gets a tunnel out of a run that has already ended.
   */
  stop(): void {
    this.server?.close();
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const socket of this.upstreams) socket.destroy();
    this.upstreams.clear();
  }
}

/** What a non-CONNECT proxied request was aiming at, as best it can be told. */
function plainTarget(url: string, hostHeader: string | undefined): string {
  try {
    return new URL(url).host || hostHeader || "?";
  } catch {
    return hostHeader || "?";
  }
}

/** `host:port`, with an IPv6 literal's own colons left where they belong. */
function splitAuthority(target: string): [string, string] {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(target);
  if (bracketed) return [bracketed[1]!, bracketed[2]!];
  const at = target.lastIndexOf(":");
  if (at < 0) return [target, ""];
  return [target.slice(0, at), target.slice(at + 1)];
}

/**
 * What a confined run's child is told, so its HTTP client uses the proxy.
 * NO_PROXY keeps Boxaide's own MCP call on loopback direct: routing it through
 * the proxy would be a hop for nothing, and CONNECT to 127.0.0.1 is exactly
 * the shape this refuses.
 */
export function egressEnv(proxyUrl: string): Record<string, string> {
  return {
    // Node ignores the proxy variables below unless told to read them, and
    // two of the launched CLIs are Node programs. Without this they do not
    // fail loudly through the proxy — they go straight at the network, hit
    // the sandbox's deny, and report a connection error that names no host.
    // Unknown to older runtimes, which ignore it.
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

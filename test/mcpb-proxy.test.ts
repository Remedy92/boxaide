/**
 * The Claude Desktop connector (apps/mcpb) is a stdio→HTTP proxy with no
 * dependencies, so it is tested the way it runs: spawned as a real process,
 * spoken to over stdin, against a real local HTTP server standing in for
 * mailmux.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const PROXY = join(process.cwd(), "apps", "mcpb", "server", "index.mjs");

type Received = { auth: string | undefined; body: unknown };

function startFake(
  handler: (received: Received) => { status: number; body?: unknown },
): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const entry: Received = {
        auth: req.headers.authorization,
        body: JSON.parse(raw),
      };
      received.push(entry);
      const reply = handler(entry);
      res.statusCode = reply.status;
      if (reply.body === undefined) return res.end();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, received });
    });
  });
}

class Proxy {
  private child: ChildProcess;
  private lines: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  private buffer = "";

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [PROXY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
  }

  send(message: unknown): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  nextLine(timeoutMs = 5_000): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("proxy wrote nothing")),
        timeoutMs,
      );
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  /** Lines that arrived and were never asked for. */
  get unread(): number {
    return this.lines.length;
  }

  kill(): void {
    this.child.kill();
  }
}

describe("mcpb connector proxy", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  function tempDataDir(token?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mailmux-mcpb-"));
    if (token !== undefined) writeFileSync(join(dir, "bearer.token"), `${token}\n`);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function startProxy(env: Record<string, string>): Proxy {
    const proxy = new Proxy(env);
    cleanups.push(() => proxy.kill());
    return proxy;
  }

  async function fake(
    handler: (received: Received) => { status: number; body?: unknown },
  ) {
    const started = await startFake(handler);
    cleanups.push(() => started.server.close());
    return started;
  }

  it("forwards a request with the token from bearer.token", async () => {
    const { url, received } = await fake(({ body }) => ({
      status: 200,
      body: { jsonrpc: "2.0", id: (body as { id: number }).id, result: { ok: true } },
    }));
    const proxy = startProxy({
      MAILMUX_URL: url,
      MAILMUX_DATA_DIR: tempDataDir("filetoken"),
      MAILMUX_TOKEN: "",
    });

    proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const reply = JSON.parse(await proxy.nextLine());

    expect(reply).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(received[0].auth).toBe("Bearer filetoken");
  });

  it("writes nothing back for a notification (202)", async () => {
    const { url } = await fake(({ body }) => {
      const message = body as { id?: number };
      if (message.id === undefined) return { status: 202 };
      return { status: 200, body: { jsonrpc: "2.0", id: message.id, result: {} } };
    });
    const proxy = startProxy({
      MAILMUX_URL: url,
      MAILMUX_DATA_DIR: tempDataDir("t"),
      MAILMUX_TOKEN: "",
    });

    proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    proxy.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const reply = JSON.parse(await proxy.nextLine());

    // The one line written is the ping's answer; the notification stayed silent.
    expect(reply.id).toBe(2);
    expect(proxy.unread).toBe(0);
  });

  it("attaches while mailmux is down: local initialize, snapshot tools/list", async () => {
    // A port that was just released: nothing is listening on it.
    const { server, url } = await startFake(() => ({ status: 200 }));
    server.close();
    const proxy = startProxy({
      MAILMUX_URL: url,
      MAILMUX_DATA_DIR: tempDataDir("t"),
      MAILMUX_TOKEN: "",
    });

    proxy.send({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude" } },
    });
    const init = JSON.parse(await proxy.nextLine());
    expect(init.result.serverInfo.name).toBe("mailmux");
    expect(init.result.protocolVersion).toBe("2025-06-18");

    proxy.send({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    const list = JSON.parse(await proxy.nextLine());
    expect(list.result.tools.length).toBeGreaterThan(0);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain(
      "messages_list",
    );
  });

  it("answers a tool call with a helpful error when mailmux is down", async () => {
    const { server, url } = await startFake(() => ({ status: 200 }));
    server.close();
    const proxy = startProxy({
      MAILMUX_URL: url,
      MAILMUX_DATA_DIR: tempDataDir("t"),
      MAILMUX_TOKEN: "",
    });

    proxy.send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "accounts_list", arguments: {} },
    });
    const reply = JSON.parse(await proxy.nextLine());

    expect(reply.id).toBe(9);
    expect(reply.error.message).toMatch(/not running/);
  });

  it("keeps the baked tool snapshot in sync with the server's list", async () => {
    const { CHAT_TOOLS, TOOLS } = await import("../src/mcp/server.js");
    const snapshot = JSON.parse(
      readFileSync(
        join(process.cwd(), "apps", "mcpb", "server", "tools.json"),
        "utf8",
      ),
    );
    // Drift here means someone changed the MCP tools without re-running
    // `node scripts/export-mcpb-tools.mjs` (npm run mcpb:build does it).
    expect(snapshot).toEqual([...TOOLS, ...CHAT_TOOLS]);
  });

  it("prefers MAILMUX_TOKEN over the token file", async () => {
    const { url, received } = await fake(({ body }) => ({
      status: 200,
      body: { jsonrpc: "2.0", id: (body as { id: number }).id, result: {} },
    }));
    const proxy = startProxy({
      MAILMUX_URL: url,
      MAILMUX_DATA_DIR: tempDataDir("filetoken"),
      MAILMUX_TOKEN: "envtoken",
    });

    proxy.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    await proxy.nextLine();

    expect(received[0].auth).toBe("Bearer envtoken");
  });

  it("re-reads a rotated token file after a 401 and retries once", async () => {
    const dir = tempDataDir("stale");
    const { url, received } = await fake(({ auth, body }) => {
      if (auth !== "Bearer fresh") return { status: 401, body: { error: "unauthorized" } };
      return { status: 200, body: { jsonrpc: "2.0", id: (body as { id: number }).id, result: {} } };
    });
    const proxy = startProxy({
      MAILMUX_URL: url,
      MAILMUX_DATA_DIR: dir,
      MAILMUX_TOKEN: "",
    });

    // First request pins the stale token in the proxy before the rotation —
    // spawn is asynchronous, so rotating first would race its startup read.
    proxy.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    const denied = JSON.parse(await proxy.nextLine());
    expect(denied.error.message).toMatch(/token/);

    writeFileSync(join(dir, "bearer.token"), "fresh\n");
    proxy.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    const reply = JSON.parse(await proxy.nextLine());

    expect(reply).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    expect(received.map((r) => r.auth)).toEqual([
      "Bearer stale",
      "Bearer stale",
      "Bearer fresh",
    ]);
  });
});

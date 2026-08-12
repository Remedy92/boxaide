import { describe, expect, it, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { AgentChannel } from "../src/agent/channel.js";
import { createRuntime } from "../src/app.js";
import { Store } from "../src/db/store.js";
import { MailService } from "../src/mail/service.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";

const open = () => new Store(randomBytes(32), ":memory:");

const channels: AgentChannel[] = [];
const stores: Store[] = [];
function make(): { store: Store; channel: AgentChannel } {
  const store = open();
  const channel = new AgentChannel(store);
  stores.push(store);
  channels.push(channel);
  return { store, channel };
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const store of stores.splice(0)) store.close();
});

describe("AgentChannel", () => {
  it("hands a queued message to the first agent that asks", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "what came in today?" });

    const turn = await channel.awaitUserTurn({ timeoutMs: 1_000 });
    expect(turn?.text).toBe("what came in today?");
  });

  it("delivers a message to exactly one of two waiting agents", async () => {
    const { channel } = make();
    const first = channel.awaitUserTurn({ timeoutMs: 2_000 });
    const second = channel.awaitUserTurn({ timeoutMs: 2_000 });
    // Both are parked before anything is posted.
    expect(channel.presence().waiting).toBe(2);

    channel.post({ role: "user", text: "only once" });

    const [a, b] = await Promise.all([first, second]);
    const delivered = [a, b].filter((t) => t !== null);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("only once");
  });

  it("resolves null on timeout rather than throwing", async () => {
    const { channel } = make();
    const turn = await channel.awaitUserTurn({ timeoutMs: 1_000 });
    expect(turn).toBeNull();
  });

  it("never re-delivers a message that was already claimed", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "once" });

    expect((await channel.awaitUserTurn({ timeoutMs: 1_000 }))?.text).toBe("once");
    expect(await channel.awaitUserTurn({ timeoutMs: 1_000 })).toBeNull();
  });

  it("keeps history in order and round-trips through encryption at rest", () => {
    const { store, channel } = make();
    channel.post({ role: "user", text: "summarise my inbox" });
    channel.post({ role: "activity", text: "reading 12 messages" });
    channel.post({ role: "agent", text: "Three need a reply." });

    expect(channel.history().map((t) => [t.role, t.text])).toEqual([
      ["user", "summarise my inbox"],
      ["activity", "reading 12 messages"],
      ["agent", "Three need a reply."],
    ]);

    // The row on disk must not be readable without the master key.
    const raw = store.db
      .prepare(`SELECT text_enc FROM agent_turns ORDER BY seq ASC LIMIT 1`)
      .get() as { text_enc: string };
    expect(raw.text_enc).not.toContain("summarise");
  });

  it("notifies subscribers in sequence order", () => {
    const { channel } = make();
    const seen: string[] = [];
    const off = channel.subscribe((turn) => seen.push(turn.text));

    channel.post({ role: "user", text: "one" });
    channel.post({ role: "agent", text: "two" });
    off();
    channel.post({ role: "agent", text: "three" });

    expect(seen).toEqual(["one", "two"]);
  });

  it("picks up a turn written by another process against the same database", () => {
    // Two AgentChannel instances over one Store is the shape `mailmux serve`
    // and `mailmux mcp` are in: separate objects, one SQLite file.
    const store = open();
    stores.push(store);
    const serve = new AgentChannel(store);
    const stdio = new AgentChannel(store);
    channels.push(serve, stdio);

    const seen: string[] = [];
    serve.subscribe((turn) => seen.push(turn.text));

    stdio.post({ role: "agent", text: "written elsewhere" });
    // drain() is what the poll interval calls; this asserts the read path, not
    // the timer.
    serve.post({ role: "activity", text: "local" });

    expect(seen).toEqual(["written elsewhere", "local"]);
  });

  it("reports presence only while an agent is actually parked", async () => {
    const { channel } = make();
    expect(channel.presence().listening).toBe(false);

    const parked = channel.awaitUserTurn({ timeoutMs: 1_000 });
    expect(channel.presence().waiting).toBe(1);
    expect(channel.presence().listening).toBe(true);

    await parked;
    expect(channel.presence().waiting).toBe(0);
  });

  it("notifies presence subscribers when an agent parks or speaks", async () => {
    const { channel } = make();
    let n = 0;
    const off = channel.subscribePresence(() => {
      n += 1;
    });

    const parked = channel.awaitUserTurn({ timeoutMs: 2_000 });
    expect(n).toBeGreaterThan(0);
    const afterPark = n;

    channel.post({ role: "user", text: "hello" });
    await parked;
    expect(n).toBeGreaterThan(afterPark);

    const afterUser = n;
    channel.post({ role: "agent", text: "hi" });
    expect(n).toBeGreaterThan(afterUser);
    off();
  });

  it("releases parked agents on close", async () => {
    const { channel } = make();
    const parked = channel.awaitUserTurn({ timeoutMs: 60_000 });
    channel.close();
    expect(await parked).toBeNull();
  });

  it("rejects an empty message", () => {
    const { channel } = make();
    expect(() => channel.post({ role: "user", text: "   " })).toThrow(/required/);
  });
});

describe("chat tools over MCP", () => {
  const mail = () => new MailService(open(), new FixtureProvider());

  const call = (
    service: MailService,
    channel: AgentChannel | undefined,
    name: string,
    args: Record<string, unknown> = {},
  ) =>
    handleMcpJsonRpc(
      service,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      channel,
    ) as Promise<{ result?: { content: Array<{ text: string }>; isError?: boolean } }>;

  const payload = (res: { result?: { content: Array<{ text: string }> } }) =>
    JSON.parse(res.result?.content[0]?.text ?? "{}");

  it("lists the chat tools only when a channel exists", async () => {
    const service = mail();
    const { channel } = make();

    const without = (await handleMcpJsonRpc(service, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };
    const withChannel = (await handleMcpJsonRpc(
      service,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      channel,
    )) as { result: { tools: Array<{ name: string }> } };

    const names = (r: { result: { tools: Array<{ name: string }> } }) =>
      r.result.tools.map((t) => t.name);
    expect(names(without)).not.toContain("chat_say");
    expect(names(withChannel)).toEqual(
      expect.arrayContaining(["chat_await_message", "chat_say", "chat_activity", "chat_history"]),
    );
    // The mail tools are still all there.
    expect(names(withChannel)).toEqual(expect.arrayContaining(["messages_list", "draft_create"]));
  });

  it("round-trips a message from the user to the agent and back", async () => {
    const service = mail();
    const { channel } = make();

    channel.post({ role: "user", text: "anything from Stripe?" });

    const awaited = payload(await call(service, channel, "chat_await_message"));
    expect(awaited.message.text).toBe("anything from Stripe?");

    await call(service, channel, "chat_activity", { text: "searching two mailboxes" });
    await call(service, channel, "chat_say", { text: "One invoice, unpaid." });

    expect(channel.history().map((t) => [t.role, t.text])).toEqual([
      ["user", "anything from Stripe?"],
      ["activity", "searching two mailboxes"],
      ["agent", "One invoice, unpaid."],
    ]);
  });

  it("returns a timeout as a normal result, not a tool error", async () => {
    const service = mail();
    const { channel } = make();
    const res = await call(service, channel, "chat_await_message", { timeoutSeconds: 1 });
    expect(res.result?.isError).toBeUndefined();
    const body = payload(res);
    expect(body.message).toBeNull();
    expect(body.timedOut).toBe(true);
    // The hint is the only thing telling the model to call again.
    expect(body.hint).toMatch(/again/i);
  });

  it("refuses a chat tool on a server built without a channel", async () => {
    const res = (await handleMcpJsonRpc(mail(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "chat_say", arguments: { text: "hi" } },
    })) as { error?: { message: string } };
    expect(res.error?.message).toMatch(/Unknown tool/);
  });
});

/**
 * Transport conformance, not features.
 *
 * Both cases below were found by pointing a second vendor's CLI at the server:
 * Codex drops the whole transport on a notification answered with a body, and
 * logs every shutdown as a transport error when DELETE is unrouted. Claude Code
 * tolerates both. That is exactly why these are pinned — "works with the client
 * I happened to test" is the failure mode this channel exists to avoid.
 */
describe("MCP over HTTP conformance", () => {
  const TOKEN = "test-token-abcdefghijklmnop";
  const runtime = () =>
    createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: open(),
      provider: new FixtureProvider(),
    });

  const auth = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  it("answers a notification with 202 and an empty body", async () => {
    const res = await runtime().app.request("/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("still answers a request with its JSON-RPC result", async () => {
    const res = await runtime().app.request("/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("answers DELETE /mcp with 405, not 404", async () => {
    const res = await runtime().app.request("/mcp", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  it("keeps DELETE /mcp behind the bearer token", async () => {
    const res = await runtime().app.request("/mcp", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("advertises the chat tools over HTTP", async () => {
    const res = await runtime().app.request("/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["chat_await_message", "chat_say"]),
    );
  });
});

describe("agent HTTP routes", () => {
  const TOKEN = "test-token-abcdefghijklmnop";
  const build = () =>
    createRuntime({
      dataDir: ":memory:",
      masterKey: randomBytes(32),
      bearerToken: TOKEN,
      host: "127.0.0.1",
      port: 0,
      fixtureMode: true,
      allowedOrigins: [],
      store: open(),
      provider: new FixtureProvider(),
    });
  const auth = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  it("posts a message and reads it back with presence", async () => {
    const rt = build();
    const posted = await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "hello" }),
    });
    expect(posted.status).toBe(201);

    const state = await rt.app.request("/api/agent/state", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await state.json()) as {
      turns: Array<{ role: string; text: string }>;
      presence: { listening: boolean };
    };
    expect(body.turns).toEqual([expect.objectContaining({ role: "user", text: "hello" })]);
    // Nothing has polled, so the UI must not claim an agent is there.
    expect(body.presence.listening).toBe(false);
    rt.channel.close();
  });

  it("rejects an empty message and one over the length cap", async () => {
    const rt = build();
    const empty = await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "   " }),
    });
    expect(empty.status).toBe(400);

    const huge = await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "x".repeat(8_001) }),
    });
    expect(huge.status).toBe(400);
    rt.channel.close();
  });

  it("keeps the conversation behind the bearer token", async () => {
    const rt = build();
    expect((await rt.app.request("/api/agent/state")).status).toBe(401);
    rt.channel.close();
  });

  it("clears the conversation", async () => {
    const rt = build();
    await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "hello" }),
    });
    await rt.app.request("/api/agent/clear", { method: "POST", headers: auth });
    const state = await rt.app.request("/api/agent/state", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(((await state.json()) as { turns: unknown[] }).turns).toEqual([]);
    rt.channel.close();
  });
});

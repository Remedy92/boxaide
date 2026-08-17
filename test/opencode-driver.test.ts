/**
 * The in-process OpenCode loop, tested the way it runs: a real AgentChannel
 * over a real (in-memory) store, and a real local HTTP server standing in for
 * `opencode serve`. Nothing here is mocked except the model.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChannel } from "../src/agent/channel.js";
import { OpenCodeDriver } from "../src/agent/opencode-driver.js";
import { Store } from "../src/db/store.js";

type Call = { path: string; auth: string | undefined; body: any };

type Fake = {
  url: string;
  /** POSTs only. The event stream is a GET and is counted separately. */
  calls: Call[];
  /** Every `GET /event`, in order, with the auth header it carried. */
  streams: Array<{ path: string; auth: string | undefined }>;
  /** Pushes one `data:` line to every open event stream. */
  send: (event: unknown) => void;
  close: () => Promise<void>;
};

/**
 * `reply` returns the message-endpoint response, a status to fail with, or
 * null to hang: the request is accepted and never answered, which is the case
 * the watchdog exists for.
 */
function startFake(
  reply: (call: Call) => { status: number; body?: unknown } | null,
): Promise<Fake> {
  const calls: Call[] = [];
  const streams: Array<{ path: string; auth: string | undefined }> = [];
  const open = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && (req.url ?? "").startsWith("/event")) {
      streams.push({ path: req.url ?? "", auth: req.headers.authorization });
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      // A comment line: the driver ignores it, and it gets the response
      // headers on the wire so the client's read starts.
      res.write(": open\n\n");
      open.add(res);
      req.on("close", () => open.delete(res));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const call: Call = {
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      };
      calls.push(call);
      const out = call.path.startsWith("/session?")
        ? { status: 200, body: { id: "ses_test" } }
        : reply(call);
      if (!out) return;
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        streams,
        send: (event) => {
          for (const res of open) res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        // Held streams and hung requests keep their sockets open, so close()
        // would wait forever without this.
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const cleanup: Array<() => void | Promise<void>> = [];

function make(): { store: Store; channel: AgentChannel } {
  const store = new Store(randomBytes(32), ":memory:");
  const channel = new AgentChannel(store);
  cleanup.push(() => {
    channel.close();
    store.close();
  });
  return { store, channel };
}

/**
 * True for the extra prompt that names the chat.
 *
 * It rides the same endpoint as a real turn, so tests counting conversation
 * attempts have to tell the two apart. Matched on the prompt text rather than
 * on a count, so a test still fails if the naming prompt goes out twice.
 */
function isNaming(call: Call): boolean {
  const text = call.body?.parts?.[0]?.text;
  return typeof text === "string" && text.startsWith("Name this conversation");
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("OpenCodeDriver", () => {
  it("prompts the server with a user turn and posts the reply as that turn's answer", async () => {
    const fake = await startFake(() => ({
      status: 200,
      body: {
        info: { finish: "stop" },
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking out loud" },
          { type: "text", text: "two invoices came in" },
        ],
      },
    }));
    cleanup.push(fake.close);
    const { channel } = make();
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      password: "pw",
      model: "opencode/big-pickle",
      waitMs: 1_000,
    }).start();
    cleanup.push(() => driver.stop());

    const user = channel.post({ role: "user", text: "what came in today?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("two invoices came in");
    // Same path chat_say takes: stamped as the agent, tied to the user turn.
    expect(answer.replyTo).toBe(user.seq);
    expect(answer.agent).toBe("opencode");
    // The lease ended with the answer.
    expect(channel.presence().working).toBeNull();

    const message = fake.calls.find((c) => c.path.startsWith("/session/ses_test/message"));
    expect(message).toBeTruthy();
    expect(message!.body.parts).toEqual([{ type: "text", text: "what came in today?" }]);
    expect(message!.body.model).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
    // The chat tools are off: the driver already holds the lease.
    expect(message!.body.tools.chat_await_message).toBe(false);
    expect(message!.body.tools.boxaide_chat_say).toBe(false);
    // Working directory travels as a query parameter on every call.
    expect(message!.path).toContain(`directory=${encodeURIComponent("/tmp/boxaide-agent")}`);
    expect(message!.auth).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  });

  it("names the chat from the exchange, once, and never at the answer's expense", async () => {
    let namings = 0;
    const fake = await startFake((call) => {
      if (!isNaming(call)) {
        return { status: 200, body: { parts: [{ type: "text", text: "two invoices" }] } };
      }
      namings += 1;
      // First answer is prose a model would not be asked for but writes anyway;
      // it is refused, and the chat keeps the name its message gave it.
      if (namings === 1) return { status: 500 };
      return { status: 200, body: { parts: [{ type: "text", text: '"Invoices from today"' }] } };
    });
    cleanup.push(fake.close);
    const { channel } = make();
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      waitMs: 1_000,
      retryBaseMs: 10,
    }).start();
    cleanup.push(() => driver.stop());

    channel.post({ role: "user", text: "what came in today?" });
    await until(() => namings === 1);
    // A failed naming is not a failed turn: the answer stands and the message
    // is not re-queued.
    await until(() => channel.history().filter((t) => t.role === "agent").length === 1);
    expect(channel.chats()[0].title).toBe("what came in today?");

    channel.post({ role: "user", text: "and yesterday?" });
    await until(() => channel.chats()[0].title === "Invoices from today");
    expect(namings).toBe(2);

    // Named, so nothing asks again.
    channel.post({ role: "user", text: "and the day before?" });
    await until(() => channel.history().filter((t) => t.role === "agent").length === 3);
    expect(namings).toBe(2);
  });

  it("releases the lease and retries when the API fails", async () => {
    let attempts = 0;
    const fake = await startFake((call) => {
      // A failed prompt also fires a fire-and-forget session abort; only the
      // message posts are attempts.
      if (!call.path.includes("/message")) return { status: 200 };
      if (isNaming(call)) {
        return { status: 200, body: { parts: [{ type: "text", text: "Retry test" }] } };
      }
      attempts += 1;
      if (attempts === 1) return { status: 500, body: { name: "UnknownError" } };
      return { status: 200, body: { parts: [{ type: "text", text: "second time lucky" }] } };
    });
    cleanup.push(fake.close);
    const { store, channel } = make();
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      waitMs: 1_000,
      retryBaseMs: 10,
    }).start();
    cleanup.push(() => driver.stop());

    const user = channel.post({ role: "user", text: "retry me" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(attempts).toBe(2);
    // The failed turn went back on the queue and was handed over again, so the
    // same message was answered rather than lost with the request.
    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("second time lucky");
    expect(answer.replyTo).toBe(user.seq);
    expect(store.listDroppedUserSeqs()).toEqual([]);
  });

  it("stops cleanly while parked on the channel", async () => {
    const fake = await startFake(() => ({ status: 200, body: { parts: [] } }));
    cleanup.push(fake.close);
    const { channel } = make();
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      waitMs: 100_000,
    }).start();

    // Parked in awaitUserTurn with a two-minute timeout: only the abort ends it.
    await until(() => channel.presence().waiting === 1);
    expect(channel.driven).toBe(true);
    driver.stop();
    await driver.done;

    expect(channel.presence().waiting).toBe(0);
    // The gate lifts with the loop, so the MCP tier can take over again.
    expect(channel.driven).toBe(false);
    // Nothing was prompted, and stopping twice is a no-op.
    expect(fake.calls).toEqual([]);
    driver.stop();
  });

  it("shows the tool the server is running mid-turn", async () => {
    // The prompt never comes back, so the whole test happens inside one turn:
    // the only thing the pane can say about it is what the stream reports.
    const fake = await startFake((call) =>
      call.path.startsWith("/session/ses_test/message")
        ? null
        : { status: 200, body: {} },
    );
    cleanup.push(fake.close);
    const { channel } = make();
    // Boxaide launched this server, which is what lets the stream speak for
    // the open claim (see AgentChannel.streamSpeaksForWork).
    channel.setLaunchedAgent("opencode");
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      password: "pw",
      waitMs: 1_000,
    }).start();
    cleanup.push(() => driver.stop());

    await until(() => fake.streams.length === 1);
    expect(fake.streams[0].path).toContain(
      `directory=${encodeURIComponent("/tmp/boxaide-agent")}`,
    );
    expect(fake.streams[0].auth).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );

    channel.post({ role: "user", text: "read the config" });
    await until(() => fake.calls.some((c) => c.path.startsWith("/session/ses_test/message")));

    // Another session's parts are somebody else's turn.
    fake.send({
      id: "evt_other",
      type: "message.part.updated",
      properties: { sessionID: "ses_other", part: { type: "tool", tool: "webfetch" } },
    });
    fake.send({
      id: "evt_1",
      type: "message.part.updated",
      properties: { sessionID: "ses_test", part: { type: "tool", tool: "bash" } },
    });
    await until(() => channel.presence().working?.tool?.name === "bash");

    // Text deltas are the answer being written, and say so under one name.
    fake.send({
      id: "evt_2",
      type: "message.part.delta",
      properties: { sessionID: "ses_test", field: "text", text: "the config is" },
    });
    await until(() => channel.presence().working?.tool?.name === "responding");

    driver.stop();
    await driver.done;
  });

  it("abandons a prompt the server has gone quiet on, and retries it", async () => {
    let attempts = 0;
    const fake = await startFake((call) => {
      if (!call.path.startsWith("/session/ses_test/message")) {
        return { status: 200, body: {} };
      }
      if (isNaming(call)) {
        return { status: 200, body: { parts: [{ type: "text", text: "Watchdog test" }] } };
      }
      attempts += 1;
      // The first turn is accepted and never answered: a live socket with a
      // dead turn behind it, which is exactly what the timeout cannot see.
      if (attempts === 1) return null;
      return { status: 200, body: { parts: [{ type: "text", text: "back on track" }] } };
    });
    cleanup.push(fake.close);
    const { store, channel } = make();
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      waitMs: 1_000,
      watchdogMs: 80,
      retryBaseMs: 300,
    }).start();
    cleanup.push(() => driver.stop());

    const user = channel.post({ role: "user", text: "answer me" });
    await until(() => attempts === 1);
    // The lease went back while the driver waits out its backoff.
    await until(() => channel.presence().working === null);
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(attempts).toBe(2);
    const answer = channel.history().find((t) => t.role === "agent")!;
    expect(answer.text).toBe("back on track");
    // The same message was handed over again rather than dying with the POST.
    expect(answer.replyTo).toBe(user.seq);
    expect(store.listDroppedUserSeqs()).toEqual([]);

    driver.stop();
    await driver.done;
  });

  it("does not let a server heartbeat stand in for progress on the turn", async () => {
    let attempts = 0;
    const fake = await startFake((call) => {
      if (!call.path.startsWith("/session/ses_test/message")) {
        return { status: 200, body: {} };
      }
      if (isNaming(call)) {
        return { status: 200, body: { parts: [{ type: "text", text: "Heartbeat test" }] } };
      }
      attempts += 1;
      if (attempts === 1) return null;
      return { status: 200, body: { parts: [{ type: "text", text: "finally" }] } };
    });
    cleanup.push(fake.close);
    const { channel } = make();
    const driver = new OpenCodeDriver({
      channel,
      agent: "opencode",
      baseUrl: fake.url,
      directory: "/tmp/boxaide-agent",
      waitMs: 1_000,
      watchdogMs: 150,
      retryBaseMs: 10,
    }).start();
    cleanup.push(() => driver.stop());

    // Twice as often as the watchdog window: if these counted, the first
    // prompt would never be abandoned and there would be no second attempt.
    const beat = setInterval(
      () => fake.send({ id: "evt_beat", type: "server.heartbeat", properties: {} }),
      50,
    );
    cleanup.push(() => clearInterval(beat));

    channel.post({ role: "user", text: "still there?" });
    await until(() => channel.history().some((t) => t.role === "agent"));

    expect(attempts).toBe(2);
    clearInterval(beat);
    driver.stop();
    await driver.done;
  });
});

import { describe, expect, it, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AgentChannel, MAX_DELIVERIES } from "../src/agent/channel.js";
import { createRuntime } from "../src/app.js";
import { encryptSecret } from "../src/crypto/secrets.js";
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

  it("does not hand a held message to a second agent", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "once" });

    expect((await channel.awaitUserTurn({ timeoutMs: 1_000, agent: "a" }))?.text).toBe(
      "once",
    );
    // A different agent parking is not abandon. The first still holds it.
    expect(await channel.awaitUserTurn({ timeoutMs: 1_000, agent: "b" })).toBeNull();
    expect(channel.history()[0].delivered).toBe(true);
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
    // Two AgentChannel instances over one Store is the shape `boxaide serve`
    // and `boxaide mcp` are in: separate objects, one SQLite file.
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

  it("reports work from the hand-off until the answer lands", async () => {
    const { channel } = make();
    expect(channel.presence().working).toBeNull();

    const parked = channel.awaitUserTurn({ timeoutMs: 2_000, agent: "grok" });
    const posted = channel.post({ role: "user", text: "what came in today?" });
    await parked;

    const working = channel.presence().working;
    expect(working?.seq).toBe(posted.seq);
    expect(working?.agent).toBe("grok");
    expect(working?.tool).toBeNull();

    // An activity line is narration mid-task, not the answer.
    channel.post({ role: "activity", text: "checking your inbox" });
    expect(channel.presence().working?.seq).toBe(posted.seq);

    channel.post({ role: "agent", text: "two invoices and a newsletter" });
    expect(channel.presence().working).toBeNull();
  });

  it("records a mail tool call as a step only while work is open", async () => {
    const { channel } = make();

    // Nobody asked anything: a tool call belongs to no question.
    channel.noteToolCall("messages_list");
    expect(channel.presence().working).toBeNull();

    const parked = channel.awaitUserTurn({ timeoutMs: 2_000 });
    channel.post({ role: "user", text: "find the invoice" });
    await parked;

    channel.noteToolCall("messages_search");
    expect(channel.presence().working?.tool?.name).toBe("messages_search");
  });

  it("keeps a launched agent present on its own output, with no MCP call", async () => {
    const { channel } = make();
    channel.setLaunchedAgent("claude-code");
    const parked = channel.awaitUserTurn({ timeoutMs: 2_000 });
    channel.post({ role: "user", text: "migrate my outreach" });
    await parked;

    // The gap this closes: the agent is reading files and running commands in
    // its own process, and calls no Boxaide tool while it does.
    channel.noteAgentActivity("Read");
    expect(channel.presence().working?.tool?.name).toBe("Read");
    channel.noteAgentActivity("Bash");
    expect(channel.presence().working?.tool?.name).toBe("Bash");

    // A line that names no tool still proves the process is alive.
    channel.noteAgentActivity(null);
    expect(channel.presence().listening).toBe(true);
    expect(channel.presence().working?.tool?.name).toBe("Bash");
  });

  it("does not push a presence event for every line of a firehose", async () => {
    const { channel } = make();
    channel.setLaunchedAgent("grok");
    channel.post({ role: "user", text: "summarise today" });
    await channel.awaitUserTurn({ timeoutMs: 1_000 });

    let n = 0;
    const off = channel.subscribePresence(() => {
      n += 1;
    });

    // Grok narrates its thinking one token per line. Same tool, no news.
    channel.noteAgentActivity("read_file");
    for (let i = 0; i < 500; i += 1) channel.noteAgentActivity(null);
    expect(n).toBe(1);

    // A different tool is news, and goes out at once.
    channel.noteAgentActivity("run_terminal_command");
    expect(n).toBe(2);
    off();
  });

  it("stops holding a claim open on output once two agents are asking", async () => {
    vi.useFakeTimers();
    try {
      const { channel } = make();
      channel.setLaunchedAgent("claude-code");
      channel.post({ role: "user", text: "one" });
      await channel.awaitUserTurn({ agent: "claude-desktop", timeoutMs: 1_000 });
      channel.post({ role: "user", text: "two" });
      await channel.awaitUserTurn({ agent: "claude-code", timeoutMs: 1_000 });

      // Two names have asked, so this claim cannot be pinned on the process we
      // own. Its output no longer holds the claim open, and the ordinary
      // proof clock takes back over.
      vi.advanceTimersByTime(4 * 60_000);
      channel.noteAgentActivity("Read");
      vi.advanceTimersByTime(60_000 + 1_000);
      expect(channel.presence().working).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never expires a claim while the process we launched is still running", async () => {
    vi.useFakeTimers();
    try {
      const { channel } = make();
      channel.setLaunchedAgent("claude-code");
      channel.post({ role: "user", text: "migrate everything into here" });
      await channel.awaitUserTurn({ agent: "claude-code", timeoutMs: 1_000 });

      // One long tool call — a test run, a build, a big read — and stdout says
      // nothing for the whole of it. Half an hour, not one line, still ours.
      vi.advanceTimersByTime(30 * 60_000);
      expect(channel.presence().working).not.toBeNull();

      // And the answer still lands on a claim that was never taken away.
      channel.post({ role: "agent", text: "here is the plan" });
      expect(channel.presence().working).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the claim the moment a launched agent exits unanswered", async () => {
    const { channel } = make();
    channel.setLaunchedAgent("claude-code");
    channel.post({ role: "user", text: "who emailed me?" });
    await channel.awaitUserTurn({ agent: "claude-code", timeoutMs: 1_000 });
    expect(channel.presence().working).not.toBeNull();

    // The process died. That is exactly what the expiry was built to catch,
    // and the exit proves it — no reason to hold a spinner for five minutes.
    channel.setLaunchedAgent(null);
    expect(channel.presence().working).toBeNull();
    expect(channel.history()[0].delivered).toBe(false);
    expect((await channel.awaitUserTurn({ timeoutMs: 1_000 }))?.text).toBe(
      "who emailed me?",
    );
  });

  it("leaves another agent's claim alone when a launched agent exits", async () => {
    const { channel } = make();
    channel.setLaunchedAgent("claude-code");
    channel.post({ role: "user", text: "one" });
    await channel.awaitUserTurn({ agent: "claude-desktop", timeoutMs: 1_000 });
    channel.post({ role: "user", text: "two" });
    await channel.awaitUserTurn({ agent: "claude-code", timeoutMs: 1_000 });

    // Two agents asked, so the claim cannot be pinned on the one that exited.
    channel.setLaunchedAgent(null);
    expect(channel.presence().working).not.toBeNull();
  });

  it("gives up the claim when a Boxaide tool call is the only proof", async () => {
    vi.useFakeTimers();
    try {
      const { channel } = make();
      channel.post({ role: "user", text: "find the invoice" });
      await channel.awaitUserTurn({ timeoutMs: 1_000 });

      // No launched process here, so a mail tool call is all an agent can
      // offer. It counts: the agent that called it is holding this message.
      vi.advanceTimersByTime(4 * 60_000);
      channel.noteToolCall("messages_search");
      vi.advanceTimersByTime(4 * 60_000);
      expect(channel.presence().working).not.toBeNull();

      vi.advanceTimersByTime(5 * 60_000 + 1_000);
      expect(channel.presence().working).toBeNull();
      expect(channel.history()[0].delivered).toBe(false);
      expect(
        (await channel.awaitUserTurn({ timeoutMs: 1_000, agent: "b" }))?.text,
      ).toBe("find the invoice");
    } finally {
      vi.useRealTimers();
    }
  });

  it("will not let a launched agent's output speak for another agent's claim", async () => {
    const { channel } = make();
    channel.setLaunchedAgent("claude-code");

    // Two clients ask for messages, so Boxaide cannot tell which of them holds
    // the open one — HTTP MCP gives a claim no session to trace back.
    channel.post({ role: "user", text: "one" });
    await channel.awaitUserTurn({ agent: "claude-desktop", timeoutMs: 1_000 });
    channel.post({ role: "user", text: "two" });
    await channel.awaitUserTurn({ agent: "claude-code", timeoutMs: 1_000 });

    // The launched CLI is reading files. That may be nothing to do with the
    // question on screen, so it must not be drawn as a step under it.
    channel.noteAgentActivity("Read");
    expect(channel.presence().working?.tool).toBeNull();

    // The process is still provably running, and presence still says so.
    expect(channel.presence().listening).toBe(true);
  });

  it("re-trusts the stream once a new launched agent starts alone", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "one" });
    await channel.awaitUserTurn({ agent: "claude-desktop", timeoutMs: 1_000 });

    // Start counts from the new process: the old client may be long gone, and
    // its name must not mute the stream for the rest of the session.
    channel.setLaunchedAgent("claude-code");
    channel.post({ role: "user", text: "two" });
    await channel.awaitUserTurn({ agent: "claude-code", timeoutMs: 1_000 });

    channel.noteAgentActivity("Bash");
    expect(channel.presence().working?.tool?.name).toBe("Bash");
  });

  it("reports a claimed message as delivered while the lease is held", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "who emailed me?" });
    expect(channel.history()[0].delivered).toBe(false);

    await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" });

    expect(channel.history()[0].delivered).toBe(true);
    expect(channel.presence().dropped).toEqual([]);
  });

  it("hands the message back when the same agent returns unanswered", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "hello" });
    const first = await channel.awaitUserTurn({ timeoutMs: 1_000, agent: "a" });
    expect(first?.deliveryCount).toBe(1);

    const again = await channel.awaitUserTurn({ timeoutMs: 1_000, agent: "a" });
    expect(again?.text).toBe("hello");
    expect(again?.deliveryCount).toBe(2);
  });

  it("keeps another agent's lease when a second agent parks", async () => {
    const { channel } = make();
    const parked = channel.awaitUserTurn({ timeoutMs: 2_000, agent: "a" });
    channel.post({ role: "user", text: "hello" });
    await parked;
    expect(channel.presence().working).not.toBeNull();

    const next = channel.awaitUserTurn({ timeoutMs: 500, agent: "b" });
    expect(channel.presence().working).not.toBeNull();
    await next;
  });

  it("drops a waiter when the request is aborted", async () => {
    const { channel } = make();
    const abort = new AbortController();
    const parked = channel.awaitUserTurn({ timeoutMs: 60_000, signal: abort.signal });
    expect(channel.presence().waiting).toBe(1);
    abort.abort();
    expect(await parked).toBeNull();
    expect(channel.presence().waiting).toBe(0);
  });

  it("dead-letters a message after too many unanswered leases", async () => {
    const { channel } = make();
    const posted = channel.post({ role: "user", text: "once" });
    for (let n = 0; n < MAX_DELIVERIES; n += 1) {
      expect(
        (await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" }))?.text,
      ).toBe("once");
    }
    expect(await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" })).toBeNull();
    expect(channel.history()[0].delivered).toBe(true);
    expect(channel.presence().dropped).toEqual([posted.seq]);
  });

  it("offers a dropped message again to the agent that just started", async () => {
    const { store, channel } = make();
    const posted = channel.post({ role: "user", text: "once" });
    // A CLI that cannot run at all burns every delivery without reading a word
    // of the message. That is not a verdict on the message.
    for (let n = 0; n < MAX_DELIVERIES; n += 1) {
      await channel.awaitUserTurn({ timeoutMs: 500, agent: "signed-out" });
      channel.releaseLease(posted.seq);
    }
    expect(channel.presence().dropped).toEqual([posted.seq]);

    channel.setLaunchedAgent("claude-code");

    // The warning is gone and the message is queued again, with the full three
    // deliveries: the ones before were spent on an agent that no longer exists.
    expect(channel.presence().dropped).toEqual([]);
    expect(store.listDroppedUserSeqs()).toEqual([]);
    const handed = await channel.awaitUserTurn({ timeoutMs: 500, agent: "claude-code" });
    expect(handed?.text).toBe("once");
    expect(handed?.deliveryCount).toBe(1);
  });

  it("hands a requeued message straight to an agent already waiting", async () => {
    const { channel } = make();
    const posted = channel.post({ role: "user", text: "once" });
    for (let n = 0; n < MAX_DELIVERIES; n += 1) {
      await channel.awaitUserTurn({ timeoutMs: 500, agent: "signed-out" });
      channel.releaseLease(posted.seq);
    }
    const parked = channel.awaitUserTurn({ timeoutMs: 60_000, agent: "claude-code" });
    expect(channel.presence().waiting).toBe(1);

    // A requeue writes no new turn, so nothing else would wake this waiter: it
    // would sit out its whole timeout beside a message it could have had.
    expect(channel.requeueDropped()).toBe(1);
    expect((await parked)?.text).toBe("once");
  });

  it("leaves an answered message alone, and reports nothing to requeue", async () => {
    const { channel } = make();
    const posted = channel.post({ role: "user", text: "once" });
    const held = await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" });
    channel.post({ role: "agent", text: "answered", replyTo: held!.seq });
    channel.releaseLease(posted.seq);

    // Requeuing an answered question would have a second agent answer it, which
    // is the hole the lease exists to close.
    expect(channel.requeueDropped()).toBe(0);
    expect(await channel.awaitUserTurn({ timeoutMs: 500, agent: "b" })).toBeNull();
  });

  it("drops a message again when the same agent keeps failing on it", async () => {
    const { channel } = make();
    const posted = channel.post({ role: "user", text: "the poison pill" });
    channel.setLaunchedAgent("claude-code");
    for (let n = 0; n < MAX_DELIVERIES; n += 1) {
      await channel.awaitUserTurn({ timeoutMs: 500, agent: "claude-code" });
      channel.releaseLease(posted.seq);
    }
    // No relaunch in between, so the cap still means what it meant: a message
    // that breaks the agent is not retried forever.
    expect(channel.presence().dropped).toEqual([posted.seq]);
    expect(await channel.awaitUserTurn({ timeoutMs: 500, agent: "claude-code" })).toBeNull();
  });

  it("keeps the final lease out of the dropped list while it is live", async () => {
    const { channel } = make();
    const posted = channel.post({ role: "user", text: "once" });
    for (let n = 0; n < MAX_DELIVERIES - 1; n += 1) {
      await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" });
    }

    // The last allowed hand-off. On disk this row already looks dead-lettered,
    // and the agent is answering it right now: the pane must not tell the user
    // to send it again over a live attempt.
    const last = await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" });
    expect(last?.deliveryCount).toBe(MAX_DELIVERIES);
    expect(channel.presence().working?.seq).toBe(posted.seq);
    expect(channel.presence().dropped).toEqual([]);

    // The lease ended with no answer. Now it really is dropped.
    channel.releaseLease(posted.seq);
    expect(channel.presence().working).toBeNull();
    expect(channel.presence().dropped).toEqual([posted.seq]);
  });

  it("will not let an unnamed client take a named agent's lease", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "hello" });
    const held = await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" });
    expect(held?.deliveryCount).toBe(1);

    // Neither an anonymous client nor a different name is the holder, so the
    // lease stays with "a" and nobody else is handed the same message.
    expect(await channel.awaitUserTurn({ timeoutMs: 500, agent: null })).toBeNull();
    expect(channel.presence().working?.agent).toBe("a");
    expect(await channel.awaitUserTurn({ timeoutMs: 500, agent: "b" })).toBeNull();
    expect(channel.presence().working?.agent).toBe("a");

    // The holder itself returning unanswered still gives the message back.
    const again = await channel.awaitUserTurn({ timeoutMs: 500, agent: "a" });
    expect(again?.text).toBe("hello");
    expect(again?.deliveryCount).toBe(2);
  });

  it("lets an unnamed holder re-take its own lease after another was named", async () => {
    const { channel } = make();
    // A named client initialized first, so lastAgent is set before anyone asks.
    channel.noteClient("claude-desktop");
    channel.post({ role: "user", text: "hello" });

    const held = await channel.awaitUserTurn({ timeoutMs: 500, agent: null });
    expect(held?.deliveryCount).toBe(1);
    expect(channel.presence().working?.agent).toBeNull();

    const again = await channel.awaitUserTurn({ timeoutMs: 500, agent: null });
    expect(again?.text).toBe("hello");
    expect(again?.deliveryCount).toBe(2);
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

  it("lets a launched agent own the name without erasing the last MCP client", () => {
    const { channel } = make();
    channel.noteClient("claude-code");
    expect(channel.presence().lastAgent).toBe("claude-code");
    expect(channel.presence().launchedAgent).toBeNull();
    expect(channel.clientName).toBe("claude-code");

    channel.setLaunchedAgent("grok");
    expect(channel.presence().launchedAgent).toBe("grok");
    expect(channel.presence().lastAgent).toBe("grok");
    expect(channel.clientName).toBe("grok");

    channel.post({ role: "agent", text: "hi", agent: channel.clientName });
    expect(channel.history().at(-1)?.agent).toBe("grok");

    channel.noteClient("claude-code");
    expect(channel.clientName).toBe("grok");

    // Stop returns the leftover MCP name; the grok stamp did not erase it.
    channel.setLaunchedAgent(null);
    expect(channel.presence().launchedAgent).toBeNull();
    expect(channel.presence().lastAgent).toBe("claude-code");
    expect(channel.clientName).toBe("claude-code");
  });

  it("notifies presence subscribers when the launched agent changes", () => {
    const { channel } = make();
    let n = 0;
    const off = channel.subscribePresence(() => {
      n += 1;
    });
    channel.setLaunchedAgent("grok");
    expect(n).toBe(1);
    channel.setLaunchedAgent("grok");
    expect(n).toBe(1);
    channel.setLaunchedAgent(null);
    expect(n).toBe(2);
    off();
  });

  it("notifies presence subscribers when initialize names a client", () => {
    const { channel } = make();
    let n = 0;
    const off = channel.subscribePresence(() => {
      n += 1;
    });
    channel.noteClient("claude-code");
    expect(n).toBe(1);
    channel.noteClient("claude-code");
    expect(n).toBe(1);
    off();
  });

  it("stamps activity and the answer with the claimed user seq", async () => {
    const { channel } = make();
    const parked = channel.awaitUserTurn({ timeoutMs: 2_000 });
    const asked = channel.post({ role: "user", text: "what came in?" });
    await parked;

    const step = channel.post({ role: "activity", text: "reading inbox" });
    const said = channel.post({ role: "agent", text: "two invoices" });

    expect(asked.replyTo).toBeNull();
    expect(step.replyTo).toBe(asked.seq);
    expect(said.replyTo).toBe(asked.seq);
    expect(channel.history().map((t) => t.replyTo)).toEqual([
      null,
      asked.seq,
      asked.seq,
    ]);
  });

  it("keeps the first claimed seq when a second question arrives mid-work", async () => {
    const { channel } = make();
    const parked = channel.awaitUserTurn({ timeoutMs: 2_000 });
    const first = channel.post({ role: "user", text: "Q1" });
    await parked;

    const second = channel.post({ role: "user", text: "Q2" });
    expect(channel.presence().working?.seq).toBe(first.seq);
    expect(second.replyTo).toBeNull();

    const said = channel.post({ role: "agent", text: "answer to Q1" });
    expect(said.replyTo).toBe(first.seq);
    expect(channel.history().find((t) => t.role === "agent")?.replyTo).toBe(
      first.seq,
    );
  });

  it("leaves unprompted agent turns unstamped", () => {
    const { channel } = make();
    const said = channel.post({ role: "agent", text: "hello unprompted" });
    expect(said.replyTo).toBeNull();
    expect(channel.history()[0].replyTo).toBeNull();
  });

  it("migrates an old agent_turns table that has no reply_to", () => {
    const path = join(
      tmpdir(),
      `mailmux-turns-${randomBytes(8).toString("hex")}.db`,
    );
    const key = randomBytes(32);
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE agent_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        role TEXT NOT NULL,
        text_enc TEXT NOT NULL,
        agent TEXT,
        delivered INTEGER NOT NULL DEFAULT 0
      );
    `);
    raw
      .prepare(
        `INSERT INTO agent_turns (at, role, text_enc, agent, delivered)
         VALUES (?, 'user', ?, NULL, 0)`,
      )
      .run(new Date().toISOString(), encryptSecret(key, "old question"));
    raw.close();

    let store: Store | undefined;
    try {
      store = new Store(key, path);
      const listed = store.listTurns();
      expect(listed).toHaveLength(1);
      expect(listed[0].text).toBe("old question");
      expect(listed[0].replyTo).toBeNull();
      expect(listed[0].deliveryCount).toBe(0);

      const added = store.appendTurn({
        at: new Date().toISOString(),
        role: "agent",
        text: "new answer",
        agent: null,
        replyTo: listed[0].seq,
      });
      expect(added.replyTo).toBe(listed[0].seq);
      expect(store.listTurns().map((t) => t.replyTo)).toEqual([
        null,
        listed[0].seq,
      ]);
    } finally {
      store?.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = path + suffix;
        if (existsSync(file)) unlinkSync(file);
      }
    }
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

  it("asks for a chat name on the wait, and takes the one chat_say carries", async () => {
    const service = mail();
    const { channel } = make();

    channel.post({ role: "user", text: "can you look at the acme thing" });
    const awaited = payload(await call(service, channel, "chat_await_message"));
    expect(awaited.needsTitle).toBe(true);
    expect(awaited.hint).toContain("title");

    await call(service, channel, "chat_say", {
      text: "Their invoice is unpaid.",
      title: "Refund for the Acme invoice",
    });
    expect(channel.chats()[0].title).toBe("Refund for the Acme invoice");

    // Named once. The next wait does not ask again, and a title sent anyway is
    // ignored rather than treated as a failed answer.
    channel.post({ role: "user", text: "and the february one?" });
    const second = payload(await call(service, channel, "chat_await_message"));
    expect(second.needsTitle).toBe(false);
    const said = payload(
      await call(service, channel, "chat_say", { text: "Also unpaid.", title: "Something else" }),
    );
    expect(said.posted).toBe(true);
    expect(channel.chats()[0].title).toBe("Refund for the Acme invoice");
  });

  it("stamps chat_say with the launched agent, not a leftover MCP name", async () => {
    const service = mail();
    const { channel } = make();

    await handleMcpJsonRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "claude-code" } },
      },
      channel,
    );
    channel.setLaunchedAgent("grok");
    await call(service, channel, "chat_say", { text: "Seven drafts." });

    const said = channel.history().find((t) => t.role === "agent");
    expect(said?.text).toBe("Seven drafts.");
    expect(said?.agent).toBe("grok");
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

  it("unclaims when the await request is aborted after the hand-off", async () => {
    const service = mail();
    const { channel } = make();
    const abort = new AbortController();
    const pending = handleMcpJsonRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "chat_await_message", arguments: { timeoutSeconds: 30 } },
      },
      channel,
      undefined,
      abort.signal,
    );
    channel.post({ role: "user", text: "hello" });
    abort.abort();
    expect(await pending).toBeNull();
    expect(channel.history()[0].delivered).toBe(false);
  });

  it("refuses the chat loop tools while a driver holds the conversation", async () => {
    const service = mail();
    const { channel } = make();
    channel.post({ role: "user", text: "hello" });
    channel.setDriven(true);

    // No wait, no claim: the driver's own loop must stay the only asker.
    const awaited = payload(await call(service, channel, "chat_await_message"));
    expect(awaited.message).toBeNull();
    expect(awaited.hint).toMatch(/handling this conversation/i);
    expect(channel.history()[0].delivered).toBe(false);

    const said = payload(await call(service, channel, "chat_say", { text: "mine!" }));
    expect(said.posted).toBe(false);
    expect(channel.history()).toHaveLength(1);

    // Driver gone, tools back: the MCP tier is the fallback again.
    channel.setDriven(false);
    const after = payload(await call(service, channel, "chat_await_message"));
    expect(after.message.text).toBe("hello");
  });

  it("marks a second hand-off of the same message as redelivered", async () => {
    const service = mail();
    const { channel } = make();
    channel.post({ role: "user", text: "hello" });
    expect(payload(await call(service, channel, "chat_await_message")).redelivered).toBe(
      false,
    );
    const again = payload(await call(service, channel, "chat_await_message"));
    expect(again.message.text).toBe("hello");
    expect(again.redelivered).toBe(true);
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

  it("sends and clears the chat the pane named, not the active one", async () => {
    const rt = build();
    await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "in the first chat" }),
    });
    const first = rt.channel.chats()[0];
    // Another window opens a chat, so the server-wide active row moves.
    const second = rt.channel.createChat();

    const posted = await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "still the first", chat: first.id }),
    });
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { turn: { chatId: string } }).turn.chatId).toBe(first.id);
    expect(rt.channel.history(undefined, second.id)).toHaveLength(0);

    const cleared = await rt.app.request("/api/agent/clear", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ chat: first.id }),
    });
    expect(cleared.status).toBe(200);
    expect(rt.channel.history(undefined, first.id)).toHaveLength(0);
    rt.channel.close();
  });

  it("answers 404 for a send or clear aimed at a chat that is not there", async () => {
    const rt = build();
    const posted = await rt.app.request("/api/agent/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "hello", chat: "c_nope" }),
    });
    expect(posted.status).toBe(404);
    const cleared = await rt.app.request("/api/agent/clear", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ chat: "c_nope" }),
    });
    expect(cleared.status).toBe(404);
    rt.channel.close();
  });
});

import { describe, expect, it, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentChannel } from "../src/agent/channel.js";
import { encryptSecret } from "../src/crypto/secrets.js";
import { Store } from "../src/db/store.js";

/**
 * Chats: what lands where, what is dropped, and what is kept when it is.
 *
 * The rules under test are the ones a user would notice going wrong — an
 * answer appearing in the wrong conversation, a chat quietly starting in the
 * middle, the budget eating the conversation somebody is in.
 */

const channels: AgentChannel[] = [];
const stores: Store[] = [];

function make(): { store: Store; channel: AgentChannel } {
  const store = new Store(randomBytes(32), ":memory:");
  const channel = new AgentChannel(store);
  stores.push(store);
  channels.push(channel);
  return { store, channel };
}

/** Saves a session the way a driver does: on the epoch it just read. */
function save(
  channel: AgentChannel,
  chatId: string,
  agent: string,
  sessionId: string,
): void {
  const { epoch } = channel.chatSession(chatId, agent);
  channel.saveChatSession(chatId, agent, sessionId, epoch);
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const store of stores.splice(0)) store.close();
  delete process.env.BOXAIDE_CHAT_BUDGET_MB;
});

describe("chats", () => {
  it("starts with one chat and writes the first message into it", () => {
    const { channel } = make();
    const turn = channel.post({ role: "user", text: "hello" });
    const chats = channel.chats();
    expect(chats).toHaveLength(1);
    expect(turn.chatId).toBe(chats[0].id);
  });

  it("names a chat from its first message and does not rename it later", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "chase the March invoices" });
    channel.post({ role: "user", text: "and the February ones" });
    expect(channel.chats()[0].title).toBe("chase the March invoices");
  });

  it("lets the agent replace the derived name once, and only once", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "can you look at the acme thing" });
    expect(channel.needsTitle(channel.chats()[0].id)).toBe(true);

    const id = channel.chats()[0].id;
    expect(channel.nameChat(id, "Refund for the Acme invoice")).toBe(true);
    expect(channel.chats()[0].title).toBe("Refund for the Acme invoice");

    // A second offer is refused: the row must not move under a reader who has
    // already learned where it is.
    expect(channel.needsTitle(id)).toBe(false);
    expect(channel.nameChat(id, "Something else entirely")).toBe(false);
    expect(channel.chats()[0].title).toBe("Refund for the Acme invoice");
  });

  it("never lets the agent overwrite a name the user typed", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "hello" });
    const id = channel.chats()[0].id;
    expect(channel.renameChat(id, "My own name")).toBe(true);
    expect(channel.needsTitle(id)).toBe(false);
    expect(channel.nameChat(id, "The agent's idea")).toBe(false);
    expect(channel.chats()[0].title).toBe("My own name");
  });

  it("keeps the derived name when the agent's answer is not a name", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "chase the March invoices" });
    const id = channel.chats()[0].id;
    for (const junk of ["", "   ", `Sure! ${"a".repeat(200)}`]) {
      expect(channel.nameChat(id, junk)).toBe(false);
    }
    expect(channel.chats()[0].title).toBe("chase the March invoices");
    // Refusing a bad answer leaves the chat open to a good one.
    expect(channel.needsTitle(id)).toBe(true);
  });

  it("strips what a model puts around a title", () => {
    const cases: Array<[string, string]> = [
      ['"Refund for the Acme invoice"', "Refund for the Acme invoice"],
      ["**Invoice chase**", "Invoice chase"],
      ["Title: Invoice chase", "Invoice chase"],
      ["# Invoice chase", "Invoice chase"],
      ["Invoice chase.", "Invoice chase"],
      ["Invoice chase\nand some prose after it", "Invoice chase"],
    ];
    for (const [raw, want] of cases) {
      const { channel } = make();
      channel.post({ role: "user", text: "hello" });
      const id = channel.chats()[0].id;
      expect(channel.nameChat(id, raw)).toBe(true);
      expect(channel.chats()[0].title).toBe(want);
    }
  });

  it("offers the migrated conversation a name instead of leaving it placeheld", () => {
    const { store, channel } = make();
    const chat = store.createChat("Conversation");
    channel.selectChat(chat.id);
    // The placeholder is not a name, so the first message still renames it and
    // the agent may still improve on that.
    channel.post({ role: "user", text: "what did stripe send yesterday" });
    expect(channel.chats()[0].title).toBe("what did stripe send yesterday");
    expect(channel.needsTitle(chat.id)).toBe(true);
  });

  it("keeps a long first message to one readable line", () => {
    const { channel } = make();
    channel.post({
      role: "user",
      text: `${"summarise everything ".repeat(10)}\nsecond line`,
    });
    const title = channel.chats()[0].title;
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title).not.toContain("\n");
    expect(title.endsWith("…")).toBe(true);
  });

  it("keeps a CLI session per chat, and hands it only to the agent that made it", () => {
    const { channel } = make();
    const first = channel.activeChat().id;
    const second = channel.createChat().id;
    save(channel, first, "claude-code", "ses-a");
    save(channel, second, "claude-code", "ses-b");

    expect(channel.chatSession(first, "claude-code").id).toBe("ses-a");
    expect(channel.chatSession(second, "claude-code").id).toBe("ses-b");
    // A session id means nothing to a CLI that did not issue it, so the chat
    // starts a fresh one rather than failing every turn on a stranger's id.
    expect(channel.chatSession(first, "opencode").id).toBeNull();
    // A chat that changed agents keeps only the last session it was given.
    save(channel, first, "opencode", "ses-oc");
    expect(channel.chatSession(first, "opencode").id).toBe("ses-oc");
    expect(channel.chatSession(first, "claude-code").id).toBeNull();
  });

  it("drops a chat's session when its messages go, and leaves the others alone", () => {
    const { channel } = make();
    const first = channel.activeChat().id;
    const second = channel.createChat().id;
    channel.post({ role: "user", text: "hello", chatId: first });
    save(channel, first, "claude-code", "ses-a");
    save(channel, second, "claude-code", "ses-b");

    channel.clear(first);
    // A model resuming a transcript the pane no longer shows would answer from
    // history the user has just emptied.
    expect(channel.chatSession(first, "claude-code").id).toBeNull();
    expect(channel.chatSession(second, "claude-code").id).toBe("ses-b");

    channel.deleteChat(second);
    expect(channel.chatSession(second, "claude-code").id).toBeNull();
  });

  it("refuses a session saved by a turn that started before the chat was cleared", () => {
    const { channel } = make();
    const chat = channel.activeChat().id;
    channel.post({ role: "user", text: "hello", chatId: chat });
    // What a driver reads when it takes the turn.
    const before = channel.chatSession(chat, "claude-code").epoch;

    // The user empties the chat while the model is still working on it.
    channel.clear(chat);
    // The answer lands afterwards and tries to save the session it ran in.
    channel.saveChatSession(chat, "claude-code", "ses-stale", before);

    // Refused. Resuming it would answer the next message from the history the
    // user has just emptied.
    expect(channel.chatSession(chat, "claude-code").id).toBeNull();

    // The turn after the clear reads the new epoch and saves normally.
    save(channel, chat, "claude-code", "ses-fresh");
    expect(channel.chatSession(chat, "claude-code").id).toBe("ses-fresh");
  });

  it("writes new messages to the chat the user selected", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "first" });
    const second = channel.createChat();
    const turn = channel.post({ role: "user", text: "second" });
    expect(turn.chatId).toBe(second.id);
    expect(channel.history().map((t) => t.text)).toEqual(["second"]);
  });

  it("answers in the chat the question was asked in, not the one on screen", async () => {
    const { channel } = make();
    channel.post({ role: "user", text: "question in chat one" });
    const asked = channel.chats()[0];
    // The agent takes the message, and only then does the user open another
    // chat. The answer still belongs to the conversation that asked.
    const claimed = await channel.awaitUserTurn({ timeoutMs: 500 });
    expect(claimed?.chatId).toBe(asked.id);
    const elsewhere = channel.createChat();
    const answer = channel.post({ role: "agent", text: "answer" });
    expect(answer.chatId).toBe(asked.id);
    expect(answer.chatId).not.toBe(elsewhere.id);
  });

  it("clear empties the chat on screen and leaves the others alone", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "keep me" });
    const kept = channel.chats()[0];
    channel.createChat();
    channel.post({ role: "user", text: "drop me" });

    channel.clear();
    expect(channel.history()).toHaveLength(0);
    expect(channel.history(undefined, kept.id).map((t) => t.text)).toEqual([
      "keep me",
    ]);
  });

  it("writes a named send into that chat and makes it the one being written to", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "first" });
    const first = channel.chats()[0];
    // Another window opened a new chat, so the active row is no longer the one
    // this sender is looking at.
    const second = channel.createChat();

    const turn = channel.post({ role: "user", text: "back in first", chatId: first.id });
    expect(turn.chatId).toBe(first.id);
    // The agent answers where the question was asked, so the hand-off follows
    // the latest send rather than the last chat somebody clicked.
    expect(channel.activeChat().id).toBe(first.id);
    expect(channel.history(undefined, second.id)).toHaveLength(0);
  });

  it("refuses a send to a chat that is gone or archived", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "first" });
    const first = channel.chats()[0];
    channel.createChat();
    expect(channel.archiveChat(first.id)).toBe(true);

    expect(channel.writable(first.id)).toBe(false);
    expect(() => channel.post({ role: "user", text: "late", chatId: first.id })).toThrow();
    expect(channel.writable("c_nope")).toBe(false);
    expect(() => channel.post({ role: "user", text: "late", chatId: "c_nope" })).toThrow();
  });

  it("clears the chat it was told to clear, not the active one", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "drop me" });
    const first = channel.chats()[0];
    const second = channel.createChat();
    channel.post({ role: "user", text: "keep me" });

    channel.clear(first.id);
    expect(channel.history(undefined, first.id)).toHaveLength(0);
    expect(channel.history(undefined, second.id).map((t) => t.text)).toEqual(["keep me"]);
    // A clear names a chat; it does not move the user to it.
    expect(channel.activeChat().id).toBe(second.id);
    expect(() => channel.clear("c_nope")).toThrow();
  });

  it("deleting the open chat leaves the user in another one, not in nothing", () => {
    const { channel } = make();
    channel.post({ role: "user", text: "older" });
    const older = channel.chats()[0];
    const newer = channel.createChat();

    expect(channel.deleteChat(newer.id)).toBe(true);
    expect(channel.activeChat().id).toBe(older.id);
    expect(channel.history().map((t) => t.text)).toEqual(["older"]);
  });
});

describe("limits", () => {
  it("trims a chat to its own limit and says so from then on", () => {
    const { channel, store } = make();
    const chat = channel.activeChat();
    for (let i = 0; i < 520; i += 1) {
      channel.post({ role: "user", text: `message ${i}` });
    }
    const turns = store.listTurns({ chatId: chat.id, limit: 1000 });
    expect(turns).toHaveLength(500);
    expect(turns[0].text).toBe("message 20");
    expect(channel.chats()[0].trimmed).toBe(true);
  });

  it("trims each chat separately", () => {
    const { channel, store } = make();
    const first = channel.activeChat();
    for (let i = 0; i < 505; i += 1) {
      channel.post({ role: "user", text: `first ${i}` });
    }
    const second = channel.createChat();
    channel.post({ role: "user", text: "second one" });

    expect(store.listTurns({ chatId: first.id, limit: 1000 })).toHaveLength(500);
    expect(store.listTurns({ chatId: second.id, limit: 1000 })).toHaveLength(1);
  });

  it("clearing a chat drops its trimmed notice — that loss was the user's own", () => {
    const { channel } = make();
    for (let i = 0; i < 505; i += 1) {
      channel.post({ role: "user", text: `message ${i}` });
    }
    expect(channel.chats()[0].trimmed).toBe(true);
    channel.clear();
    expect(channel.chats()[0].trimmed).toBe(false);
  });

  it("archives the oldest chats when the budget is passed, keeping their records", () => {
    // Small enough that a handful of messages passes it.
    process.env.BOXAIDE_CHAT_BUDGET_MB = "0.001";
    const { channel } = make();

    channel.post({ role: "user", text: "x".repeat(400) });
    const oldest = channel.chats()[0];
    channel.createChat();
    channel.post({ role: "user", text: "y".repeat(400) });
    const middle = channel.chats()[0];
    channel.createChat();
    channel.post({ role: "user", text: "z".repeat(400) });

    const live = channel.chats();
    expect(live.some((chat) => chat.id === oldest.id)).toBe(false);

    // The record survives. That is the whole difference from deletion.
    const all = channel.chats({ includeArchived: true });
    const archived = all.find((chat) => chat.id === oldest.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.turns).toBe(0);
    expect(archived?.title).toBe("x".repeat(60) + "…");
    expect(channel.storage().archived).toBeGreaterThanOrEqual(1);
    // The chat being written to is never the one archived.
    expect(live.some((chat) => chat.id === middle.id || chat.active)).toBe(true);
  });

  it("never archives the chat being written to", () => {
    process.env.BOXAIDE_CHAT_BUDGET_MB = "0.0001";
    const { channel } = make();
    const only = channel.activeChat();
    channel.post({ role: "user", text: "x".repeat(2_000) });
    expect(channel.chats().map((chat) => chat.id)).toContain(only.id);
    expect(channel.history()).toHaveLength(1);
  });
});

describe("across processes", () => {
  /**
   * `boxaide mcp` names a chat; the browser is attached to `boxaide serve`.
   * The two share a file and nothing else, and a rename writes no turn, so
   * without the fingerprint poll the rail keeps the old name until the user
   * types again.
   */
  it("tells an attached browser about a rename made by another process", async () => {
    const key = randomBytes(32);
    const path = join(tmpdir(), `boxaide-rename-${randomBytes(6).toString("hex")}.db`);
    const serveStore = new Store(key, path);
    const mcpStore = new Store(key, path);
    const serve = new AgentChannel(serveStore);
    const mcp = new AgentChannel(mcpStore);
    try {
      const chat = serve.post({ role: "user", text: "chase the March invoices" }).chatId;
      let frames = 0;
      // The SSE route subscribes to both; turns are what starts the poll.
      serve.subscribe(() => {});
      serve.subscribeChats(() => {
        frames += 1;
      });

      expect(mcp.nameChat(chat, "March invoice chase")).toBe(true);
      const deadline = Date.now() + 5_000;
      while (frames === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(frames).toBeGreaterThan(0);
      expect(serve.chats()[0].title).toBe("March invoice chase");
    } finally {
      serve.close();
      mcp.close();
      serveStore.close();
      mcpStore.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
      }
    }
  });
});

describe("migration", () => {
  it("adopts turns written before chats existed into one conversation", () => {
    const key = randomBytes(32);
    const path = join(tmpdir(), `boxaide-chats-${randomBytes(6).toString("hex")}.db`);
    const before = new Store(key, path);
    // The pre-chats shape: turns with no chat and no chats table content.
    before.db.exec(`DELETE FROM agent_chats`);
    for (const text of ["older", "newer"]) {
      before.db
        .prepare(
          `INSERT INTO agent_turns (at, chat_id, role, text_enc, agent, delivered)
           VALUES (?, NULL, 'user', ?, NULL, 0)`,
        )
        .run(new Date().toISOString(), encryptSecret(key, text));
    }
    before.close();

    const after = new Store(key, path);
    try {
      const chats = after.listChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].title).toBe("Conversation");
      expect(chats[0].active).toBe(true);
      expect(after.listTurns({ chatId: chats[0].id }).map((t) => t.text)).toEqual([
        "older",
        "newer",
      ]);
    } finally {
      after.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
      }
    }
  });
});

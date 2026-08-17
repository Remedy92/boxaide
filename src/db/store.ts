import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";
import type { AccountCredentials, MailAuth } from "../provider/types.js";

export type StoredAccount = {
  id: string;
  alias: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: number;
  username: string;
  /** Encrypted password (password auth) or access token (xoauth2). */
  passwordEnc: string;
  /** `password` (default) or `xoauth2`. */
  authKind: string;
  createdAt: string;
};

/**
 * One turn of the agent conversation.
 *
 * `activity` is the agent narrating what it is doing ("reading 12 messages in
 * Inbox") as distinct from answering. The UI renders it as a quiet line rather
 * than a message, which is why it is a role and not a flag on `agent`.
 */
export type StoredTurn = {
  seq: number;
  at: string;
  /** The chat this turn belongs to. */
  chatId: string;
  role: "user" | "agent" | "activity";
  text: string;
  /** MCP client name, when the caller identified itself. */
  agent: string | null;
  /**
   * User turns only: an agent is holding this one, or held it until it was
   * answered, or held it until it was dead-lettered. A live hold is a lease —
   * see claimNextUserTurn / unclaimUserTurn — not a permanent take. Two agents
   * still cannot hold the same row at once; a holder that vanishes gives it
   * back, up to a delivery cap, after which it stays delivered and the UI
   * treats it as dropped.
   */
  delivered: boolean;
  /**
   * User seq this turn answers. Null on user rows, on agent/activity posted
   * with no open work, and on rows written before the column existed.
   */
  replyTo: number | null;
  /**
   * How many times this user turn has been leased. 0 until the first claim.
   * Unused on agent/activity rows.
   */
  deliveryCount: number;
};

/**
 * One conversation.
 *
 * The title is encrypted for the same reason the turns are: it is derived from
 * the user's first message, and that message is as likely to name a customer as
 * anything else in this file.
 *
 * `trimmed` is sticky. Once a chat has lost turns to its own limit, the pane
 * says so for the rest of the chat's life — the alternative is a conversation
 * that quietly starts in the middle.
 */
export type StoredChat = {
  id: string;
  title: string;
  createdAt: string;
  /** Last turn written. What the list sorts on. */
  updatedAt: string;
  /** Set when the messages were dropped and only this record was kept. */
  archivedAt: string | null;
  trimmed: boolean;
  /** The one chat new turns are written to. Exactly one row has this. */
  active: boolean;
  turns: number;
  /** Bytes of encrypted turn text. What the budget counts. */
  bytes: number;
  /** Who the current title came from. See TitleSource. */
  titleSource: TitleSource;
};

/**
 * Where a chat's title came from, and therefore who may replace it.
 *
 * The three are ranked, and a title may only be replaced by one that ranks
 * above it: "auto" < "agent" < "user". A guess made from the first line the
 * user typed gives way to a name the agent wrote after reading the exchange;
 * neither overwrites a name the user typed themselves.
 */
export type TitleSource = "auto" | "agent" | "user";

const TITLE_RANK: Record<TitleSource, number> = { auto: 0, agent: 1, user: 2 };

/** Reads the column back. Anything unrecognised is treated as the user's own. */
function toTitleSource(raw: string | null): TitleSource {
  return raw === "auto" || raw === "agent" ? raw : "user";
}

/** What unclaimUserTurn did. The channel decides what the UI should say. */
export type UnclaimResult = "released" | "dead_lettered" | "acked" | "missing";

/**
 * Times a user turn may be leased without an answer. The next expiry after
 * this dead-letters it. One is what used to drop the message on the first
 * hiccup; this is "a few tries", then the same warning as before.
 */
export const MAX_DELIVERIES = 3;

type TurnRow = {
  seq: number;
  at: string;
  chatId: string;
  role: StoredTurn["role"];
  textEnc: string;
  agent: string | null;
  delivered: number;
  replyTo: number | null;
  deliveryCount: number;
};

type ChatRow = {
  id: string;
  titleEnc: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trimmed: number;
  active: number;
  turns: number;
  bytes: number;
  titleSource: string | null;
};

/** Title a chat carries until its first message renames it. */
const UNTITLED = "New chat";

/** What pre-chat history was called before chats had names of their own. */
const MIGRATED = "Conversation";

export class Store {
  static readonly MAX_DELIVERIES = MAX_DELIVERIES;

  readonly db: Database.Database;

  constructor(
    readonly masterKey: Buffer,
    dbPath: string | ":memory:",
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  static open(dataDir: string, masterKey: Buffer): Store {
    const boxaide = join(dataDir, "boxaide.db");
    const sley = join(dataDir, "sley.db");
    const mailmux = join(dataDir, "mailmux.db");
    const dbPath = existsSync(boxaide)
      ? boxaide
      : existsSync(sley)
        ? sley
        : existsSync(mailmux)
          ? mailmux
          : boxaide;
    return new Store(masterKey, dbPath);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL,
        imap_secure INTEGER NOT NULL,
        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL,
        smtp_secure INTEGER NOT NULL,
        username TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        auth_kind TEXT NOT NULL DEFAULT 'password',
        created_at TEXT NOT NULL
      );
    `);
    // Only reached by databases created before auth_kind existed. Fresh ones
    // get the column from the CREATE above, so this is a no-op for them.
    const cols = this.db
      .prepare(`PRAGMA table_info(accounts)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "auth_kind")) {
      this.db.exec(
        `ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password'`,
      );
    }

    // The agent conversation. `text_enc` is encrypted with the same master key
    // the account passwords use, and for the same reason: an agent summarising
    // an inbox puts mail content in these rows, and mail content has never been
    // at rest in plaintext anywhere else in this product.
    //
    // `delivered` belongs to user rows only. It is the hand-off cursor: a
    // message typed while no agent was listening is still waiting when one
    // arrives, and it survives a restart because it is a column and not a
    // variable in a process that just exited. The hold is a lease: the
    // claiming process gives it back if the holder vanishes, and
    // `delivery_count` is how many times that has been tried.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        role TEXT NOT NULL,
        text_enc TEXT NOT NULL,
        agent TEXT,
        delivered INTEGER NOT NULL DEFAULT 0,
        reply_to INTEGER,
        delivery_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Only reached by databases created before these columns existed. Fresh
    // ones get them from the CREATE above, so this is a no-op for them.
    const turnCols = this.db
      .prepare(`PRAGMA table_info(agent_turns)`)
      .all() as Array<{ name: string }>;
    if (!turnCols.some((c) => c.name === "reply_to")) {
      this.db.exec(`ALTER TABLE agent_turns ADD COLUMN reply_to INTEGER`);
    }
    if (!turnCols.some((c) => c.name === "delivery_count")) {
      this.db.exec(
        `ALTER TABLE agent_turns ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 0`,
      );
    }

    // Chats. `seq` stays a single global sequence across all of them — it is
    // the SSE resume cursor and the lease key, and per-chat numbering would
    // make both ambiguous. A chat is a scope over that sequence, not its own.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_chats (
        id TEXT PRIMARY KEY,
        title_enc TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trimmed INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        title_source TEXT NOT NULL DEFAULT 'auto'
      );
    `);
    // Chats that predate title_source. A name already on screen is left alone —
    // the reader has been looking at it — so those settle as the user's own.
    // The two placeholder names are the exception: nobody chose them, and they
    // are the whole reason an agent gets to name a chat at all.
    const chatCols = this.db
      .prepare(`PRAGMA table_info(agent_chats)`)
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "title_source")) {
      this.db.exec(
        `ALTER TABLE agent_chats ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user'`,
      );
      for (const row of this.db
        .prepare(`SELECT id, title_enc as titleEnc FROM agent_chats`)
        .all() as Array<{ id: string; titleEnc: string }>) {
        const title = decryptSecret(this.masterKey, row.titleEnc);
        if (title !== UNTITLED && title !== MIGRATED) continue;
        this.db
          .prepare(`UPDATE agent_chats SET title_source = 'auto' WHERE id = ?`)
          .run(row.id);
      }
    }
    if (!turnCols.some((c) => c.name === "chat_id")) {
      this.db.exec(`ALTER TABLE agent_turns ADD COLUMN chat_id TEXT`);
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS agent_turns_chat ON agent_turns (chat_id, seq)`,
    );
    // Everything written before chats existed was one conversation, so that is
    // what it becomes. Named for what it was rather than given a made-up title:
    // there is no first message to derive one from that is not also the middle
    // of somebody's history.
    const loose = this.db
      .prepare(`SELECT COUNT(*) as n FROM agent_turns WHERE chat_id IS NULL`)
      .get() as { n: number };
    if (loose.n > 0) {
      const id = this.newChatId();
      const at = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO agent_chats (id, title_enc, created_at, updated_at, active,
                                    title_source)
           VALUES (?, ?, ?, ?, 1, 'auto')`,
        )
        .run(id, encryptSecret(this.masterKey, MIGRATED), at, at);
      this.db
        .prepare(`UPDATE agent_turns SET chat_id = ? WHERE chat_id IS NULL`)
        .run(id);
    }
  }

  /* ---- chats -------------------------------------------------------------
     A chat owns its turns and nothing else. Which one is active, when one is
     archived, and what the budget is are all decisions AgentChannel makes.
     --------------------------------------------------------------------- */

  private newChatId(): string {
    return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  listChats(options: { includeArchived?: boolean } = {}): StoredChat[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title_enc as titleEnc, c.created_at as createdAt,
                c.updated_at as updatedAt, c.archived_at as archivedAt,
                c.trimmed, c.active, c.title_source as titleSource,
                COUNT(t.seq) as turns,
                COALESCE(SUM(LENGTH(t.text_enc)), 0) as bytes
         FROM agent_chats c
         LEFT JOIN agent_turns t ON t.chat_id = c.id
         ${options.includeArchived ? "" : "WHERE c.archived_at IS NULL"}
         GROUP BY c.id
         ORDER BY c.updated_at DESC`,
      )
      .all() as ChatRow[];
    return rows.map((row) => this.toChat(row));
  }

  getChat(id: string): StoredChat | null {
    const row = this.db
      .prepare(
        `SELECT c.id, c.title_enc as titleEnc, c.created_at as createdAt,
                c.updated_at as updatedAt, c.archived_at as archivedAt,
                c.trimmed, c.active, c.title_source as titleSource,
                COUNT(t.seq) as turns,
                COALESCE(SUM(LENGTH(t.text_enc)), 0) as bytes
         FROM agent_chats c
         LEFT JOIN agent_turns t ON t.chat_id = c.id
         WHERE c.id = ?
         GROUP BY c.id`,
      )
      .get(id) as ChatRow | undefined;
    return row ? this.toChat(row) : null;
  }

  createChat(title = UNTITLED): StoredChat {
    const id = this.newChatId();
    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE agent_chats SET active = 0`).run();
      // The source is written rather than defaulted: the column's default is
      // 'user' on databases that gained it by ALTER, and a new chat is not
      // named by anybody.
      this.db
        .prepare(
          `INSERT INTO agent_chats (id, title_enc, created_at, updated_at, active,
                                    title_source)
           VALUES (?, ?, ?, ?, 1, 'auto')`,
        )
        .run(id, encryptSecret(this.masterKey, title), at, at);
    })();
    return this.getChat(id) as StoredChat;
  }

  /**
   * The chat new turns go to, creating one when there is none.
   *
   * Both `boxaide serve` and `boxaide mcp` call this, which is why the answer
   * is a column and not a field on the channel: the two are separate processes
   * and must agree on where a message lands.
   */
  ensureActiveChat(): StoredChat {
    const row = this.db
      .prepare(
        `SELECT id FROM agent_chats WHERE active = 1 AND archived_at IS NULL LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (row) return this.getChat(row.id) as StoredChat;
    // An archived or deleted active chat leaves none. Fall back to the most
    // recent live one before making a new one, so Archive does not strand the
    // user in an empty conversation with their history one click away.
    const recent = this.db
      .prepare(
        `SELECT id FROM agent_chats WHERE archived_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (recent) {
      this.selectChat(recent.id);
      return this.getChat(recent.id) as StoredChat;
    }
    return this.createChat();
  }

  selectChat(id: string): boolean {
    const exists = this.db
      .prepare(`SELECT 1 as hit FROM agent_chats WHERE id = ? AND archived_at IS NULL`)
      .get(id) as { hit: number } | undefined;
    if (!exists) return false;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE agent_chats SET active = 0`).run();
      this.db.prepare(`UPDATE agent_chats SET active = 1 WHERE id = ?`).run(id);
    })();
    return true;
  }

  /**
   * Names a chat, if the caller outranks whoever named it last.
   *
   * False means the title stood: either the chat is gone, or a better-ranked
   * source already named it. Callers treat that as normal — the agent offering
   * a name for a chat the user has already named is the expected case, not an
   * error.
   */
  renameChat(id: string, title: string, source: TitleSource = "user"): boolean {
    const current = this.titleSource(id);
    if (current === null) return false;
    if (TITLE_RANK[source] < TITLE_RANK[current]) return false;
    // Equal rank is a re-name by the same kind of caller. The user may do that
    // as often as they like, and the derived title is re-derived under a guard
    // of its own; the agent gets one go, so the list stops moving once it has
    // a name written from the conversation.
    if (source === "agent" && current === "agent") return false;
    const res = this.db
      .prepare(`UPDATE agent_chats SET title_enc = ?, title_source = ? WHERE id = ?`)
      .run(encryptSecret(this.masterKey, title), source, id);
    return res.changes > 0;
  }

  /** Who named this chat, or null when there is no such chat. */
  titleSource(id: string): TitleSource | null {
    const row = this.db
      .prepare(`SELECT title_source as titleSource FROM agent_chats WHERE id = ?`)
      .get(id) as { titleSource: string | null } | undefined;
    return row ? toTitleSource(row.titleSource) : null;
  }

  /**
   * True while the chat carries a placeholder name rather than one of its own.
   *
   * "Conversation" counts. It is the name pre-chat history was migrated under,
   * and it says as little about that history as "New chat" does.
   */
  isUntitled(id: string): boolean {
    const chat = this.getChat(id);
    if (!chat) return false;
    return chat.title === UNTITLED || chat.title === MIGRATED;
  }

  /**
   * Drops a chat's messages and keeps the record: title, dates, and the fact
   * that it existed. This is the step the budget takes on its own, so it is
   * deliberately not deletion — the user's own list does not lose rows to a
   * housekeeping rule they did not run.
   */
  archiveChat(id: string): boolean {
    return this.db.transaction((): boolean => {
      const res = this.db
        .prepare(
          `UPDATE agent_chats SET archived_at = ?, active = 0
           WHERE id = ? AND archived_at IS NULL`,
        )
        .run(new Date().toISOString(), id);
      if (res.changes === 0) return false;
      this.db.prepare(`DELETE FROM agent_turns WHERE chat_id = ?`).run(id);
      return true;
    })();
  }

  deleteChat(id: string): boolean {
    return this.db.transaction((): boolean => {
      this.db.prepare(`DELETE FROM agent_turns WHERE chat_id = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM agent_chats WHERE id = ?`).run(id);
      return res.changes > 0;
    })();
  }

  /** Bytes of encrypted turn text across every chat. What the budget counts. */
  chatBytes(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(LENGTH(text_enc)), 0) as bytes FROM agent_turns`)
      .get() as { bytes: number };
    return row.bytes;
  }

  /**
   * Live chats holding messages, oldest first. The order the budget archives in.
   * The active chat is never returned: the budget must not empty the
   * conversation somebody is in the middle of.
   */
  archiveCandidates(): Array<{ id: string; bytes: number }> {
    return this.db
      .prepare(
        `SELECT c.id, COALESCE(SUM(LENGTH(t.text_enc)), 0) as bytes
         FROM agent_chats c
         JOIN agent_turns t ON t.chat_id = c.id
         WHERE c.archived_at IS NULL AND c.active = 0
         GROUP BY c.id
         ORDER BY c.updated_at ASC`,
      )
      .all() as Array<{ id: string; bytes: number }>;
  }

  private toChat(row: ChatRow): StoredChat {
    return {
      id: row.id,
      title: decryptSecret(this.masterKey, row.titleEnc),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      trimmed: row.trimmed === 1,
      active: row.active === 1,
      turns: row.turns,
      bytes: row.bytes,
      titleSource: toTitleSource(row.titleSource),
    };
  }

  /* ---- agent conversation ------------------------------------------------
     Rows in, rows out. Every decision about who gets a message and when lives
     in AgentChannel; this class only reads and writes.
     --------------------------------------------------------------------- */

  appendTurn(input: {
    at: string;
    chatId: string;
    role: StoredTurn["role"];
    text: string;
    agent: string | null;
    replyTo?: number | null;
  }): StoredTurn {
    const replyTo = input.replyTo ?? null;
    const res = this.db
      .prepare(
        `INSERT INTO agent_turns (at, chat_id, role, text_enc, agent, delivered, reply_to)
         VALUES (@at, @chatId, @role, @textEnc, @agent, 0, @replyTo)`,
      )
      .run({
        at: input.at,
        chatId: input.chatId,
        role: input.role,
        textEnc: encryptSecret(this.masterKey, input.text),
        agent: input.agent,
        replyTo,
      });
    // The list sorts on this, so it tracks the last message rather than the
    // last time somebody clicked the chat.
    this.db
      .prepare(`UPDATE agent_chats SET updated_at = ? WHERE id = ?`)
      .run(input.at, input.chatId);
    return {
      seq: Number(res.lastInsertRowid),
      at: input.at,
      chatId: input.chatId,
      role: input.role,
      text: input.text,
      agent: input.agent,
      delivered: false,
      replyTo,
      deliveryCount: 0,
    };
  }

  listTurns(
    options: { afterSeq?: number; limit?: number; chatId?: string } = {},
  ): StoredTurn[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    // Newest `limit` rows, then flipped: asking for "the last 200" and getting
    // the FIRST 200 is the classic version of this bug.
    const rows = this.db
      .prepare(
        `SELECT seq, at, chat_id as chatId, role, text_enc as textEnc, agent, delivered,
                reply_to as replyTo, COALESCE(delivery_count, 0) as deliveryCount
         FROM agent_turns
         WHERE seq > ? AND (? IS NULL OR chat_id = ?)
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(
        options.afterSeq ?? 0,
        options.chatId ?? null,
        options.chatId ?? null,
        limit,
      ) as TurnRow[];
    return rows.reverse().map((row) => this.toTurn(row));
  }

  /**
   * User seqs that were leased until the delivery cap and never answered.
   * The UI warning is these, not every row that is merely in flight.
   */
  listDroppedUserSeqs(): number[] {
    const rows = this.db
      .prepare(
        `SELECT seq FROM agent_turns
         WHERE role = 'user' AND delivered = 1
           AND COALESCE(delivery_count, 0) >= ?
           AND seq NOT IN (
             SELECT reply_to FROM agent_turns
             WHERE role = 'agent' AND reply_to IS NOT NULL
           )
         ORDER BY seq ASC`,
      )
      .all(Store.MAX_DELIVERIES) as Array<{ seq: number }>;
    return rows.map((row) => row.seq);
  }

  /**
   * The oldest user turn no agent is holding, marked as held in the same
   * transaction. Returns null when there is nothing waiting.
   *
   * The claim has to be atomic. Two agents polling the same channel would
   * otherwise both read the same row and both answer it. It is a lease: the
   * holder is exclusive until they answer, vanish, or hit the delivery cap.
   */
  claimNextUserTurn(): StoredTurn | null {
    const claim = this.db.transaction((): StoredTurn | null => {
      const row = this.db
        .prepare(
          `SELECT seq, at, chat_id as chatId, role, text_enc as textEnc, agent,
                  reply_to as replyTo, COALESCE(delivery_count, 0) as deliveryCount
           FROM agent_turns
           WHERE role = 'user' AND delivered = 0
           ORDER BY seq ASC
           LIMIT 1`,
        )
        .get() as TurnRow | undefined;
      if (!row) return null;
      this.db
        .prepare(
          `UPDATE agent_turns
           SET delivered = 1, delivery_count = COALESCE(delivery_count, 0) + 1
           WHERE seq = ?`,
        )
        .run(row.seq);
      return this.toTurn({ ...row, delivered: 1, deliveryCount: row.deliveryCount + 1 });
    });
    return claim();
  }

  /**
   * Gives an unanswered lease back, or dead-letters it once it has been
   * offered MAX_DELIVERIES times. An answered row is left alone: that is the
   * ack, and re-queuing it would make a second agent answer a finished question.
   *
   * `revertAttempt` is for a claim the client never read (abort before the
   * tool result was written). That try does not count.
   */
  unclaimUserTurn(
    seq: number,
    options: { revertAttempt?: boolean } = {},
  ): UnclaimResult {
    return this.db.transaction((): UnclaimResult => {
      const row = this.db
        .prepare(
          `SELECT delivered, COALESCE(delivery_count, 0) as deliveryCount
           FROM agent_turns WHERE seq = ? AND role = 'user'`,
        )
        .get(seq) as { delivered: number; deliveryCount: number } | undefined;
      if (!row || row.delivered !== 1) return "missing";
      const answered = this.db
        .prepare(
          `SELECT 1 AS hit FROM agent_turns
           WHERE role = 'agent' AND reply_to = ? LIMIT 1`,
        )
        .get(seq) as { hit: number } | undefined;
      if (answered) return "acked";
      if (options.revertAttempt) {
        this.db
          .prepare(
            `UPDATE agent_turns
             SET delivered = 0,
                 delivery_count = MAX(COALESCE(delivery_count, 0) - 1, 0)
             WHERE seq = ?`,
          )
          .run(seq);
        return "released";
      }
      if (row.deliveryCount >= Store.MAX_DELIVERIES) return "dead_lettered";
      this.db
        .prepare(`UPDATE agent_turns SET delivered = 0 WHERE seq = ?`)
        .run(seq);
      return "released";
    })();
  }

  /**
   * Restarts drop in-memory work, so every unanswered lease in this file is
   * held by nobody. Give them back, except those already at the delivery cap.
   */
  releaseOrphanLeases(): number {
    const res = this.db
      .prepare(
        `UPDATE agent_turns SET delivered = 0
         WHERE role = 'user' AND delivered = 1
           AND COALESCE(delivery_count, 0) < ?
           AND seq NOT IN (
             SELECT reply_to FROM agent_turns
             WHERE role = 'agent' AND reply_to IS NOT NULL
           )`,
      )
      .run(Store.MAX_DELIVERIES);
    return res.changes;
  }

  /** Empties one chat and keeps it. The trash can in the pane header. */
  clearTurns(chatId: string): void {
    this.db.prepare(`DELETE FROM agent_turns WHERE chat_id = ?`).run(chatId);
    // A cleared chat is not a trimmed one: the user asked for this, and the
    // banner explaining an automatic loss would be a lie about their own click.
    this.db.prepare(`UPDATE agent_chats SET trimmed = 0 WHERE id = ?`).run(chatId);
  }

  /**
   * Drops everything but the newest `keep` turns of one chat. Returns true when
   * something went, which is what makes the chat say so from then on.
   */
  trimTurns(chatId: string, keep: number): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM agent_turns WHERE chat_id = @chatId AND seq <= (
           SELECT COALESCE(MIN(seq), 0) - 1 FROM (
             SELECT seq FROM agent_turns WHERE chat_id = @chatId
             ORDER BY seq DESC LIMIT @keep
           )
         )`,
      )
      .run({ chatId, keep: Math.max(keep, 1) });
    if (res.changes === 0) return false;
    this.db.prepare(`UPDATE agent_chats SET trimmed = 1 WHERE id = ?`).run(chatId);
    return true;
  }

  listAccounts(): Array<{
    id: string;
    alias: string;
    email: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, alias, email, created_at as createdAt FROM accounts ORDER BY created_at ASC`,
      )
      .all() as Array<{
      id: string;
      alias: string;
      email: string;
      createdAt: string;
    }>;
    return rows;
  }

  getAccount(idOrAlias: string): StoredAccount | null {
    const row = this.db
      .prepare(
        `SELECT id, alias, email,
          imap_host as imapHost, imap_port as imapPort, imap_secure as imapSecure,
          smtp_host as smtpHost, smtp_port as smtpPort, smtp_secure as smtpSecure,
          username, password_enc as passwordEnc,
          COALESCE(auth_kind, 'password') as authKind,
          created_at as createdAt
         FROM accounts WHERE id = ? OR alias = ?`,
      )
      .get(idOrAlias, idOrAlias) as StoredAccount | undefined;
    return row ?? null;
  }

  credentialsFor(account: StoredAccount): AccountCredentials {
    const secret = decryptSecret(this.masterKey, account.passwordEnc);
    const auth: MailAuth =
      account.authKind === "xoauth2"
        ? { kind: "xoauth2", user: account.username, accessToken: secret }
        : { kind: "password", user: account.username, pass: secret };
    return {
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: Boolean(account.imapSecure),
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: Boolean(account.smtpSecure),
      auth,
    };
  }

  upsertAccount(input: {
    id: string;
    alias: string;
    email: string;
    creds: AccountCredentials;
  }): void {
    const { auth } = input.creds;
    const secret = auth.kind === "password" ? auth.pass : auth.accessToken;
    const passwordEnc = encryptSecret(this.masterKey, secret);
    const authKind = auth.kind;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, alias, email, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, username, password_enc, auth_kind, created_at
        ) VALUES (
          @id, @alias, @email, @imapHost, @imapPort, @imapSecure,
          @smtpHost, @smtpPort, @smtpSecure, @username, @passwordEnc, @authKind, @createdAt
        )
        ON CONFLICT(id) DO UPDATE SET
          alias=excluded.alias,
          email=excluded.email,
          imap_host=excluded.imap_host,
          imap_port=excluded.imap_port,
          imap_secure=excluded.imap_secure,
          smtp_host=excluded.smtp_host,
          smtp_port=excluded.smtp_port,
          smtp_secure=excluded.smtp_secure,
          username=excluded.username,
          password_enc=excluded.password_enc,
          auth_kind=excluded.auth_kind
        `,
      )
      .run({
        id: input.id,
        alias: input.alias,
        email: input.email,
        imapHost: input.creds.imapHost,
        imapPort: input.creds.imapPort,
        imapSecure: input.creds.imapSecure ? 1 : 0,
        smtpHost: input.creds.smtpHost,
        smtpPort: input.creds.smtpPort,
        smtpSecure: input.creds.smtpSecure ? 1 : 0,
        username: auth.user,
        passwordEnc,
        authKind,
        createdAt,
      });
  }

  deleteAccount(idOrAlias: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM accounts WHERE id = ? OR alias = ?`)
      .run(idOrAlias, idOrAlias);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private toTurn(row: TurnRow): StoredTurn {
    return {
      seq: row.seq,
      at: row.at,
      chatId: row.chatId,
      role: row.role,
      text: decryptSecret(this.masterKey, row.textEnc),
      agent: row.agent,
      delivered: row.delivered === 1,
      replyTo: row.role === "user" || row.replyTo == null ? null : row.replyTo,
      deliveryCount: row.deliveryCount,
    };
  }
}

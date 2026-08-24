import Database from "better-sqlite3";
import { migrateLegacyDatabase } from "../legacy-names.js";
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
 * An action an agent asked for and a human has not answered yet.
 *
 * Sending mail and putting a meeting in somebody's calendar are the two things
 * an agent does that another person sees immediately, and the agent decided to
 * do them after reading text strangers wrote. So a launched agent never
 * performs one: it asks, the row lands here, and Boxaide carries it out only
 * once the user says yes. That is why `args` is stored rather than a summary —
 * this row IS the action, and nothing re-derives it later from a description.
 *
 * `args_enc` holds mail content and attendee addresses, so it is encrypted
 * with the same master key the account passwords use.
 */
export type StoredApproval = {
  id: string;
  /** The tool the agent asked for: message_send, meeting_create, meeting_cancel. */
  tool: string;
  /** Exactly the arguments the agent passed, replayed verbatim on approval. */
  args: Record<string, unknown>;
  /** Which launch asked. `chat`, `driven` or `run` — see src/mcp/scope.ts. */
  profile: string;
  /** MCP client name, when the caller gave one. */
  agent: string | null;
  /** The conversation it was asked in. Null for a scheduled run. */
  chatId: string | null;
  askedAt: string;
  /**
   * What the request is ABOUT, in the user's terms, captured when it was made.
   *
   * Not part of the call and never replayed: `args` stays exactly what the
   * agent passed. This is the one thing a card cannot rebuild from the
   * arguments — `message_move` names a message by an opaque accountId:folder:uid
   * id, and a person cannot approve moving mail to Trash without knowing whose
   * mail it is. Captured at ask time on purpose: by the time the card is read
   * the message may have moved, and the subject the user is being asked about
   * is the one that was true when the agent asked.
   */
  context: { subject?: string; from?: string; folder?: string } | null;
  /** Null while it is still waiting. */
  decidedAt: string | null;
  state: "pending" | "approved" | "denied" | "failed";
  /** Set once carried out or refused: what happened, in the user's words. */
  outcome: string | null;
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
 * Archived and trimmed are two different things, and a chat can be both.
 * Archiving is the user putting a conversation away: every turn stays, and
 * Unarchive brings it back exactly as it was. Trimming is the store enforcing a
 * limit: the record stays and the messages go. `trimmedAt` is sticky, so a chat
 * that lost turns says so for the rest of its life. The alternative is a
 * conversation that quietly starts in the middle.
 */
export type StoredChat = {
  id: string;
  title: string;
  createdAt: string;
  /** Last turn written. What the list sorts on. */
  updatedAt: string;
  /** Set while the user has this chat put away. Its turns are untouched. */
  archivedAt: string | null;
  /** When a limit last dropped turns from this chat. Null while none has. */
  trimmedAt: string | null;
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
 * A chat's CLI session, as the driver about to prompt sees it.
 *
 * `id` is null when there is no session for this agent yet. `epoch` is the
 * chat's session generation, and it comes back either way: the driver hands it
 * to `saveChatSession`, which refuses a write from a turn that started before
 * somebody dropped the session it was using.
 */
export type ChatSession = { id: string | null; epoch: number };

/**
 * Times a user turn may be leased without an answer. The next expiry after
 * this dead-letters it. One is what used to drop the message on the first
 * hiccup; this is "a few tries", then the same warning as before.
 */
export const MAX_DELIVERIES = 3;

/**
 * How long a queued user message stays worth answering.
 *
 * A message waits on the queue until an agent asks for one, and nothing used to
 * put a floor under that wait. Start an agent the next morning and it was
 * handed last night's question first, ahead of the one the user had just typed
 * — and because a launch requeues dropped messages, the same backlog came back
 * every time. The window is what makes a quiet evening cost one evening.
 *
 * Twelve hours, so it never cuts across a working session. An agent can hold a
 * single message for a long tool run, and a user can leave a question queued
 * over lunch; both stay inside this. What falls outside it is yesterday.
 */
export const USER_TURN_TTL_MS = 12 * 60 * 60 * 1000;

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

type ApprovalRow = {
  id: string;
  tool: string;
  argsEnc: string;
  contextEnc: string | null;
  profile: string;
  agent: string | null;
  chatId: string | null;
  askedAt: string;
  decidedAt: string | null;
  state: StoredApproval["state"];
  outcome: string | null;
};

export type AgentArchiveRow = {
  id: number;
  accountId: string;
  /** The message's id in the Archive mailbox, or null without UIDPLUS. */
  messageId: string | null;
  fromFolder: string;
  toFolder: string;
  agent: string | null;
  chatId: string | null;
  at: string;
};

type ChatRow = {
  id: string;
  titleEnc: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trimmedAt: string | null;
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

  /**
   * The install's database, opened at `boxaide.db`.
   *
   * A database still named `sley.db` or `mailmux.db` is renamed onto the
   * current name first, WAL sidecars and all (src/legacy-names.ts), rather
   * than opened where it lies for ever. A rename that cannot be made safely
   * answers the legacy path, so the install opens the same file it always did.
   */
  static open(dataDir: string, masterKey: Buffer): Store {
    return new Store(masterKey, migrateLegacyDatabase(dataDir));
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

    // Actions an agent asked a human to authorise. On disk, not in memory,
    // because the case this exists for is a scheduled run at three in the
    // morning: the agent that queued the action is long gone by the time
    // anybody reads it, and a restart in between must not lose the request.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_approvals (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        args_enc TEXT NOT NULL,
        profile TEXT NOT NULL,
        agent TEXT,
        chat_id TEXT,
        asked_at TEXT NOT NULL,
        decided_at TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT
      );
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS agent_approvals_state ON agent_approvals (state, asked_at)`,
    );
    // Added after the first release: what the request is about, for the card.
    const approvalCols = this.db
      .prepare(`PRAGMA table_info(agent_approvals)`)
      .all() as Array<{ name: string }>;
    if (!approvalCols.some((c) => c.name === "context_enc")) {
      this.db.exec(`ALTER TABLE agent_approvals ADD COLUMN context_enc TEXT`);
    }

    // Every message a launched agent archived, so the user can put a whole
    // sweep back.
    //
    // Archiving is the one mail write an agent performs unasked, on the
    // grounds that it is reversible. That is only true if reversing it is
    // something a person can actually do: an agent told to tidy an inbox can
    // file hundreds of messages, and undoing that one toast at a time is not
    // an undo. The row keeps where the message came from and the id it now
    // has, which is everything a move back needs.
    //
    // `message_id` is nullable on purpose. A server without UIDPLUS does not
    // name the new uid, so the message is archived with nothing to address it
    // by; the row is still written, because the count the user is shown must
    // be the truth about what happened, not about what can be reversed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        message_id TEXT,
        from_folder TEXT NOT NULL,
        to_folder TEXT NOT NULL,
        agent TEXT,
        chat_id TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_archives_at ON agent_archives (at);
    `);

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
        trimmed_at TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        title_source TEXT NOT NULL DEFAULT 'auto',
        session_agent TEXT,
        session_id TEXT,
        session_epoch INTEGER NOT NULL DEFAULT 0
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
      this.db.transaction(() => {
        this.db.exec(
          `ALTER TABLE agent_chats ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user'`,
        );
        for (const row of this.db
          .prepare(`SELECT id, title_enc as titleEnc FROM agent_chats`)
          .all() as Array<{ id: string; titleEnc: string }>) {
          // A title this key cannot read is not a title anybody is reading,
          // and a wrong key or one corrupt row must not stop the app from
          // starting: mail does not depend on any of this. The row keeps the
          // settled default and the migration carries on.
          let title: string;
          try {
            title = decryptSecret(this.masterKey, row.titleEnc);
          } catch {
            continue;
          }
          if (title !== UNTITLED && title !== MIGRATED) continue;
          this.db
            .prepare(`UPDATE agent_chats SET title_source = 'auto' WHERE id = ?`)
            .run(row.id);
        }
      })();
    }
    // The CLI session each chat resumes. Two columns rather than one, because a
    // session id only means anything to the CLI that issued it: an id Claude
    // Code wrote is not one OpenCode can resume, and handing it over would fail
    // every turn of that chat until somebody cleared it.
    //
    // Plain text, unlike the title beside it. A session id is the CLI's own
    // identifier for a transcript it already holds on disk; it carries no user
    // content, and encrypting it would only make the column unreadable to the
    // process that has to hand it back verbatim.
    //
    // `session_epoch` is what makes a save safe to land late. A turn reads the
    // epoch when it starts and hands it back when it saves; anything that drops
    // the session in between bumps it, and the save is refused. Without it a
    // chat cleared while the agent was still answering would have its old
    // session written straight back, and the next message would resume the
    // history the user had just emptied.
    if (!chatCols.some((c) => c.name === "session_id")) {
      this.db.exec(`ALTER TABLE agent_chats ADD COLUMN session_agent TEXT`);
      this.db.exec(`ALTER TABLE agent_chats ADD COLUMN session_id TEXT`);
    }
    if (!chatCols.some((c) => c.name === "session_epoch")) {
      this.db.exec(
        `ALTER TABLE agent_chats ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`,
      );
    }
    // Splitting archiving from trimming. `trimmed` was a sticky flag meaning
    // "a limit dropped turns from this chat", and archiving used to do exactly
    // that: it stamped archived_at and then deleted every turn. Those are two
    // different promises to the user, so they are now two columns with two
    // meanings: archived_at is the user putting a conversation away with its
    // messages intact, and trimmed_at is when a limit took the messages.
    //
    // Which makes every row archived by the old build a trimmed row: its turns
    // are already gone, and archived_at is exactly when they went. Those rows
    // stay archived as well, on purpose. The user has been reading them under
    // Archived, they hold nothing to come back to, and putting empty
    // conversations back in the rail would be a worse surprise than leaving
    // them where they were left. Unarchive is one click away for anyone who
    // wants the row back in the list.
    //
    // Rows the per-chat cap trimmed are dated by updated_at. It is not the
    // moment the turns went, but it is the closest date the row holds, and the
    // flag it replaces carried no date at all.
    //
    // The old `trimmed` column is left on the table rather than dropped.
    // Nothing reads it after this, and a failed DROP on a database this
    // process must open is a mail client that will not start over a column
    // that costs one byte a row.
    if (!chatCols.some((c) => c.name === "trimmed_at")) {
      this.db.transaction(() => {
        this.db.exec(`ALTER TABLE agent_chats ADD COLUMN trimmed_at TEXT`);
        this.db.exec(
          `UPDATE agent_chats SET trimmed_at = archived_at WHERE archived_at IS NOT NULL`,
        );
        this.db.exec(
          `UPDATE agent_chats SET trimmed_at = updated_at
           WHERE trimmed = 1 AND trimmed_at IS NULL`,
        );
      })();
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
                c.trimmed_at as trimmedAt, c.active, c.title_source as titleSource,
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
                c.trimmed_at as trimmedAt, c.active, c.title_source as titleSource,
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

  /**
   * Opens a chat, archived or not, and brings it back out of the archive.
   *
   * Selecting a chat is the user coming back to it, and a conversation
   * somebody is reading and typing into is not one they have put away. Doing
   * it here rather than asking callers to unarchive first is what makes it
   * impossible to end up with an archived chat as the active one, which every
   * write path assumes cannot happen.
   */
  selectChat(id: string): boolean {
    const exists = this.db
      .prepare(`SELECT 1 as hit FROM agent_chats WHERE id = ?`)
      .get(id) as { hit: number } | undefined;
    if (!exists) return false;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE agent_chats SET active = 0`).run();
      this.db
        .prepare(`UPDATE agent_chats SET active = 1, archived_at = NULL WHERE id = ?`)
        .run(id);
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

  /**
   * A value that changes whenever the chat list would look different.
   *
   * The turn stream crosses processes on its own — every turn is a row with a
   * sequence — but a rename writes no row, so `boxaide mcp` naming a chat is
   * invisible to the browser attached to `boxaide serve`. This is what the
   * poll compares to notice it. `title_enc` earns its place here: encryption
   * uses a fresh nonce every time, so re-encrypting the same title still
   * changes the string, and a rename cannot slip past unnoticed. `trimmed_at`
   * is here for the same reason: a budget sweep in one process deletes turns
   * without writing one, so nothing else in this string would move.
   */
  chatsFingerprint(): string {
    const rows = this.db
      .prepare(
        `SELECT id, title_enc as titleEnc, archived_at as archivedAt,
                trimmed_at as trimmedAt, active
         FROM agent_chats ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      titleEnc: string;
      archivedAt: string | null;
      trimmedAt: string | null;
      active: number;
    }>;
    return rows
      .map(
        (r) =>
          `${r.id}:${r.titleEnc.slice(0, 16)}:${r.archivedAt ?? ""}:${r.trimmedAt ?? ""}:${r.active}`,
      )
      .join("|");
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
   * Puts a chat away, with every turn it holds.
   *
   * Nothing is deleted here, and that is the whole point: the user asked to
   * tidy their list, not to lose a conversation. The row leaves the live list
   * and stops being the active one; `unarchiveChat` puts it back, messages and
   * all. Deleting is a separate control, and it is the only one that destroys.
   */
  archiveChat(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE agent_chats SET archived_at = ?, active = 0
         WHERE id = ? AND archived_at IS NULL`,
      )
      .run(new Date().toISOString(), id);
    return res.changes > 0;
  }

  /**
   * Puts an archived chat back in the list, exactly as it was.
   *
   * The chat is not selected as part of this: the user may be tidying the
   * archive rather than reading it, and moving the pane they are looking at
   * would be an answer to a question nobody asked. Opening the chat is what
   * selects it, and that unarchives it too. See selectChat.
   */
  unarchiveChat(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE agent_chats SET archived_at = NULL
         WHERE id = ? AND archived_at IS NOT NULL`,
      )
      .run(id);
    return res.changes > 0;
  }

  /**
   * Drops a chat's messages and keeps the record: title, dates, and the fact
   * that it existed. This is the step the budget takes on its own, so it is
   * deliberately not deletion — the user's own list does not lose rows to a
   * housekeeping rule they did not run.
   *
   * The CLI session goes with the messages, for the same reason `clearTurns`
   * drops it: a model resuming a transcript this chat no longer holds would
   * answer the next message from history the store has already thrown away.
   * The epoch moves with it, so a turn still running in this chat cannot save
   * the session it started with.
   */
  trimChat(id: string): boolean {
    return this.db.transaction((): boolean => {
      const res = this.db
        .prepare(
          `UPDATE agent_chats
           SET trimmed_at = ?, session_agent = NULL, session_id = NULL,
               session_epoch = session_epoch + 1
           WHERE id = ?`,
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

  /**
   * Whether a user turn is still there to be answered.
   *
   * False once the chat was emptied or deleted under the agent that was working
   * on it. A turn takes minutes, and the user is free to clear the conversation
   * inside that window — the question the answer belongs to is simply gone.
   */
  answerable(seq: number, chatId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 as hit FROM agent_turns
         WHERE seq = ? AND chat_id = ? AND role = 'user'`,
      )
      .get(seq, chatId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * The CLI session this chat resumes, for the agent that is asking, and the
   * epoch that answer is good for.
   *
   * A null id for another agent's session: the id would be meaningless to this
   * CLI, and a chat switched from one agent to another has to start a session
   * rather than fail every turn on one it cannot find. The epoch is returned
   * either way — the caller needs it to save whatever session it does end up
   * using, and it belongs to the chat rather than to any one agent's id.
   */
  chatSession(chatId: string, agent: string): ChatSession {
    const row = this.db
      .prepare(
        `SELECT session_agent as sessionAgent, session_id as sessionId,
                session_epoch as epoch
         FROM agent_chats WHERE id = ?`,
      )
      .get(chatId) as
      | { sessionAgent: string | null; sessionId: string | null; epoch: number }
      | undefined;
    if (!row) return { id: null, epoch: 0 };
    return {
      id: row.sessionAgent === agent ? (row.sessionId ?? null) : null,
      epoch: row.epoch,
    };
  }

  /**
   * Remembers which session a chat is living in. On disk, not in the driver:
   * the agent workdir is stable, so the CLI's transcript outlives the process
   * that made it, and a restarted agent that forgot the id would answer the
   * next message as a stranger.
   *
   * `epoch` is the one read when the turn started. A turn can be minutes long,
   * and anything that dropped this chat's session while it ran — the user
   * clearing the chat, a refused resume — moved the epoch on. Saving then would
   * undo that, so the write is refused instead. Silently: the session is gone
   * because somebody meant it to be gone, and the next turn starts a fresh one.
   */
  saveChatSession(
    chatId: string,
    agent: string,
    sessionId: string,
    epoch: number,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_chats SET session_agent = ?, session_id = ?
         WHERE id = ? AND session_epoch = ?`,
      )
      .run(agent, sessionId, chatId, epoch);
  }

  clearChatSession(chatId: string): void {
    this.db
      .prepare(
        `UPDATE agent_chats
         SET session_agent = NULL, session_id = NULL,
             session_epoch = session_epoch + 1
         WHERE id = ?`,
      )
      .run(chatId);
  }

  /** Bytes of encrypted turn text across every chat. What the budget counts. */
  chatBytes(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(LENGTH(text_enc)), 0) as bytes FROM agent_turns`)
      .get() as { bytes: number };
    return row.bytes;
  }

  /**
   * Chats holding messages the budget may take, in the order it should take
   * them. Archived first, then oldest first.
   *
   * Archived comes first because the user has already said they are done with
   * those conversations, and the budget taking one of them costs less than it
   * taking a chat still in the list. Within each group the oldest goes first,
   * which is the same rule as before.
   *
   * The active chat is never returned: the budget must not empty the
   * conversation somebody is in the middle of.
   */
  trimCandidates(): Array<{ id: string; bytes: number }> {
    return this.db
      .prepare(
        `SELECT c.id, COALESCE(SUM(LENGTH(t.text_enc)), 0) as bytes
         FROM agent_chats c
         JOIN agent_turns t ON t.chat_id = c.id
         WHERE c.active = 0
         GROUP BY c.id
         ORDER BY (c.archived_at IS NULL) ASC, c.updated_at ASC`,
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
      trimmedAt: row.trimmedAt,
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
   * Puts every dropped user message back on the queue, and returns how many.
   *
   * Dropping used to be final. It was written for the message an agent cannot
   * answer — the one that makes it fall over three times running — and for that
   * message it is right: retrying forever is a loop nobody can stop.
   *
   * But the commonest reason a message is dropped has nothing to do with the
   * message. It is an agent that could not run at all: signed out, out of
   * quota, pointed at a model that no longer exists. Every delivery of every
   * queued message burns against that, and what the user sees is their question
   * marked "never answered" by an agent that never read it. So when a NEW agent
   * starts, the count is reset and the question is asked again, instead of
   * asking the user to retype what they already typed.
   *
   * To zero, not down by one: the three deliveries were spent on a process that
   * no longer exists, and the agent replacing it deserves its own three. The
   * cap still holds for the case it was written for — an agent that keeps
   * failing on the same message drops it again, without a relaunch in between.
   */
  requeueDroppedUserTurns(now: number = Date.now()): number {
    // Never back past the freshness window. Without this the requeue is what
    // keeps a stale backlog alive: every launch would hand yesterday's
    // questions back to the queue, including the ones expiry had just retired,
    // and the two would trade the same rows for the life of the install.
    const cutoff = new Date(now - USER_TURN_TTL_MS).toISOString();
    const res = this.db
      .prepare(
        `UPDATE agent_turns SET delivered = 0, delivery_count = 0
         WHERE role = 'user' AND delivered = 1 AND at >= ?
           AND COALESCE(delivery_count, 0) >= ?
           AND seq NOT IN (
             SELECT reply_to FROM agent_turns
             WHERE role = 'agent' AND reply_to IS NOT NULL
           )`,
      )
      .run(cutoff, Store.MAX_DELIVERIES);
    return res.changes;
  }

  /**
   * Puts ONE unanswered user message back on the queue, and says whether a row
   * moved.
   *
   * The bulk requeue above is a rule a launch applies to everything at once.
   * This is a person pointing at a single message and asking for it again, the
   * retry on a message the pane says was never answered, so it is narrower in
   * what it touches and wider in what it accepts: a row still marked in flight
   * is reset too. A lease nobody is ever going to answer looks, from the pane,
   * exactly like a dropped one, and the user asking for that message back means
   * the same thing either way.
   *
   * To zero, for the same reason the bulk reset goes to zero: the deliveries
   * before this were spent on attempts the user has just declared failures.
   *
   * Answered rows are refused, because requeuing one would have a second agent
   * answer a finished question, which is the hole the lease exists to close. So
   * are messages older than the freshness window, which the next claim would
   * retire again on the spot. False is a caller's cue to say why, not a silent
   * no-op.
   */
  requeueUserTurn(seq: number, now: number = Date.now()): boolean {
    const cutoff = new Date(now - USER_TURN_TTL_MS).toISOString();
    const res = this.db
      .prepare(
        `UPDATE agent_turns SET delivered = 0, delivery_count = 0
         WHERE seq = ? AND role = 'user' AND at >= ?
           AND seq NOT IN (
             SELECT reply_to FROM agent_turns
             WHERE role = 'agent' AND reply_to IS NOT NULL
           )`,
      )
      .run(seq, cutoff);
    return res.changes > 0;
  }

  /**
   * Retires every queued user message that has gone stale, and says how many.
   *
   * A message with nobody listening waits on the queue, and until this existed
   * it waited without end: start an agent a day later and the first thing it
   * was handed was yesterday's question, in a chat the user had moved on from,
   * while the message they had just typed sat behind it. The backlog survived
   * every restart — dropping it only marked it, and the next launch requeued
   * it — so one quiet evening poisoned every session after it.
   *
   * Retired, not deleted: the row is marked exactly as a dropped one is, so the
   * pane already has the words for it — this was never picked up, send it again
   * — and the user decides whether it still matters. Nothing an agent answered
   * is touched, and neither is anything inside the window.
   */
  expireStaleUserTurns(now: number = Date.now()): number {
    const cutoff = new Date(now - USER_TURN_TTL_MS).toISOString();
    const res = this.db
      .prepare(
        `UPDATE agent_turns
         SET delivered = 1, delivery_count = ?
         WHERE role = 'user' AND delivered = 0 AND at < ?`,
      )
      .run(Store.MAX_DELIVERIES, cutoff);
    return res.changes;
  }

  /**
   * The next user turn no agent is holding, marked as held in the same
   * transaction. Returns null when there is nothing waiting.
   *
   * The claim has to be atomic. Two agents polling the same channel would
   * otherwise both read the same row and both answer it. It is a lease: the
   * holder is exclusive until they answer, vanish, or hit the delivery cap.
   *
   * `activeChatId` is the conversation the user is looking at, and it is served
   * before any other. Plain oldest-first is right within one chat and wrong
   * across several: an agent would work another chat's backlog while the pane
   * in front of the user said nothing was listening, which reads as an agent
   * that does not work at all. Ordering by the chat on screen first costs the
   * other chats nothing — every message is still delivered, and still oldest
   * first among its peers.
   *
   * Stale messages are retired first, in the same transaction, so a claim can
   * never hand over one this store would refuse to keep queued.
   *
   * A message in an archived chat is not handed over either. Archiving keeps
   * the turns, so an unanswered question sits there undelivered, and an agent
   * started later would otherwise work a conversation the rail does not show.
   * It is still queued: opening the chat unarchives it, and the claim after
   * that picks the message up.
   *
   * `skipSeq` is one message this claim must step over, and it exists for the
   * client that has just walked away from that message: handing it straight
   * back is a loop, and every turn of the loop spends one of its deliveries.
   * The row stays queued and everybody else stays eligible for it. This only
   * says "not this one, not right now".
   */
  claimNextUserTurn(
    activeChatId?: string | null,
    options: { skipSeq?: number | null } = {},
  ): StoredTurn | null {
    const claim = this.db.transaction((): StoredTurn | null => {
      this.expireStaleUserTurns();
      const row = this.db
        .prepare(
          `SELECT seq, at, chat_id as chatId, role, text_enc as textEnc, agent,
                  reply_to as replyTo, COALESCE(delivery_count, 0) as deliveryCount
           FROM agent_turns
           WHERE role = 'user' AND delivered = 0
             AND seq IS NOT ?
             AND chat_id NOT IN (
               SELECT id FROM agent_chats WHERE archived_at IS NOT NULL
             )
           ORDER BY (chat_id IS NOT NULL AND chat_id = ?) DESC, seq ASC
           LIMIT 1`,
        )
        .get(options.skipSeq ?? null, activeChatId ?? null) as TurnRow | undefined;
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
   *
   * `deadLetter` ends the message here whatever the count says. It is for the
   * lease that ran out of time while its holder was provably alive and simply
   * never answered: offering that one again buys another wait of the same
   * length, so the row is marked exactly as a message nobody picked up is, and
   * the pane asks the user whether they still want it.
   */
  unclaimUserTurn(
    seq: number,
    options: { revertAttempt?: boolean; deadLetter?: boolean } = {},
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
      if (options.deadLetter) {
        this.db
          .prepare(
            `UPDATE agent_turns SET delivered = 1, delivery_count = ?
             WHERE seq = ?`,
          )
          .run(Store.MAX_DELIVERIES, seq);
        return "dead_lettered";
      }
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
    // The session goes with the messages: a model still resuming a transcript
    // the pane no longer shows would answer from history the user just emptied.
    // The epoch moves with it, so a turn still running in this chat cannot save
    // the session it started with once the answer lands.
    this.db
      .prepare(
        `UPDATE agent_chats
         SET trimmed_at = NULL, session_agent = NULL, session_id = NULL,
             session_epoch = session_epoch + 1
         WHERE id = ?`,
      )
      .run(chatId);
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
    this.db
      .prepare(`UPDATE agent_chats SET trimmed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), chatId);
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

  /* ---- approvals ---------------------------------------------------------
     Rows in, rows out, exactly as the conversation is. What may be asked for
     and what happens on yes lives in src/agent/approvals.ts.
     --------------------------------------------------------------------- */

  addApproval(input: {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    profile: string;
    agent: string | null;
    chatId: string | null;
    askedAt: string;
    context?: StoredApproval["context"];
  }): StoredApproval {
    const context = input.context ?? null;
    this.db
      .prepare(
        `INSERT INTO agent_approvals (id, tool, args_enc, context_enc, profile, agent, chat_id, asked_at, state)
         VALUES (@id, @tool, @argsEnc, @contextEnc, @profile, @agent, @chatId, @askedAt, 'pending')`,
      )
      .run({
        id: input.id,
        tool: input.tool,
        argsEnc: encryptSecret(this.masterKey, JSON.stringify(input.args)),
        // Encrypted like the arguments: a subject line is mail content.
        contextEnc: context
          ? encryptSecret(this.masterKey, JSON.stringify(context))
          : null,
        profile: input.profile,
        agent: input.agent,
        chatId: input.chatId,
        askedAt: input.askedAt,
      });
    return {
      ...input,
      context,
      decidedAt: null,
      state: "pending",
      outcome: null,
    };
  }

  /**
   * Oldest first, and ordered on `rowid` rather than on `asked_at`: two
   * requests written in the same millisecond are the normal case for an agent
   * working through a list, and a timestamp cannot separate them. The newest
   * `limit` are taken and then flipped, so a capped list keeps the recent ones.
   */
  listApprovals(options: { pendingOnly?: boolean; limit?: number } = {}): StoredApproval[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT id, tool, args_enc as argsEnc, context_enc as contextEnc, profile, agent, chat_id as chatId,
                asked_at as askedAt, decided_at as decidedAt, state, outcome
         FROM agent_approvals
         WHERE (? = 0 OR state = 'pending')
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(options.pendingOnly ? 1 : 0, limit) as ApprovalRow[];
    return rows.map((row) => this.toApproval(row)).reverse();
  }

  getApproval(id: string): StoredApproval | null {
    const row = this.db
      .prepare(
        `SELECT id, tool, args_enc as argsEnc, context_enc as contextEnc, profile, agent, chat_id as chatId,
                asked_at as askedAt, decided_at as decidedAt, state, outcome
         FROM agent_approvals WHERE id = ?`,
      )
      .get(id) as ApprovalRow | undefined;
    return row ? this.toApproval(row) : null;
  }

  /**
   * Moves a request out of `pending`, and only from `pending`.
   *
   * The guard is in the WHERE clause rather than in a read-then-write above
   * it: two windows showing the same request is the normal case, and a second
   * Approve landing after the first has already sent the mail must change
   * nothing. False means somebody else got there first.
   */
  settleApproval(
    id: string,
    state: StoredApproval["state"],
    outcome: string | null,
    decidedAt: string,
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE agent_approvals SET state = ?, outcome = ?, decided_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(state, outcome, decidedAt, id);
    return res.changes > 0;
  }

  /* ---- what a launched agent archived ------------------------------------ */

  addAgentArchive(input: {
    accountId: string;
    messageId: string | null;
    fromFolder: string;
    toFolder: string;
    agent: string | null;
    chatId: string | null;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_archives
           (account_id, message_id, from_folder, to_folder, agent, chat_id, at)
         VALUES (@accountId, @messageId, @fromFolder, @toFolder, @agent, @chatId, @at)`,
      )
      .run(input);
  }

  /** Oldest first, so a sweep reads in the order the agent worked. */
  listAgentArchives(options: { since?: string; limit?: number } = {}): AgentArchiveRow[] {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
    return this.db
      .prepare(
        `SELECT id, account_id as accountId, message_id as messageId,
                from_folder as fromFolder, to_folder as toFolder,
                agent, chat_id as chatId, at
         FROM agent_archives
         WHERE (@since IS NULL OR at >= @since)
         ORDER BY id ASC
         LIMIT @limit`,
      )
      .all({ since: options.since ?? null, limit }) as AgentArchiveRow[];
  }

  deleteAgentArchives(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`DELETE FROM agent_archives WHERE id = ?`);
    const run = this.db.transaction((all: number[]) => {
      for (const id of all) stmt.run(id);
    });
    run(ids);
  }

  /** Drops rows older than the cutoff. Called when the log is read. */
  pruneAgentArchives(before: string): void {
    this.db.prepare(`DELETE FROM agent_archives WHERE at < ?`).run(before);
  }

  private toApproval(row: ApprovalRow): StoredApproval {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(decryptSecret(this.masterKey, row.argsEnc));
      if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // A row this key cannot read is a row nobody can act on. It comes back
      // with no arguments, which every caller treats as "cannot be carried
      // out" — the alternative is refusing to list any of them.
    }
    let context: StoredApproval["context"] = null;
    if (row.contextEnc) {
      try {
        const parsed = JSON.parse(decryptSecret(this.masterKey, row.contextEnc));
        if (parsed && typeof parsed === "object") {
          context = parsed as StoredApproval["context"];
        }
      } catch {
        // Same rule as the arguments above: unreadable is not fatal. The card
        // falls back to naming the message by its id.
      }
    }
    return {
      id: row.id,
      tool: row.tool,
      args,
      context,
      profile: row.profile,
      agent: row.agent,
      chatId: row.chatId,
      askedAt: row.askedAt,
      decidedAt: row.decidedAt,
      state: row.state,
      outcome: row.outcome,
    };
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

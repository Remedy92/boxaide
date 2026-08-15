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
  role: StoredTurn["role"];
  textEnc: string;
  agent: string | null;
  delivered: number;
  replyTo: number | null;
  deliveryCount: number;
};

export class Store {
  static readonly MAX_DELIVERIES = MAX_DELIVERIES;

  readonly db: Database.Database;

  constructor(
    private masterKey: Buffer,
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
  }

  /* ---- agent conversation ------------------------------------------------
     Rows in, rows out. Every decision about who gets a message and when lives
     in AgentChannel; this class only reads and writes.
     --------------------------------------------------------------------- */

  appendTurn(input: {
    at: string;
    role: StoredTurn["role"];
    text: string;
    agent: string | null;
    replyTo?: number | null;
  }): StoredTurn {
    const replyTo = input.replyTo ?? null;
    const res = this.db
      .prepare(
        `INSERT INTO agent_turns (at, role, text_enc, agent, delivered, reply_to)
         VALUES (@at, @role, @textEnc, @agent, 0, @replyTo)`,
      )
      .run({
        at: input.at,
        role: input.role,
        textEnc: encryptSecret(this.masterKey, input.text),
        agent: input.agent,
        replyTo,
      });
    return {
      seq: Number(res.lastInsertRowid),
      at: input.at,
      role: input.role,
      text: input.text,
      agent: input.agent,
      delivered: false,
      replyTo,
      deliveryCount: 0,
    };
  }

  listTurns(options: { afterSeq?: number; limit?: number } = {}): StoredTurn[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    // Newest `limit` rows, then flipped: asking for "the last 200" and getting
    // the FIRST 200 is the classic version of this bug.
    const rows = this.db
      .prepare(
        `SELECT seq, at, role, text_enc as textEnc, agent, delivered, reply_to as replyTo,
                COALESCE(delivery_count, 0) as deliveryCount
         FROM agent_turns
         WHERE seq > ?
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(options.afterSeq ?? 0, limit) as Array<{
      seq: number;
      at: string;
      role: StoredTurn["role"];
      textEnc: string;
      agent: string | null;
      delivered: number;
      replyTo: number | null;
      deliveryCount: number;
    }>;
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
          `SELECT seq, at, role, text_enc as textEnc, agent, reply_to as replyTo,
                  COALESCE(delivery_count, 0) as deliveryCount
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

  clearTurns(): void {
    this.db.exec(`DELETE FROM agent_turns`);
  }

  /** Drops everything but the newest `keep` turns. */
  trimTurns(keep: number): void {
    this.db
      .prepare(
        `DELETE FROM agent_turns WHERE seq <= (
           SELECT COALESCE(MIN(seq), 0) - 1 FROM (
             SELECT seq FROM agent_turns ORDER BY seq DESC LIMIT ?
           )
         )`,
      )
      .run(Math.max(keep, 1));
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
      role: row.role,
      text: decryptSecret(this.masterKey, row.textEnc),
      agent: row.agent,
      delivered: row.delivered === 1,
      replyTo: row.role === "user" || row.replyTo == null ? null : row.replyTo,
      deliveryCount: row.deliveryCount,
    };
  }
}

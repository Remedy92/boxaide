/**
 * Outreach tables and queries. DDL: docs/specs/agent-platform.md.
 * Owns: outbox, suppression.
 * Subjects and bodies are encrypted (_enc).
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import { OPT_OUT_FOOTER, canonicalEmail } from "./opt-out.js";

/**
 * Re-exported, not redefined: src/outreach/opt-out.ts owns the keyword and the
 * footer built from it. Existing importers of this module keep working.
 */
export { OPT_OUT_FOOTER } from "./opt-out.js";

export type OutboxStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "failed";

export type OutboxRow = {
  id: string;
  accountId: string;
  contactId: string | null;
  to: string;
  subject: string;
  body: string;
  status: OutboxStatus;
  createdAt: string;
  decidedAt: string | null;
  sentAt: string | null;
  error: string | null;
};

export type SuppressionRow = { email: string; reason: string; at: string };

export const MAX_OUTREACH_SUBJECT_BYTES = 4 * 1024;
export const MAX_OUTREACH_BODY_BYTES = 128 * 1024;
const MAX_IDENTIFIER_CHARS = 200;
const MAX_EMAIL_CHARS = 320;
const MAX_SUPPRESSION_REASON_CHARS = 1_000;

function assertOutreachText(label: string, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} must be at most ${maxBytes} bytes`);
  }
}

/** Idempotent: a body that already carries the footer is left alone. */
export function withOptOutFooter(body: string): string {
  return body.includes(OPT_OUT_FOOTER) ? body : `${body}${OPT_OUT_FOOTER}`;
}

type OutboxDbRow = {
  id: string;
  account_id: string;
  contact_id: string | null;
  to_addr: string;
  subject_enc: string;
  body_enc: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  sent_at: string | null;
  error: string | null;
};

export class OutreachStore {
  /**
   * Prepared once and reused: isSuppressed runs inside the send guard, on
   * every recipient of every send in the process (spec invariant 2), so it
   * must not re-parse SQL each call.
   */
  private suppressedStmt: Database.Statement | null = null;

  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        contact_id TEXT,
        to_addr TEXT NOT NULL,
        subject_enc TEXT NOT NULL,
        body_enc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        sent_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS suppression (
        email TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_sent ON outbox(account_id, sent_at);
    `);

    // Campaigns shipped and were removed: drop their tables. The outbox
    // columns campaign_id and step_position are left in existing databases —
    // SQLite cannot drop a column without a table rewrite, and an unread
    // column costs nothing.
    this.db.exec(`
      DROP TABLE IF EXISTS campaign_contacts;
      DROP TABLE IF EXISTS sequence_steps;
      DROP TABLE IF EXISTS campaigns;
    `);

    // Rows written before canonicalEmail existed hold trim+lowercase keys;
    // lookups now canonicalize (punycode the domain), so a pre-existing
    // unicode-domain suppression would silently stop matching — the exact
    // failure this table exists to prevent. Rewrite once, at open: move each
    // non-canonical row onto its canonical key, keeping whichever row is
    // already there (a standing request never un-suppresses).
    const stale = this.db
      .prepare(`SELECT email, reason, at FROM suppression`)
      .all() as SuppressionRow[];
    const rewrite = this.db.transaction(() => {
      for (const row of stale) {
        const canonical = canonicalEmail(row.email);
        if (canonical === row.email) continue;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO suppression (email, reason, at) VALUES (?, ?, ?)`,
          )
          .run(canonical, row.reason, row.at);
        this.db.prepare(`DELETE FROM suppression WHERE email = ?`).run(row.email);
      }
    });
    rewrite();
  }

  private enc(text: string): string {
    return encryptSecret(this.masterKey, text);
  }

  private dec(payload: string): string {
    return decryptSecret(this.masterKey, payload);
  }

  /* ---- suppression ---------------------------------------------------- */

  /**
   * Send-guard check. The lookup key is canonicalEmail — the same form
   * addSuppression writes — so an IDN address suppressed in its unicode form
   * still blocks the punycoded address nodemailer actually delivers to.
   */
  isSuppressed(email: string): boolean {
    if (!this.suppressedStmt) {
      this.suppressedStmt = this.db.prepare(
        `SELECT 1 FROM suppression WHERE email = ?`,
      );
    }
    return this.suppressedStmt.get(canonicalEmail(email)) !== undefined;
  }

  addSuppression(email: string, reason = "manual"): SuppressionRow {
    const row: SuppressionRow = {
      email: canonicalEmail(email),
      reason,
      at: new Date().toISOString(),
    };
    if (!row.email.includes("@")) throw new Error("valid email is required");
    if (row.email.length > MAX_EMAIL_CHARS) throw new Error("email is too long");
    if (row.reason.length > MAX_SUPPRESSION_REASON_CHARS) {
      throw new Error(
        `reason must be at most ${MAX_SUPPRESSION_REASON_CHARS} characters`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO suppression (email, reason, at) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
      )
      .run(row.email, row.reason, row.at);
    return row;
  }

  listSuppression(): SuppressionRow[] {
    return this.db
      .prepare(`SELECT email, reason, at FROM suppression ORDER BY at DESC`)
      .all() as SuppressionRow[];
  }

  removeSuppression(email: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM suppression WHERE email = ?`)
      .run(canonicalEmail(email));
    return res.changes > 0;
  }

  /* ---- outbox --------------------------------------------------------- */

  /**
   * Did outreach ever touch this contact? The opt-out sweep suppresses on the
   * strength of one inbound message, so it must only reach people this product
   * mailed or was about to mail — an outbox row. Someone who writes "stop"
   * into an unrelated thread is not suppressed.
   */
  hasOutreachHistory(contactId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM outbox WHERE contact_id = ?`)
      .get(contactId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * Queue a draft for human review. Status is always 'pending': nothing in
   * this file may create an already-approved row (spec invariant 1).
   */
  queueOutbox(input: {
    accountId: string;
    to: string;
    subject: string;
    body: string;
    contactId?: string | null;
    createdAt?: string;
  }): OutboxRow {
    if (!input.to.trim()) throw new Error("to is required");
    if (input.to.length > MAX_EMAIL_CHARS) throw new Error("to is too long");
    if (input.accountId.length > MAX_IDENTIFIER_CHARS) {
      throw new Error("accountId is too long");
    }
    assertOutreachText("subject", input.subject, MAX_OUTREACH_SUBJECT_BYTES);
    assertOutreachText("body", input.body, MAX_OUTREACH_BODY_BYTES);
    const row: OutboxRow = {
      id: randomUUID(),
      accountId: input.accountId,
      contactId: input.contactId ?? null,
      to: input.to.trim(),
      subject: input.subject,
      body: withOptOutFooter(input.body),
      status: "pending",
      createdAt: input.createdAt ?? new Date().toISOString(),
      decidedAt: null,
      sentAt: null,
      error: null,
    };
    // The look-up and the insert are one atomic step. Nothing inside this
    // process can interleave between them — the code never yields — but a
    // stdio `boxaide mcp` process serves this same tool over the same file,
    // and both could otherwise read "no duplicate" and then both insert.
    // IMMEDIATE takes the write lock at the start rather than at the INSERT,
    // which is exactly the window that would let that happen.
    return this.db
      .transaction((): OutboxRow => {
        const already = this.pendingDuplicate(row);
        if (already) return already;
        this.db
          .prepare(
            `INSERT INTO outbox
               (id, account_id, contact_id, to_addr,
                subject_enc, body_enc, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.accountId,
            row.contactId,
            row.to,
            this.enc(row.subject),
            this.enc(row.body),
            row.status,
            row.createdAt,
          );
        return row;
      })
      .immediate();
  }

  /**
   * The pending row this queue request would repeat exactly, if there is one.
   *
   * Automation runs can overlap, so two of them can reach the same conclusion
   * about the same person in the same minute. Returning the existing row makes
   * queueing idempotent for that case.
   *
   * The match is the WHOLE message — recipient, subject, body. Deliberately
   * narrow. A looser key (same person) would also swallow a second, genuinely
   * different draft, and a draft that silently never appears is worse than two
   * similar ones: the reviewer can delete a duplicate they can see, but cannot
   * recover one they never got.
   *
   * Subject and body are encrypted, so the comparison happens after decrypting
   * the candidates. Only pending rows to the same address on the same account
   * are read, which is a handful at most.
   */
  private pendingDuplicate(row: OutboxRow): OutboxRow | null {
    const candidates = this.db
      .prepare(
        `SELECT * FROM outbox
          WHERE status = 'pending' AND account_id = ? AND to_addr = ?`,
      )
      .all(row.accountId, row.to) as OutboxDbRow[];
    for (const candidate of candidates) {
      const existing = this.toOutbox(candidate);
      if (
        existing.subject === row.subject &&
        existing.body === row.body
      ) {
        return existing;
      }
    }
    return null;
  }

  private toOutbox(row: OutboxDbRow): OutboxRow {
    return {
      id: row.id,
      accountId: row.account_id,
      contactId: row.contact_id,
      to: row.to_addr,
      subject: this.dec(row.subject_enc),
      body: this.dec(row.body_enc),
      status: row.status as OutboxStatus,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      sentAt: row.sent_at,
      error: row.error,
    };
  }

  getOutbox(id: string): OutboxRow | null {
    const row = this.db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as
      | OutboxDbRow
      | undefined;
    return row ? this.toOutbox(row) : null;
  }

  listOutbox(opts: { status?: OutboxStatus; limit?: number } = {}): OutboxRow[] {
    const limit = Math.max(1, opts.limit ?? 50);
    // rowid breaks ties: several rows can carry the same created_at (one tick
    // queues several drafts), and the send loop must stay first-in-first-out
    // rather than fall back to UUID order.
    const rows = opts.status
      ? (this.db
          .prepare(
            `SELECT * FROM outbox WHERE status = ?
              ORDER BY created_at ASC, rowid ASC LIMIT ?`,
          )
          .all(opts.status, limit) as OutboxDbRow[])
      : (this.db
          .prepare(
            `SELECT * FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(limit) as OutboxDbRow[]);
    return rows.map((r) => this.toOutbox(r));
  }

  /**
   * The approval state machine. Only 'pending' can be approved or rejected,
   * and only 'approved' can become 'sent' or 'failed' — a row cannot be walked
   * back into a sendable state after it was rejected or already went out.
   */
  decide(
    id: string,
    next: "approved" | "rejected",
    at = new Date().toISOString(),
  ): OutboxRow | null {
    const row = this.getOutbox(id);
    if (!row) return null;
    if (row.status !== "pending") {
      throw new Error(`outbox row is ${row.status}, not pending`);
    }
    this.db
      .prepare(`UPDATE outbox SET status = ?, decided_at = ? WHERE id = ?`)
      .run(next, at, id);
    return this.getOutbox(id);
  }

  markSent(id: string, at: string): void {
    const res = this.db
      .prepare(
        `UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL
          WHERE id = ? AND status = 'approved'`,
      )
      .run(at, id);
    if (res.changes === 0) throw new Error("outbox row is not approved");
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE outbox SET status = 'failed', error = ?
          WHERE id = ? AND status = 'approved'`,
      )
      .run(error.slice(0, 500), id);
  }

  /** Engine sends for one account inside one UTC day; feeds the daily cap. */
  countSentOnUtcDay(accountId: string, dayIso: string): number {
    const day = dayIso.slice(0, 10);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM outbox
          WHERE account_id = ? AND sent_at IS NOT NULL
            AND substr(sent_at, 1, 10) = ?`,
      )
      .get(accountId, day) as { n: number };
    return row.n;
  }

  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
      .get() as { n: number };
    return row.n;
  }
}

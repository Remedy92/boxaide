/**
 * Outreach tables and queries. DDL: docs/specs/agent-platform.md.
 * Owns: campaigns, sequence_steps, campaign_contacts, outbox, suppression.
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

export type CampaignStatus = "draft" | "active" | "paused" | "done";
export type OutboxStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "failed";
export type ContactState =
  | "active"
  | "replied"
  | "opted_out"
  | "done"
  | "suppressed";

export type Campaign = {
  id: string;
  name: string;
  accountId: string;
  status: CampaignStatus;
  createdAt: string;
};

export type StepInput = { subject: string; body: string; waitDays?: number };

export type SequenceStep = {
  id: string;
  campaignId: string;
  position: number;
  waitDays: number;
  subject: string;
  body: string;
};

export type CampaignContact = {
  campaignId: string;
  contactId: string;
  state: ContactState;
  currentStep: number;
  lastSentAt: string | null;
  nextDueAt: string | null;
};

export type OutboxRow = {
  id: string;
  accountId: string;
  campaignId: string | null;
  contactId: string | null;
  stepPosition: number | null;
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

export const MAX_CAMPAIGN_NAME_CHARS = 200;
export const MAX_CAMPAIGN_STEPS = 50;
export const MAX_OUTREACH_SUBJECT_BYTES = 4 * 1024;
export const MAX_OUTREACH_BODY_BYTES = 128 * 1024;
export const MAX_CAMPAIGN_CONTACTS_PER_REQUEST = 1_000;
const MAX_IDENTIFIER_CHARS = 200;
const MAX_EMAIL_CHARS = 320;
const MAX_SUPPRESSION_REASON_CHARS = 1_000;

function assertOutreachText(label: string, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} must be at most ${maxBytes} bytes`);
  }
}

function assertSteps(steps: StepInput[]): void {
  if (steps.length > MAX_CAMPAIGN_STEPS) {
    throw new Error(`steps must contain at most ${MAX_CAMPAIGN_STEPS} entries`);
  }
  for (const step of steps) {
    assertOutreachText(
      "step subject",
      String(step.subject ?? ""),
      MAX_OUTREACH_SUBJECT_BYTES,
    );
    assertOutreachText(
      "step body",
      String(step.body ?? ""),
      MAX_OUTREACH_BODY_BYTES,
    );
  }
}

const CAMPAIGN_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "active",
  "paused",
  "done",
]);

/** Idempotent: a body that already carries the footer is left alone. */
export function withOptOutFooter(body: string): string {
  return body.includes(OPT_OUT_FOOTER) ? body : `${body}${OPT_OUT_FOOTER}`;
}

type CampaignRow = {
  id: string;
  name: string;
  account_id: string;
  status: string;
  created_at: string;
};

type StepRow = {
  id: string;
  campaign_id: string;
  position: number;
  wait_days: number;
  subject_enc: string;
  body_enc: string;
};

type ContactRow = {
  campaign_id: string;
  contact_id: string;
  state: string;
  current_step: number;
  last_sent_at: string | null;
  next_due_at: string | null;
};

type OutboxDbRow = {
  id: string;
  account_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  step_position: number | null;
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
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sequence_steps (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        wait_days INTEGER NOT NULL DEFAULT 0,
        subject_enc TEXT NOT NULL,
        body_enc TEXT NOT NULL,
        UNIQUE (campaign_id, position)
      );
      CREATE TABLE IF NOT EXISTS campaign_contacts (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        current_step INTEGER NOT NULL DEFAULT -1,
        last_sent_at TEXT,
        next_due_at TEXT,
        PRIMARY KEY (campaign_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        campaign_id TEXT,
        contact_id TEXT,
        step_position INTEGER,
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

  /**
   * Decrypt a payload written by any store that shares this master key.
   * The engine needs it for CRM interaction subjects/snippets: its constructor
   * deps are fixed by src/platform.ts and carry no key of their own.
   */
  decryptText(payload: string): string {
    return this.dec(payload);
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

  /* ---- campaigns ------------------------------------------------------ */

  createCampaign(input: {
    name: string;
    accountId: string;
    steps: StepInput[];
  }): Campaign {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    if (name.length > MAX_CAMPAIGN_NAME_CHARS) {
      throw new Error(
        `name must be at most ${MAX_CAMPAIGN_NAME_CHARS} characters`,
      );
    }
    if (!input.accountId.trim()) throw new Error("account is required");
    if (input.accountId.trim().length > MAX_IDENTIFIER_CHARS) {
      throw new Error("account is too long");
    }
    if (!input.steps.length) throw new Error("at least one step is required");
    assertSteps(input.steps);
    const campaign: Campaign = {
      id: randomUUID(),
      name,
      accountId: input.accountId.trim(),
      status: "draft",
      createdAt: new Date().toISOString(),
    };
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO campaigns (id, name, account_id, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          campaign.id,
          campaign.name,
          campaign.accountId,
          campaign.status,
          campaign.createdAt,
        );
      this.writeSteps(campaign.id, input.steps);
    });
    write();
    return campaign;
  }

  private writeSteps(campaignId: string, steps: StepInput[]): void {
    this.db
      .prepare(`DELETE FROM sequence_steps WHERE campaign_id = ?`)
      .run(campaignId);
    const insert = this.db.prepare(
      `INSERT INTO sequence_steps
         (id, campaign_id, position, wait_days, subject_enc, body_enc)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    steps.forEach((step, position) => {
      // Step 0 is the initial email: it goes out as soon as the contact is due,
      // so any wait the caller passed for it is meaningless and dropped.
      const waitDays = position === 0 ? 0 : Math.max(0, Number(step.waitDays ?? 0));
      insert.run(
        randomUUID(),
        campaignId,
        position,
        waitDays,
        this.enc(String(step.subject ?? "")),
        this.enc(String(step.body ?? "")),
      );
    });
  }

  getCampaign(id: string): Campaign | null {
    const row = this.db
      .prepare(`SELECT * FROM campaigns WHERE id = ?`)
      .get(id) as CampaignRow | undefined;
    return row ? this.toCampaign(row) : null;
  }

  private toCampaign(row: CampaignRow): Campaign {
    return {
      id: row.id,
      name: row.name,
      accountId: row.account_id,
      status: row.status as CampaignStatus,
      createdAt: row.created_at,
    };
  }

  listCampaigns(): Array<Campaign & { counts: Record<string, number> }> {
    const rows = this.db
      .prepare(`SELECT * FROM campaigns ORDER BY created_at DESC`)
      .all() as CampaignRow[];
    const counts = this.db
      .prepare(
        `SELECT campaign_id, state, COUNT(*) AS n
           FROM campaign_contacts GROUP BY campaign_id, state`,
      )
      .all() as Array<{ campaign_id: string; state: string; n: number }>;
    return rows.map((row) => {
      const perState: Record<string, number> = {};
      for (const c of counts) {
        if (c.campaign_id === row.id) perState[c.state] = c.n;
      }
      return { ...this.toCampaign(row), counts: perState };
    });
  }

  listActiveCampaigns(): Campaign[] {
    const rows = this.db
      .prepare(`SELECT * FROM campaigns WHERE status = 'active'`)
      .all() as CampaignRow[];
    return rows.map((r) => this.toCampaign(r));
  }

  /**
   * Steps may only be replaced while the campaign is still a draft: contacts
   * already partway through a sequence would otherwise silently receive a
   * different mail than the one the human approved the campaign for. The check
   * reads the status BEFORE this update, so "activate and set final steps" in
   * one call is allowed.
   */
  updateCampaign(
    id: string,
    patch: { name?: string; status?: CampaignStatus; steps?: StepInput[] },
  ): Campaign | null {
    const current = this.getCampaign(id);
    if (!current) return null;
    // Both callers (MCP tool, REST PATCH) cast unchecked input to
    // CampaignStatus, so the write itself is the last place to stop a bogus
    // status from landing in the row and hiding the campaign from every
    // status-filtered query.
    if (patch.status !== undefined && !CAMPAIGN_STATUSES.has(patch.status)) {
      throw new Error(`unknown status: ${patch.status}`);
    }
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("name is required");
    }
    if (
      patch.name !== undefined &&
      patch.name.trim().length > MAX_CAMPAIGN_NAME_CHARS
    ) {
      throw new Error(
        `name must be at most ${MAX_CAMPAIGN_NAME_CHARS} characters`,
      );
    }
    if (patch.steps) {
      if (current.status !== "draft") {
        throw new Error("steps can only be replaced while the campaign is draft");
      }
      if (!patch.steps.length) throw new Error("at least one step is required");
      assertSteps(patch.steps);
    }
    const write = this.db.transaction(() => {
      if (patch.name !== undefined) {
        this.db
          .prepare(`UPDATE campaigns SET name = ? WHERE id = ?`)
          .run(patch.name.trim(), id);
      }
      if (patch.status !== undefined) {
        this.db
          .prepare(`UPDATE campaigns SET status = ? WHERE id = ?`)
          .run(patch.status, id);
      }
      if (patch.steps) this.writeSteps(id, patch.steps);
    });
    write();
    return this.getCampaign(id);
  }

  deleteCampaign(id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM campaigns WHERE id = ?`).run(id).changes > 0
    );
  }

  listSteps(campaignId: string): SequenceStep[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sequence_steps WHERE campaign_id = ? ORDER BY position`,
      )
      .all(campaignId) as StepRow[];
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      position: r.position,
      waitDays: r.wait_days,
      subject: this.dec(r.subject_enc),
      body: this.dec(r.body_enc),
    }));
  }

  /* ---- campaign contacts ---------------------------------------------- */

  addCampaignContacts(campaignId: string, contactIds: string[]): number {
    if (contactIds.length > MAX_CAMPAIGN_CONTACTS_PER_REQUEST) {
      throw new Error(
        `contactIds must contain at most ${MAX_CAMPAIGN_CONTACTS_PER_REQUEST} entries`,
      );
    }
    if (contactIds.some((id) => id.length > MAX_IDENTIFIER_CHARS)) {
      throw new Error("contactId is too long");
    }
    const insert = this.db.prepare(
      `INSERT INTO campaign_contacts
         (campaign_id, contact_id, state, current_step)
       VALUES (?, ?, 'active', -1)
       ON CONFLICT(campaign_id, contact_id) DO UPDATE SET
         state = 'active',
         current_step = -1,
         last_sent_at = NULL,
         next_due_at = NULL
       WHERE campaign_contacts.state IN ('opted_out', 'suppressed')`,
    );
    const write = this.db.transaction(() => {
      let added = 0;
      for (const contactId of contactIds) {
        added += insert.run(campaignId, contactId).changes;
      }
      return added;
    });
    return write();
  }

  listCampaignContacts(campaignId: string): CampaignContact[] {
    const rows = this.db
      .prepare(`SELECT * FROM campaign_contacts WHERE campaign_id = ?`)
      .all(campaignId) as ContactRow[];
    return rows.map((r) => this.toCampaignContact(r));
  }

  private toCampaignContact(row: ContactRow): CampaignContact {
    return {
      campaignId: row.campaign_id,
      contactId: row.contact_id,
      state: row.state as ContactState,
      currentStep: row.current_step,
      lastSentAt: row.last_sent_at,
      nextDueAt: row.next_due_at,
    };
  }

  /** Active contacts that have never been queued, or whose wait has elapsed. */
  dueContacts(campaignId: string, nowIso: string): CampaignContact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM campaign_contacts
          WHERE campaign_id = ? AND state = 'active'
            AND (current_step = -1 OR next_due_at IS NULL OR next_due_at <= ?)
          ORDER BY contact_id`,
      )
      .all(campaignId, nowIso) as ContactRow[];
    return rows.map((r) => this.toCampaignContact(r));
  }

  setContactState(
    campaignId: string,
    contactId: string,
    state: ContactState,
  ): void {
    this.db
      .prepare(
        `UPDATE campaign_contacts SET state = ?
          WHERE campaign_id = ? AND contact_id = ?`,
      )
      .run(state, campaignId, contactId);
  }

  /**
   * Did outreach ever touch this contact? The opt-out sweep suppresses on the
   * strength of one inbound message, so it must only reach people this product
   * mailed or was about to mail — a campaign_contacts row or an outbox row.
   * Someone who writes "stop" into an unrelated thread is not suppressed.
   */
  hasOutreachHistory(contactId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit WHERE EXISTS (
             SELECT 1 FROM campaign_contacts WHERE contact_id = ?
           ) OR EXISTS (
             SELECT 1 FROM outbox WHERE contact_id = ?
           )`,
      )
      .get(contactId, contactId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * End every live campaign membership for a contact who asked to stop.
   * Rows already 'opted_out' or 'suppressed' are left alone; 'active',
   * 'replied' and 'done' all move, because the request outranks whatever the
   * sequence thought its state was.
   */
  optOutContact(contactId: string): number {
    return this.db
      .prepare(
        `UPDATE campaign_contacts SET state = 'opted_out'
          WHERE contact_id = ? AND state NOT IN ('opted_out', 'suppressed')`,
      )
      .run(contactId).changes;
  }

  /**
   * A human took this address off the suppression list. Rows that stopped
   * because of that list or a reply-stop restart at step 0 so the sequence
   * can queue again (still pending approval). replied/done stay put: those
   * are sequence outcomes, not the suppression the human just answered.
   */
  reopenStoppedCampaigns(contactId: string): number {
    return this.db
      .prepare(
        `UPDATE campaign_contacts
            SET state = 'active', current_step = -1,
                last_sent_at = NULL, next_due_at = NULL
          WHERE contact_id = ? AND state IN ('opted_out', 'suppressed')`,
      )
      .run(contactId).changes;
  }

  advanceContact(
    campaignId: string,
    contactId: string,
    patch: {
      currentStep: number;
      lastSentAt: string;
      nextDueAt: string | null;
      state: ContactState;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE campaign_contacts
            SET current_step = ?, last_sent_at = ?, next_due_at = ?, state = ?
          WHERE campaign_id = ? AND contact_id = ?`,
      )
      .run(
        patch.currentStep,
        patch.lastSentAt,
        patch.nextDueAt,
        patch.state,
        campaignId,
        contactId,
      );
  }

  /* ---- outbox --------------------------------------------------------- */

  /**
   * Queue a draft for human review. Status is always 'pending': nothing in
   * this file may create an already-approved row (spec invariant 1).
   */
  queueOutbox(input: {
    accountId: string;
    to: string;
    subject: string;
    body: string;
    campaignId?: string | null;
    contactId?: string | null;
    stepPosition?: number | null;
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
      campaignId: input.campaignId ?? null,
      contactId: input.contactId ?? null,
      stepPosition: input.stepPosition ?? null,
      to: input.to.trim(),
      subject: input.subject,
      body: withOptOutFooter(input.body),
      status: "pending",
      createdAt: input.createdAt ?? new Date().toISOString(),
      decidedAt: null,
      sentAt: null,
      error: null,
    };
    this.db
      .prepare(
        `INSERT INTO outbox
           (id, account_id, campaign_id, contact_id, step_position, to_addr,
            subject_enc, body_enc, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.accountId,
        row.campaignId,
        row.contactId,
        row.stepPosition,
        row.to,
        this.enc(row.subject),
        this.enc(row.body),
        row.status,
        row.createdAt,
      );
    return row;
  }

  private toOutbox(row: OutboxDbRow): OutboxRow {
    return {
      id: row.id,
      accountId: row.account_id,
      campaignId: row.campaign_id,
      contactId: row.contact_id,
      stepPosition: row.step_position,
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
    // queues a whole campaign), and the send loop must stay first-in-first-out
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

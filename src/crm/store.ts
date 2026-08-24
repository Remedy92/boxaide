/**
 * CRM tables and queries. DDL and derivation rules: docs/specs/agent-platform.md.
 *
 * Owns: organizations, contacts, contact_tags, notes, interactions,
 * pipeline_stages, deals. Mail-derived text (subjects, snippets, notes) is
 * stored encrypted via encryptSecret; identity fields stay plaintext.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import { canonicalEmail } from "../outreach/opt-out.js";
import {
  type ContactIntent,
  type ContactState,
  type StateOpts,
  contactState,
  contactStates,
} from "./state.js";

export type ContactIntentRow = {
  contactId: string;
  intent: ContactIntent;
  at: string;
  source: string;
  note: string | null;
};

export type Organization = {
  id: string;
  name: string;
  domain: string | null;
  createdAt: string;
};

export type Contact = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  orgId: string | null;
  /** Denormalised for list rendering; null when the contact has no org. */
  orgName: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type Note = {
  id: string;
  contactId: string;
  at: string;
  text: string;
};

export type Interaction = {
  id: string;
  contactId: string;
  accountId: string;
  messageId: string;
  direction: "in" | "out";
  at: string;
  subject: string | null;
  snippet: string | null;
  /**
   * Inbound mail that asks us to stop. CRM sync writes this from the full
   * body (retrying until that body is read); a later walk does not re-fetch
   * a finished judgement.
   */
  optOut: boolean;
};

export type PipelineStage = {
  id: string;
  name: string;
  position: number;
};

export type Deal = {
  id: string;
  title: string;
  contactId: string | null;
  orgId: string | null;
  stageId: string;
  value: number | null;
  currency: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

/** Everything the detail pane and `crm_contact_get` need in one read. */
export type ContactDetail = {
  contact: Contact;
  tags: string[];
  notes: Note[];
  interactions: Interaction[];
  deals: Deal[];
  /**
   * Worked out from the rows below, not stored. Read this — never the tags —
   * to decide whether someone may be contacted.
   */
  state: ContactState;
};

/** The board: stages in order, each with its deals in board order. */
export type PipelineBoard = Array<PipelineStage & { deals: Deal[] }>;

/**
 * Seeded once, only into an empty table. Ids are the names on purpose: a stage
 * id shows up in every deal row and in the MCP surface, and 'lead' is readable
 * where a UUID is not. Renaming a stage later changes `name`, never `id`.
 */
const SEED_STAGES: ReadonlyArray<[string, string]> = [
  ["lead", "Lead"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["won", "Won"],
  ["lost", "Lost"],
];

type ContactRow = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  orgId: string | null;
  orgName: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

type InteractionRow = {
  id: string;
  contactId: string;
  accountId: string;
  messageId: string;
  direction: "in" | "out";
  at: string;
  subjectEnc: string | null;
  snippetEnc: string | null;
  optOut: number;
};

const CONTACT_COLUMNS = `
  c.id as id, c.email as email, c.name as name, c.title as title,
  c.org_id as orgId, o.name as orgName, c.source as source,
  c.created_at as createdAt, c.updated_at as updatedAt`;

export class CrmStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        title TEXT,
        org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'mail',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contact_tags (
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (contact_id, tag)
      );
      -- Intent, the one part of contact state that cannot be worked out from
      -- recorded mail: meaning to contact someone, or meaning never to. The
      -- contact id is the whole primary key, so a contact holds exactly one
      -- intent and setting a new one replaces the old. That is the property
      -- tags lacked — an unordered set could hold 'queued' and 'contacted' at
      -- once with no way to tell which came last. Everything else about
      -- outreach state is derived; see src/crm/state.ts.
      CREATE TABLE IF NOT EXISTS contact_intent (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
        intent TEXT NOT NULL,
        at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'agent',
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        text_enc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        at TEXT NOT NULL,
        subject_enc TEXT,
        snippet_enc TEXT,
        opt_out INTEGER NOT NULL DEFAULT 0,
        -- 1 once sync read a non-empty full body (or a human withdrew the
        -- flags). 0 means the verdict is snippet-only and the next walk
        -- should fetch again — a transient IMAP miss must not freeze a 0.
        opt_out_full INTEGER NOT NULL DEFAULT 0,
        UNIQUE (account_id, message_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS pipeline_stages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
        stage_id TEXT NOT NULL REFERENCES pipeline_stages(id),
        value REAL,
        currency TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interactions_contact
        ON interactions (contact_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_deals_stage
        ON deals (stage_id, position);
    `);

    // Only reached by databases created before opt_out existed. Fresh ones get
    // the column from the CREATE above, so this is a no-op for them. Existing
    // rows default to 0: the sync decides opt-out for new inbound mail only,
    // and re-reading years of bodies to backfill is not worth the IMAP traffic.
    const interactionCols = this.db
      .prepare(`PRAGMA table_info(interactions)`)
      .all() as Array<{ name: string }>;
    if (!interactionCols.some((c) => c.name === "opt_out")) {
      this.db.exec(
        `ALTER TABLE interactions ADD COLUMN opt_out INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!interactionCols.some((c) => c.name === "opt_out_full")) {
      this.db.exec(
        `ALTER TABLE interactions ADD COLUMN opt_out_full INTEGER NOT NULL DEFAULT 0`,
      );
    }

    // Seed only into an empty table. A user who renamed or deleted a stage must
    // not have it grow back on the next start.
    const stageCount = this.db
      .prepare(`SELECT COUNT(*) as n FROM pipeline_stages`)
      .get() as { n: number };
    if (stageCount.n === 0) {
      const insert = this.db.prepare(
        `INSERT INTO pipeline_stages (id, name, position) VALUES (?, ?, ?)`,
      );
      const seed = this.db.transaction(() => {
        SEED_STAGES.forEach(([id, name], i) => insert.run(id, name, i));
      });
      seed();
    }
  }

  /* ---- organizations ---------------------------------------------------- */

  /**
   * Find-or-create by domain first, then by case-insensitive name. Domain is
   * the stronger key: two spellings of the same company ("Acme", "ACME Inc")
   * are one org when they share a mail domain.
   */
  upsertOrg(input: { name: string; domain?: string | null }): Organization {
    const domain = normalizeDomain(input.domain);
    const name = input.name.trim();
    if (!name) throw new Error("org name is required");

    const existing = domain
      ? this.getOrgByDomain(domain)
      : this.getOrgByName(name);
    if (existing) {
      this.db
        .prepare(
          `UPDATE organizations SET name = ?, domain = COALESCE(?, domain) WHERE id = ?`,
        )
        .run(name, domain, existing.id);
      return this.getOrg(existing.id) as Organization;
    }
    const org: Organization = {
      id: randomUUID(),
      name,
      domain,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO organizations (id, name, domain, created_at)
         VALUES (@id, @name, @domain, @createdAt)`,
      )
      .run(org);
    return org;
  }

  getOrg(id: string): Organization | null {
    return (
      (this.db
        .prepare(
          `SELECT id, name, domain, created_at as createdAt FROM organizations WHERE id = ?`,
        )
        .get(id) as Organization | undefined) ?? null
    );
  }

  getOrgByDomain(domain: string): Organization | null {
    return (
      (this.db
        .prepare(
          `SELECT id, name, domain, created_at as createdAt FROM organizations WHERE domain = ?`,
        )
        .get(domain.toLowerCase()) as Organization | undefined) ?? null
    );
  }

  getOrgByName(name: string): Organization | null {
    return (
      (this.db
        .prepare(
          `SELECT id, name, domain, created_at as createdAt FROM organizations
           WHERE lower(name) = lower(?) ORDER BY created_at ASC LIMIT 1`,
        )
        .get(name.trim()) as Organization | undefined) ?? null
    );
  }

  listOrgs(): Organization[] {
    return this.db
      .prepare(
        `SELECT id, name, domain, created_at as createdAt
         FROM organizations ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as Organization[];
  }

  /* ---- contacts --------------------------------------------------------- */

  /** True when this address already has a contact row. Email is lowercased. */
  isKnownContact(email: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 as hit FROM contacts WHERE email = ?`)
      .get(email.trim().toLowerCase()) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * Insert or update by lowercase email.
   *
   * The display-name rule is "keep the longest non-empty name seen" (spec):
   * mail gives you "j.smith@acme.com" one day and "Jane Smith" the next, and
   * the longer string is the one a human recognises. An explicit `name` from a
   * tool or the UI is not mail-derived, so `force` lets it win outright.
   */
  upsertContact(input: {
    email: string;
    name?: string | null;
    title?: string | null;
    orgId?: string | null;
    source?: string;
    /** Replace the stored name even when it is longer. */
    force?: boolean;
  }): Contact {
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) throw new Error(`invalid email: ${input.email}`);
    const now = new Date().toISOString();
    const existing = this.getContactByEmail(email);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO contacts (id, email, name, title, org_id, source, created_at, updated_at)
           VALUES (@id, @email, @name, @title, @orgId, @source, @now, @now)`,
        )
        .run({
          id: randomUUID(),
          email,
          name: emptyToNull(input.name),
          title: emptyToNull(input.title),
          orgId: input.orgId ?? null,
          source: input.source ?? "mail",
          now,
        });
      return this.getContactByEmail(email) as Contact;
    }

    const candidate = emptyToNull(input.name);
    const keepName =
      candidate === null
        ? existing.name
        : input.force || (existing.name ?? "").length < candidate.length
          ? candidate
          : existing.name;
    this.db
      .prepare(
        `UPDATE contacts
         SET name = @name,
             title = COALESCE(@title, title),
             org_id = COALESCE(@orgId, org_id),
             updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id: existing.id,
        name: keepName,
        title: emptyToNull(input.title),
        orgId: input.orgId ?? null,
        now,
      });
    return this.getContact(existing.id) as Contact;
  }

  getContact(id: string): Contact | null {
    return (
      (this.db
        .prepare(
          `SELECT ${CONTACT_COLUMNS}
           FROM contacts c LEFT JOIN organizations o ON o.id = c.org_id
           WHERE c.id = ?`,
        )
        .get(id) as ContactRow | undefined) ?? null
    );
  }

  getContactByEmail(email: string): Contact | null {
    return (
      (this.db
        .prepare(
          `SELECT ${CONTACT_COLUMNS}
           FROM contacts c LEFT JOIN organizations o ON o.id = c.org_id
           WHERE c.email = ?`,
        )
        .get(email.trim().toLowerCase()) as ContactRow | undefined) ?? null
    );
  }

  /**
   * Every contact whose address is at one domain, newest first.
   *
   * Exists for address-pattern inference, which needs the addresses a domain
   * is already known to write and the names they belong to. searchContacts
   * cannot answer it: its LIKE runs over the name and the org name too, so
   * "acme.com" there also matches a person called Acme and an org whose name
   * contains the domain, and a pattern learned from those is learned from
   * addresses at other companies.
   */
  contactsAtDomain(domain: string, limit?: number): Contact[] {
    const bare = domain.trim().toLowerCase().replace(/^@/, "");
    if (bare === "") return [];
    const sql = `SELECT ${CONTACT_COLUMNS}
      FROM contacts c LEFT JOIN organizations o ON o.id = c.org_id
      WHERE c.email LIKE ? ESCAPE '\\' COLLATE NOCASE
      ORDER BY c.updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(`%@${escapeLike(bare)}`, clampLimit(limit)) as ContactRow[];
  }

  /** Free-text over name, email and org name, optionally narrowed by tag. */
  searchContacts(
    opts: { query?: string; tag?: string; limit?: number } = {},
  ): Contact[] {
    const limit = clampLimit(opts.limit);
    const query = (opts.query ?? "").trim();
    const tag = (opts.tag ?? "").trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (query) {
      where.push(
        `(c.email LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR c.name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR o.name LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      const like = `%${escapeLike(query)}%`;
      params.push(like, like, like);
    }
    if (tag) {
      where.push(
        `EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag = ?)`,
      );
      params.push(tag);
    }
    const sql = `SELECT ${CONTACT_COLUMNS}
      FROM contacts c LEFT JOIN organizations o ON o.id = c.org_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit) as ContactRow[];
  }

  deleteContact(id: string): boolean {
    // The FK cascades are declared, but SQLite only honours them when
    // foreign_keys is ON — and the shared handle does not turn it on. Delete
    // the children explicitly so a removed contact leaves nothing behind.
    const drop = this.db.transaction((contactId: string) => {
      this.db.prepare(`DELETE FROM contact_tags WHERE contact_id = ?`).run(contactId);
      this.db.prepare(`DELETE FROM contact_intent WHERE contact_id = ?`).run(contactId);
      this.db.prepare(`DELETE FROM notes WHERE contact_id = ?`).run(contactId);
      this.db.prepare(`DELETE FROM interactions WHERE contact_id = ?`).run(contactId);
      this.db
        .prepare(`UPDATE deals SET contact_id = NULL WHERE contact_id = ?`)
        .run(contactId);
      return this.db.prepare(`DELETE FROM contacts WHERE id = ?`).run(contactId)
        .changes > 0;
    });
    return drop(id);
  }

  /* ---- tags ------------------------------------------------------------- */

  listTags(contactId: string): string[] {
    const rows = this.db
      .prepare(`SELECT tag FROM contact_tags WHERE contact_id = ? ORDER BY tag ASC`)
      .all(contactId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  /** Additive: tags already on the contact stay. Blank entries are dropped. */
  addTags(contactId: string, tags: readonly string[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)`,
    );
    const run = this.db.transaction(() => {
      for (const raw of tags) {
        const tag = String(raw).trim();
        if (tag) insert.run(contactId, tag);
      }
    });
    run();
  }

  removeTag(contactId: string, tag: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM contact_tags WHERE contact_id = ? AND tag = ?`)
        .run(contactId, tag).changes > 0
    );
  }

  /* ---- intent ----------------------------------------------------------- */

  /**
   * Replaces whatever intent the contact held. There is no additive form on
   * purpose: two intents at once is the ambiguity this table exists to remove.
   */
  setIntent(
    contactId: string,
    intent: ContactIntent,
    opts: { source?: string; note?: string; at?: Date } = {},
  ): ContactIntentRow {
    const row: ContactIntentRow = {
      contactId,
      intent,
      at: (opts.at ?? new Date()).toISOString(),
      source: opts.source ?? "agent",
      note: opts.note ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO contact_intent (contact_id, intent, at, source, note)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET
           intent = excluded.intent, at = excluded.at,
           source = excluded.source, note = excluded.note`,
      )
      .run(row.contactId, row.intent, row.at, row.source, row.note);
    return row;
  }

  getIntent(contactId: string): ContactIntentRow | null {
    const row = this.db
      .prepare(
        `SELECT contact_id as contactId, intent, at, source, note
           FROM contact_intent WHERE contact_id = ?`,
      )
      .get(contactId) as ContactIntentRow | undefined;
    return row ?? null;
  }

  clearIntent(contactId: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM contact_intent WHERE contact_id = ?`)
        .run(contactId).changes > 0
    );
  }

  /**
   * State for a page of contacts, worked out rather than stored. `tag` narrows
   * by label, which is all tags are used for now — targeting, never eligibility.
   */
  states(
    opts: { query?: string; tag?: string; limit?: number } = {},
    stateOpts: StateOpts = {},
  ): ContactState[] {
    const contacts = this.searchContacts({
      query: opts.query,
      tag: opts.tag,
      limit: opts.limit ?? 200,
    });
    return contactStates(
      this.db,
      contacts.map((c) => ({ id: c.id, email: c.email })),
      stateOpts,
    );
  }

  /* ---- notes ------------------------------------------------------------ */

  addNote(contactId: string, text: string): Note {
    const note: Note = {
      id: randomUUID(),
      contactId,
      at: new Date().toISOString(),
      text,
    };
    this.db
      .prepare(
        `INSERT INTO notes (id, contact_id, at, text_enc) VALUES (?, ?, ?, ?)`,
      )
      .run(note.id, contactId, note.at, encryptSecret(this.masterKey, text));
    return note;
  }

  listNotes(contactId: string, limit = 50): Note[] {
    const rows = this.db
      .prepare(
        `SELECT id, contact_id as contactId, at, text_enc as textEnc
         FROM notes WHERE contact_id = ? ORDER BY at DESC LIMIT ?`,
      )
      .all(contactId, clampLimit(limit)) as Array<{
      id: string;
      contactId: string;
      at: string;
      textEnc: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      at: r.at,
      text: decryptSecret(this.masterKey, r.textEnc),
    }));
  }

  deleteNote(id: string): boolean {
    return this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(id).changes > 0;
  }

  /* ---- interactions ----------------------------------------------------- */

  /**
   * Record one message against one contact. Returns false when the row already
   * existed — the derivation walks the same 200 messages every 10 minutes, so
   * "already seen" is the normal case, not an error.
   */
  addInteraction(input: {
    contactId: string;
    accountId: string;
    messageId: string;
    direction: "in" | "out";
    at: string;
    subject?: string | null;
    snippet?: string | null;
    optOut?: boolean;
    fromBody?: boolean;
  }): boolean {
    const optOut = input.optOut ? 1 : 0;
    const fromBody = input.fromBody ? 1 : 0;
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO interactions
           (id, contact_id, account_id, message_id, direction, at, subject_enc, snippet_enc, opt_out, opt_out_full)
         VALUES (@id, @contactId, @accountId, @messageId, @direction, @at, @subjectEnc, @snippetEnc, @optOut, @fromBody)`,
      )
      .run({
        id: randomUUID(),
        contactId: input.contactId,
        accountId: input.accountId,
        messageId: input.messageId,
        direction: input.direction,
        at: input.at,
        subjectEnc: this.encNullable(input.subject),
        snippetEnc: this.encNullable(input.snippet),
        optOut,
        fromBody,
      });
    // A row that already existed keeps its text but takes the flag when the
    // caller now knows better — a first pass that only saw a truncated snippet
    // must be repairable. Never the other way round: an opt-out already
    // recorded is a standing request, not something a later read can clear.
    if (res.changes === 0 && (optOut === 1 || fromBody === 1)) {
      this.db
        .prepare(
          `UPDATE interactions
              SET opt_out = CASE WHEN @optOut = 1 THEN 1 ELSE opt_out END,
                  opt_out_full = CASE WHEN @fromBody = 1 THEN 1 ELSE opt_out_full END
            WHERE account_id = @accountId AND message_id = @messageId
              AND contact_id = @contactId`,
        )
        .run({
          optOut,
          fromBody,
          accountId: input.accountId,
          messageId: input.messageId,
          contactId: input.contactId,
        });
    }
    return res.changes > 0;
  }

  /**
   * Should this inbound message still be fetched for opt-out? A stored 0 that
   * came from a full body is a judgement and is not revisited (IMAP cost, and
   * so a human who cleared the flags is not second-guessed). A stored 0 from
   * a failed or empty fetch is not a judgement — the next walk tries again.
   */
  needsOptOutDecision(
    accountId: string,
    messageId: string,
    contactId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT opt_out as optOut, opt_out_full as optOutFull FROM interactions
         WHERE account_id = ? AND message_id = ? AND contact_id = ?`,
      )
      .get(accountId, messageId, contactId) as
      | { optOut: number; optOutFull: number }
      | undefined;
    if (!row) return true;
    return row.optOut !== 1 && row.optOutFull !== 1;
  }

  /**
   * Contact ids whose mailbox matches `email` after canonicalEmail. Used by
   * un-suppress so the CRM flags move with the human's decision.
   */
  contactIdsForEmail(email: string): string[] {
    const canonical = canonicalEmail(email);
    const contacts = this.db
      .prepare(`SELECT id, email FROM contacts`)
      .all() as Array<{ id: string; email: string }>;
    return contacts
      .filter((c) => canonicalEmail(c.email) === canonical)
      .map((c) => c.id);
  }

  /**
   * Withdraw the stored opt-out flags for one mailbox. Called when a human
   * removes the suppression: the flag is derived data standing in for "they
   * asked us to stop", and the human has just ruled that request answered.
   * Without this, the windowed reply check would re-suppress from the same
   * old rows. A NEW "stop" writes a new flagged row and suppresses again.
   * Matching is canonical, so the unicode and punycode spellings both clear.
   */
  clearOptOutFlags(email: string): number {
    const ids = this.contactIdsForEmail(email);
    let cleared = 0;
    for (const id of ids) {
      // Mark the row body-complete so the next sync does not re-fetch the
      // same mail and resurrect the suppression the human just removed.
      cleared += this.db
        .prepare(
          `UPDATE interactions
              SET opt_out = 0, opt_out_full = 1
            WHERE contact_id = ? AND opt_out = 1`,
        )
        .run(id).changes;
    }
    return cleared;
  }

  listInteractions(contactId: string, limit = 50): Interaction[] {
    const rows = this.db
      .prepare(
        `SELECT id, contact_id as contactId, account_id as accountId,
                message_id as messageId, direction, at,
                subject_enc as subjectEnc, snippet_enc as snippetEnc,
                opt_out as optOut
         FROM interactions WHERE contact_id = ? ORDER BY at DESC LIMIT ?`,
      )
      .all(contactId, clampLimit(limit)) as InteractionRow[];
    return rows.map((r) => this.decodeInteraction(r));
  }

  /**
   * Interactions after `since`, newest first. The outreach engine's reply and
   * opt-out checks read inbound mail that landed after the last send, so the
   * cutoff and the direction filter both belong in SQL, not in the caller.
   */
  interactionsSince(
    contactId: string,
    since: string,
    direction?: "in" | "out",
  ): Interaction[] {
    const rows = this.db
      .prepare(
        `SELECT id, contact_id as contactId, account_id as accountId,
                message_id as messageId, direction, at,
                subject_enc as subjectEnc, snippet_enc as snippetEnc,
                opt_out as optOut
         FROM interactions
         WHERE contact_id = ? AND at > ? AND (? IS NULL OR direction = ?)
         ORDER BY at DESC`,
      )
      .all(contactId, since, direction ?? null, direction ?? null) as InteractionRow[];
    return rows.map((r) => this.decodeInteraction(r));
  }

  /* ---- pipeline --------------------------------------------------------- */

  listStages(): PipelineStage[] {
    return this.db
      .prepare(`SELECT id, name, position FROM pipeline_stages ORDER BY position ASC`)
      .all() as PipelineStage[];
  }

  getStage(id: string): PipelineStage | null {
    return (
      (this.db
        .prepare(`SELECT id, name, position FROM pipeline_stages WHERE id = ?`)
        .get(id) as PipelineStage | undefined) ?? null
    );
  }

  listDeals(stageId?: string): Deal[] {
    const sql = `SELECT id, title, contact_id as contactId, org_id as orgId,
        stage_id as stageId, value, currency, position,
        created_at as createdAt, updated_at as updatedAt
      FROM deals ${stageId ? "WHERE stage_id = ?" : ""}
      ORDER BY position ASC, created_at ASC`;
    return (
      stageId
        ? this.db.prepare(sql).all(stageId)
        : this.db.prepare(sql).all()
    ) as Deal[];
  }

  getDeal(id: string): Deal | null {
    return (
      (this.db
        .prepare(
          `SELECT id, title, contact_id as contactId, org_id as orgId,
                  stage_id as stageId, value, currency, position,
                  created_at as createdAt, updated_at as updatedAt
           FROM deals WHERE id = ?`,
        )
        .get(id) as Deal | undefined) ?? null
    );
  }

  dealsForContact(contactId: string): Deal[] {
    return this.db
      .prepare(
        `SELECT id, title, contact_id as contactId, org_id as orgId,
                stage_id as stageId, value, currency, position,
                created_at as createdAt, updated_at as updatedAt
         FROM deals WHERE contact_id = ? ORDER BY updated_at DESC`,
      )
      .all(contactId) as Deal[];
  }

  /** Stages in board order, each carrying its deals in board order. */
  pipeline(): PipelineBoard {
    const deals = this.listDeals();
    return this.listStages().map((stage) => ({
      ...stage,
      deals: deals.filter((d) => d.stageId === stage.id),
    }));
  }

  /**
   * Create when `dealId` is absent, patch when it is present. Returns null for
   * an unknown dealId so the caller can answer 404 instead of silently
   * creating a second deal under a typo'd id.
   */
  upsertDeal(input: {
    dealId?: string | null;
    title?: string;
    contactId?: string | null;
    orgId?: string | null;
    stageId?: string | null;
    value?: number | null;
    currency?: string | null;
  }): Deal | null {
    const now = new Date().toISOString();
    if (input.dealId) {
      const existing = this.getDeal(input.dealId);
      if (!existing) return null;
      const stageId = input.stageId ?? existing.stageId;
      if (!this.getStage(stageId)) throw new Error(`unknown stage: ${stageId}`);
      this.db
        .prepare(
          `UPDATE deals SET title = @title, contact_id = @contactId, org_id = @orgId,
             stage_id = @stageId, value = @value, currency = @currency, updated_at = @now
           WHERE id = @id`,
        )
        .run({
          id: existing.id,
          title: input.title?.trim() || existing.title,
          contactId:
            input.contactId === undefined ? existing.contactId : input.contactId,
          orgId: input.orgId === undefined ? existing.orgId : input.orgId,
          stageId,
          value: input.value === undefined ? existing.value : input.value,
          currency:
            input.currency === undefined ? existing.currency : input.currency,
          now,
        });
      if (stageId !== existing.stageId) this.reindexStage(existing.stageId);
      return this.getDeal(existing.id);
    }

    const title = (input.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const stageId = input.stageId ?? "lead";
    if (!this.getStage(stageId)) throw new Error(`unknown stage: ${stageId}`);
    const id = randomUUID();
    const tail = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) as max FROM deals WHERE stage_id = ?`)
      .get(stageId) as { max: number };
    this.db
      .prepare(
        `INSERT INTO deals (id, title, contact_id, org_id, stage_id, value, currency,
           position, created_at, updated_at)
         VALUES (@id, @title, @contactId, @orgId, @stageId, @value, @currency,
           @position, @now, @now)`,
      )
      .run({
        id,
        title,
        contactId: input.contactId ?? null,
        orgId: input.orgId ?? null,
        stageId,
        value: input.value ?? null,
        currency: input.currency ?? null,
        position: tail.max + 1,
        now,
      });
    return this.getDeal(id);
  }

  /**
   * Move a deal to `stageId`, optionally at a given index within it. Both the
   * old and the new column are renumbered, so board order never carries gaps
   * or ties that would make the next drag land somewhere unexpected.
   */
  moveDeal(dealId: string, stageId: string, position?: number): Deal | null {
    const deal = this.getDeal(dealId);
    if (!deal) return null;
    if (!this.getStage(stageId)) throw new Error(`unknown stage: ${stageId}`);
    const now = new Date().toISOString();

    const move = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE deals SET stage_id = ?, updated_at = ? WHERE id = ?`)
        .run(stageId, now, dealId);
      const ordered = this.listDeals(stageId)
        .map((d) => d.id)
        .filter((id) => id !== dealId);
      const at =
        position === undefined || Number.isNaN(position)
          ? ordered.length
          : Math.min(Math.max(Math.trunc(position), 0), ordered.length);
      ordered.splice(at, 0, dealId);
      const write = this.db.prepare(`UPDATE deals SET position = ? WHERE id = ?`);
      ordered.forEach((id, i) => write.run(i, id));
      if (stageId !== deal.stageId) this.reindexStage(deal.stageId);
    });
    move();
    return this.getDeal(dealId);
  }

  deleteDeal(id: string): boolean {
    const deal = this.getDeal(id);
    if (!deal) return false;
    this.db.prepare(`DELETE FROM deals WHERE id = ?`).run(id);
    this.reindexStage(deal.stageId);
    return true;
  }

  /** Contact plus everything hanging off it, decrypted. */
  contactDetail(
    ref: { contactId?: string; email?: string },
    opts: { interactionLimit?: number } = {},
  ): ContactDetail | null {
    const contact = ref.contactId
      ? this.getContact(ref.contactId)
      : ref.email
        ? this.getContactByEmail(ref.email)
        : null;
    if (!contact) return null;
    return {
      contact,
      tags: this.listTags(contact.id),
      notes: this.listNotes(contact.id),
      interactions: this.listInteractions(contact.id, opts.interactionLimit ?? 50),
      deals: this.dealsForContact(contact.id),
      state: contactState(this.db, { id: contact.id, email: contact.email }),
    };
  }

  /* ---- internals -------------------------------------------------------- */

  private reindexStage(stageId: string): void {
    const write = this.db.prepare(`UPDATE deals SET position = ? WHERE id = ?`);
    this.listDeals(stageId).forEach((d, i) => write.run(i, d.id));
  }

  private encNullable(value: string | null | undefined): string | null {
    const text = emptyToNull(value);
    return text === null ? null : encryptSecret(this.masterKey, text);
  }

  private decodeInteraction(row: InteractionRow): Interaction {
    return {
      id: row.id,
      contactId: row.contactId,
      accountId: row.accountId,
      messageId: row.messageId,
      direction: row.direction,
      at: row.at,
      subject: row.subjectEnc ? decryptSecret(this.masterKey, row.subjectEnc) : null,
      snippet: row.snippetEnc ? decryptSecret(this.masterKey, row.snippetEnc) : null,
      optOut: row.optOut === 1,
    };
  }
}

/** Highest number of rows any CRM read returns, mirroring MAX_LIMIT in the API. */
const MAX_ROWS = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ROWS);
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeDomain(domain: string | null | undefined): string | null {
  const value = emptyToNull(domain);
  return value === null ? null : value.toLowerCase();
}

/**
 * LIKE treats % and _ as wildcards, and an address contains both often enough
 * ("jane_doe@x.com"). Escaped with backslash, matching the ESCAPE '\' in the
 * search query — replacing them would silently widen the search instead.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

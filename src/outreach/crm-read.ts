/**
 * Read-only SQL against the CRM tables (owned by src/crm/store.ts).
 *
 * The outreach engine needs contact identity and inbound interactions to
 * substitute templates and to detect replies/opt-outs, and the spec gives it
 * CrmStore as a constructor dep for exactly that. Everything here is SELECT
 * only: outreach never writes CRM rows.
 */
import type Database from "better-sqlite3";

export type CrmContact = {
  id: string;
  email: string;
  name: string | null;
  org: string | null;
};

export type InboundInteraction = {
  at: string;
  subjectEnc: string | null;
  snippetEnc: string | null;
};

/**
 * The CRM module owns the DDL, so in a process where its store has not run
 * (or a harness that wires outreach alone) the tables are simply absent. A
 * missing table must not throw out of the hourly tick, so every read checks.
 */
function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

const CONTACT_SELECT = `
  SELECT c.id AS id, c.email AS email, c.name AS name, o.name AS org
    FROM contacts c
    LEFT JOIN organizations o ON o.id = c.org_id
`;

export function readContact(
  db: Database.Database,
  contactId: string,
): CrmContact | null {
  if (!hasTable(db, "contacts")) return null;
  const row = db.prepare(`${CONTACT_SELECT} WHERE c.id = ?`).get(contactId) as
    | CrmContact
    | undefined;
  return row ?? null;
}

export function readContacts(
  db: Database.Database,
  contactIds: string[],
): CrmContact[] {
  if (!hasTable(db, "contacts") || contactIds.length === 0) return [];
  const holes = contactIds.map(() => "?").join(", ");
  return db
    .prepare(`${CONTACT_SELECT} WHERE c.id IN (${holes})`)
    .all(...contactIds) as CrmContact[];
}

/** Inbound interactions strictly after `sinceIso`, newest first. */
export function inboundSince(
  db: Database.Database,
  contactId: string,
  sinceIso: string,
): InboundInteraction[] {
  if (!hasTable(db, "interactions")) return [];
  return db
    .prepare(
      `SELECT at, subject_enc AS subjectEnc, snippet_enc AS snippetEnc
         FROM interactions
        WHERE contact_id = ? AND direction = 'in' AND at > ?
        ORDER BY at DESC`,
    )
    .all(contactId, sinceIso) as InboundInteraction[];
}

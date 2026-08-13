/**
 * CRM tables and queries. DDL and derivation rules: docs/specs/agent-platform.md.
 *
 * Owns: organizations, contacts, contact_tags, notes, interactions,
 * pipeline_stages, deals. Mail-derived text (subjects, snippets, notes) is
 * stored encrypted via encryptSecret; identity fields stay plaintext.
 */
import type Database from "better-sqlite3";

export class CrmStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    // TODO(crm): CREATE TABLE IF NOT EXISTS per the spec DDL, and seed
    // pipeline_stages (lead, contacted, replied, won, lost) only when empty.
  }

  /** True when the (lowercased) address is on nobody's radar — placeholder. */
  isKnownContact(_email: string): boolean {
    // TODO(crm)
    return false;
  }
}

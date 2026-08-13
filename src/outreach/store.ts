/**
 * Outreach tables and queries. DDL: docs/specs/agent-platform.md.
 * Owns: campaigns, sequence_steps, campaign_contacts, outbox, suppression.
 * Subjects and bodies are encrypted (_enc).
 */
import type Database from "better-sqlite3";

export class OutreachStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    // TODO(outreach): CREATE TABLE IF NOT EXISTS per the spec DDL.
  }

  /** Send-guard check; email compared lowercase. */
  isSuppressed(_email: string): boolean {
    // TODO(outreach)
    return false;
  }
}

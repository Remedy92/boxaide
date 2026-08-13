/**
 * Automation tables and queries. DDL: docs/specs/agent-platform.md.
 * Owns: automations, automation_runs. Run logs are encrypted (log_enc) —
 * agent output quotes mail content.
 */
import type Database from "better-sqlite3";

export class AutomationStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    // TODO(automation): CREATE TABLE IF NOT EXISTS per the spec DDL.
  }
}

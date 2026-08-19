/**
 * Connector keys on disk. Owns one table: connectors (one row per provider
 * id, the API key encrypted with the master key).
 *
 * Encrypted whole, the same way calendar_accounts keeps a Google refresh
 * token: the ciphertext is never a lookup key, the provider id is, and the id
 * is public. A read decrypts; a failed decrypt is reported as "not
 * configured" rather than thrown, because a rotated master key must not take
 * the settings screen down with it.
 */
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import { maskKey } from "./types.js";

type ConnectorRow = { id: string; key_enc: string; updated_at: string };

export class ConnectorStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        key_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** Decrypted key. Never leaves the server process. */
  getKey(id: string): string | null {
    const row = this.db
      .prepare(`SELECT * FROM connectors WHERE id = ?`)
      .get(id) as ConnectorRow | undefined;
    if (!row) return null;
    try {
      const key = decryptSecret(this.masterKey, row.key_enc);
      return key === "" ? null : key;
    } catch {
      return null;
    }
  }

  /** Last four characters of the stored key, for the REST read. */
  maskedKey(id: string): string | null {
    const key = this.getKey(id);
    return key === null ? null : maskKey(key);
  }

  setKey(id: string, apiKey: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO connectors (id, key_enc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET key_enc = excluded.key_enc, updated_at = excluded.updated_at`,
      )
      .run(id, encryptSecret(this.masterKey, apiKey), now);
  }

  /** True when a row was there to remove. */
  clearKey(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM connectors WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}

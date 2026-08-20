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
import { maskKey, type ConnectorCheck } from "./types.js";

type ConnectorRow = { id: string; key_enc: string; updated_at: string };

type CheckRow = {
  id: string;
  verdict: string;
  reason: string | null;
  masked_key: string;
  checked_at: string;
};

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
      CREATE TABLE IF NOT EXISTS connector_checks (
        id TEXT PRIMARY KEY,
        verdict TEXT NOT NULL,
        reason TEXT,
        masked_key TEXT NOT NULL,
        checked_at TEXT NOT NULL
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

  /**
   * The last verdict a provider gave about this connector, if there is one.
   *
   * Its own table rather than columns on `connectors`: a key set where the
   * server was started has no row there to hang a verdict on, and that key is
   * exactly as likely to be wrong as a pasted one.
   */
  getCheck(id: string): ConnectorCheck | null {
    const row = this.db
      .prepare(`SELECT * FROM connector_checks WHERE id = ?`)
      .get(id) as CheckRow | undefined;
    if (!row) return null;
    if (row.verdict !== "works" && row.verdict !== "rejected" && row.verdict !== "unreachable") {
      return null;
    }
    return {
      verdict: row.verdict,
      reason: row.reason,
      checkedAt: row.checked_at,
      maskedKey: row.masked_key,
    };
  }

  setCheck(id: string, check: ConnectorCheck): void {
    this.db
      .prepare(
        `INSERT INTO connector_checks (id, verdict, reason, masked_key, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           verdict = excluded.verdict,
           reason = excluded.reason,
           masked_key = excluded.masked_key,
           checked_at = excluded.checked_at`,
      )
      .run(id, check.verdict, check.reason, check.maskedKey, check.checkedAt);
  }

  /** Forget the verdict. Called whenever the key it was about changes. */
  clearCheck(id: string): void {
    this.db.prepare(`DELETE FROM connector_checks WHERE id = ?`).run(id);
  }
}

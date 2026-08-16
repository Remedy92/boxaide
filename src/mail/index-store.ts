/**
 * Local message-summary index. Lists and the tray read this; IMAP only fills
 * gaps. Envelope text is encrypted at rest the same way agent turns are.
 */
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import type { MailMessageSummary } from "../provider/types.js";
import type { MailboxCursor, MailboxSyncResult } from "../provider/types.js";

/** Paint from SQLite; IMAP only if older than this or marked dirty. */
export const MAIL_INDEX_STALE_MS = 30_000;

export type MailboxState = {
  accountId: string;
  folder: string;
  uidvalidity: number;
  highestModseq: string | null;
  uidnext: number | null;
  exists: number;
  dirty: boolean;
  syncedAt: string | null;
  lastError: string | null;
};

type SummaryRow = {
  accountId: string;
  folder: string;
  uid: number;
  id: string;
  messageIdEnc: string | null;
  fromEnc: string;
  toEnc: string;
  subjectEnc: string;
  snippetEnc: string;
  date: string;
  seen: number;
  hasAttachments: number;
};

export class MailIndexStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_state (
        account_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uidvalidity INTEGER NOT NULL,
        highest_modseq TEXT,
        uidnext INTEGER,
        exists_count INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        last_error TEXT,
        PRIMARY KEY (account_id, folder)
      );
      CREATE TABLE IF NOT EXISTS message_summaries (
        account_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        id TEXT NOT NULL,
        message_id_enc TEXT,
        from_enc TEXT NOT NULL,
        to_enc TEXT NOT NULL,
        subject_enc TEXT NOT NULL,
        snippet_enc TEXT NOT NULL,
        date TEXT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, folder, uid)
      );
      CREATE INDEX IF NOT EXISTS message_summaries_account_folder_date
        ON message_summaries (account_id, folder, date DESC);
      DROP INDEX IF EXISTS message_summaries_date;
    `);
  }

  getState(accountId: string, folder: string): MailboxState | null {
    const row = this.db
      .prepare(
        `SELECT account_id as accountId, folder, uidvalidity,
                highest_modseq as highestModseq, uidnext,
                exists_count as existsCount, dirty, synced_at as syncedAt,
                last_error as lastError
         FROM mailbox_state WHERE account_id = ? AND folder = ?`,
      )
      .get(accountId, folder) as
      | {
          accountId: string;
          folder: string;
          uidvalidity: number;
          highestModseq: string | null;
          uidnext: number | null;
          existsCount: number;
          dirty: number;
          syncedAt: string | null;
          lastError: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      accountId: row.accountId,
      folder: row.folder,
      uidvalidity: row.uidvalidity,
      highestModseq: row.highestModseq,
      uidnext: row.uidnext,
      exists: row.existsCount,
      dirty: row.dirty === 1,
      syncedAt: row.syncedAt,
      lastError: row.lastError,
    };
  }

  count(accountId: string, folder: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM message_summaries
         WHERE account_id = ? AND folder = ?`,
      )
      .get(accountId, folder) as { n: number };
    return row.n;
  }

  isStale(state: MailboxState | null, now = Date.now()): boolean {
    if (!state?.syncedAt) return true;
    return now - Date.parse(state.syncedAt) > MAIL_INDEX_STALE_MS;
  }

  markDirty(accountId: string, folder: string): void {
    this.db
      .prepare(
        `UPDATE mailbox_state SET dirty = 1 WHERE account_id = ? AND folder = ?`,
      )
      .run(accountId, folder);
  }

  setLastError(accountId: string, folder: string, error: string | null): void {
    this.db
      .prepare(
        `UPDATE mailbox_state SET last_error = ? WHERE account_id = ? AND folder = ?`,
      )
      .run(error, accountId, folder);
  }

  listMessages(opts: {
    accountIds: string[];
    folder: string;
    limit: number;
    offset?: number;
    unreadOnly?: boolean;
  }): MailMessageSummary[] {
    if (opts.accountIds.length === 0) return [];
    const placeholders = opts.accountIds.map(() => "?").join(", ");
    const unread = opts.unreadOnly ? "AND seen = 0" : "";
    const rows = this.db
      .prepare(
        `SELECT account_id as accountId, folder, uid, id, message_id_enc as messageIdEnc,
                from_enc as fromEnc, to_enc as toEnc, subject_enc as subjectEnc,
                snippet_enc as snippetEnc, date, seen, has_attachments as hasAttachments
         FROM message_summaries
         WHERE account_id IN (${placeholders}) AND folder = ? ${unread}
         ORDER BY date DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        ...opts.accountIds,
        opts.folder,
        opts.limit,
        opts.offset ?? 0,
      ) as SummaryRow[];
    const summaries: MailMessageSummary[] = [];
    for (const row of rows) {
      const summary = this.toSummary(row);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  listUids(accountId: string, folder: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT uid FROM message_summaries WHERE account_id = ? AND folder = ?`,
      )
      .all(accountId, folder) as Array<{ uid: number }>;
    return rows.map((row) => row.uid);
  }

  applySync(
    accountId: string,
    folder: string,
    result: MailboxSyncResult,
  ): void {
    const run = this.db.transaction(() => {
      if (result.replaced) {
        this.db
          .prepare(
            `DELETE FROM message_summaries WHERE account_id = ? AND folder = ?`,
          )
          .run(accountId, folder);
      } else {
        for (const uid of result.vanishedUids) {
          this.db
            .prepare(
              `DELETE FROM message_summaries
               WHERE account_id = ? AND folder = ? AND uid = ?`,
            )
            .run(accountId, folder, uid);
        }
        for (const flag of result.flagUpdates) {
          this.db
            .prepare(
              `UPDATE message_summaries SET seen = ?
               WHERE account_id = ? AND folder = ? AND uid = ?`,
            )
            .run(flag.seen ? 1 : 0, accountId, folder, flag.uid);
        }
      }
      for (const msg of result.messages) {
        this.upsertSummary(msg);
      }
      this.writeState(accountId, folder, result.cursor, false, null);
    });
    run();
  }

  setSeen(accountId: string, messageId: string, seen: boolean): void {
    this.db
      .prepare(
        `UPDATE message_summaries SET seen = ? WHERE account_id = ? AND id = ?`,
      )
      .run(seen ? 1 : 0, accountId, messageId);
  }

  upsertSummary(msg: MailMessageSummary): void {
    this.db
      .prepare(
        `INSERT INTO message_summaries (
           account_id, folder, uid, id, message_id_enc, from_enc, to_enc,
           subject_enc, snippet_enc, date, seen, has_attachments
         ) VALUES (
           @accountId, @folder, @uid, @id, @messageIdEnc, @fromEnc, @toEnc,
           @subjectEnc, @snippetEnc, @date, @seen, @hasAttachments
         )
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
           id=excluded.id,
           message_id_enc=excluded.message_id_enc,
           from_enc=excluded.from_enc,
           to_enc=excluded.to_enc,
           subject_enc=excluded.subject_enc,
           snippet_enc=excluded.snippet_enc,
           date=excluded.date,
           seen=excluded.seen,
           has_attachments=excluded.has_attachments`,
      )
      .run({
        accountId: msg.accountId,
        folder: msg.folder,
        uid: msg.uid,
        id: msg.id,
        messageIdEnc: msg.messageId
          ? encryptSecret(this.masterKey, msg.messageId)
          : null,
        fromEnc: encryptSecret(this.masterKey, msg.from),
        toEnc: encryptSecret(this.masterKey, msg.to),
        subjectEnc: encryptSecret(this.masterKey, msg.subject),
        snippetEnc: encryptSecret(this.masterKey, msg.snippet),
        date: msg.date,
        seen: msg.seen ? 1 : 0,
        hasAttachments: msg.hasAttachments ? 1 : 0,
      });
  }

  deleteAccount(accountId: string): void {
    this.db
      .prepare(`DELETE FROM message_summaries WHERE account_id = ?`)
      .run(accountId);
    this.db
      .prepare(`DELETE FROM mailbox_state WHERE account_id = ?`)
      .run(accountId);
  }

  private writeState(
    accountId: string,
    folder: string,
    cursor: MailboxCursor,
    dirty: boolean,
    lastError: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO mailbox_state (
           account_id, folder, uidvalidity, highest_modseq, uidnext,
           exists_count, dirty, synced_at, last_error
         ) VALUES (
           @accountId, @folder, @uidvalidity, @highestModseq, @uidnext,
           @exists, @dirty, @syncedAt, @lastError
         )
         ON CONFLICT(account_id, folder) DO UPDATE SET
           uidvalidity=excluded.uidvalidity,
           highest_modseq=excluded.highest_modseq,
           uidnext=excluded.uidnext,
           exists_count=excluded.exists_count,
           dirty=excluded.dirty,
           synced_at=excluded.synced_at,
           last_error=excluded.last_error`,
      )
      .run({
        accountId,
        folder,
        uidvalidity: cursor.uidvalidity,
        highestModseq: cursor.highestModseq,
        uidnext: cursor.uidnext,
        exists: cursor.exists,
        dirty: dirty ? 1 : 0,
        syncedAt: new Date().toISOString(),
        lastError,
      });
  }

  private toSummary(row: SummaryRow): MailMessageSummary | null {
    try {
      return {
        id: row.id,
        accountId: row.accountId,
        uid: row.uid,
        messageId: row.messageIdEnc
          ? decryptSecret(this.masterKey, row.messageIdEnc)
          : undefined,
        folder: row.folder,
        from: decryptSecret(this.masterKey, row.fromEnc),
        to: decryptSecret(this.masterKey, row.toEnc),
        subject: decryptSecret(this.masterKey, row.subjectEnc),
        date: row.date,
        snippet: decryptSecret(this.masterKey, row.snippetEnc),
        seen: row.seen === 1,
        hasAttachments: row.hasAttachments === 1,
      };
    } catch (err) {
      console.warn(
        `[mail-index] failed to decrypt row ${row.accountId}:${row.folder}:${row.uid}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}

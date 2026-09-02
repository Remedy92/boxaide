/**
 * Local message-summary index. Lists and the tray read this; IMAP only fills
 * gaps. Envelope text is encrypted at rest the same way agent turns are.
 */
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import type { FolderUnread, MailMessageSummary } from "../provider/types.js";
import type { MailboxCursor, MailboxSyncResult } from "../provider/types.js";

/** Paint from SQLite; IMAP only if older than this or marked dirty. */
export const MAIL_INDEX_STALE_MS = 30_000;

/** The earlier of two ISO instants, ignoring nulls and unparseable input. */
function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isNaN(at)) return b;
  if (Number.isNaN(bt)) return a;
  return at <= bt ? a : b;
}

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
  /**
   * Earliest instant this folder is known complete for. A `since` list older
   * than this has to ask IMAP; anything at or after it the index can answer
   * on its own.
   */
  coveredSince: string | null;
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
  internalDate: string | null;
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
        covered_since TEXT,
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
        internal_date TEXT,
        seen INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, folder, uid)
      );
      CREATE INDEX IF NOT EXISTS message_summaries_account_folder_date
        ON message_summaries (account_id, folder, date DESC);
      -- The primary key is (account_id, folder, uid), so every lookup that
      -- knows only the message id — mark read, and now the delete an archive
      -- leaves behind — scans the account's whole index without this.
      CREATE INDEX IF NOT EXISTS message_summaries_account_id
        ON message_summaries (account_id, id);
      DROP INDEX IF EXISTS message_summaries_date;
    `);
    // Columns added after the first release. SQLite has no ADD COLUMN IF NOT
    // EXISTS, so ask what the table already has.
    const columns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(message_summaries)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!columns.has("internal_date")) {
      this.db.exec(`ALTER TABLE message_summaries ADD COLUMN internal_date TEXT`);
    }
    const stateColumns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(mailbox_state)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!stateColumns.has("covered_since")) {
      this.db.exec(`ALTER TABLE mailbox_state ADD COLUMN covered_since TEXT`);
    }
  }

  getState(accountId: string, folder: string): MailboxState | null {
    const row = this.db
      .prepare(
        `SELECT account_id as accountId, folder, uidvalidity,
                highest_modseq as highestModseq, uidnext,
                exists_count as existsCount, dirty, synced_at as syncedAt,
                last_error as lastError, covered_since as coveredSince
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
          coveredSince: string | null;
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
      coveredSince: row.coveredSince,
    };
  }

  /**
   * True when a `since` list has to hit IMAP first: the index has never been
   * filled by date, or only back to a later instant than the caller asked for.
   */
  needsSinceFill(state: MailboxState | null, since: string): boolean {
    if (!state?.coveredSince) return true;
    const covered = Date.parse(state.coveredSince);
    const asked = Date.parse(since);
    if (Number.isNaN(covered) || Number.isNaN(asked)) return true;
    return covered > asked;
  }

  /**
   * How many rows this folder holds, counted no further than `cap`.
   *
   * The only caller asks whether the index already reaches a requested window,
   * so an exact count of a 20k-message Archive is 20k rows walked to answer a
   * question that `cap` rows settle. Omit `cap` for the true count.
   */
  count(accountId: string, folder: string, cap?: number): number {
    if (cap === undefined) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as n FROM message_summaries
           WHERE account_id = ? AND folder = ?`,
        )
        .get(accountId, folder) as { n: number };
      return row.n;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM (
           SELECT 1 FROM message_summaries
           WHERE account_id = ? AND folder = ? LIMIT ?
         )`,
      )
      .get(accountId, folder, cap) as { n: number };
    return row.n;
  }

  /**
   * Unread per folder for one account, for the rail's badges.
   *
   * Driven off mailbox_state, NOT off a GROUP BY over message_summaries. A
   * GROUP BY returns no row for a synced folder that happens to hold nothing
   * unread, which is indistinguishable from a folder the index has never
   * synced at all, and confusing those two is the one thing the badge must
   * never do: a confident "0" over a folder holding 400 unread destroys trust
   * in every other count on screen. A mailbox_state row exists only once
   * applySync has written one, so its presence is exactly "has been synced",
   * and the returned Map holds a key ONLY for folders that qualify. A folder
   * absent from the Map is unknown, not empty.
   *
   * `exact: false` means the index holds only a window of the folder, fewer
   * rows than the server's EXISTS. `count` is then a floor, at least this many
   * and possibly more, and the caller has to render it as "at least" rather
   * than as the total.
   *
   * No schema change and no new index: message_summaries_account_folder_date
   * already gives each subquery a prefix scan over (account_id, folder).
   */
  unreadByFolder(accountId: string): Map<string, FolderUnread> {
    const rows = this.db
      .prepare(
        `SELECT s.folder AS folder,
                s.exists_count AS existsCount,
                (SELECT COUNT(*) FROM message_summaries m
                  WHERE m.account_id = s.account_id AND m.folder = s.folder) AS indexed,
                (SELECT COUNT(*) FROM message_summaries m
                  WHERE m.account_id = s.account_id AND m.folder = s.folder
                    AND m.seen = 0) AS unread
           FROM mailbox_state s
          WHERE s.account_id = ?`,
      )
      .all(accountId) as Array<{
      folder: string;
      existsCount: number;
      indexed: number;
      unread: number;
    }>;
    const out = new Map<string, FolderUnread>();
    for (const row of rows) {
      out.set(row.folder, {
        count: row.unread,
        exact: row.indexed >= row.existsCount,
      });
    }
    return out;
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
        `INSERT INTO mailbox_state (
           account_id, folder, uidvalidity, highest_modseq, uidnext,
           exists_count, dirty, synced_at, last_error, covered_since
         ) VALUES (
           ?, ?, 0, null, null, 0, 0, null, ?, null
         )
         ON CONFLICT(account_id, folder) DO UPDATE SET last_error = excluded.last_error`,
      )
      .run(accountId, folder, error);
  }

  listMessages(opts: {
    accountIds: string[];
    folder: string;
    limit: number;
    offset?: number;
    unreadOnly?: boolean;
    since?: string;
  }): MailMessageSummary[] {
    if (opts.accountIds.length === 0) return [];
    const unread = opts.unreadOnly ? "AND seen = 0" : "";
    // Receive time first, for the same reason the provider prefers it: a
    // sender's wrong clock must not hide mail that did arrive in the window.
    const window = opts.since
      ? "AND COALESCE(internal_date, date) >= ?"
      : "";
    const bounds = opts.since ? [opts.since] : [];
    const offset = opts.offset ?? 0;
    // One indexed branch per account, unioned, rather than
    // `account_id IN (...) ORDER BY date DESC`. The index is
    // (account_id, folder, date DESC): with two or more accounts bound, SQLite
    // cannot walk it in date order and falls back to sorting every indexed row
    // of the folder before applying LIMIT. Since "all mailboxes" is the default
    // inbox, that made the default paint the slowest one. Each branch here is
    // its own indexed range scan of at most limit+offset rows, and only the
    // union of those is sorted.
    const columns = `account_id as accountId, folder, uid, id, message_id_enc as messageIdEnc,
                from_enc as fromEnc, to_enc as toEnc, subject_enc as subjectEnc,
                snippet_enc as snippetEnc, date, internal_date as internalDate,
                seen, has_attachments as hasAttachments`;
    const branch = `SELECT * FROM (
           SELECT ${columns}
           FROM message_summaries
           WHERE account_id = ? AND folder = ? ${unread} ${window}
           ORDER BY date DESC
           LIMIT ?
         )`;
    const params: unknown[] = [];
    for (const accountId of opts.accountIds) {
      params.push(accountId, opts.folder, ...bounds, opts.limit + offset);
    }
    const sql =
      opts.accountIds.length === 1
        ? `${branch} ORDER BY date DESC LIMIT ? OFFSET ?`
        : `${opts.accountIds.map(() => branch).join(" UNION ALL ")}
           ORDER BY date DESC LIMIT ? OFFSET ?`;
    const rows = this.db
      .prepare(sql)
      .all(...params, opts.limit, offset) as SummaryRow[];
    const summaries: MailMessageSummary[] = [];
    for (const row of rows) {
      const summary = this.toSummary(row);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * One indexed summary by its message id, or null when the message was never
   * indexed. Reads the (account_id, id) index rather than the primary key,
   * because the caller knows the id and not the folder it sits in.
   *
   * The approval card is the caller that matters: it has to say which message
   * an agent wants to move, and a local read is the only way to say it without
   * an IMAP round trip per card.
   */
  getSummary(accountId: string, messageId: string): MailMessageSummary | null {
    const row = this.db
      .prepare(
        `SELECT account_id as accountId, folder, uid, id, message_id_enc as messageIdEnc,
                from_enc as fromEnc, to_enc as toEnc, subject_enc as subjectEnc,
                snippet_enc as snippetEnc, date, internal_date as internalDate,
                seen, has_attachments as hasAttachments
         FROM message_summaries WHERE account_id = ? AND id = ?`,
      )
      .get(accountId, messageId) as SummaryRow | undefined;
    return row ? this.toSummary(row) : null;
  }

  /**
   * The uids this folder holds, newest first. `.pluck()` so a 50k-message
   * folder does not allocate 50k wrapper objects on every background sync.
   */
  listUids(accountId: string, folder: string): number[] {
    return this.db
      .prepare(
        `SELECT uid FROM message_summaries
         WHERE account_id = ? AND folder = ? ORDER BY uid DESC`,
      )
      .pluck()
      .all(accountId, folder) as number[];
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
      // A replaced window drops rows this folder used to hold, so whatever it
      // was complete back to is no longer true. A since read only ever adds,
      // and reaches back to the earlier of the two marks.
      const previous = result.replaced
        ? null
        : (this.getState(accountId, folder)?.coveredSince ?? null);
      this.writeState(accountId, folder, result.cursor, false, null, {
        coveredSince: earlier(previous, result.coveredSince ?? null),
      });
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

  /**
   * Drop one indexed row after it was moved out of its folder, and keep that
   * folder's EXISTS honest.
   *
   * Both halves matter. Without the delete the archived message keeps painting
   * in the list it just left; without the EXISTS decrement the next read sees
   * fewer rows than the server claims to hold and pays a blocking IMAP refill
   * for a folder that is in fact up to date. `dirty` then folds the real state
   * in on the next background pass.
   *
   * Returns the folder the row was in, or null when it was not indexed.
   */
  removeMessage(accountId: string, messageId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT folder FROM message_summaries WHERE account_id = ? AND id = ?`,
      )
      .get(accountId, messageId) as { folder: string } | undefined;
    if (!row) return null;
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM message_summaries WHERE account_id = ? AND id = ?`,
        )
        .run(accountId, messageId);
      this.db
        .prepare(
          `UPDATE mailbox_state
           SET exists_count = MAX(exists_count - 1, 0), dirty = 1
           WHERE account_id = ? AND folder = ?`,
        )
        .run(accountId, row.folder);
    });
    run();
    return row.folder;
  }

  upsertSummary(msg: MailMessageSummary): void {
    this.db
      .prepare(
        `INSERT INTO message_summaries (
           account_id, folder, uid, id, message_id_enc, from_enc, to_enc,
           subject_enc, snippet_enc, date, internal_date, seen, has_attachments
         ) VALUES (
           @accountId, @folder, @uid, @id, @messageIdEnc, @fromEnc, @toEnc,
           @subjectEnc, @snippetEnc, @date, @internalDate, @seen, @hasAttachments
         )
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
           id=excluded.id,
           message_id_enc=excluded.message_id_enc,
           from_enc=excluded.from_enc,
           to_enc=excluded.to_enc,
           subject_enc=excluded.subject_enc,
           snippet_enc=excluded.snippet_enc,
           date=excluded.date,
           -- A read that did not ask for receive time carries none; keep the
           -- one an earlier since read already established.
           internal_date=COALESCE(excluded.internal_date, internal_date),
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
        internalDate: msg.internalDate ?? null,
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
    extra: { coveredSince?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO mailbox_state (
           account_id, folder, uidvalidity, highest_modseq, uidnext,
           exists_count, dirty, synced_at, last_error, covered_since
         ) VALUES (
           @accountId, @folder, @uidvalidity, @highestModseq, @uidnext,
           @exists, @dirty, @syncedAt, @lastError, @coveredSince
         )
         ON CONFLICT(account_id, folder) DO UPDATE SET
           uidvalidity=excluded.uidvalidity,
           highest_modseq=excluded.highest_modseq,
           uidnext=excluded.uidnext,
           exists_count=excluded.exists_count,
           dirty=excluded.dirty,
           synced_at=excluded.synced_at,
           last_error=excluded.last_error,
           covered_since=excluded.covered_since`,
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
        coveredSince: extra.coveredSince ?? null,
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
        internalDate: row.internalDate ?? undefined,
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

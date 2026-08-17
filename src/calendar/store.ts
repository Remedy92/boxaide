/**
 * Calendar tables. Owns: calendar_accounts (connection config, encrypted) and
 * calendar_meetings (meetings Boxaide itself created — the cancel path needs
 * the UID, attendees and sending mailbox back, and none of that is readable
 * from the provider once the invite is out).
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import type { CalendarAccountMeta, CalendarConfig } from "./types.js";

export type StoredMeeting = {
  id: string;
  /** iCalendar UID shared by the provider event and the emailed invite. */
  uid: string;
  calendarAccountId: string | null;
  /** Provider-side handle for deletion; null when no calendar write happened. */
  eventId: string | null;
  calendarId: string | null;
  mailAccountId: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
  meetingUrl: string | null;
  status: "scheduled" | "cancelled";
  createdAt: string;
};

type AccountRow = {
  id: string;
  alias: string;
  provider: string;
  email: string;
  config_enc: string;
  created_at: string;
};

type MeetingRow = {
  id: string;
  uid: string;
  calendar_account_id: string | null;
  event_id: string | null;
  calendar_id: string | null;
  mail_account_id: string;
  title_enc: string;
  start: string;
  end: string;
  attendees_enc: string;
  location_enc: string | null;
  meeting_url: string | null;
  status: string;
  created_at: string;
};

export class CalendarStore {
  constructor(
    readonly db: Database.Database,
    private masterKey: Buffer,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_accounts (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        config_enc TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_meetings (
        id TEXT PRIMARY KEY,
        uid TEXT NOT NULL,
        calendar_account_id TEXT,
        event_id TEXT,
        calendar_id TEXT,
        mail_account_id TEXT NOT NULL,
        title_enc TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        attendees_enc TEXT NOT NULL,
        location_enc TEXT,
        meeting_url TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TEXT NOT NULL
      );
    `);
  }

  // -- accounts -------------------------------------------------------------

  listAccounts(): CalendarAccountMeta[] {
    const rows = this.db
      .prepare(`SELECT * FROM calendar_accounts ORDER BY created_at`)
      .all() as AccountRow[];
    return rows.map((r) => this.accountMeta(r));
  }

  getAccount(id: string): CalendarAccountMeta | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_accounts WHERE id = ?`)
      .get(id) as AccountRow | undefined;
    return row ? this.accountMeta(row) : null;
  }

  /** Decrypted connection config — never leaves the server process. */
  getConfig(id: string): CalendarConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_accounts WHERE id = ?`)
      .get(id) as AccountRow | undefined;
    if (!row) return null;
    return JSON.parse(decryptSecret(this.masterKey, row.config_enc)) as CalendarConfig;
  }

  addAccount(input: {
    alias: string;
    email: string;
    config: CalendarConfig;
  }): CalendarAccountMeta {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO calendar_accounts (id, alias, provider, email, config_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.alias,
        input.config.kind,
        input.email,
        encryptSecret(this.masterKey, JSON.stringify(input.config)),
        now,
      );
    return { id, alias: input.alias, provider: input.config.kind, email: input.email, createdAt: now };
  }

  /** Google token refresh rotates the stored refresh token in place. */
  updateConfig(id: string, config: CalendarConfig): void {
    this.db
      .prepare(`UPDATE calendar_accounts SET config_enc = ? WHERE id = ?`)
      .run(encryptSecret(this.masterKey, JSON.stringify(config)), id);
  }

  deleteAccount(id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM calendar_accounts WHERE id = ?`).run(id).changes > 0
    );
  }

  private accountMeta(row: AccountRow): CalendarAccountMeta {
    return {
      id: row.id,
      alias: row.alias,
      provider: row.provider as CalendarAccountMeta["provider"],
      email: row.email,
      createdAt: row.created_at,
    };
  }

  // -- meetings -------------------------------------------------------------

  addMeeting(input: Omit<StoredMeeting, "id" | "status" | "createdAt">): StoredMeeting {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO calendar_meetings
           (id, uid, calendar_account_id, event_id, calendar_id, mail_account_id,
            title_enc, start, end, attendees_enc, location_enc, meeting_url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      )
      .run(
        id,
        input.uid,
        input.calendarAccountId,
        input.eventId,
        input.calendarId,
        input.mailAccountId,
        encryptSecret(this.masterKey, input.title),
        input.start,
        input.end,
        encryptSecret(this.masterKey, JSON.stringify(input.attendees)),
        input.location ? encryptSecret(this.masterKey, input.location) : null,
        input.meetingUrl,
        now,
      );
    return { ...input, id, status: "scheduled", createdAt: now };
  }

  getMeeting(id: string): StoredMeeting | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_meetings WHERE id = ?`)
      .get(id) as MeetingRow | undefined;
    return row ? this.meeting(row) : null;
  }

  listMeetings(opts: { limit?: number } = {}): StoredMeeting[] {
    const rows = this.db
      .prepare(`SELECT * FROM calendar_meetings ORDER BY start DESC LIMIT ?`)
      .all(Math.min(opts.limit ?? 50, 200)) as MeetingRow[];
    return rows.map((r) => this.meeting(r));
  }

  markCancelled(id: string): void {
    this.db
      .prepare(`UPDATE calendar_meetings SET status = 'cancelled' WHERE id = ?`)
      .run(id);
  }

  private meeting(row: MeetingRow): StoredMeeting {
    return {
      id: row.id,
      uid: row.uid,
      calendarAccountId: row.calendar_account_id,
      eventId: row.event_id,
      calendarId: row.calendar_id,
      mailAccountId: row.mail_account_id,
      title: decryptSecret(this.masterKey, row.title_enc),
      start: row.start,
      end: row.end,
      attendees: JSON.parse(decryptSecret(this.masterKey, row.attendees_enc)) as string[],
      location: row.location_enc ? decryptSecret(this.masterKey, row.location_enc) : null,
      meetingUrl: row.meeting_url,
      status: row.status as StoredMeeting["status"],
      createdAt: row.created_at,
    };
  }
}

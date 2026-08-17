/**
 * Calendar tables. Owns: calendar_accounts (connection config, encrypted),
 * calendar_meetings (meetings Boxaide itself created — the cancel path needs
 * the UID, attendees and sending mailbox back, and none of that is readable
 * from the provider once the invite is out), calendar_meeting_rsvps (who
 * answered an invite and how) and calendar_rsvp_scan_state (how far the reply
 * scanner has read each mailbox).
 */
import { createHmac, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import type { CalendarAccountMeta, CalendarConfig } from "./types.js";

/** Where a response came from. Email replies outrank provider state — see recordRsvp. */
export type RsvpSource = "email" | "provider";

/** One recorded response. `status` is the raw PARTSTAT, lowercased by the caller's parser. */
export type StoredRsvp = {
  meetingId: string;
  email: string;
  status: string;
  /** ISO instant the guest answered; null when the provider reported status with no timestamp. */
  respondedAt: string | null;
  source: RsvpSource;
  /** iCal SEQUENCE of the invite the response refers to. */
  sequence: number;
  updatedAt: string;
};

/**
 * Response state for one invited attendee. Attendees who never answered are
 * reported as "needs-action" with source "none", so callers can render the full
 * guest list without joining anything themselves.
 */
export type AttendeeStatus = {
  email: string;
  status: string;
  respondedAt: string | null;
  source: string;
};

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
  /**
   * IANA zone the organizer asked the invite to be written in, or null when
   * they named none. Kept so every later mail about this meeting quotes the
   * same wall clock the invite did — a cancellation in the server's zone tells
   * a guest a different hour than the invite they are holding.
   */
  timeZone: string | null;
  status: "scheduled" | "cancelled";
  createdAt: string;
  /** One entry per invited attendee, in `attendees` order. Never partial. */
  attendeeStatus: AttendeeStatus[];
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
  time_zone: string | null;
  status: string;
  created_at: string;
};

type RsvpRow = {
  meeting_id: string;
  attendee_email_hash: string;
  attendee_email_enc: string;
  status: string;
  responded_at: string | null;
  source: string;
  sequence: number;
  updated_at: string;
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
      -- Guest responses. The primary key needs a deterministic per-attendee
      -- value, and encryptSecret() is randomised (fresh nonce per call), so the
      -- address cannot double as the key. Hence two columns: a keyed HMAC of the
      -- lowercased address as the lookup key (deterministic, and keyed by the
      -- master key so a stolen database cannot be dictionary-attacked for
      -- addresses), plus the address encrypted the same way attendees_enc is,
      -- which is what reads hand back.
      CREATE TABLE IF NOT EXISTS calendar_meeting_rsvps (
        meeting_id TEXT NOT NULL,
        attendee_email_hash TEXT NOT NULL,
        attendee_email_enc TEXT NOT NULL,
        status TEXT NOT NULL,
        responded_at TEXT,
        source TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (meeting_id, attendee_email_hash)
      );
      -- Per-mailbox high-water mark for the iMIP reply scanner, so it reads only
      -- what arrived since the last pass instead of the whole inbox.
      CREATE TABLE IF NOT EXISTS calendar_rsvp_scan_state (
        mail_account_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Added after the table shipped: meetings written before this migration
    // have no zone and keep the unlabelled server clock they were mailed with.
    const columns = new Set(
      (
        this.db.prepare(`PRAGMA table_info(calendar_meetings)`).all() as Array<{ name: string }>
      ).map((c) => c.name),
    );
    if (!columns.has("time_zone")) {
      this.db.exec(`ALTER TABLE calendar_meetings ADD COLUMN time_zone TEXT`);
    }
  }

  /**
   * Deterministic per-attendee key. Keyed by the master key: without it the
   * column is useless to an attacker, and with it lookups stay a plain index hit.
   */
  private attendeeKey(email: string): string {
    return createHmac("sha256", this.masterKey)
      .update(email.trim().toLowerCase())
      .digest("hex");
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
    const gone =
      this.db.prepare(`DELETE FROM calendar_accounts WHERE id = ?`).run(id).changes > 0;
    // Meetings deliberately outlive their calendar account: the emailed invite
    // is already out and the cancel path still needs the UID and attendees, so
    // their responses stay too. Sweep only rows whose meeting is truly gone —
    // this store never turns the foreign_keys pragma on (it shares the handle),
    // so cascades are written by hand here and in deleteMeeting.
    if (gone) this.sweepOrphanRsvps();
    return gone;
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

  addMeeting(
    // `timeZone` is optional so callers that never name one read as they did
    // before the column existed; it is stored as null and means "server clock".
    input: Omit<StoredMeeting, "id" | "status" | "createdAt" | "attendeeStatus" | "timeZone"> & {
      timeZone?: string | null;
    },
  ): StoredMeeting {
    const id = randomUUID();
    const now = new Date().toISOString();
    const timeZone = input.timeZone ?? null;
    this.db
      .prepare(
        `INSERT INTO calendar_meetings
           (id, uid, calendar_account_id, event_id, calendar_id, mail_account_id,
            title_enc, start, end, attendees_enc, location_enc, meeting_url, time_zone,
            status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
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
        timeZone,
        now,
      );
    return {
      ...input,
      timeZone,
      id,
      status: "scheduled",
      createdAt: now,
      // Nobody can have answered an invite that was just written.
      attendeeStatus: input.attendees.map((email) => needsAction(email)),
    };
  }

  getMeeting(id: string): StoredMeeting | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_meetings WHERE id = ?`)
      .get(id) as MeetingRow | undefined;
    return row ? this.meeting(row, this.listRsvps(row.id)) : null;
  }

  listMeetings(opts: { limit?: number } = {}): StoredMeeting[] {
    const rows = this.db
      .prepare(`SELECT * FROM calendar_meetings ORDER BY start DESC LIMIT ?`)
      .all(Math.min(opts.limit ?? 50, 200)) as MeetingRow[];
    // One batched RSVP read for the whole page instead of a query per meeting.
    const byMeeting = this.listRsvpsFor(rows.map((r) => r.id));
    return rows.map((r) => this.meeting(r, byMeeting.get(r.id) ?? []));
  }

  markCancelled(id: string): void {
    this.db
      .prepare(`UPDATE calendar_meetings SET status = 'cancelled' WHERE id = ?`)
      .run(id);
  }

  /** Drops the meeting and every response recorded against it. */
  deleteMeeting(id: string): boolean {
    const tx = this.db.transaction((meetingId: string) => {
      this.db.prepare(`DELETE FROM calendar_meeting_rsvps WHERE meeting_id = ?`).run(meetingId);
      return this.db.prepare(`DELETE FROM calendar_meetings WHERE id = ?`).run(meetingId).changes > 0;
    });
    return tx(id) as boolean;
  }

  private meeting(row: MeetingRow, rsvps: StoredRsvp[]): StoredMeeting {
    const attendees = JSON.parse(decryptSecret(this.masterKey, row.attendees_enc)) as string[];
    // Index by the hash so an address that differs only in case or padding
    // still matches the invited attendee it belongs to.
    const byKey = new Map(rsvps.map((r) => [this.attendeeKey(r.email), r]));
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
      attendees,
      location: row.location_enc ? decryptSecret(this.masterKey, row.location_enc) : null,
      meetingUrl: row.meeting_url,
      timeZone: row.time_zone,
      status: row.status as StoredMeeting["status"],
      createdAt: row.created_at,
      // Every invited attendee appears, answered or not. Responses from people
      // who are not on the invite (forwarded invites, delegates) stay in the
      // table but are not reported as guests.
      attendeeStatus: attendees.map((email) => {
        const hit = byKey.get(this.attendeeKey(email));
        return hit
          ? { email, status: hit.status, respondedAt: hit.respondedAt, source: hit.source }
          : needsAction(email);
      }),
    };
  }

  // -- rsvps ----------------------------------------------------------------

  /**
   * Merge one observed response into the stored state. Both sources feed this:
   * inbound iMIP replies (METHOD:REPLY) and the provider's own attendee status.
   * Precedence, in order:
   *   1. A lower iCal SEQUENCE than the stored one is dropped — a reply to an
   *      older version of the invite must never overwrite a fresh answer.
   *   2. A higher SEQUENCE always wins; it answers a newer invite.
   *   3. At equal SEQUENCE, "email" beats "provider": the guest's own reply is
   *      the record, provider status only fills in attendees with no reply.
   *   4. Between two email replies, the newer responded_at wins; a reply with no
   *      timestamp never displaces one that has a timestamp.
   *   5. Between two provider reads, the later read wins — it is a fresh sync.
   * Returns true when the record was written, false when it was dropped as stale.
   */
  recordRsvp(input: {
    meetingId: string;
    email: string;
    status: string;
    respondedAt?: string | null;
    source: RsvpSource;
    sequence?: number;
  }): boolean {
    const key = this.attendeeKey(input.email);
    const incoming = {
      respondedAt: input.respondedAt ?? null,
      sequence: input.sequence ?? 0,
      source: input.source,
    };
    const existing = this.db
      .prepare(
        `SELECT status, responded_at, source, sequence FROM calendar_meeting_rsvps
         WHERE meeting_id = ? AND attendee_email_hash = ?`,
      )
      .get(input.meetingId, key) as
      | Pick<RsvpRow, "status" | "responded_at" | "source" | "sequence">
      | undefined;

    if (existing && !supersedes(incoming, existing)) return false;
    // Nothing new said. Rung 5 lets a repeated provider read through so the row
    // stays fresh, but the return value is what callers count as "responses
    // that changed" — a poll that re-reads the same answer every minute would
    // otherwise report new replies to the user for ever.
    if (
      existing &&
      existing.status === input.status &&
      existing.source === incoming.source &&
      existing.sequence === incoming.sequence &&
      existing.responded_at === incoming.respondedAt
    ) {
      return false;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO calendar_meeting_rsvps
           (meeting_id, attendee_email_hash, attendee_email_enc, status,
            responded_at, source, sequence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meeting_id, attendee_email_hash) DO UPDATE SET
           attendee_email_enc = excluded.attendee_email_enc,
           status = excluded.status,
           responded_at = excluded.responded_at,
           source = excluded.source,
           sequence = excluded.sequence,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.meetingId,
        key,
        encryptSecret(this.masterKey, input.email),
        input.status,
        incoming.respondedAt,
        incoming.source,
        incoming.sequence,
        now,
      );
    return true;
  }

  listRsvps(meetingId: string): StoredRsvp[] {
    const rows = this.db
      .prepare(`SELECT * FROM calendar_meeting_rsvps WHERE meeting_id = ? ORDER BY updated_at`)
      .all(meetingId) as RsvpRow[];
    return rows.map((r) => this.rsvp(r));
  }

  /** Batch variant: one query for a page of meetings. Meetings with no responses are absent. */
  listRsvpsFor(meetingIds: string[]): Map<string, StoredRsvp[]> {
    const out = new Map<string, StoredRsvp[]>();
    if (meetingIds.length === 0) return out;
    const placeholders = meetingIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM calendar_meeting_rsvps
         WHERE meeting_id IN (${placeholders}) ORDER BY updated_at`,
      )
      .all(...meetingIds) as RsvpRow[];
    for (const row of rows) {
      const list = out.get(row.meeting_id);
      if (list) list.push(this.rsvp(row));
      else out.set(row.meeting_id, [this.rsvp(row)]);
    }
    return out;
  }

  /** How far the iMIP reply scanner has read this mailbox; null before the first pass. */
  getRsvpScanCursor(mailAccountId: string): string | null {
    const row = this.db
      .prepare(`SELECT cursor FROM calendar_rsvp_scan_state WHERE mail_account_id = ?`)
      .get(mailAccountId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  setRsvpScanCursor(mailAccountId: string, iso: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO calendar_rsvp_scan_state (mail_account_id, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (mail_account_id) DO UPDATE SET
           cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(mailAccountId, iso, now);
  }

  private sweepOrphanRsvps(): void {
    this.db.exec(
      `DELETE FROM calendar_meeting_rsvps
       WHERE meeting_id NOT IN (SELECT id FROM calendar_meetings)`,
    );
  }

  private rsvp(row: RsvpRow): StoredRsvp {
    return {
      meetingId: row.meeting_id,
      email: decryptSecret(this.masterKey, row.attendee_email_enc),
      status: row.status,
      respondedAt: row.responded_at,
      source: row.source as RsvpSource,
      sequence: row.sequence,
      updatedAt: row.updated_at,
    };
  }
}

/** Default row for an attendee who has not answered. */
function needsAction(email: string): AttendeeStatus {
  return { email, status: "needs-action", respondedAt: null, source: "none" };
}

/** The precedence ladder documented on recordRsvp, kept as one readable decision. */
function supersedes(
  incoming: { respondedAt: string | null; source: RsvpSource; sequence: number },
  existing: { responded_at: string | null; source: string; sequence: number },
): boolean {
  if (incoming.sequence !== existing.sequence) return incoming.sequence > existing.sequence;
  if (existing.source === "email" && incoming.source === "provider") return false;
  if (existing.source === "provider" && incoming.source === "email") return true;
  if (incoming.source === "email") {
    if (!incoming.respondedAt) return existing.responded_at === null;
    if (!existing.responded_at) return true;
    return incoming.respondedAt > existing.responded_at;
  }
  // Two provider reads: the later sync is the truth.
  return true;
}

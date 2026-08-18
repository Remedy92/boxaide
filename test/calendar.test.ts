/**
 * Calendar state and orchestration: the store, the service write paths, and
 * the MCP tool dispatcher. The pure units (ICS writer, CalDAV parsing, slot
 * search) live in test/calendar-ics.test.ts.
 *
 * Every provider here is a fake implementing CalendarProvider — nothing in
 * this file touches the network, and mail goes through FixtureProvider so the
 * emitted iMIP part can be read back byte for byte.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarService } from "../src/calendar/service.js";
import { CalendarStore } from "../src/calendar/store.js";
import { dispatchCalendarTool } from "../src/calendar/tools.js";
import type {
  CalDavConfig,
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
  GoogleConfig,
} from "../src/calendar/types.js";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import type { Platform } from "../src/platform.js";

/* -- shared fixtures ------------------------------------------------------ */

const CALDAV: CalDavConfig = {
  kind: "caldav",
  serverUrl: "https://caldav.example/dav",
  username: "me@test.com",
  password: "app-password",
};

const GOOGLE: GoogleConfig = {
  kind: "google",
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
  email: "me@gmail.example",
};

type ProviderEvent = Omit<CalendarEvent, "accountId" | "accountAlias">;

/** Records every call and replays scripted results. No I/O. */
class FakeProvider implements CalendarProvider {
  events: ProviderEvent[] = [];
  listError: Error | null = null;
  createError: Error | null = null;
  deleteError: Error | null = null;
  created: CreateEventInput[] = [];
  deleted: Array<{ calendarId: string; eventId: string }> = [];
  ranges: EventRange[] = [];

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "cal-1", name: "Work" }];
  }

  async listEvents(_config: CalendarConfig, range: EventRange): Promise<ProviderEvent[]> {
    this.ranges.push(range);
    if (this.listError) throw this.listError;
    return this.events;
  }

  async createEvent(
    _config: CalendarConfig,
    input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    if (this.createError) throw this.createError;
    this.created.push(input);
    return { eventId: `event-${this.created.length}`, calendarId: "cal-1" };
  }

  async deleteEvent(
    _config: CalendarConfig,
    calendarId: string,
    eventId: string,
  ): Promise<boolean> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push({ calendarId, eventId });
    return true;
  }
}

function event(over: Partial<ProviderEvent> & { start: string; end: string }): ProviderEvent {
  return {
    id: `ev-${over.start}`,
    calendarId: "cal-1",
    title: "Untitled",
    allDay: false,
    status: "confirmed",
    busy: true,
    ...over,
  };
}

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "me@test.com", pass: "ok" },
};

/* ======================================================================== */
/* CalendarStore                                                           */
/* ======================================================================== */

describe("CalendarStore", () => {
  let db: Database.Database;
  let store: CalendarStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CalendarStore(db, randomBytes(32));
  });

  afterEach(() => db.close());

  it("roundtrips an account config through encryption", () => {
    const meta = store.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    expect(meta).toMatchObject({ alias: "work", provider: "caldav", email: "me@test.com" });
    expect(store.getConfig(meta.id)).toEqual(CALDAV);
    expect(store.getAccount(meta.id)).toMatchObject({ id: meta.id, alias: "work" });
    // The ciphertext column must not carry the password in the clear.
    const row = db.prepare(`SELECT config_enc FROM calendar_accounts WHERE id = ?`).get(meta.id) as {
      config_enc: string;
    };
    expect(row.config_enc).not.toContain("app-password");
  });

  it("hides secrets from listAccounts", () => {
    store.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    store.addAccount({ alias: "gmail", email: GOOGLE.email, config: GOOGLE });
    const listed = store.listAccounts();
    expect(listed.map((a) => a.provider).sort()).toEqual(["caldav", "google"]);
    for (const account of listed) {
      expect(Object.keys(account).sort()).toEqual([
        "alias",
        "createdAt",
        "email",
        "id",
        "provider",
      ]);
      expect(JSON.stringify(account)).not.toContain("app-password");
      expect(JSON.stringify(account)).not.toContain("refresh");
    }
  });

  it("updates and deletes accounts", () => {
    const meta = store.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    store.updateConfig(meta.id, { ...CALDAV, password: "rotated" });
    expect((store.getConfig(meta.id) as CalDavConfig).password).toBe("rotated");
    expect(store.deleteAccount(meta.id)).toBe(true);
    expect(store.deleteAccount(meta.id)).toBe(false);
    expect(store.getAccount(meta.id)).toBeNull();
    expect(store.getConfig(meta.id)).toBeNull();
  });

  it("roundtrips a meeting, keeping the title encrypted at rest", () => {
    const meeting = store.addMeeting({
      uid: "uid-1@boxaide",
      calendarAccountId: null,
      eventId: null,
      calendarId: null,
      mailAccountId: "mail-1",
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      attendees: ["ada@acme.example", "bob@acme.example"],
      location: "Room A",
      meetingUrl: "https://meet.jit.si/design-sync-abc",
    });
    expect(meeting.status).toBe("scheduled");

    const read = store.getMeeting(meeting.id);
    expect(read).toEqual(meeting);
    expect(read!.attendees).toEqual(["ada@acme.example", "bob@acme.example"]);
    expect(store.listMeetings()).toEqual([meeting]);
    expect(store.getMeeting("nope")).toBeNull();

    const row = db.prepare(`SELECT title_enc FROM calendar_meetings WHERE id = ?`).get(meeting.id) as {
      title_enc: string;
    };
    expect(row.title_enc).not.toContain("Design sync");
  });

  it("marks a meeting cancelled", () => {
    const meeting = store.addMeeting({
      uid: "uid-2@boxaide",
      calendarAccountId: null,
      eventId: null,
      calendarId: null,
      mailAccountId: "mail-1",
      title: "Standup",
      start: "2026-08-19T09:00:00.000Z",
      end: "2026-08-19T09:15:00.000Z",
      attendees: ["ada@acme.example"],
      location: null,
      meetingUrl: null,
    });
    store.markCancelled(meeting.id);
    expect(store.getMeeting(meeting.id)!.status).toBe("cancelled");
  });

  /* A cancelled meeting is kept while anyone might still ask about the invite
     that went out, and swept a month later so the list is not a permanent
     record of things that are not happening. */
  describe("the 30-day sweep", () => {
    const DAY = 24 * 60 * 60 * 1000;

    function cancelledMeeting(title: string, cancelledAt: string) {
      const meeting = store.addMeeting({
        uid: `uid-${title}@boxaide`,
        calendarAccountId: null,
        eventId: null,
        calendarId: null,
        mailAccountId: "mail-1",
        title,
        start: "2026-08-19T09:00:00.000Z",
        end: "2026-08-19T09:15:00.000Z",
        attendees: ["ada@acme.example"],
        location: null,
        meetingUrl: null,
      });
      store.markCancelled(meeting.id, cancelledAt);
      return meeting;
    }

    it("drops a meeting cancelled more than 30 days ago", () => {
      const now = new Date("2026-08-19T00:00:00.000Z");
      const old = cancelledMeeting("old", new Date(now.getTime() - 31 * DAY).toISOString());
      expect(store.purgeCancelled(now)).toBe(1);
      expect(store.getMeeting(old.id)).toBeNull();
    });

    it("keeps one cancelled inside the 30 days", () => {
      const now = new Date("2026-08-19T00:00:00.000Z");
      const recent = cancelledMeeting("recent", new Date(now.getTime() - 29 * DAY).toISOString());
      expect(store.purgeCancelled(now)).toBe(0);
      expect(store.getMeeting(recent.id)!.status).toBe("cancelled");
    });

    /* The row is the only handle the cancel path has on the UID, the attendees
       and the sending mailbox, so age must never take it. */
    it("never sweeps a scheduled meeting, however old", () => {
      const meeting = store.addMeeting({
        uid: "uid-ancient@boxaide",
        calendarAccountId: null,
        eventId: null,
        calendarId: null,
        mailAccountId: "mail-1",
        title: "Ancient",
        start: "2020-01-01T09:00:00.000Z",
        end: "2020-01-01T09:15:00.000Z",
        attendees: ["ada@acme.example"],
        location: null,
        meetingUrl: null,
      });
      expect(store.purgeCancelled(new Date("2026-08-19T00:00:00.000Z"))).toBe(0);
      expect(store.getMeeting(meeting.id)!.status).toBe("scheduled");
    });

    /* Cancelled before the column existed: stamped on first sweep so its 30
       days start now, rather than deleted for an age nobody recorded. */
    it("gives a row with no cancellation time a fresh 30 days", () => {
      const meeting = cancelledMeeting("undated", "2020-01-01T00:00:00.000Z");
      store.db
        .prepare(`UPDATE calendar_meetings SET cancelled_at = NULL WHERE id = ?`)
        .run(meeting.id);
      const now = new Date("2026-08-19T00:00:00.000Z");
      expect(store.purgeCancelled(now)).toBe(0);
      expect(store.getMeeting(meeting.id)).not.toBeNull();
      // And swept once those 30 days are behind it.
      expect(store.purgeCancelled(new Date(now.getTime() + 31 * DAY))).toBe(1);
      expect(store.getMeeting(meeting.id)).toBeNull();
    });

    it("sweeps when the list is read", () => {
      const now = Date.now();
      cancelledMeeting("stale", new Date(now - 31 * DAY).toISOString());
      const kept = cancelledMeeting("fresh", new Date(now - 1 * DAY).toISOString());
      expect(store.listMeetings().map((m) => m.id)).toEqual([kept.id]);
    });
  });
});

/* ======================================================================== */
/* CalendarService                                                         */
/* ======================================================================== */

describe("CalendarService", () => {
  let store: Store;
  let calendarStore: CalendarStore;
  let mail: MailService;
  let provider: FixtureProvider;
  let caldav: FakeProvider;
  let google: FakeProvider;
  let service: CalendarService;
  let mailAccountId: string;

  beforeEach(async () => {
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    const account = await mail.connectAccount({
      alias: "work",
      email: "me@test.com",
      creds: baseCreds,
    });
    mailAccountId = account.id;
    calendarStore = new CalendarStore(store.db, masterKey);
    caldav = new FakeProvider();
    google = new FakeProvider();
    service = new CalendarService(calendarStore, mail, { caldav, google });
  });

  afterEach(() => store.db.close());

  function addCalendarAccount(kind: "caldav" | "google" = "caldav", alias = kind) {
    return calendarStore.addAccount({
      alias,
      email: kind === "google" ? GOOGLE.email : "me@test.com",
      config: kind === "google" ? GOOGLE : CALDAV,
    });
  }

  /** The invite that was actually handed to the mail provider. */
  function lastSent() {
    const sent = provider.getSent();
    return sent[sent.length - 1];
  }

  const RANGE = { start: "2026-08-17T00:00:00.000Z", end: "2026-08-24T00:00:00.000Z" };

  /* ---- agenda --------------------------------------------------------- */

  it("merges both accounts, tags them, and sorts by start", async () => {
    const work = addCalendarAccount("caldav", "work-cal");
    const personal = addCalendarAccount("google", "personal");
    caldav.events = [
      event({ start: "2026-08-19T14:00:00.000Z", end: "2026-08-19T15:00:00.000Z", title: "Later" }),
    ];
    google.events = [
      event({ start: "2026-08-18T09:00:00.000Z", end: "2026-08-18T10:00:00.000Z", title: "Earlier" }),
    ];

    const { events, errors } = await service.agenda(RANGE);
    expect(errors).toEqual([]);
    expect(events.map((e) => e.title)).toEqual(["Earlier", "Later"]);
    expect(events[0]).toMatchObject({ accountId: personal.id, accountAlias: "personal" });
    expect(events[1]).toMatchObject({ accountId: work.id, accountAlias: "work-cal" });
    expect(caldav.ranges).toEqual([RANGE]);
  });

  it("turns a failing account into an error string, not a rejection", async () => {
    addCalendarAccount("caldav", "work-cal");
    addCalendarAccount("google", "personal");
    google.listError = new Error("token expired");
    caldav.events = [event({ start: "2026-08-19T14:00:00.000Z", end: "2026-08-19T15:00:00.000Z" })];

    const { events, errors } = await service.agenda(RANGE);
    expect(events).toHaveLength(1);
    expect(errors).toEqual(["personal: token expired"]);
  });

  it("drops transparent and cancelled events from the busy list", async () => {
    addCalendarAccount("caldav");
    const day = (h: number) => new Date(2026, 7, 19, h, 0, 0, 0).toISOString();
    caldav.events = [
      event({ start: day(9), end: day(10), busy: false }),
      event({ start: day(10), end: day(11), status: "cancelled" }),
      event({ start: day(11), end: day(12) }),
    ];
    const { slots, errors } = await service.freeSlots({
      start: day(0),
      end: new Date(2026, 7, 19, 23, 59, 0, 0).toISOString(),
      now: day(0),
      durationMinutes: 60,
      maxSlots: 5,
    });
    expect(errors).toEqual([]);
    // Only 11:00-12:00 blocks; the free/cancelled pair does not, so 9:00 and
    // 10:00 stay on offer and nothing starts at 10:30 or 11:00.
    expect(slots.map((s) => s.start)).toEqual([
      day(9),
      new Date(2026, 7, 19, 9, 30, 0, 0).toISOString(),
      day(10),
      day(12),
      new Date(2026, 7, 19, 12, 30, 0, 0).toISOString(),
    ]);
  });

  /* ---- createMeeting -------------------------------------------------- */

  const INPUT = {
    title: "Design sync",
    start: "2026-08-19T14:00:00.000Z",
    end: "2026-08-19T15:00:00.000Z",
    attendees: ["ada@acme.example", "bob@acme.example"],
    description: "Bring the mocks.",
  };

  it("writes the event, mails the REQUEST, and stores the meeting", async () => {
    const account = addCalendarAccount("caldav");
    const { meeting, warnings } = await service.createMeeting(INPUT);

    expect(warnings).toEqual([]);
    expect(meeting.uid).toMatch(/@boxaide$/);
    expect(meeting.eventId).toBe("event-1");
    expect(meeting.calendarId).toBe("cal-1");
    expect(meeting.calendarAccountId).toBe(account.id);
    expect(meeting.attendees).toEqual(INPUT.attendees);
    expect(meeting.meetingUrl).toMatch(/^https:\/\/meet\.jit\.si\//);
    expect(calendarStore.getMeeting(meeting.id)).toEqual(meeting);

    expect(caldav.created).toHaveLength(1);
    expect(caldav.created[0]).toMatchObject({ uid: meeting.uid, organizerEmail: "me@test.com" });

    const sent = lastSent();
    expect(sent.accountId).toBe(mailAccountId);
    expect(sent.to).toBe("ada@acme.example, bob@acme.example");
    expect(sent.subject).toBe("Invitation: Design sync");
    expect(sent.icalEvent?.method).toBe("REQUEST");
    const ics = sent.icalEvent!.content;
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain(`UID:${meeting.uid}`);
    expect(ics).toContain("mailto:ada@acme.example");
    expect(ics).toContain("mailto:bob@acme.example");
    expect(ics).toContain("DTSTART:20260819T140000Z");
    expect(sent.text).toContain(meeting.meetingUrl!);
  });

  it("downgrades a calendar write failure to a warning and still mails", async () => {
    addCalendarAccount("caldav");
    caldav.createError = new Error("HTTP 507");

    const { meeting, warnings } = await service.createMeeting(INPUT);
    expect(warnings).toEqual(["calendar write failed: HTTP 507"]);
    expect(meeting.eventId).toBeNull();
    expect(meeting.calendarId).toBeNull();
    expect(calendarStore.getMeeting(meeting.id)!.eventId).toBeNull();
    expect(lastSent().icalEvent?.method).toBe("REQUEST");
  });

  it("warns when no calendar account is connected", async () => {
    const { meeting, warnings } = await service.createMeeting(INPUT);
    expect(warnings).toEqual(["no calendar account connected; invite emailed only"]);
    expect(meeting.calendarAccountId).toBeNull();
    expect(meeting.eventId).toBeNull();
    expect(lastSent().icalEvent?.method).toBe("REQUEST");
  });

  it("throws on an unknown calendarAccountId", async () => {
    addCalendarAccount("caldav");
    await expect(
      service.createMeeting({ ...INPUT, calendarAccountId: "nope" }),
    ).rejects.toThrow(/calendar account not found: nope/);
  });

  it("rejects invalid input before sending anything", async () => {
    await expect(service.createMeeting({ ...INPUT, attendees: [] })).rejects.toThrow(
      /at least one attendee/,
    );
    await expect(
      service.createMeeting({ ...INPUT, end: "2026-08-19T13:00:00.000Z" }),
    ).rejects.toThrow(/end must be after start/);
    await expect(
      service.createMeeting({ ...INPUT, attendees: ["not-an-email"] }),
    ).rejects.toThrow(/invalid attendee: not-an-email/);
    await expect(service.createMeeting({ ...INPUT, title: "  " })).rejects.toThrow(
      /title is required/,
    );
    await expect(service.createMeeting({ ...INPUT, start: "nope" })).rejects.toThrow(
      /invalid start or end/,
    );
    expect(provider.getSent()).toHaveLength(0);
  });

  it("omits the meeting link when includeMeetingLink is false", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting({ ...INPUT, includeMeetingLink: false });
    expect(meeting.meetingUrl).toBeNull();
    expect(meeting.location).toBeNull();
    const sent = lastSent();
    expect(sent.text).not.toContain("Join:");
    expect(sent.icalEvent!.content).not.toContain("Join:");
    expect(sent.icalEvent!.content).not.toContain("meet.jit.si");
  });

  it("lets an explicit location win over the generated link", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting({ ...INPUT, location: "Room A" });
    expect(meeting.location).toBe("Room A");
    expect(meeting.meetingUrl).toMatch(/meet\.jit\.si/);
    // The link survives in the description.
    expect(lastSent().icalEvent!.content).toContain("Join: ");
  });

  it("normalizes display-name attendees down to bare mailboxes", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting({
      ...INPUT,
      attendees: ["Jane Doe <jane@x.com>", "JANE@x.com", "bob@acme.example"],
    });
    // Deduped case-insensitively, so the second spelling of Jane is dropped.
    expect(meeting.attendees).toEqual(["jane@x.com", "bob@acme.example"]);
    const sent = lastSent();
    expect(sent.to).toBe("jane@x.com, bob@acme.example");
    // The ICS must never carry the display-name form on an ATTENDEE line.
    expect(sent.icalEvent!.content).toContain("mailto:jane@x.com");
    expect(sent.icalEvent!.content).not.toContain("Jane Doe");
  });

  it("writes nothing when the invite email fails", async () => {
    addCalendarAccount("caldav");
    mail.setSendGuard(() => {
      throw new Error("smtp down");
    });
    await expect(service.createMeeting(INPUT)).rejects.toThrow(/smtp down/);
    // The email is the transaction: no provider event, no stored meeting.
    expect(caldav.created).toEqual([]);
    expect(calendarStore.listMeetings()).toEqual([]);
  });

  /* ---- cancelMeeting -------------------------------------------------- */

  it("mails a CANCEL with SEQUENCE:1 and marks the meeting cancelled", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting(INPUT);

    const cancelled = await service.cancelMeeting(meeting.id);
    expect(cancelled.warnings).toEqual([]);
    expect(cancelled.meeting.status).toBe("cancelled");
    expect(calendarStore.getMeeting(meeting.id)!.status).toBe("cancelled");
    expect(caldav.deleted).toEqual([{ calendarId: "cal-1", eventId: "event-1" }]);

    const sent = lastSent();
    expect(sent.subject).toBe("Cancelled: Design sync");
    expect(sent.icalEvent?.method).toBe("CANCEL");
    expect(sent.icalEvent!.content).toContain("METHOD:CANCEL");
    expect(sent.icalEvent!.content).toContain("SEQUENCE:1");
    expect(sent.icalEvent!.content).toContain("STATUS:CANCELLED");
    expect(sent.icalEvent!.content).toContain(`UID:${meeting.uid}`);
  });

  it("cancels in the zone the invite quoted", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting({ ...INPUT, timeZone: "Europe/Brussels" });
    const invite = lastSent().text!;

    await service.cancelMeeting(meeting.id);
    const cancellation = lastSent().text!;
    // Both mails are about one meeting, so both must name one wall clock. The
    // zone was not stored, so the cancellation used to quote the server's.
    expect(invite).toContain("(Europe/Brussels)");
    expect(cancellation).toContain("(Europe/Brussels)");
    const hour = new Date(INPUT.start).toLocaleString(undefined, {
      timeZone: "Europe/Brussels",
    });
    expect(cancellation).toContain(hour);
  });

  it("refuses to cancel twice, or to cancel an unknown id", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting(INPUT);
    await service.cancelMeeting(meeting.id);
    await expect(service.cancelMeeting(meeting.id)).rejects.toThrow(/already cancelled/);
    await expect(service.cancelMeeting("nope")).rejects.toThrow(/meeting not found: nope/);
  });

  it("downgrades a provider delete failure to a warning but still mails", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting(INPUT);
    caldav.deleteError = new Error("HTTP 500");

    const { warnings } = await service.cancelMeeting(meeting.id);
    expect(warnings).toEqual(["calendar delete failed: HTTP 500"]);
    expect(lastSent().icalEvent?.method).toBe("CANCEL");
    expect(calendarStore.getMeeting(meeting.id)!.status).toBe("cancelled");
  });

  it("mails the CANCEL even to a suppressed attendee", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting(INPUT);
    // Installed after the invite: this attendee opted out in between.
    mail.setSendGuard((recipients, override) => {
      if (!override && recipients.includes("ada@acme.example")) {
        throw new Error("recipient is suppressed");
      }
    });

    const { warnings } = await service.cancelMeeting(meeting.id);
    expect(warnings).toEqual([]);
    expect(lastSent().icalEvent?.method).toBe("CANCEL");
    expect(calendarStore.getMeeting(meeting.id)!.status).toBe("cancelled");
  });

  it("leaves the meeting scheduled and the event in place when the CANCEL fails", async () => {
    addCalendarAccount("caldav");
    const { meeting } = await service.createMeeting(INPUT);
    const sentBefore = provider.getSent().length;
    mail.setSendGuard(() => {
      throw new Error("smtp down");
    });

    await expect(service.cancelMeeting(meeting.id)).rejects.toThrow(/smtp down/);
    expect(provider.getSent()).toHaveLength(sentBefore);
    expect(caldav.deleted).toEqual([]);
    expect(calendarStore.getMeeting(meeting.id)!.status).toBe("scheduled");
  });

  it("passes testAccount through to the provider matching the config kind", async () => {
    await expect(service.testAccount(GOOGLE)).resolves.toEqual({ ok: true });
  });
});

/* ======================================================================== */
/* Tool dispatch                                                           */
/* ======================================================================== */

describe("dispatchCalendarTool", () => {
  let store: Store;
  let calendarStore: CalendarStore;
  let calendarService: CalendarService;
  let caldav: FakeProvider;
  let platform: Platform;
  let provider: FixtureProvider;

  beforeEach(async () => {
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    provider = new FixtureProvider();
    const mail = new MailService(store, provider);
    await mail.connectAccount({ alias: "work", email: "me@test.com", creds: baseCreds });
    calendarStore = new CalendarStore(store.db, masterKey);
    caldav = new FakeProvider();
    calendarService = new CalendarService(calendarStore, mail, {
      caldav,
      google: new FakeProvider(),
    });
    platform = { calendarStore, calendarService } as unknown as Platform;
  });

  afterEach(() => store.db.close());

  it("lists calendar accounts without secrets", async () => {
    calendarStore.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    const result = (await dispatchCalendarTool(platform, "calendar_accounts_list", {})) as {
      accounts: Array<{ alias: string }>;
    };
    expect(result.accounts.map((a) => a.alias)).toEqual(["work"]);
    expect(JSON.stringify(result)).not.toContain("app-password");
  });

  it("defaults agenda_view to a seven-day range from now", async () => {
    calendarStore.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    const before = Date.now();
    await dispatchCalendarTool(platform, "agenda_view", {});
    const range = caldav.ranges[0];
    const start = new Date(range.start).getTime();
    const end = new Date(range.end).getTime();
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(Date.now());
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("honours an explicit days count and clamps it to the shared cap", async () => {
    calendarStore.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    await dispatchCalendarTool(platform, "agenda_view", {
      start: "2026-08-17T00:00:00.000Z",
      days: 900,
    });
    expect(caldav.ranges[0]).toEqual({
      start: "2026-08-17T00:00:00.000Z",
      end: "2026-10-18T00:00:00.000Z",
    });
  });

  it("caps an explicit agenda_view end at the same span as the REST route", async () => {
    await expect(
      dispatchCalendarTool(platform, "agenda_view", {
        start: "2026-08-17T00:00:00.000Z",
        end: "2036-08-17T00:00:00.000Z",
      }),
    ).rejects.toThrow(/range must be 62 days or less/);
  });

  it("rejects an inverted or unparseable agenda range", async () => {
    await expect(
      dispatchCalendarTool(platform, "agenda_view", {
        start: "2026-08-17T00:00:00.000Z",
        end: "2026-08-16T00:00:00.000Z",
      }),
    ).rejects.toThrow(/end must be after start/);
    await expect(
      dispatchCalendarTool(platform, "agenda_view", { start: "nope" }),
    ).rejects.toThrow(/start must be an ISO instant/);
  });

  it("rejects meeting_create with non-array or empty attendees", async () => {
    await expect(
      dispatchCalendarTool(platform, "meeting_create", {
        title: "Sync",
        start: "2026-08-19T14:00:00.000Z",
        end: "2026-08-19T15:00:00.000Z",
        attendees: "ada@acme.example",
      }),
    ).rejects.toThrow(/attendees must be an array of email addresses/);
    await expect(
      dispatchCalendarTool(platform, "meeting_create", {
        title: "Sync",
        start: "2026-08-19T14:00:00.000Z",
        end: "2026-08-19T15:00:00.000Z",
        attendees: ["  "],
      }),
    ).rejects.toThrow(/attendees must list at least one email address/);
    expect(provider.getSent()).toHaveLength(0);
  });

  it("requires durationMinutes for calendar_free_slots", async () => {
    await expect(
      dispatchCalendarTool(platform, "calendar_free_slots", {}),
    ).rejects.toThrow(/durationMinutes is required/);
  });

  it("caps an explicit calendar_free_slots end at the shared span", async () => {
    // The slot search reads the window through every provider and walks it day
    // by day, so the tool path must not accept a range the REST path refuses.
    await expect(
      dispatchCalendarTool(platform, "calendar_free_slots", {
        start: "2026-08-17T00:00:00.000Z",
        end: "2036-08-17T00:00:00.000Z",
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/range must be 62 days or less/);
  });

  it("defaults calendar_free_slots to a seven-day window", async () => {
    calendarStore.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    await dispatchCalendarTool(platform, "calendar_free_slots", {
      start: "2026-08-17T00:00:00.000Z",
      durationMinutes: 30,
    });
    expect(caldav.ranges[0]).toEqual({
      start: "2026-08-17T00:00:00.000Z",
      end: "2026-08-24T00:00:00.000Z",
    });
  });

  it("returns meetings through meetings_list", async () => {
    calendarStore.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    const created = (await dispatchCalendarTool(platform, "meeting_create", {
      title: "Sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      attendees: ["ada@acme.example"],
    })) as { meeting: { id: string } };
    const listed = (await dispatchCalendarTool(platform, "meetings_list", {})) as {
      meetings: Array<{ id: string }>;
    };
    expect(listed.meetings.map((m) => m.id)).toEqual([created.meeting.id]);

    await dispatchCalendarTool(platform, "meeting_cancel", { meetingId: created.meeting.id });
    expect(calendarStore.getMeeting(created.meeting.id)!.status).toBe("cancelled");
  });

  it("throws on an unknown tool", async () => {
    await expect(dispatchCalendarTool(platform, "calendar_nope", {})).rejects.toThrow(
      /unknown tool: calendar_nope/,
    );
  });
});

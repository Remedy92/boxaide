/**
 * CalendarService.refreshRsvps: the two RSVP sources meeting in one pass.
 *
 * Mail is a hand-written fake rather than FixtureProvider, because the fixture
 * mailbox stores no iMIP part — `calendar` only ever comes off a real
 * getMessage — and the point of these tests is what the service does with that
 * field. Calendars are the same kind of fake used in test/calendar.test.ts.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarService } from "../src/calendar/service.js";
import { CalendarStore, type StoredMeeting } from "../src/calendar/store.js";
import type {
  CalDavConfig,
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  EventRange,
  ProviderAttendeeStatus,
} from "../src/calendar/types.js";
import type { MailService } from "../src/mail/service.js";
import type { MailMessage, MailMessageSummary } from "../src/provider/types.js";

const CALDAV: CalDavConfig = {
  kind: "caldav",
  serverUrl: "https://caldav.example/dav",
  username: "me@test.com",
  password: "app-password",
};

/* -- fakes ---------------------------------------------------------------- */

class FakeCalendar implements CalendarProvider {
  statuses: ProviderAttendeeStatus[] = [];
  statusError: Error | null = null;
  /** Undefined until a test asks for the top-up, so "provider cannot answer" is testable. */
  getAttendeeStatus?: (
    config: CalendarConfig,
    calendarId: string,
    eventId: string,
  ) => Promise<ProviderAttendeeStatus[]>;
  polled: Array<{ calendarId: string; eventId: string }> = [];

  supportsStatus(): void {
    this.getAttendeeStatus = async (_config, calendarId, eventId) => {
      this.polled.push({ calendarId, eventId });
      if (this.statusError) throw this.statusError;
      return this.statuses;
    };
  }

  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "cal-1", name: "Work" }];
  }
  async listEvents(
    _c: CalendarConfig,
    _r: EventRange,
  ): Promise<Omit<CalendarEvent, "accountId" | "accountAlias">[]> {
    return [];
  }
  async createEvent(): Promise<{ eventId: string; calendarId: string }> {
    return { eventId: "event-1", calendarId: "cal-1" };
  }
  async deleteEvent(): Promise<boolean> {
    return true;
  }
}

type SeededMessage = {
  from: string;
  date: string;
  internalDate?: string;
  calendar?: { method?: string; content: string };
};

/** Only the three methods refreshRsvps calls; everything else would be dead weight. */
class FakeMail {
  accounts: Array<{ id: string; alias: string; email: string; createdAt: string }> = [];
  boxes = new Map<string, SeededMessage[]>();
  listErrors = new Map<string, Error>();
  /** Every listMessages call, so the scan window and cursor can be asserted. */
  listed: Array<{ accountId: string; since?: string; limit?: number }> = [];
  fetched: string[] = [];

  addAccount(alias: string, email: string): string {
    const id = `mail-${this.accounts.length + 1}`;
    this.accounts.push({ id, alias, email, createdAt: new Date().toISOString() });
    this.boxes.set(id, []);
    return id;
  }

  seed(accountId: string, messages: SeededMessage[]): void {
    this.boxes.set(accountId, messages);
  }

  listAccounts() {
    return this.accounts;
  }

  async listMessages(
    accountId: string,
    opts: { folder?: string; since?: string; limit?: number; offset?: number } = {},
  ): Promise<{ messages: MailMessageSummary[]; errors: [] }> {
    this.listed.push({ accountId, since: opts.since, limit: opts.limit });
    const boom = this.listErrors.get(accountId);
    if (boom) throw boom;
    const box = this.boxes.get(accountId) ?? [];
    const inWindow = box
      .map((m, i) => this.summary(accountId, i, m))
      // The index hands back the newest first and only what is inside `since`.
      .filter((m) => !opts.since || new Date(m.date).getTime() >= new Date(opts.since).getTime())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    // ORDER BY date DESC LIMIT ? OFFSET ?, so a truncated page loses the OLDEST
    // mail and paging deeper is how a caller reaches it.
    const offset = opts.offset ?? 0;
    const messages = inWindow.slice(offset, offset + (opts.limit ?? inWindow.length));
    return { messages, errors: [] };
  }

  async getMessage(accountId: string, messageId: string): Promise<MailMessage | null> {
    this.fetched.push(messageId);
    const box = this.boxes.get(accountId) ?? [];
    const index = Number(messageId.split(":")[1]);
    const seeded = box[index];
    if (!seeded) return null;
    return { ...this.summary(accountId, index, seeded), bodyText: "", calendar: seeded.calendar };
  }

  private summary(accountId: string, index: number, m: SeededMessage): MailMessageSummary {
    return {
      id: `${accountId}:${index}`,
      accountId,
      uid: index + 1,
      folder: "INBOX",
      from: m.from,
      to: "me@test.com",
      subject: "Re: invite",
      date: m.date,
      internalDate: m.internalDate,
      snippet: "",
      seen: false,
      hasAttachments: true,
    };
  }
}

/* -- iMIP bodies ---------------------------------------------------------- */

function reply(
  uid: string,
  attendee: string,
  partstat: string,
  sequence = 0,
  method = "REPLY",
): { method: string; content: string } {
  return {
    method,
    content: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `METHOD:${method}`,
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `SEQUENCE:${sequence}`,
      `ATTENDEE;PARTSTAT=${partstat}:mailto:${attendee}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  };
}

/* -- tests ---------------------------------------------------------------- */

describe("CalendarService.refreshRsvps", () => {
  let db: Database.Database;
  let store: CalendarStore;
  let mail: FakeMail;
  let caldav: FakeCalendar;
  let service: CalendarService;
  let mailAccountId: string;
  let calendarAccountId: string;
  /**
   * When every seeded reply arrives. A first pass starts at the oldest
   * meeting's createdAt — a reply cannot predate the invite it answers — so
   * this has to sit after the meetings these tests create.
   */
  let NOW: string;

  beforeEach(() => {
    NOW = new Date(Date.now() + 60_000).toISOString();
    db = new Database(":memory:");
    store = new CalendarStore(db, randomBytes(32));
    mail = new FakeMail();
    mailAccountId = mail.addAccount("work", "me@test.com");
    calendarAccountId = store.addAccount({
      alias: "work-cal",
      email: "me@test.com",
      config: CALDAV,
    }).id;
    caldav = new FakeCalendar();
    service = new CalendarService(store, mail as unknown as MailService, {
      caldav,
      google: new FakeCalendar(),
    });
  });

  afterEach(() => db.close());

  function addMeeting(over: Partial<StoredMeeting> = {}): StoredMeeting {
    return store.addMeeting({
      uid: "uid-1@boxaide",
      calendarAccountId,
      eventId: "event-1",
      calendarId: "cal-1",
      mailAccountId,
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      attendees: ["ada@acme.example", "bob@acme.example"],
      location: null,
      meetingUrl: null,
      ...over,
    });
  }

  const statusOf = (meetingId: string, email: string) =>
    store.getMeeting(meetingId)?.attendeeStatus.find((a) => a.email === email);

  /* ---- email leg ------------------------------------------------------- */

  it("records an accept from an inbound REPLY", async () => {
    const meeting = addMeeting();
    mail.seed(mailAccountId, [
      {
        from: "Ada <ada@acme.example>",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED"),
      },
    ]);

    const { updated, errors } = await service.refreshRsvps();
    expect(errors).toEqual([]);
    expect(updated).toBe(1);
    expect(statusOf(meeting.id, "ada@acme.example")).toEqual({
      email: "ada@acme.example",
      status: "accepted",
      respondedAt: NOW,
      source: "email",
    });
    // Nobody else answered, so the rest of the guest list stays open.
    expect(statusOf(meeting.id, "bob@acme.example")).toMatchObject({
      status: "needs-action",
      source: "none",
    });
  });

  it("ignores a reply that answers an older invite", async () => {
    const meeting = addMeeting();
    // A fresher answer is already on file at SEQUENCE 2.
    store.recordRsvp({
      meetingId: meeting.id,
      email: "ada@acme.example",
      status: "declined",
      respondedAt: NOW,
      source: "email",
      sequence: 2,
    });
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED", 1),
      },
    ]);

    const { updated } = await service.refreshRsvps();
    expect(updated).toBe(0);
    expect(statusOf(meeting.id, "ada@acme.example")).toMatchObject({ status: "declined" });
  });

  it("ignores an ATTENDEE who is not on the invite", async () => {
    const meeting = addMeeting();
    // Ada forwarded the invite; the forwardee's reply carries our UID but the
    // organizer never asked them, so it must not appear on the guest list.
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "stranger@elsewhere.example", "ACCEPTED"),
      },
    ]);

    const { updated } = await service.refreshRsvps();
    expect(updated).toBe(0);
    expect(store.getMeeting(meeting.id)!.attendeeStatus.map((a) => a.email)).toEqual([
      "ada@acme.example",
      "bob@acme.example",
    ]);
    expect(store.listRsvps(meeting.id)).toEqual([]);
  });

  it("never opens mail from outside the guest list", async () => {
    const meeting = addMeeting();
    mail.seed(mailAccountId, [
      { from: "newsletter@spam.example", date: NOW, internalDate: NOW },
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "TENTATIVE"),
      },
    ]);

    await service.refreshRsvps();
    expect(mail.fetched).toEqual([`${mailAccountId}:1`]);
    expect(statusOf(meeting.id, "ada@acme.example")).toMatchObject({ status: "tentative" });
  });

  it("skips a calendar part that is not a REPLY", async () => {
    const meeting = addMeeting();
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED", 0, "REQUEST"),
      },
    ]);
    const { updated } = await service.refreshRsvps();
    expect(updated).toBe(0);
  });

  it("skips a reply whose UID belongs to no meeting of ours", async () => {
    const meeting = addMeeting();
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply("someone-elses-uid", "ada@acme.example", "ACCEPTED"),
      },
    ]);
    const { updated } = await service.refreshRsvps();
    expect(updated).toBe(0);
    expect(store.listRsvps(meeting.id)).toEqual([]);
  });

  it("refuses a reply that answers for another guest", async () => {
    const meeting = addMeeting();
    // Ada is a real guest and knows the UID from her own invite. Her body
    // declines for Bob, whose address she read off the To header.
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "bob@acme.example", "DECLINED"),
      },
    ]);

    const { updated } = await service.refreshRsvps();
    expect(updated).toBe(0);
    expect(statusOf(meeting.id, "bob@acme.example")).toMatchObject({
      status: "needs-action",
      source: "none",
    });
    expect(store.listRsvps(meeting.id)).toEqual([]);
  });

  it("clamps an inflated SEQUENCE to the one we actually sent", async () => {
    const meeting = addMeeting();
    const later = new Date(new Date(NOW).getTime() + 60_000).toISOString();
    mail.seed(mailAccountId, [
      // SEQUENCE:999 answers an invite that does not exist; unclamped it would
      // outrank every genuine reply and freeze Ada as accepted for good.
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED", 999),
      },
      {
        from: "ada@acme.example",
        date: later,
        internalDate: later,
        calendar: reply(meeting.uid, "ada@acme.example", "DECLINED", 0),
      },
    ]);

    await service.refreshRsvps();
    expect(statusOf(meeting.id, "ada@acme.example")).toMatchObject({
      status: "declined",
      respondedAt: later,
    });
    expect(store.listRsvps(meeting.id)[0].sequence).toBe(0);
  });

  it("advances the scan cursor and reads from it next time", async () => {
    const meeting = addMeeting();
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED"),
      },
    ]);

    await service.refreshRsvps();
    expect(store.getRsvpScanCursor(mailAccountId)).toBe(NOW);
    await service.refreshRsvps();
    expect(mail.listed[1].since).toBe(NOW);
  });

  it("finishes a capped batch of replies over two passes", async () => {
    // 45 guests answer between two passes; only RSVP_FETCH_LIMIT (40) messages
    // are opened per pass. The cursor used to jump to the newest listed header,
    // which put the five it never opened behind the cursor forever.
    const guests = Array.from({ length: 45 }, (_, i) => `guest${i + 1}@acme.example`);
    const meeting = addMeeting({ attendees: guests });
    const at = (i: number) => new Date(new Date(NOW).getTime() + i * 60_000).toISOString();
    mail.seed(
      mailAccountId,
      guests.map((email, i) => ({
        from: email,
        date: at(i),
        internalDate: at(i),
        calendar: reply(meeting.uid, email, "ACCEPTED"),
      })),
    );

    const first = await service.refreshRsvps();
    expect(first.updated).toBe(40);
    // The oldest 40 are the ones read: the cursor only moves forward, so the
    // old end of the window has to be consumed first.
    expect(statusOf(meeting.id, guests[0])).toMatchObject({ status: "accepted" });
    expect(statusOf(meeting.id, guests[39])).toMatchObject({ status: "accepted" });
    expect(statusOf(meeting.id, guests[40])).toMatchObject({ status: "needs-action" });
    expect(store.getRsvpScanCursor(mailAccountId)).toBe(at(39));

    const second = await service.refreshRsvps();
    expect(second.updated).toBe(5);
    expect(
      store.getMeeting(meeting.id)!.attendeeStatus.filter((a) => a.status !== "accepted"),
    ).toEqual([]);
  });

  it("pages down to the oldest mail when the listing is truncated", async () => {
    // A truncated listing has dropped the OLDEST mail in the window (the index
    // orders date DESC), which is exactly what the cursor is standing on. So
    // the scan pages down to the last page and consumes that: the cursor moves
    // forward by a page each pass instead of stalling on the newest slice,
    // which on a busy mailbox would re-read the same rows for ever and never
    // reach the replies below them.
    const meeting = addMeeting();
    const older = NOW;
    const newer = new Date(new Date(NOW).getTime() + 60_000).toISOString();
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: older,
        internalDate: older,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED"),
      },
      {
        from: "bob@acme.example",
        date: newer,
        internalDate: newer,
        calendar: reply(meeting.uid, "bob@acme.example", "DECLINED"),
      },
    ]);

    const { updated } = await service.refreshRsvps({ limit: 1 });
    // Ada's is the oldest page, so hers is the one read — and the cursor now
    // stands on it, which is what lets the next pass reach Bob.
    expect(updated).toBe(1);
    expect(statusOf(meeting.id, "ada@acme.example")).toMatchObject({ status: "accepted" });
    expect(statusOf(meeting.id, "bob@acme.example")).toMatchObject({ status: "needs-action" });
    expect(store.getRsvpScanCursor(mailAccountId)).toBe(older);

    const second = await service.refreshRsvps({ limit: 1 });
    expect(second.updated).toBe(1);
    expect(statusOf(meeting.id, "bob@acme.example")).toMatchObject({ status: "declined" });
    expect(store.getRsvpScanCursor(mailAccountId)).toBe(newer);
  });

  it("leaves the cursor alone when the mailbox read fails", async () => {
    addMeeting();
    mail.listErrors.set(mailAccountId, new Error("connection reset"));
    const { errors } = await service.refreshRsvps();
    expect(errors).toEqual(["work: connection reset"]);
    expect(store.getRsvpScanCursor(mailAccountId)).toBeNull();
  });

  it("keeps one broken mailbox from sinking the others", async () => {
    const second = mail.addAccount("personal", "me@personal.example");
    const broken = addMeeting({ uid: "uid-broken@boxaide" });
    const ok = addMeeting({ uid: "uid-ok@boxaide", mailAccountId: second, eventId: null });
    mail.listErrors.set(mailAccountId, new Error("auth failed"));
    mail.seed(second, [
      {
        from: "bob@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(ok.uid, "bob@acme.example", "DECLINED"),
      },
    ]);

    const { updated, errors } = await service.refreshRsvps();
    expect(errors).toEqual(["work: auth failed"]);
    expect(updated).toBe(1);
    expect(statusOf(ok.id, "bob@acme.example")).toMatchObject({ status: "declined" });
    expect(statusOf(broken.id, "ada@acme.example")).toMatchObject({ status: "needs-action" });
  });

  /* ---- provider leg ---------------------------------------------------- */

  it("fills only the gaps the email replies left", async () => {
    const meeting = addMeeting();
    caldav.supportsStatus();
    caldav.statuses = [
      // The provider disagrees about Ada; her own reply is the record.
      { email: "ada@acme.example", status: "declined" },
      { email: "bob@acme.example", status: "tentative" },
    ];
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(meeting.uid, "ada@acme.example", "ACCEPTED"),
      },
    ]);

    const { updated, errors } = await service.refreshRsvps();
    expect(errors).toEqual([]);
    expect(updated).toBe(2); // Ada by email, Bob by provider
    expect(caldav.polled).toEqual([{ calendarId: "cal-1", eventId: "event-1" }]);
    expect(statusOf(meeting.id, "ada@acme.example")).toMatchObject({
      status: "accepted",
      source: "email",
      respondedAt: NOW,
    });
    expect(statusOf(meeting.id, "bob@acme.example")).toEqual({
      email: "bob@acme.example",
      status: "tentative",
      // A provider read is a state, not an event: it carries no timestamp.
      respondedAt: null,
      source: "provider",
    });
  });

  it("spends the poll budget on the meetings happening soonest", async () => {
    // Meetings are stored newest-start first, so without a re-sort the budget
    // goes on the ones furthest out and tomorrow's — the one guests are
    // actually answering — is never polled.
    caldav.supportsStatus();
    const soon = addMeeting({ start: "2026-08-18T09:00:00.000Z", eventId: "event-soon" });
    for (let i = 0; i < 25; i++) {
      addMeeting({ start: `2027-0${(i % 9) + 1}-01T09:00:00.000Z`, eventId: `event-far-${i}` });
    }

    await service.refreshRsvps();
    const polled = caldav.polled.map((p) => p.eventId);
    expect(polled).toContain("event-soon");
    expect(polled.length).toBe(20);
    expect(soon.status).toBe("scheduled");
  });

  it("counts a provider re-read of an unchanged answer as nothing new", async () => {
    // `updated` is what the UI and the agent report as replies that came in, so
    // a poll that reads the same state every minute must not keep announcing it.
    const meeting = addMeeting();
    caldav.supportsStatus();
    caldav.statuses = [{ email: "bob@acme.example", status: "accepted" }];

    expect((await service.refreshRsvps()).updated).toBe(1);
    expect((await service.refreshRsvps()).updated).toBe(0);

    // A real change still counts.
    caldav.statuses = [{ email: "bob@acme.example", status: "declined" }];
    expect((await service.refreshRsvps()).updated).toBe(1);
    expect(statusOf(meeting.id, "bob@acme.example")).toMatchObject({ status: "declined" });
  });

  it("skips meetings that are cancelled, unwritten, or on a provider that cannot answer", async () => {
    caldav.supportsStatus();
    caldav.statuses = [{ email: "ada@acme.example", status: "accepted" }];
    const noEvent = addMeeting({ uid: "uid-noevent@boxaide", eventId: null });
    const cancelled = addMeeting({ uid: "uid-cancelled@boxaide" });
    store.markCancelled(cancelled.id);
    const live = addMeeting({ uid: "uid-live@boxaide", eventId: "event-9" });

    const { updated, errors } = await service.refreshRsvps();
    expect(errors).toEqual([]);
    expect(updated).toBe(1);
    expect(caldav.polled).toEqual([{ calendarId: "cal-1", eventId: "event-9" }]);
    expect(statusOf(live.id, "ada@acme.example")).toMatchObject({ source: "provider" });
    expect(statusOf(noEvent.id, "ada@acme.example")).toMatchObject({ source: "none" });
    expect(statusOf(cancelled.id, "ada@acme.example")).toMatchObject({ source: "none" });

    // A provider with no getAttendeeStatus contributes nothing and no error.
    const bare = new FakeCalendar();
    const bareService = new CalendarService(store, mail as unknown as MailService, {
      caldav: bare,
      google: bare,
    });
    expect(await bareService.refreshRsvps()).toEqual({ updated: 0, errors: [] });
  });

  it("reports a failing poll per meeting and keeps the rest", async () => {
    caldav.supportsStatus();
    const failing = addMeeting({ uid: "uid-fail@boxaide", title: "Broken sync" });
    caldav.statusError = new Error("HTTP 401: token expired");

    const { updated, errors } = await service.refreshRsvps();
    expect(updated).toBe(0);
    expect(errors).toEqual(["Broken sync: HTTP 401: token expired"]);
    expect(statusOf(failing.id, "ada@acme.example")).toMatchObject({ status: "needs-action" });
  });

  /* ---- scoping --------------------------------------------------------- */

  it("scans only the named mailbox", async () => {
    const second = mail.addAccount("personal", "me@personal.example");
    caldav.supportsStatus();
    const mine = addMeeting({ uid: "uid-mine@boxaide" });
    addMeeting({ uid: "uid-theirs@boxaide", mailAccountId: second, eventId: "event-theirs" });
    mail.seed(mailAccountId, [
      {
        from: "ada@acme.example",
        date: NOW,
        internalDate: NOW,
        calendar: reply(mine.uid, "ada@acme.example", "ACCEPTED"),
      },
    ]);

    const { updated } = await service.refreshRsvps({ mailAccountId: "work" });
    expect(updated).toBe(1);
    expect(mail.listed.map((l) => l.accountId)).toEqual([mailAccountId]);
    // The other mailbox's meeting is not polled either.
    expect(caldav.polled.map((p) => p.eventId)).toEqual(["event-1"]);
  });

  it("throws on a mailbox that does not exist", async () => {
    addMeeting();
    await expect(service.refreshRsvps({ mailAccountId: "ghost" })).rejects.toThrow(
      "mail account not found: ghost",
    );
  });

  it("does nothing, and touches no cursor, when there are no meetings", async () => {
    mail.seed(mailAccountId, [{ from: "ada@acme.example", date: NOW, internalDate: NOW }]);
    expect(await service.refreshRsvps()).toEqual({ updated: 0, errors: [] });
    expect(mail.listed).toEqual([]);
    expect(store.getRsvpScanCursor(mailAccountId)).toBeNull();
  });
});

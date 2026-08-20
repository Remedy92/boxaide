/**
 * Guest-response persistence: the merge ladder in CalendarStore.recordRsvp,
 * the needs-action default, the scanner cursor and the hand-written cascades.
 */
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarStore } from "../src/calendar/store.js";

describe("CalendarStore rsvps", () => {
  let db: Database.Database;
  let store: CalendarStore;

  const addMeeting = (attendees = ["ada@acme.example", "bob@acme.example"]) =>
    store.addMeeting({
      uid: "uid-rsvp@boxaide",
      calendarAccountId: null,
      eventId: null,
      calendarId: null,
      mailAccountId: "mail-1",
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      attendees,
      location: null,
      meetingUrl: null,
    });

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CalendarStore(db, randomBytes(32));
  });

  afterEach(() => db.close());

  it("reports every invited attendee, defaulting to needs-action", () => {
    const meeting = addMeeting();
    expect(meeting.attendeeStatus).toEqual([
      { email: "ada@acme.example", status: "needs-action", respondedAt: null, source: "none" },
      { email: "bob@acme.example", status: "needs-action", respondedAt: null, source: "none" },
    ]);

    store.recordRsvp({
      meetingId: meeting.id,
      email: "ada@acme.example",
      status: "accepted",
      respondedAt: "2026-08-18T10:00:00.000Z",
      source: "email",
    });

    const read = store.getMeeting(meeting.id)!;
    expect(read.attendeeStatus).toEqual([
      {
        email: "ada@acme.example",
        status: "accepted",
        respondedAt: "2026-08-18T10:00:00.000Z",
        source: "email",
      },
      { email: "bob@acme.example", status: "needs-action", respondedAt: null, source: "none" },
    ]);
    // listMeetings takes the batched path and must agree with getMeeting.
    expect(store.listMeetings()[0]!.attendeeStatus).toEqual(read.attendeeStatus);
  });

  it("keeps the attendee address out of the clear on disk", () => {
    const meeting = addMeeting();
    store.recordRsvp({
      meetingId: meeting.id,
      email: "ada@acme.example",
      status: "accepted",
      source: "provider",
    });
    const row = db
      .prepare(`SELECT attendee_email_hash, attendee_email_enc FROM calendar_meeting_rsvps`)
      .get() as { attendee_email_hash: string; attendee_email_enc: string };
    expect(row.attendee_email_enc).not.toContain("ada@acme.example");
    expect(row.attendee_email_hash).not.toContain("ada@acme.example");
    expect(store.listRsvps(meeting.id)[0]!.email).toBe("ada@acme.example");
  });

  it("lets an email reply beat provider status, but never the other way round", () => {
    const meeting = addMeeting();
    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "tentative",
        source: "provider",
      }),
    ).toBe(true);
    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "accepted",
        respondedAt: "2026-08-18T10:00:00.000Z",
        source: "email",
      }),
    ).toBe(true);
    // Provider top-up arrives late and must not clobber the guest's own reply.
    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "declined",
        source: "provider",
      }),
    ).toBe(false);

    expect(store.listRsvps(meeting.id)).toEqual([
      {
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "accepted",
        respondedAt: "2026-08-18T10:00:00.000Z",
        source: "email",
        sequence: 0,
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("prefers the newer responded_at between email replies", () => {
    const meeting = addMeeting();
    store.recordRsvp({
      meetingId: meeting.id,
      email: "ada@acme.example",
      status: "accepted",
      respondedAt: "2026-08-18T10:00:00.000Z",
      source: "email",
    });
    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "declined",
        respondedAt: "2026-08-18T12:00:00.000Z",
        source: "email",
      }),
    ).toBe(true);
    expect(store.listRsvps(meeting.id)[0]!.status).toBe("declined");

    // An older reply delivered out of order changes nothing.
    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "accepted",
        respondedAt: "2026-08-18T09:00:00.000Z",
        source: "email",
      }),
    ).toBe(false);
    expect(store.listRsvps(meeting.id)[0]!.status).toBe("declined");
  });

  it("ignores a reply carrying a stale SEQUENCE and accepts a newer one", () => {
    const meeting = addMeeting();
    store.recordRsvp({
      meetingId: meeting.id,
      email: "ada@acme.example",
      status: "accepted",
      respondedAt: "2026-08-18T10:00:00.000Z",
      source: "email",
      sequence: 2,
    });
    // Sequence outranks the timestamp: this reply answers an older invite.
    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "declined",
        respondedAt: "2026-08-18T18:00:00.000Z",
        source: "email",
        sequence: 1,
      }),
    ).toBe(false);
    expect(store.listRsvps(meeting.id)[0]!.status).toBe("accepted");

    expect(
      store.recordRsvp({
        meetingId: meeting.id,
        email: "ada@acme.example",
        status: "declined",
        respondedAt: "2026-08-18T09:00:00.000Z",
        source: "email",
        sequence: 3,
      }),
    ).toBe(true);
    expect(store.listRsvps(meeting.id)[0]).toMatchObject({ status: "declined", sequence: 3 });
  });

  it("batches responses per meeting", () => {
    const one = addMeeting(["ada@acme.example"]);
    const two = addMeeting(["bob@acme.example"]);
    addMeeting(["cy@acme.example"]);
    store.recordRsvp({ meetingId: one.id, email: "ada@acme.example", status: "accepted", source: "provider" });
    store.recordRsvp({ meetingId: two.id, email: "bob@acme.example", status: "declined", source: "provider" });

    const batch = store.listRsvpsFor([one.id, two.id]);
    expect(batch.get(one.id)!.map((r) => r.status)).toEqual(["accepted"]);
    expect(batch.get(two.id)!.map((r) => r.status)).toEqual(["declined"]);
    expect(store.listRsvpsFor([]).size).toBe(0);
  });

  it("round-trips the scanner cursor per mail account", () => {
    expect(store.getRsvpScanCursor("mail-1")).toBeNull();
    store.setRsvpScanCursor("mail-1", "2026-08-18T10:00:00.000Z");
    expect(store.getRsvpScanCursor("mail-1")).toBe("2026-08-18T10:00:00.000Z");
    store.setRsvpScanCursor("mail-1", "2026-08-18T11:00:00.000Z");
    expect(store.getRsvpScanCursor("mail-1")).toBe("2026-08-18T11:00:00.000Z");
    expect(store.getRsvpScanCursor("mail-2")).toBeNull();
  });

  it("drops responses with their meeting, and sweeps orphans on account delete", () => {
    const account = store.addAccount({
      alias: "work",
      email: "me@test.com",
      config: {
        kind: "caldav",
        serverUrl: "https://caldav.example",
        username: "me@test.com",
        password: "app-password",
      },
    });
    const meeting = addMeeting(["ada@acme.example"]);
    store.recordRsvp({ meetingId: meeting.id, email: "ada@acme.example", status: "accepted", source: "email" });

    expect(store.deleteMeeting(meeting.id)).toBe(true);
    expect(store.listRsvps(meeting.id)).toEqual([]);
    expect(store.deleteMeeting(meeting.id)).toBe(false);

    // Meetings outlive their calendar account, so their responses must survive
    // the delete — only rows whose meeting is gone get swept.
    const kept = addMeeting(["ada@acme.example"]);
    store.recordRsvp({ meetingId: kept.id, email: "ada@acme.example", status: "accepted", source: "email" });
    store.recordRsvp({ meetingId: "meeting-gone", email: "ada@acme.example", status: "accepted", source: "email" });
    expect(store.deleteAccount(account.id)).toBe(true);
    expect(store.listRsvps(kept.id)).toHaveLength(1);
    expect(store.listRsvps("meeting-gone")).toEqual([]);
  });
});

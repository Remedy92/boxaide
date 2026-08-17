/**
 * Calendar pure units: the ICS writer, CalDAV object parsing, and the slot
 * search. No database, no providers, no I/O — the stateful half lives in
 * test/calendar.test.ts.
 *
 * Working hours are server-local, so the slot tests build their expectations
 * with local Date constructors instead of hardcoded ISO strings; they pass in
 * any timezone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildIcs, icsDate, jitsiLink, newEventUid, type InviteEvent } from "../src/calendar/ics.js";
import { parseObjectInstances } from "../src/calendar/caldav.js";
import { computeFreeSlots, type FreeSlot } from "../src/calendar/service.js";
import type { EventRange } from "../src/calendar/types.js";

/* ======================================================================== */
/* ICS writer                                                              */
/* ======================================================================== */

describe("buildIcs", () => {
  const base: InviteEvent = {
    uid: "abc123@boxaide",
    title: "Design sync",
    start: "2026-08-19T14:00:00.000Z",
    end: "2026-08-19T15:00:00.000Z",
    organizerEmail: "me@test.com",
    organizerName: "Me",
    attendees: ["ada@acme.example", "bob@acme.example"],
  };

  function lines(ics: string): string[] {
    expect(ics.endsWith("\r\n")).toBe(true);
    return ics.slice(0, -2).split("\r\n");
  }

  /** Content lines with RFC 5545 folding undone. */
  function unfolded(ics: string): string[] {
    return lines(ics.replace(/\r\n /g, ""));
  }

  it("emits CRLF-delimited iMIP with UTC basic-format timestamps", () => {
    const ics = buildIcs(base, "REQUEST");
    expect(ics.includes("\n")).toBe(true);
    // Every LF is part of a CRLF pair; no bare newline anywhere.
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");

    const out = lines(ics);
    expect(out[0]).toBe("BEGIN:VCALENDAR");
    expect(out).toContain("VERSION:2.0");
    expect(out).toContain("METHOD:REQUEST");
    expect(out).toContain("UID:abc123@boxaide");
    expect(out).toContain("DTSTART:20260819T140000Z");
    expect(out).toContain("DTEND:20260819T150000Z");
    expect(out).toContain("STATUS:CONFIRMED");
    expect(out).toContain("SEQUENCE:0");
    expect(out[out.length - 1]).toBe("END:VCALENDAR");
    // DTSTAMP is "now" but must still be a UTC basic-format instant.
    const stamp = out.find((l) => l.startsWith("DTSTAMP:"));
    expect(stamp).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
  });

  it("writes one ORGANIZER and one ATTENDEE line per attendee", () => {
    // ATTENDEE lines are longer than 75 octets, so they arrive folded.
    const out = unfolded(buildIcs(base, "REQUEST"));
    const organizers = out.filter((l) => l.startsWith("ORGANIZER"));
    expect(organizers).toEqual(["ORGANIZER;CN=Me:mailto:me@test.com"]);
    const attendees = out.filter((l) => l.startsWith("ATTENDEE"));
    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toBe(
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ada@acme.example",
    );
    expect(attendees[1]).toContain("mailto:bob@acme.example");
  });

  it("falls back to the organizer email as CN", () => {
    const out = lines(buildIcs({ ...base, organizerName: undefined }, "REQUEST"));
    expect(out).toContain("ORGANIZER;CN=me@test.com:mailto:me@test.com");
  });

  it("escapes comma, semicolon and newline in TEXT values", () => {
    const ics = buildIcs(
      {
        ...base,
        title: "Q3, plan; go",
        description: "line one\nline two",
        location: "Room A, floor 2",
      },
      "REQUEST",
    );
    const out = lines(ics);
    expect(out).toContain("SUMMARY:Q3\\, plan\\; go");
    expect(out).toContain("DESCRIPTION:line one\\nline two");
    expect(out).toContain("LOCATION:Room A\\, floor 2");
  });

  it("folds lines longer than 75 octets", () => {
    const title = "Very long meeting title ".repeat(6).trim();
    const ics = buildIcs({ ...base, title }, "REQUEST");
    for (const line of lines(ics)) {
      expect(Buffer.from(line, "utf8").length).toBeLessThanOrEqual(75);
    }
    expect(ics).toContain("\r\n ");
    // Unfolding restores the original value.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`SUMMARY:${title}`);
  });

  it("marks CANCEL with STATUS:CANCELLED and the given SEQUENCE", () => {
    const out = lines(buildIcs({ ...base, sequence: 1 }, "CANCEL"));
    expect(out).toContain("METHOD:CANCEL");
    expect(out).toContain("STATUS:CANCELLED");
    expect(out).toContain("SEQUENCE:1");
  });

  it("omits METHOD when no method is given", () => {
    const out = lines(buildIcs(base));
    expect(out.some((l) => l.startsWith("METHOD:"))).toBe(false);
    expect(out).toContain("STATUS:CONFIRMED");
  });

  it("rejects an unparseable date", () => {
    expect(() => icsDate("not-a-date")).toThrow(/invalid date/);
  });

  it("mints unique uids", () => {
    const a = newEventUid();
    expect(a).toMatch(/^[0-9a-f]{24}@boxaide$/);
    expect(a).not.toBe(newEventUid());
  });
});

describe("jitsiLink", () => {
  const original = process.env.BOXAIDE_JITSI_BASE;
  afterEach(() => {
    if (original === undefined) delete process.env.BOXAIDE_JITSI_BASE;
    else process.env.BOXAIDE_JITSI_BASE = original;
  });

  it("slugs the title and stays unique across calls", () => {
    delete process.env.BOXAIDE_JITSI_BASE;
    const a = jitsiLink("Design Sync: Q3!");
    const b = jitsiLink("Design Sync: Q3!");
    expect(a).toMatch(/^https:\/\/meet\.jit\.si\/design-sync-q3-[0-9a-f]{10}$/);
    expect(a).not.toBe(b);
  });

  it("drops the slug entirely when the title has no usable characters", () => {
    delete process.env.BOXAIDE_JITSI_BASE;
    expect(jitsiLink("!!!")).toMatch(/^https:\/\/meet\.jit\.si\/[0-9a-f]{10}$/);
  });

  it("respects BOXAIDE_JITSI_BASE and strips its trailing slashes", () => {
    process.env.BOXAIDE_JITSI_BASE = "https://jitsi.internal//";
    expect(jitsiLink("Standup")).toMatch(/^https:\/\/jitsi\.internal\/standup-[0-9a-f]{10}$/);
  });
});

/* ======================================================================== */
/* CalDAV object parsing                                                   */
/* ======================================================================== */

describe("parseObjectInstances", () => {
  function ics(body: string): string {
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      body,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
  }

  const WEEK: EventRange = { start: "2026-08-17T00:00:00Z", end: "2026-08-24T00:00:00Z" };

  it("returns a plain VEVENT that falls inside the range", () => {
    const out = parseObjectInstances(
      ics(
        [
          "UID:plain-1",
          "DTSTART:20260819T140000Z",
          "DTEND:20260819T150000Z",
          "SUMMARY:Design sync",
          "LOCATION:Room A",
        ].join("\r\n"),
      ),
      "cal-1",
      "https://caldav.example/cal-1/plain-1.ics",
      WEEK,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "https://caldav.example/cal-1/plain-1.ics",
      calendarId: "cal-1",
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      location: "Room A",
      status: "confirmed",
      busy: true,
      allDay: false,
    });
  });

  it("excludes a VEVENT outside the range", () => {
    const out = parseObjectInstances(
      ics(
        ["UID:plain-2", "DTSTART:20260901T140000Z", "DTEND:20260901T150000Z", "SUMMARY:Later"].join(
          "\r\n",
        ),
      ),
      "cal-1",
      "obj",
      WEEK,
    );
    expect(out).toEqual([]);
  });

  it("expands a weekly RRULE and clips it to the range", () => {
    const object = ics(
      [
        "UID:weekly-1",
        "DTSTART:20260817T140000Z",
        "DTEND:20260817T150000Z",
        "RRULE:FREQ=WEEKLY;COUNT=10",
        "SUMMARY:Weekly standup",
      ].join("\r\n"),
    );
    const out = parseObjectInstances(object, "cal-1", "obj", {
      start: "2026-08-17T00:00:00Z",
      end: "2026-09-05T00:00:00Z",
    });
    expect(out.map((i) => i.start)).toEqual([
      "2026-08-17T14:00:00.000Z",
      "2026-08-24T14:00:00.000Z",
      "2026-08-31T14:00:00.000Z",
    ]);
    expect(out.every((i) => i.title === "Weekly standup")).toBe(true);

    // The same master clipped to one week yields the single instance in it.
    expect(parseObjectInstances(object, "cal-1", "obj", WEEK).map((i) => i.start)).toEqual([
      "2026-08-17T14:00:00.000Z",
    ]);
  });

  it("expands a years-old daily series inside the range", () => {
    // The regression: expansion starts at DTSTART, so a series running since
    // 2015 burned its whole instance budget on the past and returned NOTHING
    // for the week asked about — gone from the agenda and from busy time.
    const out = parseObjectInstances(
      ics(
        [
          "UID:old-daily-1",
          "DTSTART:20150102T140000Z",
          "DTEND:20150102T150000Z",
          "RRULE:FREQ=DAILY",
          "SUMMARY:Daily standup",
        ].join("\r\n"),
      ),
      "cal-1",
      "obj",
      WEEK,
    );
    expect(out.map((i) => i.start)).toEqual([
      "2026-08-17T14:00:00.000Z",
      "2026-08-18T14:00:00.000Z",
      "2026-08-19T14:00:00.000Z",
      "2026-08-20T14:00:00.000Z",
      "2026-08-21T14:00:00.000Z",
      "2026-08-22T14:00:00.000Z",
      "2026-08-23T14:00:00.000Z",
    ]);
    // The pattern stays anchored to DTSTART: same wall-clock hour, not the
    // hour the range happens to begin at.
    expect(out.every((i) => i.title === "Daily standup")).toBe(true);
  });

  it("keeps a weekly series on its DTSTART weekday when the range starts elsewhere", () => {
    // 2026-08-17 is a Monday; the range opens mid-week on the Wednesday.
    const out = parseObjectInstances(
      ics(
        [
          "UID:old-weekly-1",
          "DTSTART:20200106T090000Z",
          "DTEND:20200106T093000Z",
          "RRULE:FREQ=WEEKLY",
          "SUMMARY:Monday sync",
        ].join("\r\n"),
      ),
      "cal-1",
      "obj",
      { start: "2026-08-19T00:00:00Z", end: "2026-09-02T00:00:00Z" },
    );
    expect(out.map((i) => i.start)).toEqual([
      "2026-08-24T09:00:00.000Z",
      "2026-08-31T09:00:00.000Z",
    ]);
  });

  it("keeps later instances when an override moves one past the range end", () => {
    // The regression: expansion stopped at the first occurrence whose moved
    // start was outside the range, so rescheduling one standup far ahead
    // deleted every later one from the agenda and from busy time.
    const object = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:moved-1",
      "DTSTART:20260817T140000Z",
      "DTEND:20260817T150000Z",
      "RRULE:FREQ=WEEKLY",
      "SUMMARY:Weekly standup",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:moved-1",
      "RECURRENCE-ID:20260824T140000Z",
      "DTSTART:20261201T140000Z",
      "DTEND:20261201T150000Z",
      "SUMMARY:Weekly standup (moved)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = parseObjectInstances(object, "cal-1", "obj", {
      start: "2026-08-17T00:00:00Z",
      end: "2026-09-14T00:00:00Z",
    });
    expect(out.map((i) => i.start)).toEqual([
      "2026-08-17T14:00:00.000Z",
      "2026-08-31T14:00:00.000Z",
      "2026-09-07T14:00:00.000Z",
    ]);
  });

  it("treats TRANSP:TRANSPARENT as not busy", () => {
    const [instance] = parseObjectInstances(
      ics(
        [
          "UID:free-1",
          "DTSTART:20260819T140000Z",
          "DTEND:20260819T150000Z",
          "SUMMARY:Focus block",
          "TRANSP:TRANSPARENT",
        ].join("\r\n"),
      ),
      "cal-1",
      "obj",
      WEEK,
    );
    expect(instance.busy).toBe(false);
  });

  it("maps STATUS:CANCELLED and STATUS:TENTATIVE", () => {
    const withStatus = (status: string) =>
      parseObjectInstances(
        ics(
          [
            "UID:s-1",
            "DTSTART:20260819T140000Z",
            "DTEND:20260819T150000Z",
            "SUMMARY:Maybe",
            `STATUS:${status}`,
          ].join("\r\n"),
        ),
        "cal-1",
        "obj",
        WEEK,
      )[0];
    expect(withStatus("CANCELLED").status).toBe("cancelled");
    expect(withStatus("TENTATIVE").status).toBe("tentative");
  });
});

/* ======================================================================== */
/* Slot search                                                             */
/* ======================================================================== */

describe("computeFreeSlots", () => {
  /** Wednesday 2026-08-19, server-local. */
  const at = (hour: number, minute = 0, day = 19) =>
    new Date(2026, 7, day, hour, minute, 0, 0);
  const iso = (d: Date) => d.toISOString();
  const span = (a: Date, b: Date): FreeSlot => ({ start: iso(a), end: iso(b) });

  const DAY = { start: iso(at(0)), end: iso(at(23, 59)) };

  it("offers half-hour starts inside working hours when nothing is busy", () => {
    const slots = computeFreeSlots([], {
      ...DAY,
      now: iso(at(0)),
      durationMinutes: 30,
      maxSlots: 4,
    });
    expect(slots).toEqual([
      span(at(9, 0), at(9, 30)),
      span(at(9, 30), at(10, 0)),
      span(at(10, 0), at(10, 30)),
      span(at(10, 30), at(11, 0)),
    ]);
  });

  it("splits the day around a busy block and never overlaps it", () => {
    const busyStart = at(10);
    const busyEnd = at(11, 15);
    const slots = computeFreeSlots([span(busyStart, busyEnd)], {
      ...DAY,
      now: iso(at(0)),
      durationMinutes: 60,
      maxSlots: 4,
    });
    expect(slots[0]).toEqual(span(at(9), at(10)));
    // 11:15 rounds up to the next half hour.
    expect(slots[1]).toEqual(span(at(11, 30), at(12, 30)));
    for (const slot of slots) {
      const s = new Date(slot.start).getTime();
      const e = new Date(slot.end).getTime();
      expect(s < busyEnd.getTime() && e > busyStart.getTime()).toBe(false);
      expect(e).toBeLessThanOrEqual(at(17).getTime());
    }
  });

  it("skips durations that do not fit the remaining gap", () => {
    const slots = computeFreeSlots([span(at(9, 30), at(17))], {
      ...DAY,
      now: iso(at(0)),
      durationMinutes: 60,
    });
    expect(slots).toEqual([]);
    // The same gap does fit a half-hour meeting.
    expect(
      computeFreeSlots([span(at(9, 30), at(17))], {
        ...DAY,
        now: iso(at(0)),
        durationMinutes: 30,
      }),
    ).toEqual([span(at(9), at(9, 30))]);
  });

  it("respects maxSlots", () => {
    const slots = computeFreeSlots([], {
      ...DAY,
      now: iso(at(0)),
      durationMinutes: 30,
      maxSlots: 2,
    });
    expect(slots).toHaveLength(2);
  });

  it("drops slots that start before now", () => {
    const slots = computeFreeSlots([], {
      ...DAY,
      now: iso(at(10, 15)),
      durationMinutes: 30,
      maxSlots: 2,
    });
    expect(slots).toEqual([span(at(10, 30), at(11, 0)), span(at(11, 0), at(11, 30))]);
  });

  it("merges overlapping busy intervals", () => {
    const slots = computeFreeSlots(
      [span(at(9), at(11)), span(at(10), at(12))],
      { ...DAY, now: iso(at(0)), durationMinutes: 60, maxSlots: 1 },
    );
    expect(slots).toEqual([span(at(12), at(13))]);
  });

  it("returns nothing for an empty or inverted window", () => {
    expect(
      computeFreeSlots([], { ...DAY, now: iso(at(0)), durationMinutes: 30, dayEndHour: 9 }),
    ).toEqual([]);
    expect(
      computeFreeSlots([], {
        start: iso(at(12)),
        end: iso(at(9)),
        now: iso(at(0)),
        durationMinutes: 30,
      }),
    ).toEqual([]);
  });

  it("honours custom working hours", () => {
    const slots = computeFreeSlots([], {
      ...DAY,
      now: iso(at(0)),
      durationMinutes: 60,
      dayStartHour: 13,
      dayEndHour: 15,
      maxSlots: 10,
    });
    expect(slots).toEqual([span(at(13), at(14)), span(at(13, 30), at(14, 30)), span(at(14), at(15))]);
  });
});


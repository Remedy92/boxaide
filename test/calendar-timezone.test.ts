/**
 * Wall clock <-> instant conversion in named zones. Every expectation is a
 * literal ISO instant: the point of the module is that the answer does not
 * depend on the machine running the test, so building expectations with local
 * Date constructors would test nothing.
 *
 * Dates are 2026 because the DST rules there are the current ones; if a zone's
 * rules change, tzdata changes with them and these assertions are the alarm.
 */
import { describe, expect, it } from "vitest";
import {
  resolveTimeZone,
  startOfNextZonedDay,
  startOfZonedDay,
  zonedParts,
  zonedTimeToUtc,
} from "../src/calendar/timezone.js";

const iso = (instant: number): string => new Date(instant).toISOString();

/** Shorthand for the common "9am wall clock" style of expectation. */
function at(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): string {
  return iso(zonedTimeToUtc({ year, month, day, hour, minute }, zone));
}

describe("resolveTimeZone", () => {
  it("falls back to the server zone when none is given", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveTimeZone()).toBe(server);
    expect(resolveTimeZone("")).toBe(server);
    expect(resolveTimeZone("   ")).toBe(server);
  });

  it("canonicalises and trims a valid zone", () => {
    expect(resolveTimeZone("utc")).toBe("UTC");
    expect(resolveTimeZone(" Europe/Brussels ")).toBe("Europe/Brussels");
  });

  it("throws on an unknown zone instead of falling back", () => {
    expect(() => resolveTimeZone("Mars/Phobos")).toThrow(/unknown time zone: Mars\/Phobos/);
    expect(() => resolveTimeZone("Europe/Brussels/Extra")).toThrow(/unknown time zone/);
  });
});

describe("zonedTimeToUtc", () => {
  it("handles UTC itself", () => {
    expect(at("UTC", 2026, 1, 15, 8)).toBe("2026-01-15T08:00:00.000Z");
    expect(at("UTC", 2026, 7, 15, 17, 30)).toBe("2026-07-15T17:30:00.000Z");
  });

  it("handles a fixed-offset zone with no DST", () => {
    // Asia/Kolkata is +05:30 year round — also checks half-hour offsets.
    expect(at("Asia/Kolkata", 2026, 3, 15, 9)).toBe("2026-03-15T03:30:00.000Z");
    expect(at("Asia/Kolkata", 2026, 12, 25, 0)).toBe("2026-12-24T18:30:00.000Z");
  });

  it("walks the Europe/Brussels spring-forward day", () => {
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST at 01:00Z.
    expect(at("Europe/Brussels", 2026, 3, 29, 1, 30)).toBe("2026-03-29T00:30:00.000Z");
    // 02:30 never happens; resolve forward to the first legal instant, 03:00.
    const gap = zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Brussels");
    expect(iso(gap)).toBe("2026-03-29T01:00:00.000Z");
    expect(zonedParts(gap, "Europe/Brussels")).toMatchObject({ hour: 3, minute: 0 });
    expect(at("Europe/Brussels", 2026, 3, 29, 3, 30)).toBe("2026-03-29T01:30:00.000Z");
  });

  it("walks the America/New_York spring-forward day", () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT at 07:00Z.
    expect(at("America/New_York", 2026, 3, 8, 1, 30)).toBe("2026-03-08T06:30:00.000Z");
    const gap = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York");
    expect(iso(gap)).toBe("2026-03-08T07:00:00.000Z");
    expect(zonedParts(gap, "America/New_York")).toMatchObject({ hour: 3, minute: 0 });
    expect(at("America/New_York", 2026, 3, 8, 3, 30)).toBe("2026-03-08T07:30:00.000Z");
  });

  it("picks the earlier offset for ambiguous fall-back wall clocks", () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST at 05:00Z, so 01:30 local
    // happens at 05:30Z (EDT) and again at 06:30Z (EST). Take the first.
    expect(at("America/New_York", 2026, 11, 1, 1, 30)).toBe("2026-11-01T05:30:00.000Z");
    // 2026-10-25 in Brussels: 03:00 CEST falls back to 02:00 CET at 01:00Z.
    expect(at("Europe/Brussels", 2026, 10, 25, 2, 30)).toBe("2026-10-25T00:30:00.000Z");
    // The unambiguous neighbours stay put.
    expect(at("America/New_York", 2026, 11, 1, 0, 30)).toBe("2026-11-01T04:30:00.000Z");
    expect(at("America/New_York", 2026, 11, 1, 3, 0)).toBe("2026-11-01T08:00:00.000Z");
  });

  it("handles a southern-hemisphere zone where DST runs the other way", () => {
    // Sydney is +10 in the southern winter, +11 in summer.
    expect(at("Australia/Sydney", 2026, 6, 15, 9)).toBe("2026-06-14T23:00:00.000Z");
    expect(at("Australia/Sydney", 2026, 12, 15, 9)).toBe("2026-12-14T22:00:00.000Z");
    // Spring forward on 2026-10-04, 02:00 AEST -> 03:00 AEDT.
    expect(at("Australia/Sydney", 2026, 10, 4, 2, 30)).toBe("2026-10-03T16:00:00.000Z");
    // Fall back on 2026-04-05, 03:00 AEDT -> 02:00 AEST; 02:30 is ambiguous.
    expect(at("Australia/Sydney", 2026, 4, 5, 2, 30)).toBe("2026-04-04T15:30:00.000Z");
  });
});

describe("zonedParts", () => {
  it("reads the wall clock a zone shows at an instant", () => {
    expect(zonedParts(Date.parse("2026-08-17T12:34:56.789Z"), "UTC")).toEqual({
      year: 2026,
      month: 8,
      day: 17,
      hour: 12,
      minute: 34,
      second: 56,
    });
    // Same instant, three zones — including one that has already rolled over.
    const instant = Date.parse("2026-01-15T23:30:00.000Z");
    expect(zonedParts(instant, "Europe/Brussels")).toMatchObject({ day: 16, hour: 0, minute: 30 });
    expect(zonedParts(instant, "America/New_York")).toMatchObject({ day: 15, hour: 18 });
    expect(zonedParts(instant, "Australia/Sydney")).toMatchObject({ day: 16, hour: 10 });
  });

  it("reports midnight as hour 0, never 24", () => {
    expect(zonedParts(Date.parse("2026-01-15T23:00:00.000Z"), "Europe/Brussels")).toMatchObject({
      day: 16,
      hour: 0,
    });
  });
});

describe("zoned day boundaries", () => {
  it("finds midnight of the containing day", () => {
    expect(iso(startOfZonedDay(Date.parse("2026-03-29T12:00:00.000Z"), "Europe/Brussels"))).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    expect(iso(startOfZonedDay(Date.parse("2026-11-01T18:00:00.000Z"), "America/New_York"))).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(iso(startOfZonedDay(Date.parse("2026-06-14T23:30:00.000Z"), "Australia/Sydney"))).toBe(
      "2026-06-14T14:00:00.000Z",
    );
  });

  it("is idempotent", () => {
    const day = startOfZonedDay(Date.parse("2026-03-29T12:00:00.000Z"), "Europe/Brussels");
    expect(startOfZonedDay(day, "Europe/Brussels")).toBe(day);
  });

  it("steps a 23-hour day without drifting", () => {
    const start = startOfZonedDay(Date.parse("2026-03-29T12:00:00.000Z"), "Europe/Brussels");
    const next = startOfNextZonedDay(start, "Europe/Brussels");
    expect(iso(next)).toBe("2026-03-29T22:00:00.000Z");
    expect(next - start).toBe(23 * 60 * 60 * 1000);
    expect(zonedParts(next, "Europe/Brussels")).toMatchObject({ day: 30, hour: 0, minute: 0 });
  });

  it("steps a 25-hour day without drifting", () => {
    const start = startOfZonedDay(Date.parse("2026-11-01T18:00:00.000Z"), "America/New_York");
    const next = startOfNextZonedDay(start, "America/New_York");
    expect(iso(next)).toBe("2026-11-02T05:00:00.000Z");
    expect(next - start).toBe(25 * 60 * 60 * 1000);
  });

  it("walks a southern DST boundary a day at a time", () => {
    const zone = "Australia/Sydney";
    let cursor = startOfZonedDay(Date.parse("2026-10-03T05:00:00.000Z"), zone);
    const walked: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      walked.push(iso(cursor));
      expect(zonedParts(cursor, zone)).toMatchObject({ hour: 0, minute: 0 });
      cursor = startOfNextZonedDay(cursor, zone);
    }
    expect(walked).toEqual([
      "2026-10-02T14:00:00.000Z",
      "2026-10-03T14:00:00.000Z",
      "2026-10-04T13:00:00.000Z", // 23-hour day: DST started at 02:00 local
    ]);
  });

  it("rolls over month and year ends", () => {
    const zone = "Europe/Brussels";
    const dec31 = startOfZonedDay(Date.parse("2026-12-31T12:00:00.000Z"), zone);
    expect(iso(startOfNextZonedDay(dec31, zone))).toBe("2026-12-31T23:00:00.000Z");
    expect(zonedParts(startOfNextZonedDay(dec31, zone), zone)).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
    });
  });
});

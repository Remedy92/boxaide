/**
 * Free-slot search in a named time zone. The unit under test is
 * computeFreeSlots, which is pure; CalendarService.freeSlots is exercised only
 * for what it adds — resolving the zone once, echoing it, and rejecting a bad
 * one before any provider is called.
 *
 * The DST cases are the whole point of the zone work: a working window is a
 * wall clock, so "09:00" must stay 09:00 on both sides of a transition even
 * though the UTC instant behind it moves by an hour.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarService, computeFreeSlots, type FreeSlot } from "../src/calendar/service.js";
import { CalendarStore } from "../src/calendar/store.js";
import type {
  CalDavConfig,
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
} from "../src/calendar/types.js";
import type { MailService } from "../src/mail/service.js";

const CALDAV: CalDavConfig = {
  kind: "caldav",
  serverUrl: "https://caldav.example/dav",
  username: "me@test.com",
  password: "app-password",
};

type ProviderEvent = Omit<CalendarEvent, "accountId" | "accountAlias">;

class FakeProvider implements CalendarProvider {
  events: ProviderEvent[] = [];

  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "cal-1", name: "Work" }];
  }
  async listEvents(_config: CalendarConfig, _range: EventRange): Promise<ProviderEvent[]> {
    return this.events;
  }
  async createEvent(): Promise<{ eventId: string; calendarId: string }> {
    return { eventId: "event-1", calendarId: "cal-1" };
  }
  async deleteEvent(_c: CalendarConfig, _cal: string, _e: string): Promise<boolean> {
    return true;
  }
}

/** Only the starts matter here; every case asks for a fixed duration. */
const starts = (slots: FreeSlot[]): string[] => slots.map((s) => s.start);

describe("computeFreeSlots in a named zone", () => {
  // 09:00-10:00 every day, so each day contributes exactly one slot and the
  // list reads as "the same wall clock, day after day".
  const oneSlotPerDay = { durationMinutes: 60, dayStartHour: 9, dayEndHour: 10, maxSlots: 10 };

  it("holds the wall clock across a spring-forward day", () => {
    // Brussels loses 02:00-03:00 on 2026-03-29: CET (+1) becomes CEST (+2).
    const slots = computeFreeSlots([], {
      ...oneSlotPerDay,
      start: "2026-03-28T00:00:00.000Z",
      end: "2026-03-31T00:00:00.000Z",
      now: "2026-03-28T00:00:00.000Z",
      timeZone: "Europe/Brussels",
    });
    expect(starts(slots)).toEqual([
      "2026-03-28T08:00:00.000Z", // 09:00 CET
      "2026-03-29T07:00:00.000Z", // 09:00 CEST — the day is 23h long
      "2026-03-30T07:00:00.000Z",
    ]);
  });

  it("holds the wall clock across a fall-back day", () => {
    // New York repeats 01:00-02:00 on 2026-11-01: EDT (-4) becomes EST (-5).
    const slots = computeFreeSlots([], {
      ...oneSlotPerDay,
      start: "2026-10-31T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
      now: "2026-10-31T00:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(starts(slots)).toEqual([
      "2026-10-31T13:00:00.000Z", // 09:00 EDT
      "2026-11-01T14:00:00.000Z", // 09:00 EST — the day is 25h long
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("reads working hours in the zone, not the server's", () => {
    // 09:00-10:00 in Tokyo is 00:00-01:00 UTC, whatever the server's zone is.
    const slots = computeFreeSlots([], {
      ...oneSlotPerDay,
      start: "2026-08-17T00:00:00.000Z",
      end: "2026-08-18T00:00:00.000Z",
      now: "2026-08-17T00:00:00.000Z",
      timeZone: "Asia/Tokyo",
    });
    expect(starts(slots)).toEqual(["2026-08-17T00:00:00.000Z"]);
  });

  it("puts the half-hour grid on the zone's clock, not the epoch's", () => {
    // Kathmandu is UTC+05:45, so 09:00 local is 03:15Z. Rounding on epoch ms
    // snapped that to 03:30Z and offered 09:15, 09:45, 10:15 — never the hour
    // or the half hour the caller asked for.
    const slots = computeFreeSlots([], {
      durationMinutes: 30,
      maxSlots: 3,
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-02T00:00:00.000Z",
      now: "2026-09-01T00:00:00.000Z",
      timeZone: "Asia/Kathmandu",
    });
    expect(starts(slots)).toEqual([
      "2026-09-01T03:15:00.000Z", // 09:00
      "2026-09-01T03:45:00.000Z", // 09:30
      "2026-09-01T04:15:00.000Z", // 10:00
    ]);
  });

  it("still fills a one-hour window in a quarter-hour-offset zone", () => {
    // Australia/Eucla is UTC+08:45. The rounding bug pushed the only candidate
    // start to 09:15, which no longer fits before 10:00, so a whole empty year
    // came back with zero slots.
    const slots = computeFreeSlots([], {
      ...oneSlotPerDay,
      maxSlots: 2,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-03T00:00:00.000Z",
      now: "2026-01-01T00:00:00.000Z",
      timeZone: "Australia/Eucla",
    });
    expect(starts(slots)).toEqual([
      "2026-01-01T00:15:00.000Z", // 09:00 (+08:45)
      "2026-01-02T00:15:00.000Z",
    ]);
  });

  it("subtracts busy time expressed in another zone", () => {
    const slots = computeFreeSlots(
      // 10:00-11:00 Brussels time, written in UTC as the providers hand it over.
      [{ start: "2026-08-19T08:00:00.000Z", end: "2026-08-19T09:00:00.000Z" }],
      {
        durationMinutes: 60,
        dayStartHour: 9,
        dayEndHour: 13,
        maxSlots: 10,
        start: "2026-08-19T00:00:00.000Z",
        end: "2026-08-20T00:00:00.000Z",
        now: "2026-08-19T00:00:00.000Z",
        timeZone: "Europe/Brussels",
      },
    );
    expect(starts(slots)).toEqual([
      "2026-08-19T07:00:00.000Z", // 09:00; 09:30 would run into the busy hour
      "2026-08-19T09:00:00.000Z", // 11:00, straight after it
      "2026-08-19T09:30:00.000Z",
      "2026-08-19T10:00:00.000Z", // 12:00-13:00, the last that fits the window
    ]);
  });

  it("with no zone matches the server-local behaviour it replaced", () => {
    // Built with local Date parts, which is exactly what the old setHours
    // implementation produced, so this pins parity for existing callers.
    const local = (h: number, m = 0) => new Date(2026, 7, 19, h, m, 0, 0).toISOString();
    const opts = {
      durationMinutes: 60,
      maxSlots: 5,
      start: local(0),
      end: new Date(2026, 7, 19, 23, 59, 0, 0).toISOString(),
      now: local(0),
    };
    const busy = [{ start: local(11), end: local(12) }];
    expect(starts(computeFreeSlots(busy, opts))).toEqual([
      local(9),
      local(9, 30),
      local(10),
      local(12),
      local(12, 30),
    ]);
    // Naming the server's own zone explicitly must not change a thing.
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(computeFreeSlots(busy, { ...opts, timeZone: server })).toEqual(
      computeFreeSlots(busy, opts),
    );
  });

  it("rejects a zone that is not a zone", () => {
    const opts = { durationMinutes: 30, start: "2026-08-19T00:00:00.000Z" };
    // Inverted ("Brussels/Europe") and plain nonsense both fail the same way:
    // a silent fallback would schedule in the wrong hours indefinitely.
    expect(() => computeFreeSlots([], { ...opts, timeZone: "Brussels/Europe" })).toThrow(
      "unknown time zone: Brussels/Europe",
    );
    expect(() => computeFreeSlots([], { ...opts, timeZone: "Mars/Olympus" })).toThrow(
      /unknown time zone/,
    );
  });
});

describe("CalendarService.freeSlots", () => {
  let db: Database.Database;
  let store: CalendarStore;
  let caldav: FakeProvider;
  let service: CalendarService;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CalendarStore(db, randomBytes(32));
    store.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    caldav = new FakeProvider();
    // freeSlots never touches mail; a real MailService would only add setup.
    service = new CalendarService(store, {} as unknown as MailService, {
      caldav,
      google: new FakeProvider(),
    });
  });

  afterEach(() => db.close());

  it("echoes the zone it used", async () => {
    const { slots, errors, timeZone } = await service.freeSlots({
      start: "2026-03-28T00:00:00.000Z",
      end: "2026-03-30T00:00:00.000Z",
      now: "2026-03-28T00:00:00.000Z",
      durationMinutes: 60,
      dayStartHour: 9,
      dayEndHour: 10,
      timeZone: "Europe/Brussels",
    });
    expect(errors).toEqual([]);
    expect(timeZone).toBe("Europe/Brussels");
    expect(starts(slots)).toEqual(["2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z"]);
  });

  it("echoes the server's zone when the caller names none", async () => {
    const { timeZone } = await service.freeSlots({ durationMinutes: 30 });
    expect(timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("canonicalises the zone it echoes", async () => {
    const { timeZone } = await service.freeSlots({ durationMinutes: 30, timeZone: " utc " });
    expect(timeZone).toBe("UTC");
  });

  it("rejects an unknown zone before reading any calendar", async () => {
    let listed = false;
    caldav.listEvents = async () => {
      listed = true;
      return [];
    };
    await expect(
      service.freeSlots({ durationMinutes: 30, timeZone: "Europe/Brussel" }),
    ).rejects.toThrow("unknown time zone: Europe/Brussel");
    expect(listed).toBe(false);
  });
});

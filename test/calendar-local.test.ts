/**
 * The macOS local calendar provider and the route that connects it.
 *
 * Nothing here spawns the real helper: every test injects a HelperRun, which
 * is the module's only I/O seam. That is deliberate — the real binary raises a
 * system permission dialog, and a test that can hang on a human is not a test.
 * Routes are mounted on a bare Hono app, exactly as in
 * test/calendar-routes.test.ts.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HelperError,
  LocalCalendarProvider,
  parseHelperReply,
  type HelperRun,
  type LocalCalendarLike,
  type LocalCalendarStatus,
} from "../src/calendar/local.js";
import { registerCalendarRoutes } from "../src/calendar/routes.js";
import { CalendarService } from "../src/calendar/service.js";
import { CalendarStore } from "../src/calendar/store.js";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
} from "../src/calendar/types.js";
import { Store } from "../src/db/store.js";
import { MailService } from "../src/mail/service.js";
import type { Platform } from "../src/platform.js";
import { FixtureProvider } from "../src/provider/fixture.js";

/** Replies keyed by the helper's first argument, in call order per command. */
function scriptedRun(replies: Record<string, string[]>): {
  run: HelperRun;
  calls: Array<{ args: string[]; input?: string; timeoutMs: number }>;
} {
  const calls: Array<{ args: string[]; input?: string; timeoutMs: number }> = [];
  const run: HelperRun = async (args, opts) => {
    calls.push({ args, input: opts.input, timeoutMs: opts.timeoutMs });
    const queue = replies[args[0]];
    if (!queue || queue.length === 0) throw new Error(`no scripted reply for ${args[0]}`);
    return queue.length === 1 ? queue[0] : (queue.shift() as string);
  };
  return { run, calls };
}

function mac(replies: Record<string, string[]>, extra: { run?: HelperRun } = {}) {
  const scripted = scriptedRun(replies);
  return {
    provider: new LocalCalendarProvider({
      platform: "darwin",
      helperPath: "/nowhere/boxaide-calendar",
      run: extra.run ?? scripted.run,
    }),
    calls: scripted.calls,
  };
}

const GRANTED = { probe: ['{"access":"fullAccess","ok":true}\n'] };

describe("local calendar helper replies", () => {
  it("reads one JSON object off stdout", () => {
    expect(parseHelperReply(' {"ok":true,"access":"denied"} \n')).toEqual({
      ok: true,
      access: "denied",
    });
  });

  it("turns ok:false into a HelperError carrying the code", () => {
    let caught: unknown;
    try {
      parseHelperReply('{"ok":false,"code":"denied","error":"Calendar access was not granted"}');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HelperError);
    expect((caught as HelperError).code).toBe("denied");
    expect((caught as HelperError).message).toBe("Calendar access was not granted");
  });

  it("refuses unparseable output rather than reading it as an empty calendar", () => {
    expect(() => parseHelperReply("dyld: Library not loaded\n")).toThrow(/unreadable output/);
    expect(() => parseHelperReply("")).toThrow(/returned nothing/);
    expect(() => parseHelperReply("[1,2]")).toThrow(/unreadable output/);
  });

  it("maps events, dropping any instance with no bounds", async () => {
    const { provider } = mac({
      events: [
        JSON.stringify({
          ok: true,
          events: [
            {
              id: "ek-1",
              calendarId: "cal-1",
              title: "Design sync",
              start: "2026-08-19T14:00:00Z",
              end: "2026-08-19T15:00:00Z",
              allDay: false,
              location: "",
              status: "tentative",
              busy: true,
            },
            { id: "ek-2", title: "Broken", start: "", end: "" },
          ],
        }),
      ],
    });
    const range: EventRange = {
      start: "2026-08-19T00:00:00.000Z",
      end: "2026-08-20T00:00:00.000Z",
    };
    const events = await provider.listEvents(undefined, range);
    expect(events).toEqual([
      {
        id: "ek-1",
        calendarId: "cal-1",
        title: "Design sync",
        start: "2026-08-19T14:00:00Z",
        end: "2026-08-19T15:00:00Z",
        allDay: false,
        location: undefined,
        status: "tentative",
        busy: true,
      },
    ]);
  });

  it("labels a calendar with the account it came from", async () => {
    const { provider } = mac({
      calendars: [
        JSON.stringify({
          ok: true,
          calendars: [
            { id: "cal-1", name: "Calendar", source: "iCloud" },
            { id: "cal-2", name: "Work", source: "" },
          ],
        }),
      ],
    });
    expect(await provider.listCalendars()).toEqual([
      { id: "cal-1", name: "Calendar (iCloud)" },
      { id: "cal-2", name: "Work" },
    ]);
  });

  it("sends the new event as JSON on stdin, not as arguments", async () => {
    const { provider, calls } = mac({
      create: ['{"ok":true,"eventId":"ek-9","calendarId":"cal-1"}'],
    });
    const input: CreateEventInput = {
      uid: "uid-1@boxaide",
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      organizerEmail: "me@test.com",
      attendees: ["ada@acme.example"],
    };
    expect(await provider.createEvent(undefined, input)).toEqual({
      eventId: "ek-9",
      calendarId: "cal-1",
    });
    expect(calls[0].args).toEqual(["create", "--no-prompt"]);
    expect(JSON.parse(calls[0].input as string)).toEqual({
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
    });
  });

  it("reports an already-deleted event as false, not as an error", async () => {
    const { provider } = mac({ delete: ['{"ok":true,"deleted":false}'] });
    expect(await provider.deleteEvent(undefined, "cal-1", "ek-gone")).toBe(false);
  });
});

/**
 * The one test that does spawn something. Not the real helper — a shell script
 * standing in for it — because spawnHelper is otherwise the only code in this
 * module with no coverage, and the failure it hides is fatal to the process
 * rather than to the request.
 */
describe.skipIf(process.platform === "win32")("local calendar helper process", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boxaide-helper-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeHelper(body: string): string {
    const path = join(dir, "boxaide-calendar");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("survives a helper that exits before reading the payload on stdin", async () => {
    // Exactly what main.swift does on denied / bad_request / no_calendar: it
    // answers and exits, so the write below lands on a closed pipe. Larger
    // than the pipe buffer, or the kernel absorbs it and nothing is proven.
    const provider = new LocalCalendarProvider({
      platform: "darwin",
      helperPath: fakeHelper(
        `echo '{"ok":false,"code":"denied","error":"Calendar access was not granted"}'`,
      ),
    });
    await expect(
      provider.createEvent(undefined, {
        uid: "uid-1@boxaide",
        title: "Design sync",
        description: "x".repeat(512 * 1024),
        start: "2026-08-19T14:00:00.000Z",
        end: "2026-08-19T15:00:00.000Z",
        organizerEmail: "me@test.com",
        attendees: [],
      }),
    ).rejects.toThrow(/System Settings/);
  });

  it("reads one reply off a helper that does run", async () => {
    const provider = new LocalCalendarProvider({
      platform: "darwin",
      helperPath: fakeHelper(`echo '{"ok":true,"access":"fullAccess"}'`),
    });
    expect(await provider.status()).toEqual({ available: true, access: "fullAccess" });
  });
});

describe("local calendar availability", () => {
  it("is unavailable off macOS, and never runs anything", async () => {
    let ran = false;
    const provider = new LocalCalendarProvider({
      platform: "win32",
      helperPath: "C:/nowhere/boxaide-calendar",
      run: async () => {
        ran = true;
        return "";
      },
    });
    const status = await provider.status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/needs macOS/);
    expect(ran).toBe(false);
    // And the connect path says the same thing rather than a bare failure.
    expect(await provider.testConnection()).toEqual({ ok: false, error: status.reason });
  });

  it("is unavailable when the helper binary is not there", async () => {
    const provider = new LocalCalendarProvider({
      platform: "darwin",
      helperPath: "/nowhere/boxaide-calendar",
    });
    const status = await provider.status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/desktop app/);
  });

  it("never lets a read raise the permission dialog", async () => {
    const { provider, calls } = mac({
      calendars: ['{"ok":true,"calendars":[]}'],
      events: ['{"ok":true,"events":[]}'],
      delete: ['{"ok":true,"deleted":true}'],
    });
    await provider.listCalendars();
    await provider.listEvents(undefined, { start: "a", end: "b" });
    await provider.deleteEvent(undefined, "cal-1", "ek-1");
    // Last, so an older helper still reads `events <start> <end>` positionally.
    for (const call of calls) expect(call.args.at(-1)).toBe("--no-prompt");
    expect(calls[1].args).toEqual(["events", "a", "b", "--no-prompt"]);
  });

  it("names System Settings on a read, not only on the connect click", async () => {
    const { provider } = mac({
      events: ['{"ok":false,"code":"denied","error":"Calendar access was not granted"}'],
    });
    await expect(
      provider.listEvents(undefined, { start: "a", end: "b" }),
    ).rejects.toThrow(/System Settings › Privacy & Security › Calendars/);
  });

  it("reports the permission state without prompting", async () => {
    const { provider, calls } = mac({ probe: ['{"ok":true,"access":"notDetermined"}'] });
    expect(await provider.status()).toEqual({ available: true, access: "notDetermined" });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["probe"]);
  });

  it("carries the reason when macOS is already refusing", async () => {
    const { provider } = mac({ probe: ['{"ok":true,"access":"denied"}'] });
    const status = await provider.status();
    // Available: the helper ran and answered. Not offerable: only System
    // Settings can change this, so the UI must not draw a button.
    expect(status.available).toBe(true);
    expect(status.reason).toMatch(/System Settings › Privacy & Security › Calendars/);
  });

  it("treats a helper that will not run as unavailable, not as broken calendars", async () => {
    const provider = new LocalCalendarProvider({
      platform: "darwin",
      helperPath: "/nowhere/boxaide-calendar",
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    const status = await provider.status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/did not run: spawn ENOENT/);
  });
});

describe("local calendar permission refusal", () => {
  it("names System Settings when macOS already holds a denial", async () => {
    const { provider, calls } = mac({ probe: ['{"ok":true,"access":"denied"}'] });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/System Settings › Privacy & Security › Calendars/);
    // The refusal was already known — no second call, so no dialog.
    expect(calls).toHaveLength(1);
  });

  it("says the same thing when the user refuses the dialog just raised", async () => {
    const { provider, calls } = mac({
      probe: ['{"ok":true,"access":"notDetermined"}'],
      calendars: ['{"ok":false,"code":"denied","error":"Calendar access was not granted"}'],
    });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/System Settings › Privacy & Security › Calendars/);
    // The prompt call waits: a timeout here would report hesitation as refusal.
    expect(calls[1].timeoutMs).toBe(0);
  });

  it("rejects write-only access, which cannot show an agenda", async () => {
    const { provider } = mac({ probe: ['{"ok":true,"access":"writeOnly"}'] });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/write-only/);
  });

  it("passes through a failure that is not a refusal", async () => {
    const { provider } = mac({
      probe: ['{"ok":true,"access":"fullAccess"}'],
      calendars: ['{"ok":false,"code":"write_failed","error":"the store is busy"}'],
    });
    expect(await provider.testConnection()).toEqual({ ok: false, error: "the store is busy" });
  });
});

/* ---- routes ----------------------------------------------------------- */

type ProviderEvent = Omit<CalendarEvent, "accountId" | "accountAlias">;

/** Stands in for the two remote providers; the local tests drive the real one. */
class FakeProvider implements CalendarProvider {
  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async listCalendars(): Promise<CalendarInfo[]> {
    return [];
  }
  async listEvents(_config: CalendarConfig, _range: EventRange): Promise<ProviderEvent[]> {
    return [];
  }
  async createEvent(
    _config: CalendarConfig,
    _input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    return { eventId: "event-1", calendarId: "cal-1" };
  }
  async deleteEvent(): Promise<boolean> {
    return true;
  }
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

describe("local calendar routes", () => {
  let store: Store;
  let calendarStore: CalendarStore;
  let app: Hono;

  async function mount(local: LocalCalendarLike): Promise<void> {
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    const mail = new MailService(store, new FixtureProvider());
    await mail.connectAccount({ alias: "work", email: "me@test.com", creds: baseCreds });
    calendarStore = new CalendarStore(store.db, masterKey);
    const service = new CalendarService(calendarStore, mail, {
      caldav: new FakeProvider(),
      google: new FakeProvider(),
      local,
    });
    app = new Hono();
    registerCalendarRoutes(
      app,
      { calendarStore, calendarService: service } as unknown as Platform,
      { host: "127.0.0.1", port: 8765 },
    );
  }

  afterEach(() => store.db.close());

  function localProvider(replies: Record<string, string[]>): LocalCalendarLike {
    return mac(replies).provider;
  }

  it("answers whether the local path is available on this machine", async () => {
    await mount(localProvider(GRANTED));
    const res = await app.request("/api/calendar/accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { local: LocalCalendarStatus };
    expect(body.local).toEqual({ available: true, access: "fullAccess" });
  });

  it("reports unavailable off macOS and changes nothing else", async () => {
    await mount(
      new LocalCalendarProvider({ platform: "linux", helperPath: "/nowhere/boxaide-calendar" }),
    );
    const res = await app.request("/api/calendar/accounts");
    const body = (await res.json()) as {
      local: LocalCalendarStatus;
      accounts: unknown[];
      googleRedirectUri: string;
    };
    expect(body.local.available).toBe(false);
    expect(body.local.reason).toMatch(/needs macOS/);
    expect(body.accounts).toEqual([]);
    expect(body.googleRedirectUri).toBe("http://127.0.0.1:8765/api/calendar/google/callback");

    const connect = await app.request("/api/calendar/local", { method: "POST" });
    expect(connect.status).toBe(400);
    expect((await connect.json()).error).toMatch(/needs macOS/);
    expect(calendarStore.listAccounts()).toEqual([]);
  });

  it("adds an account with no credentials at all", async () => {
    await mount(localProvider({ ...GRANTED, calendars: ['{"ok":true,"calendars":[]}'] }));
    const res = await app.request("/api/calendar/local", { method: "POST" });
    expect(res.status).toBe(201);
    const { account } = (await res.json()) as {
      account: { id: string; alias: string; provider: string };
    };
    expect(account.provider).toBe("local");
    expect(account.alias).toBe("This Mac");
    expect(calendarStore.getConfig(account.id)).toEqual({ kind: "local" });
  });

  it("refuses a second local account, which would double every agenda", async () => {
    await mount(localProvider({ ...GRANTED, calendars: ['{"ok":true,"calendars":[]}'] }));
    expect((await app.request("/api/calendar/local", { method: "POST" })).status).toBe(201);
    const again = await app.request("/api/calendar/local", { method: "POST" });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already connected/);
    expect(calendarStore.listAccounts()).toHaveLength(1);
  });

  it("returns the specific permission sentence when the user denies it", async () => {
    await mount(
      localProvider({
        probe: ['{"ok":true,"access":"notDetermined"}'],
        calendars: ['{"ok":false,"code":"denied","error":"Calendar access was not granted"}'],
      }),
    );
    const res = await app.request("/api/calendar/local", { method: "POST" });
    expect(res.status).toBe(400);
    const error = (await res.json()).error as string;
    expect(error).toMatch(/System Settings › Privacy & Security › Calendars/);
    expect(error).not.toMatch(/connection failed/);
    expect(calendarStore.listAccounts()).toEqual([]);
  });
});

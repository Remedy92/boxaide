/**
 * The duplicate-calendar warning.
 *
 * Two things are worth testing and neither is plumbing: which accounts count as
 * "the Mac probably already has this", and that a connect path refuses once and
 * then goes through when it is asked again with the answer. The matcher itself
 * is deliberately approximate — a source titled "work" says nothing — so the
 * tests pin the cases it must get right and the case it must not overreach on.
 *
 * Nothing here spawns the helper: the local provider is a fake that returns the
 * sources a real Mac would report.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOverlap } from "../src/calendar/coverage.js";
import type { LocalCalendarLike, LocalCalendarStatus, LocalSource } from "../src/calendar/local.js";
import { registerCalendarRoutes } from "../src/calendar/routes.js";
import { CalendarService } from "../src/calendar/service.js";
import { CalendarStore } from "../src/calendar/store.js";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
} from "../src/calendar/types.js";
import { Store } from "../src/db/store.js";
import { MailService } from "../src/mail/service.js";
import type { Platform } from "../src/platform.js";
import type { AccountCredentials } from "../src/provider/types.js";
import { FixtureProvider } from "../src/provider/fixture.js";

type ProviderEvent = Omit<CalendarEvent, "accountId" | "accountAlias">;

class FakeProvider implements CalendarProvider {
  ok = true;

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return this.ok ? { ok: true } : { ok: false, error: "401 Unauthorized" };
  }
  async listCalendars(): Promise<CalendarInfo[]> {
    return [];
  }
  async listEvents(): Promise<ProviderEvent[]> {
    return [];
  }
  async createEvent(
    _config: CalendarConfig,
    _input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    return { eventId: "e", calendarId: "c" };
  }
  async deleteEvent(): Promise<boolean> {
    return true;
  }
}

/** A Mac holding whatever sources the test says it holds. */
class FakeLocal extends FakeProvider implements LocalCalendarLike {
  sources: LocalSource[] = [];

  async status(): Promise<LocalCalendarStatus> {
    return { available: true, access: "fullAccess" };
  }
  async listSources(): Promise<LocalSource[]> {
    return this.sources;
  }
}

function creds(imapHost: string, user: string, pass: string): AccountCredentials {
  return {
    imapHost,
    imapPort: 993,
    imapSecure: true,
    smtpHost: imapHost.replace("imap", "smtp"),
    smtpPort: 465,
    smtpSecure: true,
    auth: { kind: "password", user, pass },
  };
}

describe("findOverlap", () => {
  it("matches a source named for the exact address, and says it is exact", () => {
    const found = findOverlap(
      [{ title: "me@fastmail.com", type: "caldav" }],
      { email: "me@fastmail.com" },
    );
    expect(found).toEqual({ source: "me@fastmail.com", exact: true });
  });

  it("matches the same provider by family, and admits it is only a guess", () => {
    const found = findOverlap([{ title: "Personal", type: "icloud" }], {
      email: "someone@icloud.com",
    });
    expect(found).toEqual({ source: "Personal", exact: false });
  });

  it("reads the family off a CalDAV server when the address gives nothing away", () => {
    const found = findOverlap([{ title: "iCloud", type: "caldav" }], {
      email: "me@example.com",
      serverUrl: "https://caldav.icloud.com",
    });
    expect(found?.exact).toBe(false);
  });

  it("matches a Google account against a source macOS labelled Gmail", () => {
    const found = findOverlap([{ title: "Gmail", type: "caldav" }], {
      provider: "google",
    });
    expect(found?.source).toBe("Gmail");
  });

  it("does not match a different provider", () => {
    expect(
      findOverlap([{ title: "iCloud", type: "icloud" }], {
        email: "me@fastmail.com",
        serverUrl: "https://caldav.fastmail.com/dav/",
      }),
    ).toBeNull();
  });

  it("does not treat a subscribed feed as the account itself", () => {
    expect(
      findOverlap([{ title: "Google Holidays", type: "subscribed" }], {
        provider: "google",
      }),
    ).toBeNull();
  });

  it("knows nothing when the Mac reported nothing", () => {
    expect(findOverlap([], { email: "me@icloud.com" })).toBeNull();
  });
});

describe("duplicate prevention across the connect paths", () => {
  let store: Store;
  let calendarStore: CalendarStore;
  let mail: MailService;
  let local: FakeLocal;
  let service: CalendarService;
  let app: Hono;

  beforeEach(() => {
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    mail = new MailService(store, new FixtureProvider());
    calendarStore = new CalendarStore(store.db, masterKey);
    local = new FakeLocal();
    service = new CalendarService(calendarStore, mail, {
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
  });

  afterEach(() => store.db.close());

  async function connectMailbox(alias: string, email: string, host: string) {
    await mail.connectAccount({ alias, email, creds: creds(host, email, "app-pass") });
  }

  /** The Mac connected, holding one iCloud account. */
  function macHoldsICloud() {
    local.sources = [{ title: "iCloud", type: "icloud" }];
    return calendarStore.addAccount({
      alias: "This Mac",
      email: "",
      config: { kind: "local" },
    });
  }

  it("marks a mailbox the Mac probably already holds", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    macHoldsICloud();
    const [mailbox] = await service.reusableMailboxes();
    expect(mailbox.onThisMac).toBe("iCloud");
  });

  it("leaves a mailbox unmarked when the Mac is not connected", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    local.sources = [{ title: "iCloud", type: "icloud" }];
    const [mailbox] = await service.reusableMailboxes();
    expect(mailbox.onThisMac).toBeUndefined();
  });

  it("answers 409 rather than connecting a mailbox that would duplicate", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    macHoldsICloud();
    const id = service.listReusableMailboxes()[0].mailAccountId;
    const res = await app.request(`/api/calendar/mailboxes/${id}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; needsConfirm: boolean };
    expect(body.needsConfirm).toBe(true);
    expect(body.error).toContain("twice");
    // Refused means refused: nothing was stored on the way to asking.
    expect(calendarStore.listAccounts().map((a) => a.alias)).toEqual(["This Mac"]);
  });

  it("connects the same mailbox once the confirmation is sent", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    macHoldsICloud();
    const id = service.listReusableMailboxes()[0].mailAccountId;
    const res = await app.request(`/api/calendar/mailboxes/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmOverlap: true }),
    });
    expect(res.status).toBe(201);
    expect(calendarStore.listAccounts()).toHaveLength(2);
  });

  it("answers 409 when the Mac would duplicate a calendar already connected", async () => {
    calendarStore.addAccount({
      alias: "personal",
      email: "me@icloud.com",
      config: {
        kind: "caldav",
        serverUrl: "https://caldav.icloud.com",
        username: "me@icloud.com",
        password: "app-pass",
      },
    });
    local.sources = [{ title: "iCloud", type: "icloud" }];
    const res = await app.request("/api/calendar/local", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; needsConfirm: boolean };
    expect(body.needsConfirm).toBe(true);
    expect(body.error).toContain("personal");
    expect(calendarStore.listAccounts()).toHaveLength(1);
  });

  it("connects the Mac once the confirmation is sent", async () => {
    calendarStore.addAccount({
      alias: "personal",
      email: "me@icloud.com",
      config: {
        kind: "caldav",
        serverUrl: "https://caldav.icloud.com",
        username: "me@icloud.com",
        password: "app-pass",
      },
    });
    local.sources = [{ title: "iCloud", type: "icloud" }];
    const res = await app.request("/api/calendar/local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmOverlap: true }),
    });
    expect(res.status).toBe(201);
    expect(calendarStore.listAccounts()).toHaveLength(2);
  });

  it("connects the Mac without a question when nothing overlaps", async () => {
    local.sources = [{ title: "Work", type: "exchange" }];
    const res = await app.request("/api/calendar/local", { method: "POST" });
    expect(res.status).toBe(201);
  });
});

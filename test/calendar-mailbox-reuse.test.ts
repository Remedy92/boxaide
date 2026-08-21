/**
 * Reusing a connected mailbox as a CalDAV calendar.
 *
 * The interesting parts are all decisions, not plumbing: which mailboxes are
 * offered, that the stored mail password is what actually gets used, and that
 * a rejected password produces the sentence that tells the user to make an app
 * password rather than a bare "connection failed".
 *
 * Nothing here touches the network — calendars are a fake CalendarProvider and
 * mail is FixtureProvider, as in test/calendar-routes.test.ts.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** Records what it was asked to connect with, and can be told to refuse. */
class FakeProvider implements CalendarProvider {
  ok = true;
  seen: CalendarConfig | null = null;

  async testConnection(config: CalendarConfig): Promise<{ ok: boolean; error?: string }> {
    this.seen = config;
    return this.ok ? { ok: true } : { ok: false, error: "401 Unauthorized" };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "cal-1", name: "Work" }];
  }

  async listEvents(): Promise<ProviderEvent[]> {
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

describe("mailbox reuse", () => {
  let store: Store;
  let calendarStore: CalendarStore;
  let mail: MailService;
  let caldav: FakeProvider;
  let service: CalendarService;
  let app: Hono;

  beforeEach(async () => {
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    mail = new MailService(store, new FixtureProvider());
    calendarStore = new CalendarStore(store.db, masterKey);
    caldav = new FakeProvider();
    service = new CalendarService(calendarStore, mail, {
      caldav,
      google: new FakeProvider(),
    });
    app = new Hono();
    registerCalendarRoutes(
      app,
      { calendarStore, calendarService: service } as unknown as Platform,
      { host: "127.0.0.1", port: 8765 },
    );
  });

  afterEach(() => store.db.close());

  async function connectMailbox(alias: string, email: string, host: string, pass = "app-pass") {
    await mail.connectAccount({ alias, email, creds: creds(host, email, pass) });
  }

  it("offers an iCloud mailbox with the server it would use and a free name", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    const res = await app.request("/api/calendar/mailboxes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: Array<{ email: string; provider: string; serverUrl: string; suggestedAlias: string }>;
    };
    expect(body.mailboxes).toHaveLength(1);
    expect(body.mailboxes[0]).toMatchObject({
      email: "me@icloud.com",
      provider: "iCloud",
      serverUrl: "https://caldav.icloud.com",
      suggestedAlias: "home",
    });
  });

  it("offers Fastmail and never offers Gmail", async () => {
    await connectMailbox("fm", "me@fastmail.com", "imap.fastmail.com");
    await connectMailbox("gm", "me@gmail.com", "imap.gmail.com");
    const mailboxes = service.listReusableMailboxes();
    expect(mailboxes.map((m) => m.provider)).toEqual(["Fastmail"]);
  });

  it("stops offering a mailbox once it is connected as a calendar", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    const id = service.listReusableMailboxes()[0].mailAccountId;
    await service.connectFromMailbox({ mailAccountId: id });
    expect(service.listReusableMailboxes()).toEqual([]);
  });

  it("suggests a name that is not already taken by a calendar", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    calendarStore.addAccount({
      alias: "home",
      email: "other@example.com",
      config: {
        kind: "caldav",
        serverUrl: "https://dav.example",
        username: "other@example.com",
        password: "x",
      },
    });
    expect(service.listReusableMailboxes()[0].suggestedAlias).toBe("home-2");
  });

  it("connects with the mailbox's own stored password", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com", "secret-app-pass");
    const id = service.listReusableMailboxes()[0].mailAccountId;
    const res = await app.request(`/api/calendar/mailboxes/${id}`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { account: { id: string; alias: string; email: string } };
    expect(body.account.email).toBe("me@icloud.com");
    // The password is never sent by the caller, so it can only have come from
    // the mail account's own encrypted row.
    expect(calendarStore.getConfig(body.account.id)).toEqual({
      kind: "caldav",
      serverUrl: "https://caldav.icloud.com",
      username: "me@icloud.com",
      password: "secret-app-pass",
    });
  });

  it("tests before it stores, and says to make an app password when the test fails", async () => {
    await connectMailbox("home", "me@icloud.com", "imap.mail.me.com");
    caldav.ok = false;
    const id = service.listReusableMailboxes()[0].mailAccountId;
    const res = await app.request(`/api/calendar/mailboxes/${id}`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("opens the mailbox but not the calendar");
    expect(body.error).toContain("app password");
    // The named next step, and the reason underneath it.
    expect(body.error).toContain("Calendar → Add calendar");
    expect(body.error).toContain("401 Unauthorized");
    expect(calendarStore.listAccounts()).toEqual([]);
  });

  it("400s on an unknown mailbox", async () => {
    const res = await app.request("/api/calendar/mailboxes/nope", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "account not found: nope",
    });
  });

  it("refuses a mailbox whose provider has no known calendar server", async () => {
    await connectMailbox("work", "me@corp.example", "imap.corp.example");
    const id = mail.listAccounts()[0].id;
    await expect(service.connectFromMailbox({ mailAccountId: id })).rejects.toThrow(
      /does not know which calendar server belongs to imap\.corp\.example/,
    );
  });
});

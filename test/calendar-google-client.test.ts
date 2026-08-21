/**
 * The two Google Calendar connect modes.
 *
 * With BOXAIDE_GOOGLE_CLIENT_ID / _SECRET configured the user supplies nothing
 * — not even a name — and the authorization URL still has to carry the app's
 * own client id. Without them the original path stands: no client, no start.
 *
 * The assertions read the authorization URL because that is the only place the
 * resolved client id is observable; the pending state it is minted against is
 * deliberately private to the routes module.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { registerCalendarRoutes, type CalendarRouteConfig } from "../src/calendar/routes.js";
import { CalendarService } from "../src/calendar/service.js";
import { CalendarStore } from "../src/calendar/store.js";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
} from "../src/calendar/types.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";
import { MailService } from "../src/mail/service.js";
import type { Platform } from "../src/platform.js";
import { FixtureProvider } from "../src/provider/fixture.js";

class FakeProvider implements CalendarProvider {
  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "cal-1", name: "Work" }];
  }

  async listEvents(): Promise<Array<Omit<CalendarEvent, "accountId" | "accountAlias">>> {
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

describe("google calendar client", () => {
  const opened: Store[] = [];

  afterEach(() => {
    while (opened.length > 0) opened.pop()?.db.close();
  });

  function mount(extra: Partial<CalendarRouteConfig>): Hono {
    const masterKey = randomBytes(32);
    const store = new Store(masterKey, ":memory:");
    opened.push(store);
    const mail = new MailService(store, new FixtureProvider());
    const calendarStore = new CalendarStore(store.db, masterKey);
    const service = new CalendarService(calendarStore, mail, {
      caldav: new FakeProvider(),
      google: new FakeProvider(),
    });
    const app = new Hono();
    registerCalendarRoutes(
      app,
      { calendarStore, calendarService: service } as unknown as Platform,
      { host: "127.0.0.1", port: 8765, ...extra },
    );
    return app;
  }

  const BUILT_IN = { googleClientId: "built-in.apps.googleusercontent.com", googleClientSecret: "shh" };

  async function start(app: Hono, body: unknown): Promise<Response> {
    return app.request("/api/calendar/google/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("starts the flow with no client and no name when one is configured", async () => {
    const res = await start(mount(BUILT_IN), {});
    expect(res.status).toBe(200);
    const { authUrl } = (await res.json()) as { authUrl: string };
    expect(new URL(authUrl).searchParams.get("client_id")).toBe(BUILT_IN.googleClientId);
  });

  it("still prefers a client the caller sent", async () => {
    const res = await start(mount(BUILT_IN), {
      alias: "work",
      clientId: "mine.apps.googleusercontent.com",
      clientSecret: "own",
    });
    const { authUrl } = (await res.json()) as { authUrl: string };
    expect(new URL(authUrl).searchParams.get("client_id")).toBe("mine.apps.googleusercontent.com");
  });

  it("takes the pair whole, never half a typed client and half the built-in one", async () => {
    // Google answers a mismatched pair with a bare invalid_client that names
    // neither half, so the mixture must never be assembled here.
    const res = await start(mount(BUILT_IN), {
      clientId: "mine.apps.googleusercontent.com",
    });
    expect(res.status).toBe(200);
    const { authUrl } = (await res.json()) as { authUrl: string };
    expect(new URL(authUrl).searchParams.get("client_id")).toBe(BUILT_IN.googleClientId);

    // And with only a secret, the built-in id is not paired with it either.
    const secretOnly = await start(mount(BUILT_IN), { clientSecret: "own" });
    const url = new URL(((await secretOnly.json()) as { authUrl: string }).authUrl);
    expect(url.searchParams.get("client_id")).toBe(BUILT_IN.googleClientId);

    // With nothing configured, half a pair is simply not a client.
    const half = await start(mount({}), { clientId: "mine.apps.googleusercontent.com" });
    expect(half.status).toBe(400);
  });

  it("keeps the manual path when no client is configured", async () => {
    const app = mount({});
    const missing = await start(app, { alias: "work" });
    expect(missing.status).toBe(400);
    expect((await missing.json()) as { error: string }).toMatchObject({
      error: "clientId and clientSecret are required",
    });

    const manual = await start(app, {
      alias: "work",
      clientId: "mine.apps.googleusercontent.com",
      clientSecret: "own",
    });
    expect(manual.status).toBe(200);
  });

  it("tells the UI which mode is active", async () => {
    const on = (await (await mount(BUILT_IN).request("/api/calendar/accounts")).json()) as {
      googleBuiltIn: boolean;
    };
    expect(on.googleBuiltIn).toBe(true);
    const off = (await (await mount({}).request("/api/calendar/accounts")).json()) as {
      googleBuiltIn: boolean;
    };
    expect(off.googleBuiltIn).toBe(false);
  });

  it("reads the pair from the environment, Boxaide name first", () => {
    process.env.MAILMUX_GOOGLE_CLIENT_ID = "old.apps.googleusercontent.com";
    process.env.BOXAIDE_GOOGLE_CLIENT_ID = "new.apps.googleusercontent.com";
    process.env.BOXAIDE_GOOGLE_CLIENT_SECRET = "env-secret";
    try {
      const config = loadConfig({ dataDir: ":memory:" });
      expect(config.googleClientId).toBe("new.apps.googleusercontent.com");
      expect(config.googleClientSecret).toBe("env-secret");
    } finally {
      delete process.env.MAILMUX_GOOGLE_CLIENT_ID;
      delete process.env.BOXAIDE_GOOGLE_CLIENT_ID;
      delete process.env.BOXAIDE_GOOGLE_CLIENT_SECRET;
    }
  });

  it("ships no credentials of its own", () => {
    // Explicit rather than assumed: the point of the assertion is that nothing
    // is baked into the source, so the environment must be out of the picture.
    delete process.env.BOXAIDE_GOOGLE_CLIENT_ID;
    delete process.env.SLEY_GOOGLE_CLIENT_ID;
    delete process.env.MAILMUX_GOOGLE_CLIENT_ID;
    delete process.env.BOXAIDE_GOOGLE_CLIENT_SECRET;
    delete process.env.SLEY_GOOGLE_CLIENT_SECRET;
    delete process.env.MAILMUX_GOOGLE_CLIENT_SECRET;
    const config = loadConfig({ dataDir: ":memory:" });
    expect(config.googleClientId).toBeUndefined();
    expect(config.googleClientSecret).toBeUndefined();
  });
});

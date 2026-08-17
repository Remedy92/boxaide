/**
 * Calendar REST routes, mounted inside createApi after auth.
 *
 * One thing here does NOT live inside createApi: the Google OAuth callback.
 * The browser arrives at it by a top-level redirect from accounts.google.com
 * with no Authorization header, so it is registered on the outer app in
 * src/app.ts — exactly where /api/local-bootstrap sits, and for the same
 * reason. Its authentication is the single-use random `state` minted below,
 * which is why the pending map lives in this module and is reachable only
 * through consumeGoogleOAuthState.
 */
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { isLoopbackBindAddress } from "../api/routes.js";
import type { Platform } from "../platform.js";
import { googleAuthUrl } from "./google.js";
import { parseAgendaRange } from "./range.js";
import type { CalDavConfig } from "./types.js";

export type CalendarRouteConfig = { host: string; port: number };

const STATE_TTL_MS = 10 * 60 * 1000;

type PendingGoogle = {
  alias: string;
  clientId: string;
  clientSecret: string;
  expiresAt: number;
};

/**
 * In memory on purpose: an authorization that did not complete before the app
 * restarted is one the user should start again, not one to resurrect from disk
 * with the client secret in it.
 */
const pendingGoogle = new Map<string, PendingGoogle>();

function sweep(now: number): void {
  for (const [state, entry] of pendingGoogle) {
    if (entry.expiresAt <= now) pendingGoogle.delete(state);
  }
}

function startGoogleOAuth(input: {
  alias: string;
  clientId: string;
  clientSecret: string;
}): string {
  const now = Date.now();
  sweep(now);
  const state = randomBytes(24).toString("hex");
  pendingGoogle.set(state, { ...input, expiresAt: now + STATE_TTL_MS });
  return state;
}

/**
 * Look without spending. The callback checks the state before it knows whether
 * Google sent a code, and a user who pressed Cancel on the consent screen must
 * be able to click the same authorization link again instead of retyping the
 * client id and secret.
 */
export function peekGoogleOAuthState(state: string): PendingGoogle | null {
  const now = Date.now();
  sweep(now);
  const entry = pendingGoogle.get(state);
  return entry && entry.expiresAt > now ? entry : null;
}

/**
 * Single use: the entry is removed whether or not the exchange that follows
 * succeeds, so a leaked callback URL cannot be replayed. Call it only once a
 * code is in hand — spending the state on a cancelled authorization is what
 * peekGoogleOAuthState exists to avoid.
 */
export function consumeGoogleOAuthState(state: string): PendingGoogle | null {
  const entry = peekGoogleOAuthState(state);
  pendingGoogle.delete(state);
  return entry;
}

/**
 * Where Google sends the browser back. Loopback only: a 0.0.0.0 bind still
 * wants the user's browser on the loopback interface, matching launcherHost
 * in src/app.ts.
 */
export function googleRedirectUri(config: CalendarRouteConfig): string {
  const host = isLoopbackBindAddress(config.host) ? config.host : "127.0.0.1";
  return `http://${host}:${config.port}/api/calendar/google/callback`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson<T>(c: {
  req: { json: () => Promise<unknown> };
}): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * One integer query param, bounded.
 *
 * Three outcomes, not two: `undefined` means absent (take the default),
 * `null` means present and unusable (400). Returning 0 for a missing param
 * would silently become a real value downstream.
 */
function intParam(
  raw: string | undefined,
  min: number,
  max: number,
): number | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** Both the connect and the test route take the same CalDAV fields. */
function caldavConfig(body: {
  serverUrl?: string;
  username?: string;
  password?: string;
}): CalDavConfig | null {
  const serverUrl = (body.serverUrl ?? "").trim();
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!serverUrl || !username || !password) return null;
  return { kind: "caldav", serverUrl, username, password };
}

export function registerCalendarRoutes(
  app: Hono,
  platform: Platform,
  config: CalendarRouteConfig,
): void {
  const store = platform.calendarStore;
  const service = platform.calendarService;

  // googleRedirectUri rides along so the UI can show the user the exact string
  // to paste into their Google Cloud OAuth client. Google rejects the exchange
  // on a byte-level mismatch, and it is derived here rather than guessed by
  // the client, which cannot know the bind host.
  app.get("/api/calendar/accounts", (c) =>
    c.json({
      accounts: store.listAccounts(),
      googleRedirectUri: googleRedirectUri(config),
    }),
  );

  app.post("/api/calendar/accounts", async (c) => {
    const body = await readJson<{
      alias?: string;
      serverUrl?: string;
      username?: string;
      password?: string;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const cfg = caldavConfig(body);
    if (!cfg) {
      return c.json({ error: "serverUrl, username and password are required" }, 400);
    }
    const alias = (body.alias ?? "").trim();
    if (!alias) return c.json({ error: "alias is required" }, 400);
    // Tested before it is stored: an account that cannot connect is worse than
    // no account, because the agenda then reports an error for every read.
    const result = await service.testAccount(cfg);
    if (!result.ok) return c.json({ error: result.error ?? "connection failed" }, 400);
    try {
      const account = store.addAccount({ alias, email: cfg.username, config: cfg });
      return c.json({ account }, 201);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.post("/api/calendar/accounts/test", async (c) => {
    const body = await readJson<{
      serverUrl?: string;
      username?: string;
      password?: string;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const cfg = caldavConfig(body);
    if (!cfg) {
      return c.json({ ok: false, error: "serverUrl, username and password are required" });
    }
    return c.json(await service.testAccount(cfg));
  });

  app.delete("/api/calendar/accounts/:id", (c) => {
    return store.deleteAccount(c.req.param("id"))
      ? c.json({ deleted: true })
      : c.json({ error: "unknown calendar account" }, 404);
  });

  app.post("/api/calendar/google/start", async (c) => {
    const body = await readJson<{
      alias?: string;
      clientId?: string;
      clientSecret?: string;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const alias = (body.alias ?? "").trim();
    const clientId = (body.clientId ?? "").trim();
    const clientSecret = (body.clientSecret ?? "").trim();
    if (!alias || !clientId || !clientSecret) {
      return c.json({ error: "alias, clientId and clientSecret are required" }, 400);
    }
    const state = startGoogleOAuth({ alias, clientId, clientSecret });
    return c.json({
      authUrl: googleAuthUrl({
        clientId,
        redirectUri: googleRedirectUri(config),
        state,
      }),
    });
  });

  app.get("/api/calendar/meetings", (c) => c.json({ meetings: store.listMeetings() }));

  app.post("/api/calendar/meetings", async (c) => {
    const body = await readJson<{
      title?: string;
      start?: string;
      end?: string;
      attendees?: unknown;
      description?: string;
      location?: string;
      calendarAccountId?: string;
      mailAccountId?: string;
      includeMeetingLink?: boolean;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    if (!Array.isArray(body.attendees)) {
      return c.json({ error: "attendees must be an array of email addresses" }, 400);
    }
    try {
      const result = await service.createMeeting({
        title: body.title ?? "",
        start: body.start ?? "",
        end: body.end ?? "",
        attendees: body.attendees.map((a) => String(a)),
        description: body.description,
        location: body.location,
        calendarAccountId: body.calendarAccountId,
        mailAccountId: body.mailAccountId,
        includeMeetingLink: body.includeMeetingLink,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.post("/api/calendar/meetings/:id/cancel", async (c) => {
    try {
      return c.json(await service.cancelMeeting(c.req.param("id")));
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.get("/api/calendar/agenda", async (c) => {
    const range = parseAgendaRange({ start: c.req.query("start"), end: c.req.query("end") });
    if ("error" in range) return c.json({ error: range.error }, 400);
    return c.json(await service.agenda(range));
  });

  // Suggestions, not bookings: nothing here writes. With no calendar account
  // connected there is nothing to subtract, so the answer is the bare working
  // -hours grid — a useful default for the UI rather than an empty list.
  app.get("/api/calendar/free-slots", async (c) => {
    const range = parseAgendaRange({ start: c.req.query("start"), end: c.req.query("end") });
    if ("error" in range) return c.json({ error: range.error }, 400);

    const durationMinutes = intParam(c.req.query("durationMinutes"), 5, 480);
    if (durationMinutes === undefined) {
      return c.json({ error: "durationMinutes is required" }, 400);
    }
    if (durationMinutes === null) {
      return c.json({ error: "durationMinutes must be an integer between 5 and 480" }, 400);
    }
    const dayStartHour = intParam(c.req.query("dayStartHour"), 0, 23);
    if (dayStartHour === null) {
      return c.json({ error: "dayStartHour must be an integer between 0 and 23" }, 400);
    }
    // 24 is a legal end: it means midnight, the close of the day.
    const dayEndHour = intParam(c.req.query("dayEndHour"), 1, 24);
    if (dayEndHour === null) {
      return c.json({ error: "dayEndHour must be an integer between 1 and 24" }, 400);
    }
    // Checked here rather than left to the search, which answers an inverted
    // working day with an empty list and no reason for it.
    if ((dayEndHour ?? 17) <= (dayStartHour ?? 9)) {
      return c.json({ error: "dayEndHour must be after dayStartHour" }, 400);
    }
    const maxSlots = intParam(c.req.query("maxSlots"), 1, 100);
    if (maxSlots === null) {
      return c.json({ error: "maxSlots must be an integer between 1 and 100" }, 400);
    }

    return c.json(
      await service.freeSlots({
        start: range.start,
        end: range.end,
        durationMinutes,
        dayStartHour,
        dayEndHour,
        maxSlots,
      }),
    );
  });
}

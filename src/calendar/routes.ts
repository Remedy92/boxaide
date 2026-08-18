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
import { OverlapError } from "./coverage.js";
import { googleAuthUrl } from "./google.js";
import { parseAgendaRange } from "./range.js";
import { resolveTimeZone } from "./timezone.js";
import type { CalDavConfig, LocalConfig } from "./types.js";

export type CalendarRouteConfig = {
  host: string;
  port: number;
  /**
   * The app's own Google OAuth client, when this build ships one
   * (BOXAIDE_GOOGLE_CLIENT_ID / _SECRET). Present means a user connects Google
   * Calendar by pressing one button; absent means today's path, where they
   * create a client in Google Cloud and paste the pair in. Both are supported
   * on purpose: a self-hoster who wants their own client keeps it.
   */
  googleClientId?: string;
  googleClientSecret?: string;
};

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a background RSVP refresh counts as fresh. Same shape as the mail
 * index's staleness rule: listing meetings twice in a row must not mean two
 * mailbox scans.
 */
const RSVP_FRESH_MS = 60 * 1000;

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

/**
 * One optional IANA zone, validated here so a typo costs a 400 rather than a
 * provider fan-out. Same three outcomes as intParam: `undefined` is absent
 * (the service falls back to the server's own zone), `null` is present and
 * unusable.
 */
function zoneParam(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return resolveTimeZone(raw);
  } catch {
    return null;
  }
}

const ZONE_ERROR = "timeZone must be an IANA time zone id, e.g. Europe/Brussels";

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
  //
  // `local` rides along for the same reason: whether the macOS path can be
  // offered is a property of THIS machine, not of anything stored, and the
  // page that lists accounts is the page that offers connecting one. The probe
  // behind it never raises the system permission dialog.
  //
  // `googleBuiltIn` says which of the two Google paths this server can offer,
  // so the UI shows either one button or the five-step client form — it cannot
  // work that out from anything else it can see.
  app.get("/api/calendar/accounts", async (c) =>
    c.json({
      accounts: store.listAccounts(),
      googleRedirectUri: googleRedirectUri(config),
      googleBuiltIn: Boolean(config.googleClientId && config.googleClientSecret),
      local: await service.localStatus(),
    }),
  );

  /**
   * Mailboxes that could become a calendar with nothing further to type. Cheap
   * and read-only: it decrypts stored credentials to read their IMAP host, and
   * makes no network call. Secrets never leave the server — the response
   * carries the address, the server URL and a free name, nothing else.
   */
  app.get("/api/calendar/mailboxes", async (c) =>
    c.json({ mailboxes: await service.reusableMailboxes() }),
  );

  /**
   * Connect one of them. The mailbox is named in the path; the only body field
   * is an optional name, because there is nothing else left to supply.
   */
  app.post("/api/calendar/mailboxes/:id", async (c) => {
    const body =
      (await readJson<{ alias?: string; confirmOverlap?: boolean }>(c)) ?? {};
    try {
      const account = await service.connectFromMailbox({
        mailAccountId: c.req.param("id"),
        alias: body.alias,
        confirmOverlap: body.confirmOverlap === true,
      });
      return c.json({ account }, 201);
    } catch (err) {
      // 409, and `needsConfirm`, because the same request with confirmOverlap
      // set is expected to succeed — the client has one thing to ask and then
      // one thing to resend, and nothing else about the request was wrong.
      if (err instanceof OverlapError) {
        return c.json({ error: errMessage(err), needsConfirm: true }, 409);
      }
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  /**
   * Connect the calendars macOS already holds. No body is required and no
   * credentials exist to send — the whole handshake is a system permission.
   *
   * testAccount is what raises that permission dialog on a first connect, and
   * it blocks while the dialog is up. A refusal comes back as the sentence the
   * provider wrote for it, never as a bare "connection failed".
   */
  app.post("/api/calendar/local", async (c) => {
    const body =
      (await readJson<{ alias?: string; confirmOverlap?: boolean }>(c)) ?? {};
    // One grant, one bag of calendars, one account. A second would return the
    // same events twice into every agenda.
    if (store.listAccounts().some((a) => a.provider === "local")) {
      return c.json(
        { error: "The calendars on this Mac are already connected." },
        400,
      );
    }
    // The other direction of the duplicate warning: the Mac is being connected
    // while accounts it may already hold are connected too. Asked BEFORE
    // testAccount, so the question is not buried under the system permission
    // dialog — and skipped once the person has answered it.
    if (body.confirmOverlap !== true) {
      const overlaps = await service.macConnectOverlaps();
      if (overlaps.length) {
        const names = overlaps.map((entry) => entry.alias).join(", ");
        return c.json(
          {
            error:
              `This Mac probably already holds ${names}. Connecting it as well would ` +
              "show those events twice in your agenda. Either remove " +
              `${overlaps.length > 1 ? "those calendars" : "that calendar"} first, or ` +
              "add this Mac anyway if they are different accounts.",
            needsConfirm: true,
          },
          409,
        );
      }
    }
    const cfg: LocalConfig = { kind: "local" };
    const result = await service.testAccount(cfg);
    if (!result.ok) return c.json({ error: result.error ?? "connection failed" }, 400);
    const alias = (body.alias ?? "").trim() || "This Mac";
    try {
      // No email: this account is every account macOS holds, so naming one of
      // them would be a lie. Invites are still sent from a mail account.
      const account = store.addAccount({ alias, email: "", config: cfg });
      return c.json({ account }, 201);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

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
    // Optional: with a built-in client there is no form to put a name field
    // on, and the callback falls back to the Google address it just learned.
    const alias = (body.alias ?? "").trim();
    // The built-in client is the fallback, not the override: a self-hoster who
    // sends their own pair still gets theirs. Whichever wins is stored with
    // the pending state, so the callback and the stored account never learn
    // which of the two it was.
    //
    // The pair is atomic. Falling back field by field would marry one half of
    // a typed client to the other half of the built-in one, and Google answers
    // that with a bare invalid_client that names neither.
    const typedId = (body.clientId ?? "").trim();
    const typedSecret = (body.clientSecret ?? "").trim();
    const both = typedId && typedSecret;
    const clientId = both ? typedId : (config.googleClientId ?? "");
    const clientSecret = both ? typedSecret : (config.googleClientSecret ?? "");
    if (!clientId || !clientSecret) {
      return c.json({ error: "clientId and clientSecret are required" }, 400);
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

  /**
   * Background RSVP refresh state, private to this closure.
   *
   * The list must answer from SQLite immediately — a scan reads mailboxes and
   * calendars, and the guest list is already stored. So the refresh is fired
   * and forgotten, exactly like MailService.ensureFresh's refreshLater: the
   * rejection is swallowed into `lastRsvpError` instead of becoming an
   * unhandled promise, and the next list call reports it. `inFlight` keeps a
   * burst of list calls to one scan; `refreshedAt` keeps a quiet UI from
   * scanning on every poll.
   */
  let rsvpInFlight = false;
  let rsvpRefreshedAt = 0;
  let lastRsvpError: string | null = null;

  function refreshRsvpsLater(): void {
    const now = Date.now();
    if (rsvpInFlight || now - rsvpRefreshedAt < RSVP_FRESH_MS) return;
    rsvpInFlight = true;
    rsvpRefreshedAt = now;
    void service
      .refreshRsvps()
      .then((result) => {
        // Per-account failures come back in `errors`, not as a rejection, so
        // they are surfaced the same way a thrown one is.
        lastRsvpError = result.errors.length > 0 ? result.errors.join("; ") : null;
      })
      .catch((err) => {
        lastRsvpError = errMessage(err);
      })
      .finally(() => {
        rsvpInFlight = false;
      });
  }

  // Each meeting carries its full guest list with a status per attendee, from
  // the store. `refreshError` is the last background scan's failure, or null.
  app.get("/api/calendar/meetings", (c) => {
    const meetings = store.listMeetings();
    refreshRsvpsLater();
    return c.json({ meetings, refreshError: lastRsvpError });
  });

  /**
   * The "check for replies" affordance: awaited, so the caller can show the
   * result. Errors here are per-account strings in `errors`, never a 500.
   */
  app.post("/api/calendar/meetings/refresh-rsvps", async (c) => {
    try {
      const result = await service.refreshRsvps();
      rsvpRefreshedAt = Date.now();
      lastRsvpError = result.errors.length > 0 ? result.errors.join("; ") : null;
      return c.json(result);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

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
      timeZone?: string;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    if (!Array.isArray(body.attendees)) {
      return c.json({ error: "attendees must be an array of email addresses" }, 400);
    }
    // Validated before the send: the invite body is written in this zone, and
    // a typo must not reach an attendee's inbox with the wrong hours on it.
    const timeZone = zoneParam(body.timeZone);
    if (timeZone === null) return c.json({ error: ZONE_ERROR }, 400);
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
        timeZone,
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
    // The working hours above are a wall clock in this zone. Checked before the
    // fan-out so a typo costs no provider round trip; the response echoes the
    // zone that was actually used.
    const timeZone = zoneParam(c.req.query("timeZone"));
    if (timeZone === null) return c.json({ error: ZONE_ERROR }, 400);

    return c.json(
      await service.freeSlots({
        start: range.start,
        end: range.end,
        durationMinutes,
        dayStartHour,
        dayEndHour,
        maxSlots,
        timeZone,
      }),
    );
  });
}

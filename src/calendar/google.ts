/**
 * Google Calendar provider — REST v3 over fetch, no SDK.
 *
 * Auth is the user's OWN Google Cloud OAuth client (self-host: there is no
 * shared Boxaide secret to leak). The stored refresh token mints short-lived
 * access tokens on demand; app passwords do not work here, Google's calendar
 * endpoints only take OAuth.
 *
 * Invites: events are written with sendUpdates=none. Boxaide mails its own
 * iMIP invite from the user's mailbox, and letting Google email a second one
 * would double-invite every attendee. iCalUID ties the two together so
 * attendee replies land on the right event.
 */
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
} from "./types.js";

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/calendar openid email";
/** Page budget per calendar per read: 250 events each, so 5000 in total. */
const MAX_PAGES = 20;

type ParsedInstance = Omit<CalendarEvent, "accountId" | "accountAlias">;

function requireGoogle(config: CalendarConfig) {
  if (config.kind !== "google") throw new Error("not a Google account");
  return config;
}

// Access tokens live ~1h; cache per refresh token so an agenda sweep over
// many tool calls does not hit the token endpoint every time.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(config: CalendarConfig): Promise<string> {
  const { clientId, clientSecret, refreshToken } = requireGoogle(config);
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google token refresh failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(refreshToken, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

async function api<T>(
  config: CalendarConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await accessToken(config);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Calendar HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

type CalendarListEntry = {
  id: string;
  summary?: string;
  selected?: boolean;
  accessRole?: string;
};

function eventTime(t?: { dateTime?: string; date?: string }): {
  iso: string;
  allDay: boolean;
} | null {
  if (t?.dateTime) return { iso: new Date(t.dateTime).toISOString(), allDay: false };
  // All-day events carry a bare date; treat it as local midnight.
  if (t?.date) return { iso: new Date(`${t.date}T00:00:00`).toISOString(), allDay: true };
  return null;
}

export class GoogleCalendarProvider implements CalendarProvider {
  async testConnection(config: CalendarConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      await api<{ items?: unknown[] }>(config, "/users/me/calendarList?maxResults=1");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listCalendars(config: CalendarConfig): Promise<CalendarInfo[]> {
    const body = await api<{ items?: CalendarListEntry[] }>(
      config,
      "/users/me/calendarList",
    );
    return (body.items ?? []).map((c) => ({ id: c.id, name: c.summary ?? c.id }));
  }

  async listEvents(config: CalendarConfig, range: EventRange): Promise<ParsedInstance[]> {
    const list = await api<{ items?: CalendarListEntry[] }>(
      config,
      "/users/me/calendarList",
    );
    // Calendars the user hid in Google's UI stay out of the agenda too.
    const calendars = (list.items ?? []).filter((c) => c.selected !== false);
    const out: ParsedInstance[] = [];
    for (const calendar of calendars) {
      const events: GoogleEvent[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      // Following nextPageToken is not optional: one page held 250 events, so
      // a busy month came back clipped and free-slot search offered times the
      // user was already booked for.
      do {
        const params = new URLSearchParams({
          timeMin: new Date(range.start).toISOString(),
          timeMax: new Date(range.end).toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const body = await api<{ items?: GoogleEvent[]; nextPageToken?: string }>(
          config,
          `/calendars/${encodeURIComponent(calendar.id)}/events?${params}`,
        );
        events.push(...(body.items ?? []));
        pageToken = body.nextPageToken;
        pages++;
        if (pageToken && pages >= MAX_PAGES) {
          // Residual risk, named rather than hidden: past 5000 events in one
          // window this calendar IS clipped. listEvents has no errors channel
          // to report it through, so it is logged instead of swallowed. The
          // agenda range cap (62 days) keeps realistic calendars under it.
          console.warn(
            `[calendar] Google calendar ${calendar.id} has more than ${MAX_PAGES * 250} events in the requested range; the rest are omitted`,
          );
          break;
        }
      } while (pageToken);

      for (const event of events) {
        const start = eventTime(event.start);
        const end = eventTime(event.end);
        if (!start || !end || event.status === "cancelled") continue;
        out.push({
          id: event.id,
          calendarId: calendar.id,
          title: event.summary ?? "(no title)",
          start: start.iso,
          end: end.iso,
          allDay: start.allDay,
          location: event.location,
          status: event.status === "tentative" ? "tentative" : "confirmed",
          busy: event.transparency !== "transparent",
        });
      }
    }
    return out;
  }

  async createEvent(
    config: CalendarConfig,
    input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    const created = await api<GoogleEvent>(
      config,
      // sendUpdates=none: the iMIP email from the user's own mailbox is the
      // one invite attendees get.
      "/calendars/primary/events?sendUpdates=none",
      {
        method: "POST",
        body: JSON.stringify({
          iCalUID: input.uid,
          summary: input.title,
          description: input.description,
          location: input.location,
          start: { dateTime: new Date(input.start).toISOString() },
          end: { dateTime: new Date(input.end).toISOString() },
          attendees: input.attendees.map((email) => ({ email })),
        }),
      },
    );
    return { eventId: created.id, calendarId: "primary" };
  }

  async deleteEvent(
    config: CalendarConfig,
    calendarId: string,
    eventId: string,
  ): Promise<boolean> {
    try {
      await api<void>(
        config,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: "DELETE" },
      );
      return true;
    } catch (err) {
      if (err instanceof Error && /HTTP (404|410)/.test(err.message)) return false;
      throw err;
    }
  }
}

// -- OAuth flow helpers (used by the REST routes) ---------------------------

export function googleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Without consent Google omits the refresh token on re-authorization.
    prompt: "consent",
    state: opts.state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeGoogleCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ refreshToken: string; email: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google code exchange failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    refresh_token?: string;
    id_token?: string;
  };
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Remove Boxaide's access at myaccount.google.com/permissions and connect again.",
    );
  }
  // The id_token arrived over TLS straight from Google; decoding without
  // signature verification is safe for reading our own user's email.
  let email = "";
  if (body.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(body.id_token.split(".")[1], "base64url").toString("utf8"),
      ) as { email?: string };
      email = payload.email ?? "";
    } catch {
      // Email stays blank; the account still works.
    }
  }
  return { refreshToken: body.refresh_token, email };
}

/**
 * The calendars this Mac already holds, read through a small Swift helper.
 *
 * Everything EventKit knows is behind one system permission the user grants
 * once, so this provider stores no credentials at all (see LocalConfig). The
 * helper is a separate process on purpose: EventKit's permission prompt blocks
 * for as long as the user looks at it, and a crash inside an in-process native
 * addon would take the whole server down with it.
 *
 * Availability is three cheap layers, in this order, and each one degrades to
 * a sentence a person can act on rather than an exception:
 *   1. not macOS            — nothing to ship, nothing to ask for
 *   2. no helper binary     — a plain checkout without the desktop pack
 *   3. `probe`              — the true permission state, and it never prompts
 * Only an explicit connect may raise the system dialog: every other command
 * carries `--no-prompt`, so a background read refuses instead of asking.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Background reads must not hang. Every read carries NO_PROMPT, so the helper
 * answers `denied` immediately when the permission is not already granted — a
 * helper that blocks here is a helper in trouble, not a user staring at a
 * dialog, and the connect path below is the only one that waits for one.
 */
const READ_TIMEOUT_MS = 10_000;

/**
 * Last, not first: an older helper that does not know the flag still reads
 * `events <start> <end>` off the same argv positions and simply ignores it.
 */
const NO_PROMPT = "--no-prompt";

/** The macOS permission states, verbatim from EKAuthorizationStatus. */
export type LocalAccess =
  | "notDetermined"
  | "restricted"
  | "denied"
  | "writeOnly"
  | "fullAccess"
  | "authorized";

/**
 * Whether the local path can be offered on this machine right now. `reason` is
 * populated whenever it cannot be, and is written to be shown to a person —
 * including when the helper runs perfectly and macOS is simply refusing, which
 * is `available: true` with a reason and is not something a click can fix.
 */
export type LocalCalendarStatus = {
  available: boolean;
  reason?: string;
  /** Present when available; the state `probe` reported. */
  access?: LocalAccess;
};

/**
 * One account behind the Mac's calendars: the name the user gave it and the
 * kind of account it is. `title` is arbitrary user text — "work", "Gmail", an
 * email address — which is exactly why `type` travels beside it.
 */
export type LocalSource = { title: string; type: string };

/** A CalendarProvider that can also answer "can I be used here at all?". */
export interface LocalCalendarLike extends CalendarProvider {
  status(): Promise<LocalCalendarStatus>;
  /**
   * The accounts behind the Mac's calendars, for the duplicate warning.
   *
   * Advisory, so it never throws: an empty list means "nothing known", not
   * "nothing there", and every caller treats it as the absence of a warning
   * rather than as proof of no overlap. A denied permission, a plain checkout
   * and a machine that is not a Mac all land here as [].
   */
  listSources(): Promise<LocalSource[]>;
}

const NOT_MAC = "The local calendar needs macOS. Connect a CalDAV or Google account instead.";
const NO_HELPER =
  "This build does not include the macOS calendar helper. Use the Boxaide desktop app to read the calendars on this Mac.";
const DENIED =
  "macOS is not letting Boxaide use your calendars. Turn Boxaide on in System Settings › Privacy & Security › Calendars, then try again.";
const WRITE_ONLY =
  "macOS granted Boxaide write-only calendar access, which cannot show your agenda. Give Boxaide full access in System Settings › Privacy & Security › Calendars.";

/**
 * The helper's own refusal codes, rewritten into the sentence that names the
 * fix. Without this only the connect path says where to turn the permission
 * back on, and the agenda — the screen where a revoked permission recurs on
 * every refresh — reports the helper's bare "access was not granted".
 */
const PERMISSION_TEXT: Record<string, string> = {
  denied: DENIED,
  restricted: DENIED,
  writeOnly: WRITE_ONLY,
};

/**
 * A refusal the helper reported as data (`{"ok":false,"code":…}`) rather than a
 * crash. The code is carried so the connect path can tell "the user said no"
 * from "something else went wrong" and say so precisely.
 */
export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HelperError";
  }
}

/** One helper invocation. The only I/O seam, so tests never spawn anything. */
export type HelperRun = (args: string[], opts: { input?: string; timeoutMs: number }) => Promise<string>;

type HelperReply = Record<string, unknown>;

/**
 * Where the helper lives when nobody said. The desktop shell always says — it
 * is the only process that knows where its own bundle is, and an explicit
 * override arrives the same way, from BOXAIDE_CALENDAR_HELPER via AppConfig.
 * This covers only `boxaide serve` out of a checkout.
 *
 * The path is not checked here; the constructor checks it once, for every
 * source at the same time.
 */
export function defaultHelperPath(): string {
  // dist/calendar/local.js → the repo root two levels up.
  return join(__dirname, "..", "..", "apps", "desktop", "build", "boxaide-calendar");
}

function spawnHelper(helperPath: string): HelperRun {
  return (args, opts) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        helperPath,
        args,
        // 0 means "wait": the connect call is blocked on a human reading a
        // dialog, and killing it after n seconds would look like a denial.
        { timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      if (opts.input !== undefined) {
        // The helper exits before reading stdin on every refusal it can name,
        // so this write often lands on a closed pipe. Unhandled, the EPIPE is
        // an 'error' on a socket nobody listens to, which ends the process —
        // execFile's callback already carries the real failure.
        child.stdin?.on("error", () => {});
        child.stdin?.end(opts.input);
      }
    });
}

/**
 * One reply, or an error. The helper answers `{"ok":false,…}` for everything it
 * can describe, so anything unparseable here is a genuinely broken binary and
 * must not be reported as "no calendars".
 */
export function parseHelperReply(stdout: string): HelperReply {
  const text = stdout.trim();
  if (!text) throw new Error("the macOS calendar helper returned nothing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the macOS calendar helper returned unreadable output: ${text.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the macOS calendar helper returned unreadable output");
  }
  const reply = parsed as { ok?: unknown; code?: unknown; error?: unknown };
  if (reply.ok !== true) {
    throw new HelperError(
      typeof reply.code === "string" ? reply.code : "failed",
      typeof reply.error === "string" ? reply.error : "the macOS calendar helper refused",
    );
  }
  return parsed as HelperReply;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function eventStatus(raw: unknown): CalendarEvent["status"] {
  return raw === "cancelled" || raw === "tentative" ? raw : "confirmed";
}

function toInstances(reply: HelperReply): Omit<CalendarEvent, "accountId" | "accountAlias">[] {
  const rows = Array.isArray(reply.events) ? reply.events : [];
  const out: Omit<CalendarEvent, "accountId" | "accountAlias">[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const e = row as Record<string, unknown>;
    const start = str(e.start);
    const end = str(e.end);
    // An instance with no bounds cannot be placed on an agenda or block a
    // slot, and a NaN date silently sorts to the front of every list.
    if (!start || !end) continue;
    const location = str(e.location);
    out.push({
      id: str(e.id),
      calendarId: str(e.calendarId),
      title: str(e.title),
      start,
      end,
      allDay: e.allDay === true,
      location: location || undefined,
      status: eventStatus(e.status),
      // Absent means busy: an event that does not say otherwise blocks time.
      busy: e.busy !== false,
    });
  }
  return out;
}

export class LocalCalendarProvider implements LocalCalendarLike {
  private readonly helperPath: string | null;
  private readonly platform: string;
  private readonly run: HelperRun | null;

  constructor(
    opts: { helperPath?: string; platform?: string; run?: HelperRun } = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    // Resolution is skipped entirely off macOS: there is no helper to look for
    // and existsSync on every construction would be pure noise.
    this.helperPath =
      opts.helperPath ?? (this.platform === "darwin" ? defaultHelperPath() : null);
    // A path that names nothing is the same as no path — a checkout that never
    // built the helper must read as "not available here", not as a spawn error.
    this.run =
      opts.run ??
      (this.helperPath && existsSync(this.helperPath) ? spawnHelper(this.helperPath) : null);
  }

  private async call(
    args: string[],
    opts: { input?: string; timeoutMs?: number } = {},
  ): Promise<HelperReply> {
    if (this.platform !== "darwin") throw new Error(NOT_MAC);
    if (!this.run) throw new Error(NO_HELPER);
    try {
      return parseHelperReply(
        await this.run(args, { input: opts.input, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS }),
      );
    } catch (err) {
      if (err instanceof HelperError && PERMISSION_TEXT[err.code]) {
        throw new HelperError(err.code, PERMISSION_TEXT[err.code]);
      }
      throw err;
    }
  }

  /** Every call but the connect one. Reads may not raise the system dialog. */
  private read(args: string[], opts: { input?: string } = {}): Promise<HelperReply> {
    return this.call([...args, NO_PROMPT], opts);
  }

  /** Never prompts, so the UI can render the true state on every page load. */
  async status(): Promise<LocalCalendarStatus> {
    if (this.platform !== "darwin") return { available: false, reason: NOT_MAC };
    if (!this.run) return { available: false, reason: NO_HELPER };
    try {
      const reply = await this.call(["probe"]);
      const access = str(reply.access) as LocalAccess;
      // A refusal macOS already holds is reported here rather than left for
      // the connect click to discover: offering a button that can only fail
      // tells the user nothing, and this sentence names the pane to open.
      return { available: true, access, reason: PERMISSION_TEXT[access] };
    } catch (err) {
      // A helper that will not run is unavailable, not broken calendars: it
      // must read the same as "not on this machine" to anything asking.
      return {
        available: false,
        reason: `The macOS calendar helper did not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * The connect click. This is the ONLY call that can raise the system
   * permission dialog, and it waits without a timeout while it is up — the
   * user is reading it, and killing the helper would report their hesitation
   * as a refusal.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const state = await this.status();
    if (!state.available || state.reason) return { ok: false, error: state.reason };
    try {
      // No NO_PROMPT and no timeout: this is the one call allowed to raise the
      // dialog, and it waits while the dialog is up.
      await this.call(["calendars"], { timeoutMs: 0 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Deduplicated by title and type, because a source with six calendars in it
   * is still one account and would otherwise be named six times in a warning.
   */
  async listSources(): Promise<LocalSource[]> {
    let rows: unknown[];
    try {
      const reply = await this.read(["calendars"]);
      rows = Array.isArray(reply.calendars) ? reply.calendars : [];
    } catch {
      // Advisory only — see listSources on LocalCalendarLike.
      return [];
    }
    const seen = new Map<string, LocalSource>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const entry = row as Record<string, unknown>;
      const title = str(entry.source);
      const type = str(entry.sourceType);
      if (!title && !type) continue;
      seen.set(`${title.toLowerCase()} ${type}`, { title, type });
    }
    return [...seen.values()];
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const reply = await this.read(["calendars"]);
    const rows = Array.isArray(reply.calendars) ? reply.calendars : [];
    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row) => {
        const name = str(row.name);
        const source = str(row.source);
        // Two accounts both call their calendar "Calendar"; the source is the
        // only thing that tells a person which one they are looking at.
        return { id: str(row.id), name: source ? `${name} (${source})` : name };
      });
  }

  async listEvents(
    _config: unknown,
    range: EventRange,
  ): Promise<Omit<CalendarEvent, "accountId" | "accountAlias">[]> {
    return toInstances(await this.read(["events", range.start, range.end]));
  }

  /**
   * Writes to the Mac's default calendar for new events. Attendees do not
   * travel: EventKit cannot construct a participant, so the emailed iMIP
   * REQUEST remains the only invite and this row is the organizer's own copy.
   */
  async createEvent(
    _config: unknown,
    input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    const reply = await this.read(["create"], {
      // On stdin, not argv: a title or description is arbitrary user text and
      // argv has both a length limit and quoting rules this does not need.
      input: JSON.stringify({
        title: input.title,
        start: input.start,
        end: input.end,
        description: input.description,
        location: input.location,
      }),
    });
    return { eventId: str(reply.eventId), calendarId: str(reply.calendarId) };
  }

  async deleteEvent(_config: unknown, _calendarId: string, eventId: string): Promise<boolean> {
    const reply = await this.read(["delete", eventId]);
    return reply.deleted === true;
  }

  // getAttendeeStatus is deliberately absent. EventKit reports whatever the
  // underlying account synced into the organizer's copy, which for a
  // Google-backed local calendar is the same data the Google provider already
  // reads and for an Exchange one is unreliable. types.ts documents omission
  // as the honest answer; the caller skips the top-up.
}

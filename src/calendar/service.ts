/**
 * Calendar orchestration: agenda across accounts, free-slot search, the two
 * write paths (schedule / cancel a meeting), and the RSVP refresh.
 *
 * Three rules shape the whole file:
 * - The emailed iMIP invite is the source of truth for attendees. A calendar
 *   write is a convenience on top, so a provider failure downgrades to a
 *   warning and the invite still goes out — an attendee with no invite is a
 *   worse outcome than an organizer whose own calendar is missing a row.
 * - The email IS the transaction, so it goes first and everything durable
 *   happens after it. Both write paths run validate → send → calendar write →
 *   store. A send that fails therefore leaves nothing behind: no orphan
 *   provider event, no stored meeting, and the caller can simply retry.
 * - Fan-out reads never fail whole. One unreachable account contributes an
 *   error string, exactly like MailService.listMessages. refreshRsvps obeys
 *   this per mail account AND per polled meeting.
 *
 * Working hours are read in a caller-supplied IANA zone (freeSlots/
 * createMeeting take an optional `timeZone`), defaulting to the server's own
 * zone so callers that name none behave exactly as they did before. Every
 * response echoes the zone actually used, so a caller never has to guess which
 * clock produced the answer. The ICS itself stays UTC — see ics.ts.
 */
import addressparser from "nodemailer/lib/addressparser/index.js";
import { CalDavProvider } from "./caldav.js";
import { GoogleCalendarProvider } from "./google.js";
import { parseIcs } from "./ics-parse.js";
import { buildIcs, jitsiLink, newEventUid, type InviteEvent } from "./ics.js";
import type { CalendarStore, StoredMeeting } from "./store.js";
import {
  resolveTimeZone,
  startOfNextZonedDay,
  startOfZonedDay,
  zonedParts,
  zonedTimeToUtc,
  zoneOffsetMs,
} from "./timezone.js";
import type { CalendarConfig, CalendarEvent, CalendarProvider } from "./types.js";
import type { MailService } from "../mail/service.js";
import type { MailAccountMeta } from "../provider/types.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SLOT_STEP_MINUTES = 30;

/**
 * Bounds on one refreshRsvps pass. The scan runs on a timer and shares a
 * process with the inbox, so every leg is capped rather than left to grow with
 * the mailbox: at worst one pass lists RSVP_LIST_LIMIT headers per mailbox,
 * opens RSVP_FETCH_LIMIT of them, and makes RSVP_POLL_LIMIT provider calls.
 */
const RSVP_LIST_LIMIT = 200;
const RSVP_FETCH_LIMIT = 40;
const RSVP_POLL_LIMIT = 20;
/** Widest window a single pass reads, so a first run cannot walk a whole mailbox. */
const RSVP_MAX_WINDOW_DAYS = 30;
/**
 * How far the paging walk to the oldest unread mail will go: 100 pages of 200
 * is 20k messages in one 30-day window. These are index reads, not fetches, so
 * the cost is small; the cap only exists so a pathological mailbox cannot spin.
 */
const RSVP_MAX_PAGES = 100;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type FreeSlot = { start: string; end: string };

export type FreeSlotOpts = {
  start?: string;
  end?: string;
  durationMinutes: number;
  dayStartHour?: number;
  dayEndHour?: number;
  maxSlots?: number;
  /** Slots before this instant are dropped; defaults to now. */
  now?: string;
  /**
   * IANA zone the working hours are a wall clock in ("Europe/Brussels").
   * Defaults to the server's zone, which is what every caller got before this
   * option existed. An unknown id throws rather than falling back — see
   * resolveTimeZone.
   */
  timeZone?: string;
};

/** Merge overlapping/touching intervals so subtraction sees a clean list. */
function mergeIntervals(busy: FreeSlot[]): Array<{ start: number; end: number }> {
  const spans = busy
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Pure slot search, exported so tests can drive it without providers.
 * Candidate starts are rounded up to the next half hour of `opts.timeZone`'s
 * wall clock: a meeting that ends at 10:12 should offer 10:30, not 10:12.
 *
 * Days are walked in `opts.timeZone`, not by adding 24h: a DST day is 23 or 25
 * hours long, so a fixed step drifts the working window off the wall clock
 * from the transition onwards. Each day's window is rebuilt from that day's
 * zoned date parts instead, which keeps "09:00 to 17:00" meaning 09:00 to
 * 17:00 on both sides of the change.
 */
export function computeFreeSlots(busy: FreeSlot[], opts: FreeSlotOpts): FreeSlot[] {
  const duration = Math.max(1, Math.round(opts.durationMinutes)) * MINUTE;
  const dayStartHour = opts.dayStartHour ?? 9;
  const dayEndHour = opts.dayEndHour ?? 17;
  const maxSlots = opts.maxSlots ?? 10;
  const zone = resolveTimeZone(opts.timeZone);
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const rangeStart = opts.start ? new Date(opts.start).getTime() : now;
  const rangeEnd = opts.end ? new Date(opts.end).getTime() : rangeStart + 7 * DAY;
  if (!(rangeEnd > rangeStart) || dayEndHour <= dayStartHour) return [];

  const merged = mergeIntervals(busy);
  const slots: FreeSlot[] = [];
  let cursor = startOfZonedDay(rangeStart, zone);

  while (cursor < rangeEnd && slots.length < maxSlots) {
    const day = zonedParts(cursor, zone);
    const windowStart = zonedTimeToUtc({ ...day, hour: dayStartHour, minute: 0 }, zone);
    // An hour past 23 rolls into the next day, so dayEndHour: 24 means midnight.
    const windowEnd = zonedTimeToUtc({ ...day, hour: dayEndHour, minute: 0 }, zone);
    let free = Math.max(windowStart, rangeStart, now);
    const dayEnd = Math.min(windowEnd, rangeEnd);

    for (const span of merged) {
      if (span.end <= free) continue;
      if (span.start >= dayEnd) break;
      emitSlots(slots, free, Math.min(span.start, dayEnd), duration, maxSlots, zone);
      free = Math.max(free, span.end);
      if (slots.length >= maxSlots) break;
    }
    if (slots.length < maxSlots) emitSlots(slots, free, dayEnd, duration, maxSlots, zone);

    cursor = startOfNextZonedDay(cursor, zone);
  }
  return slots;
}

/**
 * Half-hour grid of the READER's clock, not the epoch's. Rounding `from` on
 * epoch ms silently assumes every zone sits a whole half hour off UTC, which
 * Asia/Kathmandu (+05:45), Pacific/Chatham (+12:45) and Australia/Eucla
 * (+08:45) do not: there the window's 09:00 became 09:15 and the 09:00 slot
 * was never offered at all. Shifting by the zone's offset first puts the grid
 * back on the wall clock the caller asked for.
 *
 * The offset is read once, at `from`: a transition inside the following half
 * hour is the one case where it moves, and there the grid is undefined anyway.
 */
function emitSlots(
  out: FreeSlot[],
  from: number,
  until: number,
  duration: number,
  maxSlots: number,
  zone: string,
): void {
  const step = SLOT_STEP_MINUTES * MINUTE;
  const offset = zoneOffsetMs(from, zone);
  let start = Math.ceil((from + offset) / step) * step - offset;
  while (start + duration <= until && out.length < maxSlots) {
    out.push({
      start: new Date(start).toISOString(),
      end: new Date(start + duration).toISOString(),
    });
    start += step;
  }
}

/**
 * Bare mailboxes, in input order, deduped case-insensitively.
 *
 * ATTENDEE lines carry `mailto:` plus the address and nothing else, so a
 * display-name form ("Jane Doe <jane@x.com>") interpolated raw produced ICS no
 * client would parse. nodemailer's parser is the one used on the send path in
 * MailService, so the invite and the envelope agree on what an address is.
 */
function normalizeAttendees(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const parsed = addressparser(entry, { flatten: true })
      .map((a) => (a.address ?? "").trim())
      .filter((a) => a.includes("@"));
    if (parsed.length === 0) throw new Error(`invalid attendee: ${entry.trim()}`);
    for (const address of parsed) {
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(address);
    }
  }
  if (out.length === 0) throw new Error("at least one attendee is required");
  return out;
}

export type CreateMeetingInput = {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  description?: string;
  location?: string;
  calendarAccountId?: string;
  mailAccountId?: string;
  includeMeetingLink?: boolean;
  /**
   * IANA zone the invite's human-readable time is written in, so a guest reads
   * the hour the organizer meant. It never reaches the ICS: that stays UTC and
   * every client renders it in the reader's own zone. Omitted means the
   * server's zone and an unlabelled range, byte for byte what this sent before.
   */
  timeZone?: string;
};

export class CalendarService {
  private providers: { caldav: CalendarProvider; google: CalendarProvider };

  constructor(
    private store: CalendarStore,
    private mail: MailService,
    providers?: { caldav: CalendarProvider; google: CalendarProvider },
  ) {
    this.providers = providers ?? {
      caldav: new CalDavProvider(),
      google: new GoogleCalendarProvider(),
    };
  }

  private providerFor(config: CalendarConfig): CalendarProvider {
    return config.kind === "google" ? this.providers.google : this.providers.caldav;
  }

  async testAccount(config: CalendarConfig): Promise<{ ok: boolean; error?: string }> {
    return this.providerFor(config).testConnection(config);
  }

  /** Returns { events, errors } — NOT a bare array. See the file header. */
  async agenda(range: { start: string; end: string }): Promise<{
    events: CalendarEvent[];
    errors: string[];
  }> {
    const accounts = this.store.listAccounts();
    const settled = await Promise.allSettled(
      accounts.map(async (account) => {
        const config = this.store.getConfig(account.id);
        if (!config) throw new Error("account config missing");
        const events = await this.providerFor(config).listEvents(config, range);
        return events.map((e) => ({
          ...e,
          accountId: account.id,
          accountAlias: account.alias,
        }));
      }),
    );

    const events: CalendarEvent[] = [];
    const errors: string[] = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") events.push(...res.value);
      else errors.push(`${accounts[i].alias}: ${errText(res.reason)}`);
    });
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return { events, errors };
  }

  /**
   * Returns the zone the working hours were read in alongside the slots, so a
   * caller that named none still knows which clock to quote back to a human.
   * Resolved before the fan-out: a typo'd zone is a caller error and should
   * not cost a round trip to every calendar first.
   */
  async freeSlots(
    opts: FreeSlotOpts,
  ): Promise<{ slots: FreeSlot[]; errors: string[]; timeZone: string }> {
    const timeZone = resolveTimeZone(opts.timeZone);
    const now = opts.now ? new Date(opts.now) : new Date();
    const start = opts.start ?? now.toISOString();
    const end = opts.end ?? new Date(new Date(start).getTime() + 7 * DAY).toISOString();
    const { events, errors } = await this.agenda({ start, end });
    // Tentative events still block; free/transparent and cancelled ones do not.
    const busy = events
      .filter((e) => e.busy && e.status !== "cancelled")
      .map((e) => ({ start: e.start, end: e.end }));
    return {
      slots: computeFreeSlots(busy, { ...opts, start, end, now: now.toISOString(), timeZone }),
      errors,
      timeZone,
    };
  }

  async createMeeting(input: CreateMeetingInput): Promise<{
    meeting: StoredMeeting;
    warnings: string[];
    timeZone: string;
  }> {
    const title = input.title.trim();
    if (!title) throw new Error("title is required");
    // Validated with the other inputs, before anything is sent: a bad zone must
    // not surface after the invite has already gone out.
    const timeZone = resolveTimeZone(input.timeZone);
    const startMs = new Date(input.start).getTime();
    const endMs = new Date(input.end).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error("invalid start or end");
    if (endMs <= startMs) throw new Error("end must be after start");
    const listed = input.attendees.map((a) => a.trim()).filter(Boolean);
    if (listed.length === 0) throw new Error("at least one attendee is required");
    const attendees = normalizeAttendees(listed);

    const warnings: string[] = [];
    const meetingUrl = (input.includeMeetingLink ?? true) ? jitsiLink(title) : null;
    // An explicit location wins the LOCATION field; the link then survives in
    // the description only, so neither piece of information is lost.
    const location = input.location ?? meetingUrl ?? null;
    const description = [input.description, meetingUrl ? `Join: ${meetingUrl}` : null]
      .filter(Boolean)
      .join("\n\n");

    const mailAccounts = this.mail.listAccounts();
    const mailAccount = input.mailAccountId
      ? mailAccounts.find((a) => a.id === input.mailAccountId || a.alias === input.mailAccountId)
      : mailAccounts[0];
    if (!mailAccount) throw new Error("connect a mail account first");

    const calendarAccounts = this.store.listAccounts();
    const calendarAccount = input.calendarAccountId
      ? calendarAccounts.find((a) => a.id === input.calendarAccountId)
      : calendarAccounts[0];
    if (input.calendarAccountId && !calendarAccount) {
      throw new Error(`calendar account not found: ${input.calendarAccountId}`);
    }
    if (!calendarAccount) warnings.push("no calendar account connected; invite emailed only");

    // The UID is minted here, not by the calendar, so the invite can go out
    // before any provider write and still match the event written afterwards.
    const uid = newEventUid();
    const event: InviteEvent = {
      uid,
      title,
      start: input.start,
      end: input.end,
      description: description || undefined,
      location: location ?? undefined,
      organizerEmail: mailAccount.email,
      attendees,
    };
    // First durable act, and the one that defines the meeting. It throws on
    // failure: nothing has been written yet, so the caller can retry cleanly.
    await this.mail.sendMessage(mailAccount.id, {
      to: attendees.join(", "),
      subject: `Invitation: ${title}`,
      // The label is only worth printing when the organizer asked for a zone;
      // without one this is the server's clock and reads as it always did.
      text: inviteText(
        title,
        input.start,
        input.end,
        location,
        description,
        input.timeZone ? timeZone : undefined,
      ),
      icalEvent: { method: "REQUEST", content: buildIcs(event, "REQUEST") },
    });

    let eventId: string | null = null;
    let calendarId: string | null = null;
    if (calendarAccount) {
      try {
        const config = this.store.getConfig(calendarAccount.id);
        if (!config) throw new Error("account config missing");
        const written = await this.providerFor(config).createEvent(config, {
          uid,
          title,
          start: input.start,
          end: input.end,
          description: description || undefined,
          location: location ?? undefined,
          organizerEmail: mailAccount.email,
          attendees,
        });
        eventId = written.eventId;
        calendarId = written.calendarId;
      } catch (err) {
        // The attendees already have the invite; the organizer's own calendar
        // missing a row is a warning, not a failed meeting.
        warnings.push(`calendar write failed: ${errText(err)}`);
      }
    }

    const meeting = this.store.addMeeting({
      uid,
      calendarAccountId: calendarAccount?.id ?? null,
      eventId,
      calendarId,
      mailAccountId: mailAccount.id,
      title,
      start: input.start,
      end: input.end,
      attendees,
      location,
      meetingUrl,
      // Only when the organizer named one: an absent zone must keep meaning
      // "the server's clock, unlabelled", in the cancellation as in the invite.
      timeZone: input.timeZone ? timeZone : null,
    });
    return { meeting, warnings, timeZone };
  }

  async cancelMeeting(meetingId: string): Promise<{
    meeting: StoredMeeting;
    warnings: string[];
  }> {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
    if (meeting.status === "cancelled") throw new Error("meeting is already cancelled");

    const warnings: string[] = [];
    // Resolved before anything destructive runs: a cancellation that deletes
    // the event and then discovers it cannot mail anyone leaves the attendees
    // holding an invite to a meeting nobody will attend.
    const mailAccount = this.mail
      .listAccounts()
      .find((a) => a.id === meeting.mailAccountId);
    if (!mailAccount) throw new Error("the mailbox that sent this invite is gone");

    // Same UID, higher SEQUENCE: clients drop a CANCEL that does not outrank
    // the REQUEST it withdraws.
    const event: InviteEvent = {
      uid: meeting.uid,
      title: meeting.title,
      start: meeting.start,
      end: meeting.end,
      location: meeting.location ?? undefined,
      organizerEmail: mailAccount.email,
      attendees: meeting.attendees,
      sequence: 1,
    };
    // The send comes first and throws on failure, so a mail outage leaves the
    // meeting scheduled and the event in place — retryable, not half-cancelled.
    await this.mail.sendMessage(
      mailAccount.id,
      {
        to: meeting.attendees.join(", "),
        subject: `Cancelled: ${meeting.title}`,
        // The zone the invite quoted, so both mails about one meeting name the
        // same wall clock; null keeps the unlabelled server clock as before.
        text: `${meeting.title} on ${localRange(
          meeting.start,
          meeting.end,
          meeting.timeZone ?? undefined,
        )} is cancelled.`,
        icalEvent: { method: "CANCEL", content: buildIcs(event, "CANCEL") },
      },
      // Suppression exists to stop marketing, not to withhold the news that an
      // accepted meeting is off. An attendee who opted out still has this
      // meeting on their calendar and must be told it is cancelled.
      { overrideSuppression: true },
    );

    if (meeting.eventId && meeting.calendarAccountId) {
      try {
        const config = this.store.getConfig(meeting.calendarAccountId);
        if (!config) throw new Error("account config missing");
        await this.providerFor(config).deleteEvent(
          config,
          meeting.calendarId ?? "",
          meeting.eventId,
        );
      } catch (err) {
        warnings.push(`calendar delete failed: ${errText(err)}`);
      }
    }

    this.store.markCancelled(meeting.id);
    return { meeting: { ...meeting, status: "cancelled" }, warnings };
  }

  /**
   * Learn who answered, from both sources, and merge them through the store's
   * precedence ladder (documented on CalendarStore.recordRsvp):
   *
   *  - Inbound iMIP replies (METHOD:REPLY) are the base. They are the guest's
   *    own answer and carry the instant they sent it.
   *  - The provider's attendee status is a top-up. It fills in guests whose
   *    reply never reached this mailbox — answered in a web UI, replied to a
   *    delegate, or auto-accepted by a room. It has no timestamp, so it loses
   *    to a recorded email reply and only writes where there is none.
   *
   * Both legs are fan-outs and neither fails the call: an unreachable mailbox
   * or calendar contributes an error string, exactly like agenda.
   *
   * `limit` caps how many INBOX headers are listed per mailbox.
   */
  async refreshRsvps(
    opts: { mailAccountId?: string; limit?: number } = {},
  ): Promise<{ updated: number; errors: string[] }> {
    const mailAccounts = this.mail.listAccounts();
    const accounts = opts.mailAccountId
      ? mailAccounts.filter(
          (a) => a.id === opts.mailAccountId || a.alias === opts.mailAccountId,
        )
      : mailAccounts;
    if (opts.mailAccountId && accounts.length === 0) {
      throw new Error(`mail account not found: ${opts.mailAccountId}`);
    }

    const ids = new Set(accounts.map((a) => a.id));
    const meetings = this.store
      .listMeetings({ limit: 200 })
      .filter((m) => ids.has(m.mailAccountId));
    // Nothing to match a reply against. Returning early also leaves the scan
    // cursors alone: advancing them over a mailbox we never really read would
    // silently skip the replies to a meeting created a minute from now.
    if (meetings.length === 0) return { updated: 0, errors: [] };

    let updated = 0;
    const errors: string[] = [];

    const scans = await Promise.allSettled(
      accounts.map((account) => this.scanReplies(account, meetings, opts.limit)),
    );
    scans.forEach((res, i) => {
      if (res.status === "fulfilled") updated += res.value;
      else errors.push(`${accounts[i].alias}: ${errText(res.reason)}`);
    });

    const polled = await this.pollAttendeeStatus(meetings);
    updated += polled.updated;
    errors.push(...polled.errors);
    return { updated, errors };
  }

  /**
   * One mailbox's iMIP reply pass. Throws on a mailbox-level failure so the
   * caller can name the account; anything a single message does wrong is
   * skipped instead, since a malformed .ics from one guest must not stop the
   * rest of the inbox being read.
   */
  private async scanReplies(
    account: MailAccountMeta,
    meetings: StoredMeeting[],
    limit?: number,
  ): Promise<number> {
    const mine = meetings.filter((m) => m.mailAccountId === account.id);
    if (mine.length === 0) return 0;
    const byUid = new Map(mine.map((m) => [m.uid, m]));
    // Only mail from someone we invited can be a reply to one of our invites.
    // Applied to the index rows, this drops the ordinary inbox before a single
    // full message is fetched — the summary rows are headers only and cannot
    // say whether a calendar part is attached.
    const invited = new Set<string>();
    for (const meeting of mine) for (const a of meeting.attendees) invited.add(a.toLowerCase());

    const since = this.scanSince(account.id, mine);
    const listLimit = Math.min(limit ?? RSVP_LIST_LIMIT, RSVP_LIST_LIMIT);
    const messages = await this.oldestPage(account.id, since, listLimit);

    let updated = 0;
    // Oldest first, because the cursor below is a forward-only floor: a pass
    // that opened the NEWEST replies and then advanced past them would leave
    // everything under the fetch cap behind the cursor and unreadable forever.
    // Consuming the old end of the window instead makes each capped pass a step
    // the next one continues from.
    const ordered = [...messages].sort((a, b) => receivedAt(a) - receivedAt(b));
    const fromGuests = ordered.filter((m) => {
      const from = senderAddress(m.from);
      return from !== null && invited.has(from);
    });
    const candidates = fromGuests.slice(0, RSVP_FETCH_LIMIT);

    for (const summary of candidates) {
      const full = await this.mail.getMessage(account.id, summary.id, summary.folder);
      const body = full?.calendar?.content;
      if (!body) continue;
      const ics = parseIcs(body);
      // The body's own METHOD is the calendar speaking; the part's Content-Type
      // method is the transport's copy of it and stands in when the body omits
      // it. Anything but a REPLY (an invite forwarded to us, say) is not ours.
      const method = ics.method ?? full.calendar?.method;
      if (method !== "REPLY") continue;
      const meeting = ics.uid ? byUid.get(ics.uid) : undefined;
      if (!meeting) continue;

      // A reply speaks for its sender and nobody else. The From address is all
      // this mailbox knows about who wrote the body, so an ATTENDEE naming
      // anyone else is that guest answering for another guest — which would let
      // any invitee decline on a colleague's behalf, and outrank the colleague's
      // own real reply by carrying a fresher timestamp.
      const sender = senderAddress(summary.from);
      if (!sender || !isAttendee(meeting, sender)) continue;

      // Server receive time first: a guest with a wrong clock would otherwise
      // order their own answers wrongly against the rest.
      const respondedAt = summary.internalDate ?? summary.date;
      for (const attendee of ics.attendees) {
        // Only people on the invite. A guest who forwards an invite gets a
        // reply carrying our UID from someone we never asked; recording it
        // would let a stranger appear on the organizer's guest list.
        if (!isAttendee(meeting, attendee.email)) continue;
        if (attendee.email.trim().toLowerCase() !== sender) continue;
        const wrote = this.store.recordRsvp({
          meetingId: meeting.id,
          email: attendee.email,
          status: attendee.status,
          respondedAt,
          source: "email",
          // SEQUENCE comes off an untrusted body, and the store's ladder treats
          // a higher one as unbeatable. Left unbounded, a single reply claiming
          // SEQUENCE:999 would freeze that guest's status for the life of the
          // meeting: every later reply and every provider read carries the real
          // sequence and would lose. We know what we sent, so cap it there.
          sequence: Math.min(ics.sequence, meetingSequence(meeting)),
        });
        if (wrote) updated += 1;
      }
    }

    // Only over mail this pass actually examined — a cursor advanced past mail
    // we did not read drops those replies for good, since nothing ever lists
    // below the cursor again. `messages` is already the oldest page of the
    // window, so the only cut left is the fetch cap: it opened the oldest
    // RSVP_FETCH_LIMIT guest messages, and the window is finished up to the
    // last one opened and no further. 60 guests answering between two passes
    // are read 40 then 20, not 40 then never.
    const lastRead = fromGuests.length > candidates.length ? candidates.at(-1) : ordered.at(-1);
    const mark = !lastRead ? null : receivedAt(lastRead);
    if (mark !== null && Number.isFinite(mark) && mark > new Date(since).getTime()) {
      this.store.setRsvpScanCursor(account.id, new Date(mark).toISOString());
    }
    return updated;
  }

  /**
   * The OLDEST page of the window, which is the end the scan has to consume.
   *
   * listMessages hands back the NEWEST rows (index-store orders date DESC), but
   * the cursor is a forward-only floor, so a pass that reads the newest slice
   * can never advance without stepping over the mail below it. On a mailbox
   * that outruns the list cap that stalls the scan outright: the same newest
   * page is re-read for ever and replies further down are never opened. Paging
   * to the oldest rows instead makes every pass a step the next one continues
   * from, and the backlog is walked off one page at a time.
   *
   * `since` is inclusive, so the last message of the previous pass sits at the
   * bottom of this one's window and the oldest page can consist of nothing but
   * mail already read. That page cannot move the cursor, so the walk steps back
   * up one page in that case: every pass is then guaranteed to reach mail the
   * cursor has not passed, which is what stops the scan standing still.
   *
   * Paging is index reads, not mailbox fetches: the first call fills the window
   * from IMAP, the rest answer from SQLite.
   */
  private async oldestPage(
    accountId: string,
    since: string,
    listLimit: number,
  ): Promise<Awaited<ReturnType<MailService["listMessages"]>>["messages"]> {
    type Page = Awaited<ReturnType<MailService["listMessages"]>>["messages"];
    const page = async (offset: number) =>
      (await this.mail.listMessages(accountId, { folder: "INBOX", since, limit: listLimit, offset }))
        .messages;
    const sinceMs = new Date(since).getTime();
    const advances = (rows: Page) => rows.some((m) => receivedAt(m) > sinceMs);

    let messages = await page(0);
    let newer: Page | null = null;
    let offset = 0;
    for (let n = 0; n < RSVP_MAX_PAGES && messages.length >= listLimit; n++) {
      const older = await page(offset + listLimit);
      // A short last page: nothing older to step down to, so this is the end.
      // An unmoved page means the source ignored the offset — stop rather than
      // ask for the same rows for ever.
      if (older.length === 0 || older[0]?.id === messages[0]?.id) break;
      offset += listLimit;
      newer = messages;
      messages = older;
    }
    return !advances(messages) && newer ? newer : messages;
  }

  /**
   * Where this mailbox's scan starts: its stored high-water mark, or on a first
   * pass the oldest meeting it might still hear about. Clamped to
   * RSVP_MAX_WINDOW_DAYS either way, so a mailbox that has gone unscanned for
   * months costs one bounded pass rather than one proportional to the outage.
   */
  private scanSince(mailAccountId: string, meetings: StoredMeeting[]): string {
    const cursor = this.store.getRsvpScanCursor(mailAccountId);
    const oldest = Math.min(...meetings.map((m) => new Date(m.createdAt).getTime()));
    const wanted = cursor ? new Date(cursor).getTime() : oldest;
    const floor = Date.now() - RSVP_MAX_WINDOW_DAYS * DAY;
    return new Date(Math.max(wanted, floor)).toISOString();
  }

  /**
   * The provider top-up. Only meetings that are still scheduled and actually
   * have a provider event are worth a call, and only RSVP_POLL_LIMIT of them
   * per pass. The stored order is by start descending, which puts a meeting a
   * year out ahead of tomorrow's — so the cap is spent nearest-first instead:
   * this runs on a timer, and the meeting people are answering right now is the
   * one about to happen. Providers that cannot report attendee status (a plain
   * CalDAV collection may not) are skipped, not an error.
   */
  private async pollAttendeeStatus(
    meetings: StoredMeeting[],
  ): Promise<{ updated: number; errors: string[] }> {
    const now = Date.now();
    const pollable = meetings
      .filter((m) => m.status === "scheduled" && m.eventId && m.calendarAccountId)
      .sort(
        (a, b) =>
          Math.abs(new Date(a.start).getTime() - now) -
          Math.abs(new Date(b.start).getTime() - now),
      )
      .slice(0, RSVP_POLL_LIMIT);

    const settled = await Promise.allSettled(
      pollable.map(async (meeting) => {
        const config = this.store.getConfig(meeting.calendarAccountId as string);
        if (!config) throw new Error("account config missing");
        const provider = this.providerFor(config);
        if (!provider.getAttendeeStatus) return 0;
        const rows = await provider.getAttendeeStatus(
          config,
          meeting.calendarId ?? "",
          meeting.eventId as string,
        );
        let updated = 0;
        for (const row of rows) {
          // Same rule as the email leg: rooms, delegates and anyone the
          // provider added on its own are not on our guest list.
          if (!isAttendee(meeting, row.email)) continue;
          const wrote = this.store.recordRsvp({
            meetingId: meeting.id,
            email: row.email,
            status: row.status,
            respondedAt: null,
            source: "provider",
            // A scheduled meeting's invite is SEQUENCE 0 — only cancellation
            // bumps it — so a provider read sits on the same rung as the
            // replies to that invite and loses the tie to them by source.
            sequence: 0,
          });
          if (wrote) updated += 1;
        }
        return updated;
      }),
    );

    let updated = 0;
    const errors: string[] = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") updated += res.value;
      else errors.push(`${pollable[i].title}: ${errText(res.reason)}`);
    });
    return { updated, errors };
  }
}

/** Server receive time, falling back to the sender's Date when the index has none. */
function receivedAt(summary: { internalDate?: string; date: string }): number {
  return new Date(summary.internalDate ?? summary.date).getTime();
}

/**
 * The highest SEQUENCE we have ever published for a meeting. Invites go out at
 * 0 (see ics.ts) and only cancelMeeting bumps to 1, so anything above this in
 * an inbound reply is a claim about an invite we never sent.
 */
function meetingSequence(meeting: StoredMeeting): number {
  return meeting.status === "cancelled" ? 1 : 0;
}

/** Addresses compare case-insensitively; the invite keeps the sender's casing. */
function isAttendee(meeting: StoredMeeting, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  return meeting.attendees.some((a) => a.trim().toLowerCase() === wanted);
}

/** Bare mailbox of a From header, lowercased for comparison. Null when unparseable. */
function senderAddress(from: string): string | null {
  const parsed = addressparser(from ?? "", { flatten: true })
    .map((a) => (a.address ?? "").trim().toLowerCase())
    .filter((a) => a.includes("@"));
  return parsed[0] ?? null;
}

/**
 * Wall clock for the mail body. With a zone the range is rendered there and
 * labelled with it, since a bare "14:00" is worthless to a guest who does not
 * know whose clock it is. Without one this is the server's zone and no label —
 * the exact string this produced before zones were an option.
 */
function localRange(start: string, end: string, zone?: string): string {
  const opts = zone ? { timeZone: zone } : undefined;
  const range = `${new Date(start).toLocaleString(undefined, opts)} - ${new Date(end).toLocaleString(undefined, opts)}`;
  return zone ? `${range} (${zone})` : range;
}

function inviteText(
  title: string,
  start: string,
  end: string,
  location: string | null,
  description: string,
  zone?: string,
): string {
  const lines = [title, localRange(start, end, zone)];
  if (location) lines.push(location);
  if (description) lines.push("", description);
  return lines.join("\n");
}

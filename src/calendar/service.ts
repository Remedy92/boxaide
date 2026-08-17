/**
 * Calendar orchestration: agenda across accounts, free-slot search, and the
 * two write paths (schedule / cancel a meeting).
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
 *   error string, exactly like MailService.listMessages.
 *
 * Working hours are server-local, matching how automation crons are read.
 */
import addressparser from "nodemailer/lib/addressparser/index.js";
import { CalDavProvider } from "./caldav.js";
import { GoogleCalendarProvider } from "./google.js";
import { buildIcs, jitsiLink, newEventUid, type InviteEvent } from "./ics.js";
import type { CalendarStore, StoredMeeting } from "./store.js";
import type { CalendarConfig, CalendarEvent, CalendarProvider } from "./types.js";
import type { MailService } from "../mail/service.js";

const MINUTE = 60 * 1000;
const SLOT_STEP_MINUTES = 30;

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
 * Candidate starts are rounded up to the next half hour: a meeting that ends
 * at 10:12 should offer 10:30, not 10:12.
 */
export function computeFreeSlots(busy: FreeSlot[], opts: FreeSlotOpts): FreeSlot[] {
  const duration = Math.max(1, Math.round(opts.durationMinutes)) * MINUTE;
  const dayStartHour = opts.dayStartHour ?? 9;
  const dayEndHour = opts.dayEndHour ?? 17;
  const maxSlots = opts.maxSlots ?? 10;
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const rangeStart = opts.start ? new Date(opts.start).getTime() : now;
  const rangeEnd = opts.end ? new Date(opts.end).getTime() : rangeStart + 7 * 24 * 60 * MINUTE;
  if (!(rangeEnd > rangeStart) || dayEndHour <= dayStartHour) return [];

  const merged = mergeIntervals(busy);
  const slots: FreeSlot[] = [];
  const cursor = new Date(rangeStart);
  cursor.setHours(0, 0, 0, 0);

  while (cursor.getTime() < rangeEnd && slots.length < maxSlots) {
    // Built from local date parts, so DST shifts land on the right wall clock.
    const windowStart = new Date(cursor);
    windowStart.setHours(dayStartHour, 0, 0, 0);
    const windowEnd = new Date(cursor);
    windowEnd.setHours(dayEndHour, 0, 0, 0);
    let free = Math.max(windowStart.getTime(), rangeStart, now);
    const dayEnd = Math.min(windowEnd.getTime(), rangeEnd);

    for (const span of merged) {
      if (span.end <= free) continue;
      if (span.start >= dayEnd) break;
      emitSlots(slots, free, Math.min(span.start, dayEnd), duration, maxSlots);
      free = Math.max(free, span.end);
      if (slots.length >= maxSlots) break;
    }
    if (slots.length < maxSlots) emitSlots(slots, free, dayEnd, duration, maxSlots);

    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

function emitSlots(
  out: FreeSlot[],
  from: number,
  until: number,
  duration: number,
  maxSlots: number,
): void {
  const step = SLOT_STEP_MINUTES * MINUTE;
  let start = Math.ceil(from / step) * step;
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

  async freeSlots(opts: FreeSlotOpts): Promise<{ slots: FreeSlot[]; errors: string[] }> {
    const now = opts.now ? new Date(opts.now) : new Date();
    const start = opts.start ?? now.toISOString();
    const end =
      opts.end ?? new Date(new Date(start).getTime() + 7 * 24 * 60 * MINUTE).toISOString();
    const { events, errors } = await this.agenda({ start, end });
    // Tentative events still block; free/transparent and cancelled ones do not.
    const busy = events
      .filter((e) => e.busy && e.status !== "cancelled")
      .map((e) => ({ start: e.start, end: e.end }));
    return {
      slots: computeFreeSlots(busy, { ...opts, start, end, now: now.toISOString() }),
      errors,
    };
  }

  async createMeeting(input: CreateMeetingInput): Promise<{
    meeting: StoredMeeting;
    warnings: string[];
  }> {
    const title = input.title.trim();
    if (!title) throw new Error("title is required");
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
      text: inviteText(title, input.start, input.end, location, description),
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
    });
    return { meeting, warnings };
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
        text: `${meeting.title} on ${localRange(meeting.start, meeting.end)} is cancelled.`,
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
}

/** Server-local wall clock, so the body matches the organizer's own agenda. */
function localRange(start: string, end: string): string {
  return `${new Date(start).toLocaleString()} - ${new Date(end).toLocaleString()}`;
}

function inviteText(
  title: string,
  start: string,
  end: string,
  location: string | null,
  description: string,
): string {
  const lines = [title, localRange(start, end)];
  if (location) lines.push(location);
  if (description) lines.push("", description);
  return lines.join("\n");
}

/**
 * Calendar text, in the viewer's local time.
 *
 * Intl.DateTimeFormat only, like src/lib/format/date.ts — no date library. Day
 * boundaries are calendar days here too: an event that starts at 23:50 belongs
 * to today's group, not to "in 10 minutes".
 */

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const dayHeadingFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "short",
});
const shortDayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
});

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local midnight of the day `date` falls in. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayNumber(date: Date): number {
  return Math.floor(startOfDay(date).getTime() / 86_400_000);
}

/**
 * The grouping key: a local calendar day, not a UTC one. `2026-08-17` in the
 * viewer's own timezone, so two events an hour apart across midnight land in
 * different groups exactly where a person would put them.
 */
export function dayKey(iso: string): string {
  const date = parse(iso);
  if (!date) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "Today", "Tomorrow", or "Wednesday 19 Aug". */
export function formatDayHeading(iso: string, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return "";
  const days = dayNumber(date) - dayNumber(now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return dayHeadingFmt.format(date);
}

/** "Today", "Tomorrow", or "Tue 19" — the compact form, for chip rows. */
export function formatDayHeadingShort(
  iso: string,
  now: Date = new Date(),
): string {
  const date = parse(iso);
  if (!date) return "";
  const days = dayNumber(date) - dayNumber(now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return shortDayFmt.format(date);
}

/** "09:00", local. The one time a suggestion chip carries. */
export function formatTime(iso: string): string {
  const date = parse(iso);
  return date ? timeFmt.format(date) : "";
}

/** "09:00 – 09:30", or "All day". An unparsable pair prints nothing. */
export function formatEventTime(event: {
  start: string;
  end: string;
  allDay: boolean;
}): string {
  if (event.allDay) return "All day";
  const start = parse(event.start);
  const end = parse(event.end);
  if (!start) return "";
  if (!end) return timeFmt.format(start);
  return `${timeFmt.format(start)} – ${timeFmt.format(end)}`;
}

/** The one-line "17 Aug, 09:00 – 09:30" a meeting row carries. */
export function formatMeetingWhen(
  meeting: { start: string; end: string },
  now: Date = new Date(),
): string {
  const start = parse(meeting.start);
  if (!start) return "";
  return `${formatDayHeading(meeting.start, now)}, ${formatEventTime({
    ...meeting,
    allDay: false,
  })}`;
}

/**
 * A location that is a link, as a link. Conference details arrive in the
 * location field far more often than in a field of their own, and a bare
 * https:// string is a URL whichever field it came in.
 */
export function locationUrl(location: string | null | undefined): string | null {
  const text = (location ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

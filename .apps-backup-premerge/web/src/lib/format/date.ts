/**
 * Intl.DateTimeFormat only — no date library. Boundaries are calendar days in
 * the viewer's local time, not elapsed hours, so a message sent at 23:58 reads
 * "Yesterday" at 00:02 rather than "2m".
 */

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayMonthFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});
const shortDateFmt = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
});
const dayMonthYearFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const fullFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayNumber(date: Date): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() /
      86_400_000,
  );
}

type Age = "now" | "today" | "yesterday" | "week" | "year" | "older";

function ageOf(date: Date, now: Date): Age {
  const seconds = (now.getTime() - date.getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return "now";
  const days = dayNumber(now) - dayNumber(date);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (date.getFullYear() === now.getFullYear()) return "year";
  return "older";
}

/** The message-list column. Never longer than "12/03/24". */
export function formatListDate(iso: string, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return "";
  switch (ageOf(date, now)) {
    case "now":
      return "now";
    case "today":
      return timeFmt.format(date);
    case "yesterday":
      return "Yesterday";
    case "week":
      return weekdayFmt.format(date);
    case "year":
      return dayMonthFmt.format(date);
    default:
      return shortDateFmt.format(date);
  }
}

/** The reader's timestamp. Written out — never a micro-format. */
export function formatReaderDate(iso: string, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return "";
  const time = timeFmt.format(date);
  switch (ageOf(date, now)) {
    case "now":
      return `Just now · ${fullFmt.format(date)}`;
    case "today":
      return `Today at ${time}`;
    case "yesterday":
      return `Yesterday at ${time}`;
    case "week":
      return `${weekdayFmt.format(date)} ${time}`;
    case "year":
      return `${dayMonthFmt.format(date)} at ${time}`;
    default:
      return `${dayMonthYearFmt.format(date)} at ${time}`;
  }
}

/** The `title` on every <time>: the full localized value. */
export function isoTitle(iso: string): string {
  const date = parse(iso);
  return date ? fullFmt.format(date) : iso;
}

/** The `dateTime` attribute. Falls back to the raw string when unparsable. */
export function isoAttr(iso: string): string {
  const date = parse(iso);
  return date ? date.toISOString() : iso;
}

/** `From:`/`Date:` header line inside a forwarded body. */
export function forwardDate(iso: string): string {
  const date = parse(iso);
  return date ? fullFmt.format(date) : iso;
}

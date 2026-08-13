/**
 * Cron, in words.
 *
 * The stored expression is the truth and is always shown beside this sentence —
 * so anything this function does not recognise falls back to the raw text
 * rather than to a guess. A schedule the reader misreads is worse than one they
 * have to parse themselves.
 *
 * Times are printed as the literal fields, 24-hour, because that is what the
 * scheduler evaluates: cron-parser runs them in the SERVER's timezone, and
 * re-rendering "30 7" through the browser's locale would show a person in
 * another zone a time the automation will not fire at.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function isNumber(field: string): boolean {
  return /^\d{1,2}$/.test(field);
}

function at(minute: string, hour: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function describeCron(cron: string): string {
  const raw = cron.trim();
  const fields = raw.split(/\s+/);
  // Five fields is the contract the store enforces. Six (the seconds form) is
  // rejected server-side, so it is not a shape worth describing.
  if (fields.length !== 5) return raw;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const everyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*";

  const step = /^\*\/(\d{1,2})$/.exec(minute);
  if (step && hour === "*" && everyDay) {
    const n = Number(step[1]);
    if (n === 1) return "Every minute";
    return `Every ${n} minutes`;
  }

  if (minute === "*" && hour === "*" && everyDay) return "Every minute";

  if (isNumber(minute) && hour === "*" && everyDay) {
    return `Hourly, at :${minute.padStart(2, "0")}`;
  }

  if (isNumber(minute) && isNumber(hour)) {
    if (everyDay) return `Daily at ${at(minute, hour)}`;
    if (
      dayOfMonth === "*" &&
      month === "*" &&
      isNumber(dayOfWeek) &&
      Number(dayOfWeek) <= 7
    ) {
      // Both 0 and 7 are Sunday in cron.
      const day = WEEKDAYS[Number(dayOfWeek) % 7];
      return `Weekly on ${day} at ${at(minute, hour)}`;
    }
    if (isNumber(dayOfMonth) && month === "*" && dayOfWeek === "*") {
      return `Monthly on day ${Number(dayOfMonth)} at ${at(minute, hour)}`;
    }
  }

  return raw;
}

/** How a finished run reads in one word, and how it should be coloured. */
export function runStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "ok":
      return "Succeeded";
    case "error":
      return "Failed";
    case "killed":
      // The 15-minute hard timeout, not a person pressing stop.
      return "Timed out";
    default:
      return status;
  }
}

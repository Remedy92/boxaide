/**
 * Wall-clock arithmetic in an arbitrary IANA zone, built on Intl alone.
 *
 * Working hours are a wall clock ("09:00 to 17:00"), but every stored instant
 * is epoch ms. Converting between the two with local Date constructors ties
 * the answer to the server's zone, which is wrong the moment the user and the
 * server disagree — and wrong twice a year even when they agree, because a
 * DST day is 23 or 25 hours long and naive day stepping drifts across it.
 *
 * Everything here is pure and dependency-free: Intl.DateTimeFormat is the only
 * source of zone data, so no tzdata copy can go stale against Node's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wall clock in some zone. Month is 1-12, matching how humans write dates. */
export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** The fields a caller must supply to name a wall-clock moment. */
export type ZonedTimeInput = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
};

/**
 * Formatters are expensive to build and we build one per zone per call in the
 * hot paths (a slot search formats twice per candidate instant), so cache them.
 * The key set is bounded by the number of zones the user's accounts use.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      // h23 so midnight reads as hour 0, not 24 — h12/h24 both bite here.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, fmt);
  }
  return fmt;
}

/**
 * Returns the canonical zone id, falling back to the server's own zone when
 * none is given. Throws on an unknown id rather than silently falling back:
 * a typo'd zone would otherwise schedule meetings in the wrong hours forever.
 */
export function resolveTimeZone(zone?: string): string {
  const wanted = zone?.trim();
  if (!wanted) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    // Constructing is the only validation Intl offers; it also canonicalises
    // ("utc" -> "UTC"), which is what we want stored.
    return new Intl.DateTimeFormat("en-US", { timeZone: wanted }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`unknown time zone: ${wanted}`);
  }
}

/** The wall clock that zone shows at a UTC instant. */
export function zonedParts(instant: number, zone: string): ZonedParts {
  const parts = formatterFor(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`time zone ${zone} produced no ${type} part`);
    return Number(found.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** A wall clock treated as if it were UTC — the pivot both directions use. */
function wallClockAsUtc(parts: ZonedParts | ZonedTimeInput): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );
}

/**
 * The zone's UTC offset in ms at an instant, positive east of Greenwich.
 * Derived by diffing the wall clock against the instant; the instant is
 * floored to the second because the formatter drops sub-second precision.
 *
 * Exported because rounding to a wall-clock grid (the slot search snaps
 * candidate starts to the half hour) needs the shift between the two clocks,
 * not just a conversion: zones like Asia/Kathmandu (+05:45) sit off every
 * grid the epoch has.
 */
export function zoneOffsetMs(instant: number, zone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockAsUtc(zonedParts(whole, zone)) - whole;
}

/**
 * The instant at which `zone` starts showing `after` instead of `before`,
 * found by bisecting the ms range that brackets the jump. Only reached for
 * wall clocks inside a spring-forward gap, so the ~22 formatter calls are rare.
 */
function transitionInstant(lo: number, hi: number, after: number, zone: string): number {
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zoneOffsetMs(mid, zone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The UTC instant for a wall clock in `zone`.
 *
 * The naive "guess, measure the offset, correct once" loop settles on a fixed
 * point, but on a fall-back day it settles on the *second* of the two, and on
 * a spring-forward day it settles on a time the clock never showed. So instead
 * bracket the wall clock with the offsets a day either side of it — a day is
 * wider than any real transition — and test both candidates against the
 * fixed-point condition `zoneOffsetMs(candidate) === wall - candidate`:
 *
 *  - one valid candidate: the ordinary case.
 *  - two valid: an ambiguous wall clock (fall back). Take the earlier instant,
 *    i.e. the offset still in force before the change.
 *  - none valid: a nonexistent wall clock (spring forward). Resolve forward to
 *    the first instant the clock is legal again — the transition itself, so
 *    "02:30" on a 02:00->03:00 day becomes 03:00, not 03:30.
 */
export function zonedTimeToUtc(parts: ZonedTimeInput, zone: string): number {
  const wall = wallClockAsUtc(parts);
  const before = zoneOffsetMs(wall - DAY_MS, zone);
  const after = zoneOffsetMs(wall + DAY_MS, zone);

  const candidates = before === after ? [wall - before] : [wall - before, wall - after];
  const valid = candidates.filter((c) => zoneOffsetMs(c, zone) === wall - c);
  if (valid.length > 0) return Math.min(...valid);

  // Gaps only exist where the offset jumps forward, so `after` is the larger
  // offset and `wall - after` sits before the jump.
  return transitionInstant(wall - after, wall - before, after, zone);
}

/**
 * Midnight of the zoned day containing `instant`. In zones that skip midnight
 * (Santiago, Havana) this lands on the first legal instant of that day, which
 * is what a day boundary means there.
 */
export function startOfZonedDay(instant: number, zone: string): number {
  const p = zonedParts(instant, zone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, zone);
}

/**
 * Midnight of the next zoned day. Callers walk days with this rather than
 * adding 24h: on a DST day 24h either overshoots into the next day or lands
 * back in the same one, and the error compounds over a range.
 */
export function startOfNextZonedDay(instant: number, zone: string): number {
  const p = zonedParts(instant, zone);
  // Date.UTC normalises the overflow (31st + 1 -> next month) for us.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    zone,
  );
}

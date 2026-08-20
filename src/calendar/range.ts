/**
 * The one start/end parser both entry points use: the REST read routes and the
 * MCP tool dispatcher.
 *
 * It lives alone because the two used to have a copy each, and the copies
 * drifted — different caps, and the tool path skipped the cap entirely when an
 * explicit `end` was passed, so agenda_view could fan every connected provider
 * out over ten years. One function, one cap, one set of messages.
 *
 * The cap is not politeness: every day in the window fans out to every
 * connected provider, and the slot search walks day by day to the end of the
 * range even when it finds nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_AGENDA_DAYS = 62;

export type AgendaRange = { start: string; end: string };

export type AgendaRangeInput = {
  start?: string;
  end?: string;
  /** Length of the range when `end` is omitted; clamped to the cap. */
  days?: number;
};

/**
 * Returns the range or a message — never throws, so the REST routes can answer
 * 400 with it and the tool dispatcher can throw it.
 */
export function parseAgendaRange(
  input: AgendaRangeInput,
): AgendaRange | { error: string } {
  const start = input.start ? new Date(input.start) : new Date();
  if (Number.isNaN(start.getTime())) return { error: "start must be an ISO instant" };

  let end: Date;
  if (input.end) {
    end = new Date(input.end);
    if (Number.isNaN(end.getTime())) return { error: "end must be an ISO instant" };
  } else {
    const days = Math.min(Math.max(input.days ?? 7, 1), MAX_AGENDA_DAYS);
    end = new Date(start.getTime() + days * DAY_MS);
  }

  if (end.getTime() <= start.getTime()) return { error: "end must be after start" };
  if (end.getTime() - start.getTime() > MAX_AGENDA_DAYS * DAY_MS) {
    return { error: `range must be ${MAX_AGENDA_DAYS} days or less` };
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Same rules, thrown — the shape MCP tool handlers report errors in. */
export function agendaRangeOrThrow(input: AgendaRangeInput): AgendaRange {
  const range = parseAgendaRange(input);
  if ("error" in range) throw new Error(range.error);
  return range;
}

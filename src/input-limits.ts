/** Shared ceilings for list operations exposed over REST and MCP. */
export const MAX_LIST_LIMIT = 200;

/**
 * Parse an integer list limit without allowing NaN, Infinity, fractions, or
 * values large enough to turn a bounded provider query into a memory spike.
 */
export function parseListLimit(
  value: unknown,
  defaultValue: number,
): number | null {
  if (value === undefined || value === null || value === "") return defaultValue;
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(number) || number < 1 || number > MAX_LIST_LIMIT) {
    return null;
  }
  return number;
}

export function requireListLimit(value: unknown, defaultValue: number): number {
  const limit = parseListLimit(value, defaultValue);
  if (limit === null) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

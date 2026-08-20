/**
 * What a pasted API key is, once the paste has been cleaned up.
 *
 * People do not copy keys out of a vendor's dashboard and nothing else. They
 * copy the line around it: a `.env` assignment, a quoted string out of a JSON
 * config, an `Authorization: Bearer …` header out of a curl example, a trailing
 * newline out of a terminal. Every one of those saves happily — the server
 * stores whatever string it is handed — and then the provider refuses it, and
 * the operator is left reading "the provider refused this key" about a key that
 * is perfectly correct with four characters of packaging around it.
 *
 * So the packaging comes off here, before the key ever leaves the browser.
 *
 * The rule is narrow on purpose: strip only wrappers that cannot be part of a
 * key, and never guess at a key's shape. Vendors change their key formats
 * without telling anybody, and a regex that "knows" what an Exa key looks like
 * would one day refuse a real key and send an operator back to a vendor for a
 * replacement they did not need. The provider is the only authority on whether
 * a key is good, and Boxaide already asks it.
 *
 * Pure, and tested in test/connector-key.test.ts.
 */

/** Quote characters a key can be wrapped in when copied out of a config file. */
const QUOTES = ["\"", "'", "`"];

/** Prefixes a key can be copied with, lower-cased for comparison. */
const PREFIXES = ["bearer ", "authorization: bearer ", "authorization: ", "x-api-key: "];

export type CleanedKey = {
  /** The key with the packaging removed. Possibly empty. */
  key: string;
  /**
   * What was removed, in words, or null when the paste was already clean.
   * Shown to the operator so a silent edit of their secret is never silent.
   */
  removed: string | null;
  /**
   * Why this still cannot be saved, or null when it can. Only the two cases
   * that are certainly not a key: nothing at all, and more than one value.
   */
  problem: string | null;
};

/**
 * Strip the packaging off a pasted key and say what came off.
 *
 * Runs until nothing more comes off, because the real pastes stack: an env line
 * whose value is quoted, a quoted value that is a Bearer header.
 */
export function cleanPastedKey(raw: string): CleanedKey {
  let key = raw.trim();
  const removed: string[] = [];

  for (let pass = 0; pass < 4; pass += 1) {
    const before = key;

    const assignment = stripAssignment(key);
    if (assignment !== key) {
      key = assignment;
      if (!removed.includes("the variable name")) removed.push("the variable name");
    }

    const unquoted = stripQuotes(key);
    if (unquoted !== key) {
      key = unquoted;
      if (!removed.includes("the quotes")) removed.push("the quotes");
    }

    const unprefixed = stripPrefix(key);
    if (unprefixed !== key) {
      key = unprefixed;
      if (!removed.includes("the header name")) removed.push("the header name");
    }

    key = key.trim();
    if (key === before) break;
  }

  return { key, removed: describe(removed), problem: problemWith(key) };
}

/**
 * `BOXAIDE_EXA_API_KEY=abc` and `EXA_API_KEY: abc` become `abc`.
 *
 * Only an all-caps, underscore-separated name counts, which is what an env
 * variable is and what a key is not. A key that happens to contain `=` — some
 * base64 keys end in one — keeps it, because the part before the `=` has to
 * look like a variable name for anything to be stripped at all.
 */
function stripAssignment(value: string): string {
  const match = /^(?:export\s+)?[A-Z][A-Z0-9_]*\s*[=:]\s*(.+)$/.exec(value);
  return match ? match[1].trim() : value;
}

/** One matched pair of wrapping quotes. Unbalanced quotes are left alone. */
function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if (!QUOTES.includes(first)) return value;
  return value.endsWith(first) ? value.slice(1, -1) : value;
}

/** `Bearer abc` and `Authorization: Bearer abc` become `abc`. */
function stripPrefix(value: string): string {
  const lower = value.toLowerCase();
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  return value;
}

/** "the quotes and the header name", or null when nothing came off. */
function describe(removed: string[]): string | null {
  if (removed.length === 0) return null;
  if (removed.length === 1) return removed[0];
  return `${removed.slice(0, -1).join(", ")} and ${removed[removed.length - 1]}`;
}

/**
 * The two pastes that are certainly not one key.
 *
 * Everything else is handed to the provider, which is the only thing that
 * actually knows. A short string, an odd character set, an unfamiliar prefix:
 * all of those are somebody's real key at some vendor.
 */
function problemWith(key: string): string | null {
  if (key === "") return "That paste had no key in it.";
  if (/\s/.test(key)) {
    return "That paste has a space in it, so it is more than just the key. Copy the key on its own.";
  }
  return null;
}

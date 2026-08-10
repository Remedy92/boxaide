/**
 * The backend hands addresses over as one preformatted RFC-5322 string —
 * `Jane Doe <jane@x.com>`, or several of those comma-joined, or `""`. Nothing
 * here fetches and nothing here renders HTML.
 */

export type ParsedAddress = {
  /** Display name with quotes stripped. `""` when the header carried none. */
  name: string;
  /** Bare address. `""` when the string was not an address at all. */
  address: string;
};

/** Split a comma-joined list without breaking quoted names or angle brackets. */
export function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Parse one address. Never throws; an unparsable string yields two empties. */
export function parseAddress(raw: string): ParsedAddress {
  const value = (raw ?? "").trim();
  if (!value) return { name: "", address: "" };

  const angled = /^(.*?)<([^>]*)>\s*$/.exec(value);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
    return { name, address: angled[2].trim() };
  }
  if (value.includes("@")) return { name: "", address: value };
  return { name: value.replace(/^"(.*)"$/, "$1").trim(), address: "" };
}

/** Parse a comma-joined list. `""` yields `[]`. */
export function parseAddressList(raw: string): ParsedAddress[] {
  return splitAddressList(raw ?? "").map(parseAddress);
}

/** Every bare address in a list, lowercased, in order. */
export function addressesOf(raw: string | undefined): string[] {
  if (!raw) return [];
  return parseAddressList(raw)
    .map((entry) => entry.address.toLowerCase())
    .filter((address) => address.length > 0);
}

/**
 * What a human reads in the sender slot. Never the raw angle-bracket form.
 * `from` can genuinely be `""` — the backend's addr() returns a string.
 */
export function displayName(raw: string): string {
  const { name, address } = parseAddress(raw);
  if (name) return name;
  if (address) return address;
  return "Unknown sender";
}

/**
 * Initials for a monogram. First letters of the first two tokens of the name;
 * failing that the first two characters of the address's local part; failing
 * that `?`.
 */
export function initials(raw: string): string {
  const { name, address } = parseAddress(raw);
  if (name) {
    const tokens = name.split(/\s+/).filter(Boolean).slice(0, 2);
    const letters = tokens
      .map((token) => token[0])
      .join("")
      .replace(/[^\p{L}\p{N}]/gu, "");
    if (letters) return letters.toUpperCase();
  }
  if (address) {
    const local = address.split("@")[0] ?? "";
    const letters = local.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2);
    if (letters) return letters.toUpperCase();
  }
  return "?";
}

/**
 * The first thing wrong with a message about to be sent, or null.
 *
 * The bundled UI got this from `required` + `reportValidity()` on a real form
 * (web/index.html). The Next composer is not a form, so the same three checks
 * live here — without them an empty To reaches POST /api/messages/send and
 * comes back as a nodemailer 400 in the error strip.
 */
export type DraftField = "to" | "subject" | "text";

export function validateDraft(draft: {
  to: string;
  subject: string;
  text: string;
}): { field: DraftField; message: string } | null {
  if (splitAddressList(draft.to).length === 0) {
    return { field: "to", message: "Add at least one recipient." };
  }
  if (!draft.subject.trim()) {
    return { field: "subject", message: "Add a subject." };
  }
  if (!draft.text.trim()) {
    return { field: "text", message: "Write a message before sending." };
  }
  return null;
}

/**
 * De-duplicate a list of raw address strings case-insensitively by address.
 *
 * `exclude` entries go through the same parse as the input, so excluding
 * `"Jane Doe <jane@x.com>"` really does drop `"jane@x.com"` — reply-all builds
 * its Cc by excluding the To list it just built, and comparing raw strings
 * there would silently duplicate every recipient.
 */
export function dedupeAddresses(
  entries: readonly string[],
  exclude: readonly string[] = [],
): string[] {
  const skip = new Set<string>();
  for (const entry of exclude) {
    for (const one of splitAddressList(entry)) {
      const { address } = parseAddress(one);
      skip.add((address || one).toLowerCase());
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    for (const one of splitAddressList(entry)) {
      const { address } = parseAddress(one);
      const key = (address || one).toLowerCase();
      if (!key || skip.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(one);
    }
  }
  return out;
}

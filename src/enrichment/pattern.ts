/**
 * Address patterns learned from the addresses Boxaide already holds.
 *
 * This is the one way to reach a work address that costs nothing and asks
 * nobody. A company writes every mailbox the same way, so three known people
 * at acme.com are usually enough to say how the fourth one is written. The
 * addresses come from the CRM, which means from mail the operator already
 * received or a list they already imported: no vendor, no credit, no scrape.
 *
 * Two rules keep this honest, and both are the whole reason the module is
 * shaped this way rather than as one clever regex.
 *
 * A pattern is evidence, not an answer. What comes out is a candidate address
 * with the number of known people it was derived from, and it says out loud
 * that nobody has checked it. One matching example is a coincidence as often
 * as it is a rule, and a candidate built from one is labelled as such rather
 * than quietly presented like a candidate built from nine.
 *
 * An address that is already held beats any guess. If the person asked about
 * is in the CRM, their real address is returned and nothing is inferred: a
 * guess that happens to be wrong about somebody we could have looked up is
 * the worst outcome available here.
 */

/** One way a company writes a mailbox, and how to write it for a name. */
export type AddressPattern = {
  /** Stable id, shown to the agent and to the operator, e.g. "first.last". */
  id: string;
  /** Builds the local part, or null when the name lacks a part it needs. */
  build(first: string, last: string): string | null;
};

/**
 * The patterns worth testing, most specific first. A name-shaped local part
 * almost always falls in here; anything that does not is reported as no
 * pattern found rather than forced into the nearest one.
 */
export const ADDRESS_PATTERNS: readonly AddressPattern[] = [
  { id: "first.last", build: (f, l) => (f && l ? `${f}.${l}` : null) },
  { id: "first_last", build: (f, l) => (f && l ? `${f}_${l}` : null) },
  { id: "firstlast", build: (f, l) => (f && l ? `${f}${l}` : null) },
  { id: "first-last", build: (f, l) => (f && l ? `${f}-${l}` : null) },
  { id: "f.last", build: (f, l) => (f && l ? `${f[0]}.${l}` : null) },
  { id: "flast", build: (f, l) => (f && l ? `${f[0]}${l}` : null) },
  { id: "first.l", build: (f, l) => (f && l ? `${f}.${l[0]}` : null) },
  { id: "firstl", build: (f, l) => (f && l ? `${f}${l[0]}` : null) },
  { id: "last.first", build: (f, l) => (f && l ? `${l}.${f}` : null) },
  { id: "lastf", build: (f, l) => (f && l ? `${l}${f[0]}` : null) },
  { id: "first", build: (f) => f || null },
  { id: "last", build: (_f, l) => l || null },
];

/** One address already held at the domain, with the name it belongs to. */
export type KnownAddress = { email: string; name?: string | null };

/** How well one pattern explains the addresses already held. */
export type PatternTally = {
  id: string;
  /** Known people whose address this pattern reproduces exactly. */
  matches: number;
  /** One address it explains, so a human can see why it was chosen. */
  example: string;
};

export type PatternResult = {
  domain: string;
  /** Addresses held at this domain, whether or not they carry a name. */
  addressesKnown: number;
  /** Of those, the ones with a name, which are the only ones that teach anything. */
  namedKnown: number;
  /** Every pattern that explains at least one of them, best first. */
  patterns: PatternTally[];
  /**
   * The address to try for the name that was asked about, or null when there
   * was no name to build one for, or nothing to learn a pattern from.
   *
   * Never presented as found. `verified` is always false here: this module
   * has checked nothing and cannot, and the field exists so a caller that
   * forgets to verify is at least holding a value that says so.
   */
  candidate: {
    email: string;
    pattern: string;
    /** Known people that pattern reproduced. One is weak evidence. */
    derivedFrom: number;
    verified: false;
  } | null;
  /**
   * Set when the person asked about is already in the CRM at this domain.
   * A real address, not a guess, and it makes the candidate unnecessary.
   */
  existing: { email: string; name: string | null } | null;
  notes: string[];
};

/**
 * Learn the pattern, and apply it to one name when a name was given.
 *
 * `known` is every address held at the domain. Nothing here reaches the
 * network, so this is cheap enough to call before any paid lookup, which is
 * exactly what the tool description tells an agent to do.
 */
export function inferAddressPattern(
  domain: string,
  known: KnownAddress[],
  fullName?: string,
): PatternResult {
  const bare = domain.trim().toLowerCase();
  const wanted = splitName(fullName);
  const notes: string[] = [];

  const rows = known
    .map((entry) => ({ email: entry.email.trim().toLowerCase(), name: entry.name ?? null }))
    .filter((entry) => entry.email.endsWith(`@${bare}`));
  const named = rows.filter((entry) => splitName(entry.name ?? undefined) !== null);

  // Somebody we already hold is not a guessing problem. This runs before the
  // tally so a hit short-circuits the whole exercise.
  const existing = wanted
    ? rows.find((entry) => {
        const parts = splitName(entry.name ?? undefined);
        return parts !== null && parts.first === wanted.first && parts.last === wanted.last;
      })
    : undefined;

  const tally = tallyPatterns(named, bare);
  if (rows.length === 0) {
    notes.push(
      `No addresses at ${bare} are held yet, so there is no pattern to learn. Import a list with crm_contacts_import, or use enrich_find_email if a provider key is set.`,
    );
  } else if (named.length === 0) {
    notes.push(
      `${rows.length} address(es) at ${bare} are held, but none carries a name, so none of them says how a name becomes an address.`,
    );
  } else if (tally.length === 0) {
    notes.push(
      `None of the ${named.length} named address(es) at ${bare} is built from the person's name, so this domain does not write mailboxes in a way that can be guessed. Do not invent one.`,
    );
  }

  if (existing) {
    notes.push(
      `${existing.name ?? fullName} is already in the CRM at ${bare}, so the real address is returned and nothing was inferred. Do not queue a guess over an address you hold.`,
    );
    return {
      domain: bare,
      addressesKnown: rows.length,
      namedKnown: named.length,
      patterns: tally,
      candidate: null,
      existing: { email: existing.email, name: existing.name },
      notes,
    };
  }

  const candidate = buildCandidate(tally, wanted, bare);
  if (candidate) {
    notes.push(
      `${candidate.email} is a guess built from the '${candidate.pattern}' pattern, which ${candidate.derivedFrom} known address(es) at ${bare} follow. Nobody has checked that this mailbox exists. Verify it with enrich_verify_email before you queue anything to it, and never report it as the person's address until you have.`,
    );
    if (candidate.derivedFrom < 2) {
      notes.push(
        "One example is as easily a coincidence as a rule, so treat this candidate as the weakest kind of lead: worth verifying, not worth writing to unverified.",
      );
    }
    if (tally.length > 1 && tally[1].matches === tally[0].matches) {
      notes.push(
        `The evidence is split: '${tally[0].id}' and '${tally[1].id}' explain the same number of known addresses. One of them is wrong for this person and there is no way to tell which from here.`,
      );
    }
  } else if (!wanted && tally.length > 0) {
    notes.push(
      "No fullName was given, so a pattern was reported and no address was built.",
    );
  }

  return {
    domain: bare,
    addressesKnown: rows.length,
    namedKnown: named.length,
    patterns: tally,
    candidate,
    existing: null,
    notes,
  };
}

/** Every pattern that explains at least one known address, best first. */
function tallyPatterns(
  named: { email: string; name: string | null }[],
  domain: string,
): PatternTally[] {
  const counts = new Map<string, { matches: number; example: string }>();
  for (const row of named) {
    const parts = splitName(row.name ?? undefined);
    if (!parts) continue;
    const local = row.email.slice(0, row.email.length - domain.length - 1);
    for (const pattern of ADDRESS_PATTERNS) {
      if (pattern.build(parts.first, parts.last) !== local) continue;
      const held = counts.get(pattern.id);
      if (held) held.matches += 1;
      else counts.set(pattern.id, { matches: 1, example: row.email });
    }
  }
  return [...counts.entries()]
    .map(([id, entry]) => ({ id, matches: entry.matches, example: entry.example }))
    // Ties are broken by the order in ADDRESS_PATTERNS, which is most specific
    // first, so a domain with one example does not get 'first' over
    // 'first.last' on an alphabetical accident.
    .sort((a, b) => b.matches - a.matches || patternRank(a.id) - patternRank(b.id));
}

function buildCandidate(
  tally: PatternTally[],
  wanted: { first: string; last: string } | null,
  domain: string,
): PatternResult["candidate"] {
  if (!wanted || tally.length === 0) return null;
  for (const entry of tally) {
    const pattern = ADDRESS_PATTERNS.find((p) => p.id === entry.id);
    const local = pattern?.build(wanted.first, wanted.last);
    if (local) {
      return {
        email: `${local}@${domain}`,
        pattern: entry.id,
        derivedFrom: entry.matches,
        verified: false,
      };
    }
  }
  return null;
}

function patternRank(id: string): number {
  const at = ADDRESS_PATTERNS.findIndex((p) => p.id === id);
  return at === -1 ? ADDRESS_PATTERNS.length : at;
}

/**
 * A name split into the two parts a pattern needs, or null.
 *
 * Accents are folded and everything that is not a letter or a digit is
 * dropped, because that is what a mail system does to a name: "Renée
 * O'Brien" is reneeobrien, not renée o'brien. A middle name is dropped and
 * the last word wins, which is how these mailboxes are actually written.
 */
export function splitName(fullName: string | undefined): { first: string; last: string } | null {
  if (!fullName) return null;
  const words = fullName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter((word) => word !== "");
  if (words.length < 2) return null;
  return { first: words[0], last: words[words.length - 1] };
}

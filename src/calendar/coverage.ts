/**
 * Does the Mac already hold this account's calendar?
 *
 * The agenda concatenates every connected account without matching events
 * across them (CalendarService.agenda), so an account reachable twice — once
 * through the Mac and once as its own CalDAV or Google connection — puts every
 * meeting on screen twice. Matching the events themselves is the other way to
 * fix that, and it was rejected: EventKit's cross-account identifier is
 * documented as neither guaranteed unique nor always present, and an edited
 * occurrence of a repeating meeting carries its own identity, so a matcher
 * would sometimes hide a real meeting. Warning before the second connection is
 * the cheaper and more honest half.
 *
 * Everything here is a WARNING signal, never a fact. macOS names an account
 * with whatever the user typed, so "work" may well be the Google account we are
 * about to connect and nothing in EventKit says so. Callers therefore ask the
 * person to confirm rather than refusing outright, and an empty source list
 * means "nothing known", not "no overlap".
 */
import type { LocalSource } from "./local.js";

/** Domains that give an account's provider away. */
const ICLOUD_DOMAINS = ["icloud.com", "me.com", "mac.com"];
const GOOGLE_DOMAINS = ["gmail.com", "googlemail.com"];
const FASTMAIL_DOMAINS = ["fastmail.com", "fastmail.fm", "sent.com", "messagingengine.com"];

/** The provider families the Mac can be holding a copy of. */
type Family = "icloud" | "google" | "fastmail" | null;

function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Which family an account we are about to connect belongs to, from whatever the
 * caller holds: a Google account is named outright, a CalDAV one is given away
 * by its server, and an address is the last resort.
 */
function familyOf(target: { email?: string; serverUrl?: string; provider?: string }): Family {
  if (target.provider === "google") return "google";
  const host = hostOf(target.serverUrl ?? "");
  if (host.includes("icloud")) return "icloud";
  if (host.includes("fastmail") || host.includes("messagingengine")) return "fastmail";
  const domain = domainOf(target.email ?? "");
  if (ICLOUD_DOMAINS.includes(domain)) return "icloud";
  if (GOOGLE_DOMAINS.includes(domain)) return "google";
  if (FASTMAIL_DOMAINS.includes(domain)) return "fastmail";
  return null;
}

/** Which family one of the Mac's accounts looks like, by type then by name. */
function familyOfSource(source: LocalSource): Family {
  if (source.type === "icloud") return "icloud";
  const title = source.title.toLowerCase();
  if (title.includes("icloud")) return "icloud";
  if (title.includes("google") || title.includes("gmail")) return "google";
  if (title.includes("fastmail")) return "fastmail";
  return null;
}

/**
 * Thrown by a connect path that would create a duplicate. Separate from a plain
 * Error so the route can answer 409 with `needsConfirm`, which is the whole
 * mechanism: the same request repeated with the confirmation goes through.
 */
export class OverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlapError";
  }
}

export type Overlap = {
  /** The name macOS shows for the account that looks like a duplicate. */
  source: string;
  /** True when the Mac names this exact address, not merely the same provider. */
  exact: boolean;
};

/**
 * The Mac account that looks like the one about to be connected, or null.
 *
 * Two strengths, and the caller says which it found so the sentence can be
 * honest about it:
 *   exact  — a source is literally named for this address
 *   family — a source is the same provider, which is usually but not always
 *            the same account
 */
export function findOverlap(
  sources: readonly LocalSource[],
  target: { email?: string; serverUrl?: string; provider?: string },
): Overlap | null {
  const email = (target.email ?? "").trim().toLowerCase();
  if (email) {
    const named = sources.find((s) => s.title.trim().toLowerCase() === email);
    if (named) return { source: named.title, exact: true };
  }
  const family = familyOf(target);
  if (!family) return null;
  // A subscribed read-only feed is not the account: it holds someone else's
  // published calendar, so connecting the account itself is not a duplicate.
  const sameFamily = sources.find(
    (s) => s.type !== "subscribed" && familyOfSource(s) === family,
  );
  return sameFamily ? { source: sameFamily.title, exact: false } : null;
}

/**
 * The sentence shown when someone is about to create the duplicate. It names
 * what overlaps, says what will happen, and states the way out — because the
 * one thing a person cannot deduce is that the events would simply appear
 * twice rather than something breaking.
 */
export function overlapSentence(overlap: Overlap, what: string): string {
  const which = overlap.exact
    ? `This Mac already has ${overlap.source}`
    : `This Mac already has a ${overlap.source} account, which may be the same one`;
  return (
    `${which}. Connecting ${what} as well would show those events twice in your ` +
    "agenda. Add it anyway only if this is a different account."
  );
}

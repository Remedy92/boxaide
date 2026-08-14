/**
 * The single home of opt-out: the invited keyword, the footer built from it,
 * the intent detector, and the canonical email form suppression keys on.
 *
 * Everything here is pure and dependency-free so both sides of the contract
 * can import it without cycles: the CRM sync flags inbound mail with
 * optOutIntent, the outreach engine and footer read the same constants, and
 * the send guard and suppression store share canonicalEmail. A reworded
 * footer that no longer matches the detector cannot happen silently — a test
 * asserts optOutIntent accepts the exact reply OPT_OUT_FOOTER invites.
 */

/** The reply the footer asks for. Change it here and nowhere else. */
export const OPT_OUT_KEYWORD = "stop";

/**
 * Appended to every queued outreach body, step 0 included. Plain text, no
 * link — a tracking or one-click URL would leak that the mail was opened,
 * which this product does not do.
 */
export const OPT_OUT_FOOTER = `\n\n--\nIf you'd rather not hear from me, just reply with "${OPT_OUT_KEYWORD}".`;

/** Explicit opt-out phrases, valid anywhere in subject or body. */
const PHRASE_RE = /\b(?:unsubscribe|opt.?out|stop (?:emailing|mailing|contacting))\b/i;

/**
 * Reply-chain prefixes mail clients prepend to subjects. Stripped before the
 * bare-keyword checks so "Re: stop" reads as "stop". Covers the common
 * localized forms (Aw: German, Sv: Swedish/Danish, Antw: Dutch).
 */
const REPLY_PREFIX_RE = /^\s*(?:(?:re|fwd?|aw|sv|antw)\s*:\s*)+/i;

/**
 * A body that OPENS with the invited keyword. "stop", "Stop.", "please stop",
 * and "stop\n\nOn Thu … wrote:" all opt out; the keyword buried mid-prose
 * does not. Residual false positive — a reply that begins "Stop by anytime"
 * — is accepted: wrongly suppressing one interested prospect costs a thread,
 * mailing someone who said stop costs trust and compliance. Callers narrow
 * the blast radius by only acting on contacts outreach actually touched.
 */
const BODY_START_RE = new RegExp(
  String.raw`^\s*(?:please\s+)?${OPT_OUT_KEYWORD}\b`,
  "i",
);

/**
 * A subject that IS the keyword and nothing else (after reply prefixes).
 * Subjects get the strict whole-match, not the start-anchor: "Stop by our
 * booth at SaaStr" is a normal mail, "Re: stop" is an opt-out.
 */
const SUBJECT_WHOLE_RE = new RegExp(
  String.raw`^\s*(?:please\s+)?${OPT_OUT_KEYWORD}\s*[.!,]*\s*$`,
  "i",
);

/**
 * Does this text ask us to stop?
 *
 * `kind` picks the bare-keyword rule: "body" matches the keyword at the
 * start of the text, "subject" only when the whole subject is the keyword.
 * The explicit phrases match anywhere in either. Never call this on a
 * string that concatenates fields — a phrase fabricated across a field
 * boundary must not suppress anyone.
 */
export function optOutIntent(
  text: string,
  kind: "subject" | "body",
): boolean {
  if (!text) return false;
  if (PHRASE_RE.test(text)) return true;
  const bare = text.replace(REPLY_PREFIX_RE, "");
  return kind === "body" ? BODY_START_RE.test(bare) : SUBJECT_WHOLE_RE.test(bare);
}

/**
 * The canonical form all suppression keys and guard lookups use.
 *
 * trim + lowercase + punycoded domain, because nodemailer punycodes IDN
 * domains before delivery — "user@münchen.de" and "user@xn--mnchen-3ya.de"
 * are one mailbox and must be one suppression key. The URL parser is the
 * punycoder; a domain it cannot parse falls back to the lowercased original
 * rather than throwing on the send path.
 */
export function canonicalEmail(raw: string): string {
  const addr = raw.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at === -1 || at === addr.length - 1) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  try {
    return `${local}@${new URL(`http://${domain}/`).hostname}`;
  } catch {
    return addr;
  }
}

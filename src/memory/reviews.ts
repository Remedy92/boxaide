/**
 * Which workspace notes a person has actually looked at.
 *
 * The notes are the agent's own (src/memory/store.ts), and their material
 * comes from read mail: a stranger who lands a line in one has written into
 * every prompt that follows. Quoting the content answers what the model is
 * told the text is; it cannot answer what the text is doing there. This
 * module answers that instead, and it is the layer that does not depend on
 * the model obeying anything: a note reaches an unattended automation run
 * only after a human has seen the exact bytes it holds.
 *
 * Review is recorded as a hash of the reviewed content, not a flag. A flag
 * would survive the agent rewriting the file underneath it, which is the one
 * event that must un-review a note. Same-bytes-as-approved is the whole
 * predicate.
 *
 * The record lives in the data directory, beside `boxaide.db` — deliberately
 * NOT with the notes. An agent owns its own subtree and can rewrite anything
 * in it, so a review kept there would be a permission the reviewed party
 * hands itself. The data directory is the one place `src/agent/sandbox.ts`
 * denies every launch.
 *
 * Anything unreadable, corrupt or unrecognised counts as reviewed by nobody.
 * The failure direction matters: a run that loses its notes does its task
 * without them, and a run that gains unreviewed ones is the thing this exists
 * to prevent.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where the record sits. One file per install, owner-only. */
export function reviewsPath(dataDir: string): string {
  return join(dataDir, "memory-reviews.json");
}

/** The bytes a person approved, named so two identical notes agree. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** name -> hash of the content that was reviewed. */
type Reviews = Record<string, string>;

function readReviews(dataDir: string): Reviews {
  let raw: string;
  try {
    raw = readFileSync(reviewsPath(dataDir), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Reviews = {};
    for (const [name, hash] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof hash === "string") out[name] = hash;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * True when this exact text is what somebody reviewed. Rewritten content
 * answers false, which is the point: an edit the agent made after the review
 * has not been seen by anyone.
 */
export function isReviewed(
  dataDir: string,
  name: string,
  content: string,
): boolean {
  return readReviews(dataDir)[name] === contentHash(content);
}

/**
 * Record that a person has seen this text. Called when they save an edit —
 * saving is reviewing — and when they say a note the agent wrote reads right.
 */
export function markReviewed(
  dataDir: string,
  name: string,
  content: string,
): void {
  const reviews = readReviews(dataDir);
  reviews[name] = contentHash(content);
  writeFileSync(reviewsPath(dataDir), `${JSON.stringify(reviews, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Drop a note's review, for a note that no longer exists. */
export function forgetReview(dataDir: string, name: string): void {
  const reviews = readReviews(dataDir);
  if (!(name in reviews)) return;
  delete reviews[name];
  writeFileSync(reviewsPath(dataDir), `${JSON.stringify(reviews, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

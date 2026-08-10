/**
 * The account rail hue. Deterministic, dependency-free, identical in the rail,
 * the list and the reader because every caller resolves against the same
 * account set.
 */

export const ACCOUNT_HUE_COUNT = 8;

/**
 * FNV-1a 32-bit. Deterministic, dependency-free, well distributed over the
 * short lowercase strings we feed it. Seeds are lowercased and trimmed so that
 * "Jane@X.com" and "jane@x.com " agree.
 */
export function hueIndex(seed: string): number {
  const s = seed.trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % ACCOUNT_HUE_COUNT;
}

/**
 * Hue per account id, hashed then linear-probed so no two mailboxes share a
 * colour while there are free buckets.
 *
 * Hashing each id independently is not enough. The rail is the one element
 * that says which mailbox a row belongs to, and ids are server-generated, so a
 * collision is invisible until a user sees two mailboxes painted the same —
 * which is exactly what the fixture pair does: `0fc5d6782b1b9d75` and
 * `1fc67cd736f7bfbd` both hash to bucket 0.
 *
 * Ids are sorted first so the assignment depends on the *set*, not on the
 * order the API happened to return.
 */
export function assignAccountHues(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of [...ids].sort()) {
    if (out.has(id)) continue;
    const start = hueIndex(id);
    let bucket = start;
    // Past ACCOUNT_HUE_COUNT mailboxes every bucket is taken; reuse the hash.
    for (let step = 0; step < ACCOUNT_HUE_COUNT; step++) {
      const candidate = (start + step) % ACCOUNT_HUE_COUNT;
      if (!taken.has(candidate)) {
        bucket = candidate;
        break;
      }
    }
    taken.add(bucket);
    out.set(id, bucket);
  }
  return out;
}

/** The CSS variable for a resolved bucket. Both themes define --acct-0 … 7. */
export function hueVar(bucket: number): string {
  return `var(--acct-${bucket})`;
}

/**
 * Fallback for a seed that is not a known account id — a sender address in the
 * reader, or an account whose row rendered before the accounts query resolved.
 */
export function accountHueVar(seed: string): string {
  return hueVar(hueIndex(seed));
}

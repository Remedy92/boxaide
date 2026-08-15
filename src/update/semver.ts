/**
 * The version comparison the updater turns on.
 *
 * Written here rather than pulled in: the only question this app asks is
 * "is the published release newer than the one running", and getting that
 * wrong in either direction is the whole failure mode. A false "newer" nags
 * forever; a false "same" never offers the update at all.
 *
 * Semver 2.0.0 precedence, with the two liberties a release tag needs: a
 * leading `v` is accepted, and build metadata (`+sha`) is ignored, as the
 * spec requires.
 */

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers. Empty for a release version. */
  pre: readonly string[];
};

const PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version, or null when the string is not one. */
export function parseVersion(raw: string | null | undefined): Semver | null {
  if (typeof raw !== "string") return null;
  const match = PATTERN.exec(raw.trim());
  if (!match) return null;
  const pre = match[4] ? match[4].split(".") : [];
  // "1.0.0-" and "1.0.0-a..b" parse into empty identifiers, which have no
  // defined precedence. Treat them as unparseable rather than guessing.
  if (pre.some((id) => id.length === 0)) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
  };
}

const NUMERIC = /^\d+$/;

/** -1, 0 or 1, by semver precedence. */
export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A prerelease is always lower than the release it leads to: 1.0.0-rc.1
  // comes before 1.0.0. An empty prerelease list is therefore the higher side.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.pre[i];
    const right = b.pre[i];
    // A shorter prerelease is lower when every identifier so far is equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = NUMERIC.test(left);
    const rightNumeric = NUMERIC.test(right);
    // Numeric identifiers compare as numbers and rank below alphanumerics.
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Is `candidate` a version worth offering to someone running `current`?
 *
 * Unparseable on either side answers false. An unknown version is not evidence
 * of an update, and a banner nobody can act on is worse than silence.
 */
export function isNewer(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return false;
  return compareVersions(next, now) > 0;
}

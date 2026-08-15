/**
 * The version of the running build.
 *
 * Read from the nearest package.json above the compiled file rather than
 * baked in at compile time, because the same `dist` is copied into three
 * layouts and every one of them has a package.json that `scripts/ship.sh`
 * bumps in lockstep:
 *
 *   dist/version.js                        -> package.json
 *   apps/desktop/server/dist/version.js    -> apps/desktop/package.json
 *   app.asar/server/dist/version.js        -> app.asar/package.json
 *
 * A hardcoded literal here would be a second place to bump, and the one place
 * nobody remembers. `/api/health` reported "0.1.0" for every release until
 * this existed.
 */
import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/** Falls back to this only when no package.json above us has a version. */
const UNKNOWN = "0.0.0";

let cached: string | null = null;

function findVersion(from: string): string {
  let dir = from;
  const { root } = parse(dir);
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      );
      const version = (pkg as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    } catch {
      // No package.json here, or an unreadable one. Keep walking.
    }
    if (dir === root) return UNKNOWN;
    const parent = dirname(dir);
    if (parent === dir) return UNKNOWN;
    dir = parent;
  }
}

/** The running build's version, e.g. "0.2.9". Read once. */
export function appVersion(): string {
  if (cached === null) {
    cached = findVersion(dirname(fileURLToPath(import.meta.url)));
  }
  return cached;
}

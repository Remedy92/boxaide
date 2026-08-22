/**
 * The one-time move off the retired install names.
 *
 * Boxaide was Sley, and Mailmux before that. Every install made under those
 * names put its database, its master key and its bearer token in `~/.sley` or
 * `~/.mailmux`, and its agent subtree in the sibling `~/.sley-agents`. The
 * fallback chain that used to live in src/config.ts and src/db/store.ts read
 * those names for ever, which meant an install made in 2025 stayed on a name
 * the product no longer uses, and every new place that derives a path from the
 * data directory had to be told about three names instead of one.
 *
 * So the names are migrated once, at startup, rather than tolerated for ever:
 * `~/.sley` becomes `~/.boxaide`, `~/.sley-agents` becomes `~/.boxaide-agents`,
 * `sley.db` becomes `boxaide.db`. After that first launch there is one name on
 * disk and one name in the code.
 *
 * Every rule here exists because this runs unattended against the only copy of
 * somebody's mail:
 *
 *  - Nothing is ever overwritten. A target that already exists means the two
 *    installs are not the same install, and picking one would delete the
 *    other's data. The migration declines and the legacy name keeps working.
 *  - The agent subtree moves FIRST, and the data directory only if it did.
 *    The agent root is derived from the data directory's name
 *    (src/agent/paths.ts), so a data directory that moved without its sibling
 *    would silently point at an empty subtree — new CLI config homes, and the
 *    workspace notes in `workdir/memory/` gone. A half-migrated pair is the
 *    one outcome worse than not migrating.
 *  - A failure anywhere rolls back what it already did and returns the legacy
 *    path. The install starts, on the old name, exactly as it did yesterday.
 *  - The WAL sidecars move with the database. `boxaide.db-wal` holds committed
 *    transactions that `boxaide.db` does not, so a database renamed away from
 *    its own WAL is a database that has lost whatever was in it.
 *
 * What this does NOT do, deliberately: an explicit `SLEY_DATA_DIR` or
 * `MAILMUX_DATA_DIR` still names whatever it names. Somebody who wrote a path
 * into their own environment chose it, and renaming a directory out from under
 * a configuration file is not a migration, it is a break. Those variables are
 * still read (src/config.ts); only the guessing is retired.
 */
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The data directory an install has today, under the home directory. */
export const DATA_DIR_NAME = ".boxaide";

/** The ones it may still have from an earlier name, newest first. */
export const LEGACY_DATA_DIR_NAMES = [".sley", ".mailmux"] as const;

/** The database file inside it. */
export const DB_NAME = "boxaide.db";

/** The names that file may still carry, newest first. */
export const LEGACY_DB_NAMES = ["sley.db", "mailmux.db"] as const;

/** What SQLite keeps beside a database in WAL mode. */
const DB_SIDECARS = ["-wal", "-shm"] as const;

/** The agent-owned subtree's suffix. Mirrors `agentRoot` in agent/paths.ts. */
const AGENTS_SUFFIX = "-agents";

/** One rename that happened, so a later failure can put it back. */
type Move = { from: string; to: string };

/**
 * Renames `from` to `to`, or answers false. Never throws: a migration that
 * cannot proceed is a migration that does not happen, not a server that
 * refuses to start.
 */
function move(from: string, to: string, done: Move[]): boolean {
  try {
    renameSync(from, to);
  } catch {
    return false;
  }
  done.push({ from, to });
  return true;
}

/** Puts back everything a failed migration had already moved. */
function rollback(done: Move[]): void {
  for (const step of done.reverse()) {
    try {
      renameSync(step.to, step.from);
    } catch {
      // Nothing better is available here. The rename that just failed is the
      // same operation, on the same filesystem, in the other direction.
    }
  }
}

/**
 * The data directory to use, having moved a legacy one onto the current name
 * if that was both needed and safe.
 *
 * Answers `~/.boxaide` for the overwhelmingly common cases: the install is
 * already on the current name, or it is a first run with nothing to migrate.
 * Answers a legacy path only when one exists and could not be moved.
 */
export function migrateLegacyDataDir(home: string = homedir()): string {
  const target = join(home, DATA_DIR_NAME);
  // An existing target ends it: whatever is in the legacy directory, this
  // install is the one on the current name.
  if (existsSync(target)) return target;
  for (const name of LEGACY_DATA_DIR_NAMES) {
    const legacy = join(home, name);
    if (!existsSync(legacy)) continue;
    return moveDataDir(legacy, target);
  }
  return target;
}

/**
 * One legacy directory and its agent sibling, moved together or not at all.
 */
function moveDataDir(legacy: string, target: string): string {
  const agentsFrom = `${legacy}${AGENTS_SUFFIX}`;
  const agentsTo = `${target}${AGENTS_SUFFIX}`;
  // Both siblings present means two installs' agent subtrees, and no way to
  // tell which one the mail in `legacy` belongs to. Declining leaves a working
  // install on the old name; guessing could hand an agent the wrong notes.
  if (existsSync(agentsFrom) && existsSync(agentsTo)) return legacy;

  const done: Move[] = [];
  if (existsSync(agentsFrom) && !move(agentsFrom, agentsTo, done)) {
    return legacy;
  }
  if (!move(legacy, target, done)) {
    rollback(done);
    return legacy;
  }
  return target;
}

/**
 * The database path to open inside `dataDir`, having renamed a legacy one onto
 * `boxaide.db` when there was one and no current file to collide with.
 *
 * Separate from the directory move because the two are not the same event: an
 * install pointed at a directory by `SLEY_DATA_DIR` never moves that
 * directory, but the database inside it still converges on one name.
 */
export function migrateLegacyDatabase(dataDir: string): string {
  const target = join(dataDir, DB_NAME);
  if (existsSync(target)) return target;
  for (const name of LEGACY_DB_NAMES) {
    const legacy = join(dataDir, name);
    if (!existsSync(legacy)) continue;
    return moveDatabase(legacy, target);
  }
  return target;
}

/** The database and its WAL sidecars, moved together or not at all. */
function moveDatabase(legacy: string, target: string): string {
  const done: Move[] = [];
  if (!move(legacy, target, done)) return legacy;
  for (const suffix of DB_SIDECARS) {
    const from = `${legacy}${suffix}`;
    if (!existsSync(from)) continue;
    // A sidecar that will not move takes the whole rename with it. The
    // alternative is a database separated from the transactions it has
    // committed but not yet checkpointed.
    if (!move(from, `${target}${suffix}`, done)) {
      rollback(done);
      return legacy;
    }
  }
  return target;
}

/**
 * What must never be in the repository.
 *
 * One test, from one incident. A worktree pointed its `node_modules` at
 * another checkout's install, `.gitignore` said `node_modules/` — which
 * matches a directory and not a symlink — and `git add -A` committed the link.
 * It reached master carrying an absolute path from one machine, so every clone
 * after it had a `node_modules` that resolved to nothing: npm would not install
 * into it and Turbopack refused the build outright with "Symlink
 * [project]/node_modules is invalid, it points out of the filesystem root".
 *
 * The ignore rule is fixed. This is the part that notices if it is ever
 * un-fixed, because the failure does not show up on the machine that commits
 * it — there the link resolves.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Every tracked path, with its git file mode. */
function trackedEntries(): Array<{ mode: string; path: string }> {
  const out = execFileSync("git", ["ls-files", "-s", "-z"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return out
    .split("\0")
    .filter((line) => line.length > 0)
    .map((line) => {
      // "<mode> <object> <stage>\t<path>"
      const [meta, path] = line.split("\t");
      return { mode: meta.split(" ")[0], path };
    });
}

describe("what must never be committed", () => {
  it("tracks no symlinks at all", () => {
    // 120000 is git's mode for a symlink. Nothing in this repository has a
    // reason to be one, and the only one that ever appeared was an accident
    // that broke every clone.
    const links = trackedEntries()
      .filter((entry) => entry.mode === "120000")
      .map((entry) => entry.path);
    expect(links).toEqual([]);
  });

  it("ignores a path named node_modules, symlink or directory", () => {
    // The probe paths do not exist, and that is the whole point. A rule
    // written `node_modules/` matches a DIRECTORY, so asking about the real
    // top-level node_modules — a directory on any machine that has installed —
    // answers "ignored" under the broken rule too. Asking about a path git
    // cannot stat makes it judge the rule instead of the filesystem, and there
    // the trailing slash fails: `git check-ignore packages/x/node_modules`
    // says nothing under `node_modules/` and says ignored under `node_modules`.
    for (const path of [
      "node_modules",
      "apps/web/node_modules",
      "does/not/exist/node_modules",
    ]) {
      const status = (() => {
        try {
          execFileSync("git", ["check-ignore", "-q", path], {
            cwd: process.cwd(),
          });
          return 0;
        } catch (err) {
          return (err as { status?: number }).status ?? 1;
        }
      })();
      expect(status, `${path} is not ignored`).toBe(0);
    }
  });
});

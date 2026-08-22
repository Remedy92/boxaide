/**
 * Where a launched agent lives on disk.
 *
 * Everything an agent is pointed at lives under here, and it is deliberately
 * NOT inside the data directory.
 *
 * The data directory holds `bearer.token` and `master.key`. An agent used to
 * stand in `<dataDir>/agent-workdir`, so `cat ../bearer.token` handed it the
 * master credential the scope exists to keep away from it, and
 * `cat ../master.key` decrypted the mail store. Three of the launched CLIs run
 * shell commands with approval turned off, and a prompt-injected email is
 * enough to ask for that read.
 *
 * A sibling directory, so nothing the agent is handed — its cwd, its config
 * home, the env vars naming them — walks up into the secrets. On its own that
 * only removes the escalation that needs no guessing; an absolute path still
 * reaches the data directory. `src/agent/sandbox.ts` is what closes that, and
 * this layout is what makes its rule expressible: one subtree the agent owns,
 * one it must never see, and no overlap between them.
 *
 * Shared rather than private to the launcher because other modules reason
 * about the same subtree — src/memory/store.ts puts the agent's workspace
 * notes inside it — and a second copy of the layout would let the two drift.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The scratch root a `:memory:` install's agents own, made once per process.
 *
 * This used to be a fixed `<tmp>/boxaide-agent`, and a predictable name in a
 * world-writable directory is somebody else's to claim first. On a shared
 * machine another user could create that path, or a symlink standing where it
 * belongs, and own the subtree this process then writes an agent's config
 * homes and workspace notes into. `mkdtemp` answers exactly that: a name
 * nobody can guess, created 0700, owned by us.
 *
 * Cached, because the launcher and the memory store must agree on where the
 * subtree is for the life of the process. Not shared BETWEEN processes any
 * more, which costs nothing: an install with no data directory keeps nothing
 * across runs by definition.
 */
let scratchRoot: string | null = null;

/**
 * The root of the subtree an install's agents own. One per data directory,
 * named by suffix so a data dir and its agent root sit side by side.
 *
 * `:memory:` names no directory at all, so there is no sibling to derive;
 * those installs (tests, embedders) get the private scratch root above.
 */
export function agentRoot(dataDir: string): string {
  if (dataDir === ":memory:") {
    scratchRoot ??= mkdtempSync(join(tmpdir(), "boxaide-agent-"));
    return scratchRoot;
  }
  return `${dataDir.replace(/[/\\]+$/, "")}-agents`;
}

/** The chat agent's working directory. One per install; it owns it alone. */
export function agentWorkDir(dataDir: string): string {
  return join(agentRoot(dataDir), "workdir");
}

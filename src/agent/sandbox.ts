/**
 * The operating system's own boundary around a launched agent.
 *
 * `src/mcp/scope.ts` decides what an agent may do with Boxaide's tools. This
 * decides what it may do with the machine, and the two are not the same
 * question: the scope is enforced by a server the agent talks to, and an agent
 * that can read `bearer.token` off the disk simply stops talking to that server
 * as itself. Moving the agent's directory out of the data directory took away
 * the `..` walk; it did not take away an absolute path.
 *
 * So the boundary is put where the CLI cannot argue with it. One mechanism for
 * every agent, applied at every spawn, exactly as the scope is — not a per-CLI
 * flag, because two of the five offer none and the next one is unknown.
 *
 * Two levels, chosen per launch:
 *  - `workspace` the agent reads and writes its own directory, reaches its own
 *    CLI's files, and nothing else of the user's. The default.
 *  - `full`      no confinement. What every launch did before this existed.
 *
 * The honest limits, because a sandbox believed in is worse than none:
 *  - macOS only today. Elsewhere `workspace` is refused rather than quietly
 *    granted, so nothing ever claims a confinement it does not have.
 *  - The network is open at both levels. An agent still talks to its model
 *    provider and to Boxaide. Confining reads is what keeps the master
 *    credential out of its hands; it is not an exfiltration boundary.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";

export type AgentAccess = "workspace" | "full";

export const AGENT_ACCESS_LEVELS: readonly AgentAccess[] = ["workspace", "full"];

export function isAgentAccess(value: unknown): value is AgentAccess {
  return (
    typeof value === "string" &&
    (AGENT_ACCESS_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * A command split so a caller can rebuild it with different arguments.
 *
 * `prefix` is everything between the binary that is actually executed and the
 * arguments the spec wrote. Unconfined it is empty and `bin` is the CLI, so
 * `[...prefix, ...args]` is the untouched command line. Confined, `bin` becomes
 * the sandbox tool and the CLI moves into the prefix.
 *
 * It is split rather than joined because a driver builds a fresh argument list
 * for every turn (see `ClaudeDriver`), and a driver that had to know about
 * sandboxing would be a second place to forget it.
 */
export type LaunchCommand = { bin: string; prefix: string[] };

export function plainCommand(bin: string): LaunchCommand {
  return { bin, prefix: [] };
}

/** Where a confined launch may still reach. */
export type Confinement = {
  /** Read and write. The agent's own directories. */
  write: string[];
  /** Read only. The CLI's own installation and credentials. */
  read: string[];
  /**
   * Denied last and unconditionally, whatever else names it. The data
   * directory: `bearer.token`, `master.key`, and the mail database.
   */
  deny: string[];
};

/** macOS ships `sandbox-exec`; nothing else here has a verified equivalent. */
export function sandboxSupported(platform: string = process.platform): boolean {
  return platform === "darwin";
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Why a confined launch is impossible here, or null when it is possible.
 *
 * A reason, not a boolean, because it is shown to whoever asked for the
 * launch and "it did not work" is not something a person can act on.
 */
export function sandboxUnavailable(
  platform: string = process.platform,
): string | null {
  if (!sandboxSupported(platform)) {
    return `Boxaide can only confine an agent to its own workspace on macOS, and this is ${platform}. Start the agent with full access if you accept that it can read your files, or set BOXAIDE_AGENT_ACCESS=full to make that the default.`;
  }
  if (!existsSync(SANDBOX_EXEC)) {
    return `Boxaide confines an agent with ${SANDBOX_EXEC}, which is not on this machine. Start the agent with full access if you accept that it can read your files.`;
  }
  return null;
}

/**
 * The subtree under the user's home that has to stay readable for `path` to
 * be usable, or null when `path` is not under the home at all.
 *
 * Every agent CLI on a real machine installs into the home directory, and no
 * two agree on where: `~/.local/share/claude/versions/…`, `~/.grok/bin/…`,
 * `~/.bun/install/global/node_modules/…`, `~/.codex/packages/…`,
 * `~/.nvm/versions/node/…`. Denying the home outright and allowing the
 * binary's own folder back is not enough — every one of these reaches sideways
 * for libraries, and a rule tuned to five layouts breaks on the sixth.
 *
 * So the whole first segment is allowed: `~/.codex`, `~/.bun`, `~/.nvm`. It is
 * coarse on purpose. What it must never allow is a segment the user's own
 * documents and keys live in, and those are not one directory deep under a
 * dotted install root — `~/.ssh`, `~/Documents` and the data directory are all
 * still denied, because nothing the agent runs lives inside them.
 */
export function homeRootFor(path: string, home: string): string | null {
  const rel = relative(home, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const [first] = rel.split(sep);
  return first ? join(home, first) : null;
}

/**
 * The paths a binary needs readable: where it is, and where the symlink chain
 * actually lands. `claude` on this machine is a link in `~/.local/bin` into
 * `~/.local/share/claude`; `node` is a link in `~/.local/bin` into `~/.nvm`.
 * Both ends matter, and they are not always under the same root.
 */
export function readRootsForBinary(bin: string, home: string): string[] {
  const seen = new Set<string>();
  // The home is matched both as given and as resolved. A link chain lands on
  // the real path, and if the home itself is reached through a link — every
  // temporary directory on macOS is — the two do not share a prefix and the
  // root comes back null while looking entirely correct.
  const homes = [...new Set([home, resolved(home)])];
  for (const candidate of [bin, resolved(bin)]) {
    for (const base of homes) {
      const root = homeRootFor(candidate, base);
      if (root) seen.add(root);
    }
  }
  return [...seen];
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A macOS sandbox profile.
 *
 * Read as a sequence: later rules win, so the shape is "everything, then not
 * the home, then these parts of the home back, then never the data directory".
 * The last line is the one that has to survive every future edit above it,
 * which is why it is written last rather than folded into the deny above.
 *
 * Paths are resolved before they are written. `subpath` matches on the real
 * path, and on macOS the temporary directory alone is enough to break that:
 * `/var/folders/…` is reached through `/private/var`, and a rule naming the
 * unresolved path matches nothing while looking exactly right.
 */
export function macosProfile(home: string, confinement: Confinement): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    // The home, minus what is allowed back below. Writes as well as reads: an
    // agent that cannot read the user's files should not be able to replace
    // them either.
    `(deny file-read* file-write* ${subpath(home)})`,
  ];
  for (const path of unique(confinement.read)) {
    lines.push(`(allow file-read* ${subpath(path)})`);
  }
  for (const path of unique(confinement.write)) {
    lines.push(`(allow file-read* file-write* ${subpath(path)})`);
  }
  for (const path of unique(confinement.deny)) {
    lines.push(`(deny file-read* file-write* ${subpath(path)})`);
  }
  return `${lines.join("\n")}\n`;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean).map(resolved))];
}

function subpath(path: string): string {
  return `(subpath ${sbplString(path)})`;
}

/**
 * A path as a profile string literal. Backslash and quote are the two
 * characters that would end the literal early, and a path may hold either —
 * a directory named `he said "no"` is legal on every filesystem here.
 */
function sbplString(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type ConfineOptions = {
  bin: string;
  access: AgentAccess;
  /** The launch's own directory, and anything else it may write. */
  write: string[];
  /** Credentials and installations the CLI needs, beyond its own binary. */
  read: string[];
  /** The data directory. Denied last, whatever else allows it. */
  deny: string[];
  home?: string;
  platform?: string;
  /** The runtime that will execute the CLI, when the CLI is a script. */
  execPath?: string;
};

/**
 * The command that actually gets spawned.
 *
 * Throws when `workspace` was asked for and cannot be delivered. Refusing is
 * the point: silently running an agent unconfined because the tool was missing
 * is the failure this whole module exists to prevent, and it is the one the
 * caller would never notice.
 */
export function confineCommand(opts: ConfineOptions): LaunchCommand {
  const platform = opts.platform ?? process.platform;
  if (opts.access === "full") return plainCommand(opts.bin);
  const blocked = sandboxUnavailable(platform);
  if (blocked) throw new Error(blocked);

  const home = opts.home ?? homedir();
  const read = [
    ...readRootsForBinary(opts.bin, home),
    ...readRootsForBinary(opts.execPath ?? process.execPath, home),
    ...opts.read.flatMap((path) => {
      // A credential the CLI reads at runtime is named exactly; a credential
      // under a root already allowed for the binary costs nothing to repeat.
      const root = homeRootFor(path, home);
      return root ? [root] : [path];
    }),
  ];
  const write = [...opts.write, tmpdir()];
  const profile = macosProfile(home, { read, write, deny: opts.deny });
  // `-p` rather than a profile file: a file would be one more thing to write
  // before a launch, clean up after it, and keep in step with the directory it
  // describes. The profile names paths, never secrets.
  return { bin: SANDBOX_EXEC, prefix: ["-p", profile, opts.bin] };
}

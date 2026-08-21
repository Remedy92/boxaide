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
 * There is one level a user can be asked about, and it is not a question they
 * are asked: `workspace` is simply on. It used to be a per-launch switch in
 * the sidebar, which was wrong twice over — the person clicking Start cannot
 * be expected to reason about which files a CLI reads, and the switch's other
 * position was the one where an agent could read `bearer.token`. `full` stays
 * as an install-level escape (BOXAIDE_AGENT_ACCESS=full) and as what a machine
 * with no sandbox gets, and both say so out loud rather than passing for
 * confinement. See `resolveAccess`.
 *
 *  - `workspace` the agent reads and writes its own directory, reaches its own
 *    CLI's files, and nothing else of the user's. What every launch gets.
 *  - `full`      no confinement. Only from the install setting, or from a
 *    platform that has no sandbox to apply.
 *
 * The honest limits, because a sandbox believed in is worse than none:
 *  - macOS only today. Elsewhere a launch runs unconfined and is reported that
 *    way, so nothing ever claims a confinement it does not have.
 *  - The network is open at both levels for a launch a person is watching. An
 *    agent still talks to its model provider and to Boxaide. Confining reads
 *    is what keeps the master credential out of its hands; for those launches
 *    it is not an exfiltration boundary.
 *  - A scheduled run asks for `network: "loopback"`, which denies every
 *    outbound connection except to this machine. Seatbelt takes only `*` or
 *    `localhost` as an address, so "the model provider and nothing else"
 *    cannot be said here at all: the run reaches its provider through the
 *    allowlisting proxy in `src/agent/egress.ts`, which is the only thing
 *    listening on the loopback it is left.
 *  - The login keychain is reachable. See `keychainDir`: without it no CLI
 *    that signs in through the keychain can authenticate at all, and macOS
 *    gates the items inside on the asking program, not on this profile.
 *  - Confinement decides what an agent reaches on the DISK. What it may do
 *    with the user's mail and calendar is decided by src/mcp/scope.ts and, for
 *    anything another person would see, by src/agent/approvals.ts.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";

export type AgentAccess = "workspace" | "full";

export const AGENT_ACCESS_LEVELS: readonly AgentAccess[] = ["workspace", "full"];

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
/**
 * How much network a launch keeps. "open" is what a watched launch gets, and
 * what every launch got before scheduled runs were confined; "loopback" is
 * this machine only, which is the shape the egress proxy needs.
 */
export type NetworkAccess = "open" | "loopback";

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
  /** Absent means open, so an existing caller keeps what it had. */
  network?: NetworkAccess;
};

/** macOS ships `sandbox-exec`; nothing else here has a verified equivalent. */
export function sandboxSupported(platform: string = process.platform): boolean {
  return platform === "darwin";
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The login keychain, which every confined launch may reach.
 *
 * It sits under the home, so the blanket home deny took it — and taking it is
 * what made Claude Code impossible to sign in to. On macOS that CLI keeps its
 * token in the keychain rather than in a file, keyed to the config directory,
 * so a confined launch answered "Not logged in" on every turn while the same
 * command outside the sandbox answered normally. Signing in again changed
 * nothing, because the login was never the part that was missing.
 *
 * Allowed as a directory because there is no finer unit here: one file holds
 * every item, and no profile rule can name one item inside it. What keeps the
 * other items out of reach is macOS itself — an item is released to the
 * programs its own list names, and an agent CLI is not on anybody else's.
 *
 * Writable, not only readable: a CLI refreshing an expired token writes the
 * new one back, and a read-only keychain turns every expiry into this bug.
 */
function keychainDir(home: string): string {
  return join(home, "Library", "Keychains");
}

/**
 * Why a confined launch is impossible here, or null when it is possible.
 *
 * A reason, not a boolean, because it is shown to whoever asked for the launch
 * and "it did not work" is not something a person can act on.
 *
 * The two checks are not the same kind of question. Whether the platform has a
 * sandbox at all is a fact about the named platform. Whether the tool is
 * actually installed is a fact about *this* machine, and there is no way to
 * answer it for any other — so it is only asked when the platform named is the
 * one running. A caller naming another platform is asking the first question.
 */
export function sandboxUnavailable(
  platform: string = process.platform,
): string | null {
  if (!sandboxSupported(platform)) {
    return `Boxaide can only confine an agent to its own workspace on macOS, and this is ${platform}. This agent can read your files.`;
  }
  if (platform === process.platform && !existsSync(SANDBOX_EXEC)) {
    return `Boxaide confines an agent with ${SANDBOX_EXEC}, which is not on this machine. This agent can read your files.`;
  }
  return null;
}

/** What a launch is actually given, and why, when it is not confinement. */
export type AccessDecision = {
  access: AgentAccess;
  /**
   * Null when the agent is confined. Otherwise the sentence shown next to the
   * running agent — never swallowed, because an unconfined launch that looks
   * like a confined one is the failure this module exists to prevent.
   */
  notice: string | null;
};

/**
 * The level a launch gets, from the install setting and this machine.
 *
 * This replaced a per-launch choice, and it deliberately does not refuse.
 * Refusing was right while the sidebar had a switch to fall back to; with the
 * switch gone it would mean nobody outside macOS can launch an agent at all.
 * So a machine with no sandbox runs the agent and says it is unconfined, which
 * the user can act on. What it must never do is stay quiet.
 */
export function resolveAccess(
  configured: AgentAccess,
  platform: string = process.platform,
): AccessDecision {
  if (configured === "full") {
    return {
      access: "full",
      notice:
        "This agent runs with full access to your files because BOXAIDE_AGENT_ACCESS=full is set on this install.",
    };
  }
  const blocked = sandboxUnavailable(platform);
  if (blocked) return { access: "full", notice: blocked };
  return { access: "workspace", notice: null };
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
    ...networkLines(confinement.network),
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

/**
 * Outbound network, denied except to this machine.
 *
 * Unix sockets stay allowed: the system's own name resolution and a CLI's
 * talking to a helper it spawned both use them, and neither leaves the
 * machine.
 *
 * Listening is NOT allowed back, and the omission is deliberate rather than
 * forgotten. `(allow network-bind (local ip "localhost:*"))` was written here
 * first and does not work — under `(deny network*)` a loopback `listen` still
 * fails with EPERM, so the line said something the profile did not do. No run
 * spec binds today. If one ever needs to, this is where it has to be solved
 * for real, and the fix is not that line.
 */
function networkLines(network: NetworkAccess | undefined): string[] {
  if (network !== "loopback") return [];
  return [
    "(deny network*)",
    "(allow network-outbound (remote unix-socket))",
    '(allow network-outbound (remote ip "localhost:*"))',
  ];
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
  /**
   * The launch's own directory, and every other tree the CLI must own — its
   * config home and its credentials among them. There is deliberately no
   * read-only list beside this one: every CLI here signs in by writing
   * something down, so a "credentials it only consults" category described a
   * CLI that does not exist and produced launches that could not authenticate.
   */
  write: string[];
  /** The data directory. Denied last, whatever else allows it. */
  deny: string[];
  /**
   * Outbound network. A scheduled run passes "loopback": nobody is watching
   * it, so its only way off this machine is the allowlisting proxy in
   * src/agent/egress.ts. Absent means open, which is what a watched launch
   * gets.
   */
  network?: NetworkAccess;
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
  // Readable, not writable: where the CLI and its runtime are installed. An
  // agent that can rewrite its own binary is an agent that can rewrite the
  // next launch's.
  const read = [
    ...readRootsForBinary(opts.bin, home),
    ...readRootsForBinary(opts.execPath ?? process.execPath, home),
  ];
  const write = [...opts.write, tmpdir(), keychainDir(home)];
  const profile = macosProfile(home, {
    read,
    write,
    deny: opts.deny,
    network: opts.network,
  });
  // `-p` rather than a profile file: a file would be one more thing to write
  // before a launch, clean up after it, and keep in step with the directory it
  // describes. The profile names paths, never secrets.
  return { bin: SANDBOX_EXEC, prefix: ["-p", profile, opts.bin] };
}

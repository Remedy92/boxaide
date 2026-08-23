/**
 * The operating system's boundary around a launched agent.
 *
 * Two halves, and both are needed. The profile builder is a pure function and
 * is tested everywhere. Whether the profile actually stops anything is a
 * question only the operating system can answer, so those tests run a real
 * confined process and are skipped where there is nothing to run it with.
 *
 * A sandbox that is believed in but does not hold is worse than none, which is
 * why the second half exists at all.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentLauncher,
  KNOWN_AGENTS,
  type AgentSpec,
} from "../src/agent/launcher.js";
import { capabilityOf } from "../src/agent/capability.js";
import {
  AGENT_ACCESS_LEVELS,
  confineCommand,
  homeRootFor,
  macosProfile,
  plainCommand,
  readRootsForBinary,
  resolveAccess,
  sandboxSupported,
  sandboxUnavailable,
} from "../src/agent/sandbox.js";

const HOME = "/Users/someone";

/**
 * Waits for the probe's answer instead of guessing how long it takes.
 *
 * The probe is a real spawned process: it has to be scheduled, run a shell,
 * run `cat`, and flush. A fixed sleep prices that at whatever the machine cost
 * on the day it was written. On a loaded CI runner it came back short:
 * the read then failed with ENOENT on a file the probe was about to write.
 * Polling for the file the assertion actually needs is both faster in the
 * normal case and honest about the slow one.
 */
async function readWhenWritten(path: string, ms = 10_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    // Non-empty, not merely present: the probe creates the file by redirecting
    // into it, so it exists for a moment before anything has been written.
    try {
      const seen = readFileSync(path, "utf8");
      if (seen.length > 0) return seen;
    } catch {
      // Not created yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`probe wrote nothing to ${path} within ${ms}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("agent access levels", () => {
  it("names the two levels there are", () => {
    expect(AGENT_ACCESS_LEVELS).toEqual(["workspace", "full"]);
  });
});

describe("home roots", () => {
  it("keeps the first segment, which is what every CLI layout needs", () => {
    // The five layouts this was built against, on a real machine.
    expect(homeRootFor(`${HOME}/.local/share/claude/versions/2.1`, HOME)).toBe(
      `${HOME}/.local`,
    );
    expect(homeRootFor(`${HOME}/.grok/bin/grok-1.0.5`, HOME)).toBe(`${HOME}/.grok`);
    expect(
      homeRootFor(`${HOME}/.bun/install/global/node_modules/opencode-ai`, HOME),
    ).toBe(`${HOME}/.bun`);
    expect(homeRootFor(`${HOME}/.codex/packages/standalone/x/bin/codex`, HOME)).toBe(
      `${HOME}/.codex`,
    );
    expect(homeRootFor(`${HOME}/.nvm/versions/node/v26/bin/node`, HOME)).toBe(
      `${HOME}/.nvm`,
    );
  });

  it("claims nothing outside the home, and not the home itself", () => {
    expect(homeRootFor("/usr/local/bin/codex", HOME)).toBeNull();
    expect(homeRootFor("/opt/homebrew/bin/grok", HOME)).toBeNull();
    expect(homeRootFor(HOME, HOME)).toBeNull();
    // A sibling directory that merely starts with the same characters is not
    // inside the home, and allowing it would be a silent hole.
    expect(homeRootFor("/Users/someone-else/.ssh/id_ed25519", HOME)).toBeNull();
  });

  it("follows a link to a second root, because installs do", () => {
    // `claude` and `node` are both links in ~/.local/bin landing in different
    // trees; allowing only one end leaves the process unable to start.
    const dir = mkdtempSync(join(tmpdir(), "sb-home-"));
    const real = join(dir, ".nvm", "bin");
    const linkDir = join(dir, ".local", "bin");
    mkdirSync(real, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(real, "node"), "#!/bin/sh\n");
    spawnSync("ln", ["-s", join(real, "node"), join(linkDir, "node")]);

    // Compared as resolved paths: the link lands on the real directory, and on
    // macOS every temporary directory is reached through one.
    const roots = readRootsForBinary(join(linkDir, "node"), dir).map((r) =>
      realpathSync(r),
    );
    expect(roots).toContain(realpathSync(join(dir, ".local")));
    expect(roots).toContain(realpathSync(join(dir, ".nvm")));
  });
});

describe("the macOS profile", () => {
  it("denies the home, allows the parts back, and denies the data dir last", () => {
    const profile = macosProfile(HOME, {
      read: ["/opt/tools"],
      write: ["/tmp/work"],
      deny: ["/opt/tools/secrets"],
    });
    const lines = profile.trim().split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines[1]).toBe("(allow default)");
    expect(lines[2]).toContain(`(deny file-read* file-write* (subpath "${HOME}")`);
    // Last wins in this language, so the data directory's deny has to be the
    // final word. That is the rule that must survive any edit above it.
    expect(lines.at(-1)).toContain('(deny file-read* file-write* (subpath "/opt/tools/secrets")');
    expect(lines.at(-1)).not.toContain("allow");
  });

  it("escapes a path that would otherwise end the string early", () => {
    const profile = macosProfile('/tmp/he said "no"', { read: [], write: [], deny: [] });
    expect(profile).toContain('/tmp/he said \\"no\\"');
  });

  it("lets an allowed path under home be canonicalized without opening home", () => {
    const target = `${HOME}/.boxaide-agents/workdir/runs/r1/codex-home`;
    const profile = macosProfile(HOME, {
      read: [],
      write: [target],
      deny: [],
    });
    // realpath stats each named parent. These are literals, not subpaths: the
    // process still cannot list the home or read a sibling such as ~/.ssh.
    expect(profile).toContain(
      `(allow file-read-metadata (literal "${HOME}"))`,
    );
    expect(profile).toContain(
      `(allow file-read-metadata (literal "${HOME}/.boxaide-agents/workdir/runs/r1"))`,
    );
    expect(profile).not.toContain(
      `(allow file-read-metadata (subpath "${HOME}"))`,
    );
  });

  /**
   * A scheduled run's network: nothing leaves this machine except through the
   * loopback proxy. Seatbelt takes only `*` or `localhost` as an address, so
   * "the model provider only" cannot be written here. That is why there is a
   * proxy at all (src/agent/egress.ts).
   */
  it("denies every outbound connection but loopback when asked", () => {
    const profile = macosProfile(HOME, {
      read: [],
      write: [],
      deny: [],
      network: "loopback",
    });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))');
    // Name resolution and helper processes go over unix sockets and never
    // leave the machine, so denying them would break the run for nothing.
    expect(profile).toContain("(allow network-outbound (remote unix-socket))");
    // The deny lands before the allows: later rules win in a profile.
    expect(profile.indexOf("(deny network*)")).toBeLessThan(
      profile.indexOf('(remote ip "localhost:*")'),
    );
  });

  it("says nothing about the network for a watched launch", () => {
    const profile = macosProfile(HOME, { read: [], write: [], deny: [] });
    expect(profile).not.toContain("network");
  });
});

describe("building the command", () => {
  it("leaves a full-access launch exactly as it was", () => {
    const cmd = confineCommand({
      bin: "/usr/local/bin/grok",
      access: "full",
      write: ["/tmp/w"],
      deny: ["/home/u/.boxaide"],
      platform: "linux",
    });
    // No wrapper at all, so a spec's arguments reach the CLI untouched.
    expect(cmd).toEqual(plainCommand("/usr/local/bin/grok"));
  });

  it("refuses a confined launch it cannot deliver, rather than running one", () => {
    // The failure this module exists to prevent: a launch that quietly runs
    // unconfined because the tool was missing, which nobody would notice.
    expect(sandboxSupported("linux")).toBe(false);
    expect(sandboxUnavailable("linux")).toContain("macOS");
    expect(() =>
      confineCommand({
        bin: "/usr/local/bin/grok",
        access: "workspace",
        write: ["/tmp/w"],
        deny: [],
        platform: "linux",
      }),
    ).toThrow(/macOS/);
  });

  it("runs the agent where there is no sandbox, and never calls that confined", () => {
    // The refusal above is right for `confineCommand`, which cannot deliver
    // what it was asked for. It is the wrong answer for a launch: with the
    // sidebar switch gone it would mean nobody outside macOS can start an
    // agent at all. So the decision is made one level up, it runs, and it
    // says what it is.
    const linux = resolveAccess("workspace", "linux");
    expect(linux.access).toBe("full");
    expect(linux.notice).toContain("can read your files");

    const chosen = resolveAccess("full", "darwin");
    expect(chosen.access).toBe("full");
    expect(chosen.notice).toContain("BOXAIDE_AGENT_ACCESS=full");
  });

  it("puts the CLI behind the sandbox so arguments still append", () => {
    const cmd = confineCommand({
      bin: "/usr/local/bin/grok",
      access: "workspace",
      write: ["/tmp/w"],
      deny: [],
      platform: "darwin",
      home: HOME,
    });
    expect(cmd.bin).toBe("/usr/bin/sandbox-exec");
    // The binary is the last thing before the spec's own arguments, so
    // `[...prefix, ...args]` is still the command the spec wrote.
    expect(cmd.prefix.at(-1)).toBe("/usr/local/bin/grok");
    expect(cmd.prefix[0]).toBe("-p");
  });

  it("leaves the login keychain reachable", () => {
    // Claude Code keeps its token in the keychain on macOS, not in a file. The
    // blanket home deny took the keychain with everything else, so every
    // confined turn reported "Not logged in" while the same command outside
    // the sandbox answered, and signing in again fixed nothing, because the
    // login was never the missing part.
    const cmd = confineCommand({
      bin: "/usr/local/bin/claude",
      access: "workspace",
      write: ["/tmp/w"],
      deny: [],
      platform: "darwin",
      home: HOME,
    });
    const profile = cmd.prefix[1];
    const keychains = join(HOME, "Library", "Keychains");
    // Written after the home deny, so it is the rule that wins, and writable
    // because a refreshed token is written back.
    expect(profile.indexOf(keychains)).toBeGreaterThan(
      profile.indexOf(`(deny file-read* file-write* (subpath "${HOME}")`),
    );
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${keychains}"))`,
    );
  });
});

describe("what each CLI declares it needs", () => {
  it("makes every CLI's own credential home writable, not merely readable", () => {
    // The bug, at the spec level. agy is the one that surfaced it: `~/.gemini`
    // was readable, agy could not save the session it was establishing, and it
    // waited and exited with no error anybody saw. Read-only was wrong for all
    // of them. A signed-in CLI refreshes its token and writes the new one.
    const env = { HOME: HOME };
    const ctx = {
      mcpUrl: "http://127.0.0.1:0/mcp",
      bearerToken: "t",
      dataDir: "/tmp/data",
    } as never;
    const homes: Record<string, string> = {
      codex: `${HOME}/.codex`,
      grok: `${HOME}/.grok`,
      antigravity: `${HOME}/.gemini`,
    };
    for (const [id, home] of Object.entries(homes)) {
      const spec = KNOWN_AGENTS.find((s) => s.id === id);
      expect(spec, id).toBeTruthy();
      const declared = spec!.sandbox!(ctx, "/tmp/work", env, "chat");
      expect(declared.write, id).toContain(home);
    }
  });

  it("denies the user's agy MCP config on a run and not on a chat launch", () => {
    // agy merges that file into every session and has no strict-config flag,
    // so the operating system is the only thing that can take it away. A
    // watched chat launch keeps it: someone is there to see what it does.
    const env = { HOME: HOME };
    const ctx = {
      mcpUrl: "http://127.0.0.1:0/mcp",
      bearerToken: "t",
      dataDir: "/tmp/data",
    } as never;
    const spec = KNOWN_AGENTS.find((s) => s.id === "antigravity")!;
    const config = `${HOME}/.gemini/config/mcp_config.json`;

    const run = spec.sandbox!(ctx, "/tmp/work", env, "run");
    expect(run.deny).toContain(config);
    expect(run.write).toContain(`${HOME}/.gemini`);

    const chat = spec.sandbox!(ctx, "/tmp/work", env, "chat");
    expect(chat.deny ?? []).not.toContain(config);
    // The sign-in still has to be writable, or agy starts and never saves the
    // session it establishes.
    expect(chat.write).toContain(`${HOME}/.gemini`);
  });

  it("emits a deny for a file that does not exist yet", () => {
    // The rule is written before the launch and the file may appear during
    // it. Seatbelt matches the resolved path, and every temporary home on
    // macOS is reached through a link, so an unresolved rule matches nothing
    // while looking exactly right.
    const home = mkdtempSync(join(tmpdir(), "sb-missing-home-"));
    const missing = join(home, ".gemini", "config", "mcp_config.json");
    const profile = macosProfile(home, {
      read: [],
      write: [home],
      deny: [missing],
    });
    const expected = join(
      realpathSync(home),
      ".gemini",
      "config",
      "mcp_config.json",
    );
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${expected}"))`,
    );
  });

  it("stops claiming a run is isolated when the launch is unconfined", () => {
    // Off macOS `confine` builds no profile at all, so nothing denies that
    // file and the claim would be theatre.
    const home = mkdtempSync(join(tmpdir(), "sb-agy-home-"));
    const spec = KNOWN_AGENTS.find((s) => s.id === "antigravity")!;
    const ctx = {
      mcpUrl: "http://127.0.0.1:0/mcp",
      bearerToken: "t",
      dataDir: "/tmp/data",
      access: "workspace" as const,
    } as never;
    const cap = capabilityOf(spec, "/usr/local/bin/agy", ctx, { HOME: home }, "linux");
    expect(cap.isolation.isolated).toBe(false);
    expect(cap.isolation.note).toContain("only confine an agent");
    // Nothing in the user's file reaches this Boxaide, so the run is allowed
    // even though it is not isolated. Blocked is not the answer here; saying
    // so is.
    expect(cap.runs.ok).toBe(true);
  });
});

/**
 * The half only the operating system can answer. These start real processes
 * under a real profile; anywhere else there is nothing to ask.
 */
describe.runIf(sandboxSupported() && !sandboxUnavailable())(
  "a real confined process",
  () => {
    function run(
      script: string,
      opts: {
        write?: string[];
        deny?: string[];
        env?: Record<string, string>;
      } = {},
    ) {
      const work = mkdtempSync(join(tmpdir(), "sb-run-"));
      const secrets = mkdtempSync(join(tmpdir(), "sb-secret-"));
      writeFileSync(join(secrets, "bearer.token"), "master-credential");
      const cmd = confineCommand({
        bin: process.execPath,
        access: "workspace",
        write: [work, ...(opts.write ?? [])],
        deny: [secrets, ...(opts.deny ?? [])],
      });
      const result = spawnSync(
        cmd.bin,
        [...cmd.prefix, "-e", script],
        {
          cwd: work,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, WORK: work, SECRETS: secrets, ...(opts.env ?? {}) },
        },
      );
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    }

    it("cannot read the data directory, which is the whole point", () => {
      const out = run(`
        const fs = require("node:fs");
        try {
          fs.readFileSync(process.env.SECRETS + "/bearer.token", "utf8");
          console.log("LEAKED");
        } catch { console.log("blocked"); }
      `);
      expect(out).toContain("blocked");
      expect(out).not.toContain("LEAKED");
    });

    it("cannot read the user's home, and cannot even list it", () => {
      const out = run(`
        const fs = require("node:fs");
        try { fs.readdirSync(process.env.HOME); console.log("LISTED"); }
        catch { console.log("home blocked"); }
      `);
      expect(out).toContain("home blocked");
      expect(out).not.toContain("LISTED");
    });

    it("still owns its own working directory", () => {
      // The cost of confinement has to stay zero for the work the agent is
      // actually launched to do.
      const out = run(`
        const fs = require("node:fs");
        fs.writeFileSync(process.env.WORK + "/note.txt", "hello");
        console.log("wrote:" + fs.readFileSync(process.env.WORK + "/note.txt", "utf8"));
      `);
      expect(out).toContain("wrote:hello");
    });

    it("can canonicalize an allowed directory nested under home", () => {
      const nested = mkdtempSync(join(process.env.HOME!, ".boxaide-sb-realpath-"));
      const owned = join(nested, "workdir", "runs", "r1", "codex-home");
      mkdirSync(owned, { recursive: true });
      const out = run(
        `
        const fs = require("node:fs");
        try { console.log("real:" + fs.realpathSync(process.env.OWNED)); }
        catch (err) { console.log("realpath failed:" + err.message); }
      `,
        { write: [owned], env: { OWNED: owned } },
      );
      expect(out).toContain(`real:${realpathSync(owned)}`);
      expect(out).not.toContain("realpath failed");
    });

    it("can save its own sign-in, which is what a confined agent could not do", () => {
      // The bug this replaced: a CLI's credential directory was allowed to be
      // READ and not written. Every agent CLI here signs in by writing a token
      // down and rewriting it when it refreshes, so a confined launch started,
      // could not save the result, waited, and exited with nothing the user
      // ever saw. The agent simply never picked the message up.
      const cliHome = mkdtempSync(join(tmpdir(), "sb-cli-home-"));
      writeFileSync(join(cliHome, "auth.json"), '{"token":"old"}');
      const out = run(
        `
        const fs = require("node:fs");
        const path = process.env.CLI_HOME + "/auth.json";
        JSON.parse(fs.readFileSync(path, "utf8"));
        fs.writeFileSync(path, JSON.stringify({ token: "refreshed" }));
        console.log("saved:" + JSON.parse(fs.readFileSync(path, "utf8")).token);
      `,
        { write: [cliHome], env: { CLI_HOME: cliHome } },
      );
      expect(out).toContain("saved:refreshed");

      // And the allow is what does it: the same write, one directory over,
      // still fails. Otherwise this test would pass on a sandbox that confines
      // nothing.
      const other = mkdtempSync(join(tmpdir(), "sb-cli-other-"));
      writeFileSync(join(other, "auth.json"), '{"token":"old"}');
      const blocked = run(
        `
        const fs = require("node:fs");
        try {
          fs.writeFileSync(process.env.OTHER + "/auth.json", "x");
          console.log("WROTE");
        } catch { console.log("write blocked"); }
      `,
        { deny: [other], env: { OTHER: other } },
      );
      expect(blocked).toContain("write blocked");
      expect(blocked).not.toContain("WROTE");
    });

    it("still reaches the network, because the agent has a model to talk to", () => {
      // Confining reads keeps the credential away. It is not, and does not
      // claim to be, a boundary on what the agent can send.
      const out = run(`
        const net = require("node:net");
        const server = net.createServer(() => {});
        server.listen(0, "127.0.0.1", () => {
          const port = server.address().port;
          const c = net.connect(port, "127.0.0.1", () => {
            console.log("network ok");
            c.end(); server.close();
          });
          c.on("error", () => { console.log("network blocked"); server.close(); });
        });
      `);
      expect(out).toContain("network ok");
    });
  },
);

/**
 * The wiring, not the module.
 *
 * `confineCommand` holding is worth nothing if a spawn goes around it, so this
 * drives a real launch through `AgentLauncher` and reads what the child could
 * actually see. It is the test that fails if someone adds a sixth spawn site
 * and forgets the sandbox.
 */
describe.runIf(sandboxSupported() && !sandboxUnavailable())(
  "a launch, end to end",
  () => {
    function probeSpec(outPath: string): AgentSpec[] {
      // Writes what it managed to read where the test can see it, then exits.
      // stdout is the launcher's own stream, so the answer goes to a file.
      return [
        {
          id: "probe",
          label: "Probe",
          bin: "probe-agent",
          args: () => [outPath],
        },
      ];
    }

    it("cannot read the data directory it was launched from", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "sb-data-"));
      writeFileSync(join(dataDir, "bearer.token"), "master-credential");
      const binDir = mkdtempSync(join(tmpdir(), "sb-bin-"));
      const out = join(mkdtempSync(join(tmpdir(), "sb-out-")), "seen.txt");
      writeFileSync(
        join(binDir, "probe-agent"),
        `#!/bin/sh\n/bin/cat ${join(dataDir, "bearer.token")} > "$1" 2>&1\nexec /bin/sleep 30\n`,
      );
      spawnSync("chmod", ["755", join(binDir, "probe-agent")]);

      const launcher = new AgentLauncher(
        { mcpUrl: "http://127.0.0.1:0/mcp", bearerToken: "t", dataDir },
        probeSpec(out),
        { PATH: binDir, HOME: process.env.HOME },
        [],
      );
      try {
        const running = await launcher.start("probe");
        // Reported, so the pane can say what this launch actually got rather
        // than what it asked for.
        expect(running.access).toBe("workspace");
        const seen = await readWhenWritten(out);
        expect(seen).not.toContain("master-credential");
        expect(seen).toMatch(/not permitted|No such file/i);
      } finally {
        launcher.close();
      }
    });

    it("keeps a run out of one named file and leaves its siblings alone", async () => {
      // The whole new wiring in one test: confine() passing `kind` into
      // spec.sandbox, the returned deny reaching confineCommand, the rule
      // landing after the allows, and a deny path resolving the way seatbelt
      // matches. Tests of the pieces can all pass while this is unwired.
      const dataDir = mkdtempSync(join(tmpdir(), "sb-data-"));
      const configDir = mkdtempSync(join(tmpdir(), "sb-usercfg-"));
      const denied = join(configDir, "mcp_config.json");
      writeFileSync(denied, "user-servers");
      const sibling = join(configDir, "keep.txt");
      writeFileSync(sibling, "sibling-readable");
      const binDir = mkdtempSync(join(tmpdir(), "sb-bin-"));
      writeFileSync(
        join(binDir, "probe-agent"),
        `#!/bin/sh\n/bin/cat ${denied} 2>&1\n/bin/cat ${sibling} 2>&1\n`,
      );
      spawnSync("chmod", ["755", join(binDir, "probe-agent")]);

      const launcher = new AgentLauncher(
        { mcpUrl: "http://127.0.0.1:0/mcp", bearerToken: "t", dataDir },
        [
          {
            id: "probe",
            label: "Probe",
            bin: "probe-agent",
            runArgs: () => [],
            sandbox: (_ctx, _workDir, _env, kind) =>
              kind === "run" ? { deny: [denied] } : {},
          },
        ],
        { PATH: binDir, HOME: process.env.HOME },
        [],
      );
      try {
        const result = await launcher.runOnce({ runId: "denyprobe", prompt: "x" });
        expect(result.log).not.toContain("user-servers");
        expect(result.log).toMatch(/not permitted/i);
        // The deny names a file, not the directory holding it.
        expect(result.log).toContain("sibling-readable");
      } finally {
        launcher.close();
      }
    });

    it("runs unconfined only when the install says so, and says which", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "sb-data-"));
      writeFileSync(join(dataDir, "bearer.token"), "master-credential");
      const binDir = mkdtempSync(join(tmpdir(), "sb-bin-"));
      const out = join(mkdtempSync(join(tmpdir(), "sb-out-")), "seen.txt");
      writeFileSync(
        join(binDir, "probe-agent"),
        `#!/bin/sh\n/bin/cat ${join(dataDir, "bearer.token")} > "$1" 2>&1\nexec /bin/sleep 30\n`,
      );
      spawnSync("chmod", ["755", join(binDir, "probe-agent")]);

      // BOXAIDE_AGENT_ACCESS=full, as the install would set it. There is no
      // per-launch parameter any more: nobody pressing Start is asked which of
      // their files an agent CLI may read.
      const launcher = new AgentLauncher(
        {
          mcpUrl: "http://127.0.0.1:0/mcp",
          bearerToken: "t",
          dataDir,
          access: "full",
        },
        probeSpec(out),
        { PATH: binDir, HOME: process.env.HOME },
        [],
      );
      try {
        const running = await launcher.start("probe");
        expect(running.access).toBe("full");
        // Unconfined and reported as such. An unconfined launch that presents
        // as a confined one is the failure the whole module exists to prevent.
        expect(running.accessNotice).toContain("full access");
        // The level does what it says, or the notice is theatre.
        expect(await readWhenWritten(out)).toContain("master-credential");
      } finally {
        launcher.close();
      }
    });
  },
);

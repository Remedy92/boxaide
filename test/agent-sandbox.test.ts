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
import { AgentLauncher, type AgentSpec } from "../src/agent/launcher.js";
import {
  confineCommand,
  homeRootFor,
  isAgentAccess,
  macosProfile,
  plainCommand,
  readRootsForBinary,
  sandboxSupported,
  sandboxUnavailable,
} from "../src/agent/sandbox.js";

const HOME = "/Users/someone";

describe("agent access levels", () => {
  it("accepts only the two levels there are", () => {
    expect(isAgentAccess("workspace")).toBe(true);
    expect(isAgentAccess("full")).toBe(true);
    // Not a level, and must never be read as one: the failure to design
    // against is a typo that unconfines every agent on the machine.
    expect(isAgentAccess("Full")).toBe(false);
    expect(isAgentAccess("")).toBe(false);
    expect(isAgentAccess(undefined)).toBe(false);
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
    // final word — that is the rule that must survive any edit above it.
    expect(lines.at(-1)).toContain('(deny file-read* file-write* (subpath "/opt/tools/secrets")');
    expect(lines.at(-1)).not.toContain("allow");
  });

  it("escapes a path that would otherwise end the string early", () => {
    const profile = macosProfile('/tmp/he said "no"', { read: [], write: [], deny: [] });
    expect(profile).toContain('/tmp/he said \\"no\\"');
  });
});

describe("building the command", () => {
  it("leaves a full-access launch exactly as it was", () => {
    const cmd = confineCommand({
      bin: "/usr/local/bin/grok",
      access: "full",
      write: ["/tmp/w"],
      read: [],
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
        read: [],
        deny: [],
        platform: "linux",
      }),
    ).toThrow(/macOS/);
  });

  it("puts the CLI behind the sandbox so arguments still append", () => {
    const cmd = confineCommand({
      bin: "/usr/local/bin/grok",
      access: "workspace",
      write: ["/tmp/w"],
      read: [],
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
});

/**
 * The half only the operating system can answer. These start real processes
 * under a real profile; anywhere else there is nothing to ask.
 */
describe.runIf(sandboxSupported() && !sandboxUnavailable())(
  "a real confined process",
  () => {
    function run(script: string, opts: { write?: string[]; deny?: string[] } = {}) {
      const work = mkdtempSync(join(tmpdir(), "sb-run-"));
      const secrets = mkdtempSync(join(tmpdir(), "sb-secret-"));
      writeFileSync(join(secrets, "bearer.token"), "master-credential");
      const cmd = confineCommand({
        bin: process.execPath,
        access: "workspace",
        write: [work, ...(opts.write ?? [])],
        read: [],
        deny: [secrets, ...(opts.deny ?? [])],
      });
      const result = spawnSync(
        cmd.bin,
        [...cmd.prefix, "-e", script],
        {
          cwd: work,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, WORK: work, SECRETS: secrets },
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
        await new Promise((r) => setTimeout(r, 1_200));
        const seen = readFileSync(out, "utf8");
        expect(seen).not.toContain("master-credential");
        expect(seen).toMatch(/not permitted|No such file/i);
      } finally {
        launcher.close();
      }
    });

    it("hands full access straight through when it is asked for", async () => {
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
        const running = await launcher.start("probe", undefined, "full");
        expect(running.access).toBe("full");
        await new Promise((r) => setTimeout(r, 1_200));
        // The level does what it says: this is the behaviour a user opts into,
        // and it has to be real or the choice is theatre.
        expect(readFileSync(out, "utf8")).toContain("master-credential");
      } finally {
        launcher.close();
      }
    });
  },
);

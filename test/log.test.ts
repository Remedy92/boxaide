/**
 * The log file has two jobs and they pull against each other: keep enough that
 * a dead agent can be explained, and keep so little that the file is never
 * worth reading for anything else. These tests are the second half of that.
 *
 * Rotation, because an append-only file with no bound is a disk that fills.
 * Redaction, because the one field whose text this process did not write is a
 * child CLI's stderr, and a CLI that fails to sign in prints what it sent.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureLog, log, logError, logFilePath, logInfo, redact } from "../src/log.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  // Off again, or the next test file in this worker inherits a directory that
  // has been removed.
  configureLog({ dataDir: null });
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "boxaide-log-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every line of the live log, parsed. */
function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("where the log goes", () => {
  it("writes NDJSON under the data directory, one object per event", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir });
    logInfo("agent.launcher", "chat launch", { agent: "agy", pid: 4321 });
    logError("agent.turn", "failed", { agent: "agy", code: 1 });

    const path = logFilePath()!;
    expect(path).toBe(join(dataDir, "logs", "boxaide.log"));
    const written = lines(path);
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      level: "info",
      scope: "agent.launcher",
      msg: "chat launch",
      agent: "agy",
      pid: 4321,
    });
    expect(written[1]).toMatchObject({ level: "error", scope: "agent.turn", code: 1 });
    // A timestamp somebody can sort by and hand to a person.
    expect(String(written[0].t)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("creates the file owner-only", () => {
    // The log names what this machine runs and when. On a shared box that is
    // nobody else's business, and the file outlives the process that wrote it.
    if (process.platform === "win32") return;
    const dataDir = tempDataDir();
    configureLog({ dataDir });
    logInfo("agent.launcher", "chat launch", { agent: "claude" });
    expect(statSync(logFilePath()!).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "logs")).mode & 0o777).toBe(0o700);
  });

  it("writes nothing at all until it is configured, and nothing for :memory:", () => {
    // The default has to be silence: an unconfigured module that guessed
    // ~/.boxaide would have every test in this suite writing to the user's
    // real install.
    expect(logFilePath()).toBeNull();
    logInfo("agent.launcher", "chat launch", { agent: "agy" });

    const dataDir = tempDataDir();
    configureLog({ dataDir: ":memory:" });
    expect(logFilePath()).toBeNull();
    logInfo("agent.launcher", "chat launch", { agent: "agy" });
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
  });
});

describe("rotation", () => {
  it("keeps three files and drops the oldest", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir, maxBytes: 200, keep: 3 });
    const path = logFilePath()!;
    // Each line is well over 200 bytes once the padding is on it, so every
    // write after the first rotates.
    for (let n = 0; n < 6; n++) {
      logInfo("agent.turn", "failed", { agent: "agy", seq: n, pad: "x".repeat(200) });
    }

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    // Three files is three files. A fourth generation is the bug this bound
    // exists to prevent.
    expect(existsSync(`${path}.3`)).toBe(false);

    // Newest in the live file, older ones behind it in order.
    expect(lines(path)[0]).toMatchObject({ seq: 5 });
    expect(lines(`${path}.1`)[0]).toMatchObject({ seq: 4 });
    expect(lines(`${path}.2`)[0]).toMatchObject({ seq: 3 });
  });

  it("does not rotate a file that is still under the limit", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir, maxBytes: 5_000, keep: 3 });
    for (let n = 0; n < 5; n++) logInfo("agent.turn", "answered", { seq: n });
    const path = logFilePath()!;
    expect(lines(path)).toHaveLength(5);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("starts over rather than growing when only one file is kept", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir, maxBytes: 100, keep: 1 });
    for (let n = 0; n < 4; n++) {
      logInfo("agent.turn", "failed", { seq: n, pad: "x".repeat(200) });
    }
    const path = logFilePath()!;
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(lines(path)).toHaveLength(1);
    expect(lines(path)[0]).toMatchObject({ seq: 3 });
  });

  it("picks up the size of a log an earlier run left behind", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir, maxBytes: 300, keep: 3 });
    logInfo("agent.turn", "failed", { seq: 0, pad: "x".repeat(400) });
    // A restart. The file is already over the limit, so the next line must
    // rotate rather than append to it for ever.
    configureLog({ dataDir, maxBytes: 300, keep: 3 });
    logInfo("agent.turn", "failed", { seq: 1 });
    const path = logFilePath()!;
    expect(lines(path)).toHaveLength(1);
    expect(lines(path)[0]).toMatchObject({ seq: 1 });
    expect(lines(`${path}.1`)[0]).toMatchObject({ seq: 0 });
  });
});

describe("what may never reach the disk", () => {
  it("masks credentials in text a child process produced", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir });
    logError("agent.turn", "failed", {
      agent: "agy",
      stderrTail: [
        "GET /v1/models 401",
        "authorization: Bearer abcdef0123456789abcdef",
        "using api_key=sk-proj-Zm9vYmFyYmF6cXV4MTIzNDU2",
        "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      ].join("\n"),
    });
    const written = readFileSync(logFilePath()!, "utf8");

    for (const secret of [
      "abcdef0123456789abcdef",
      "sk-proj-Zm9vYmFyYmF6cXV4MTIzNDU2",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "eyJhbGciOiJIUzI1NiJ9",
    ]) {
      expect(written).not.toContain(secret);
    }
    // Still useful afterwards: the status code is what says why the turn died.
    expect(written).toContain("401");
    expect(written).toContain("[redacted]");
  });

  it("caps a string field so a child cannot decide how long a line is", () => {
    const dataDir = tempDataDir();
    configureLog({ dataDir });
    logError("agent.turn", "failed", { stderrTail: "y".repeat(5_000) });
    const tail = String(lines(logFilePath()!)[0].stderrTail);
    expect(tail.length).toBeLessThan(1_200);
    expect(tail).toContain("more]");
  });

  it("refuses any field that is not a scalar", () => {
    // The discipline that keeps message bodies, parsed mail and tool results
    // out of the file is that there is no way to put one in. An object is not
    // an identifier, whatever it holds.
    const dataDir = tempDataDir();
    configureLog({ dataDir });
    log("error", "agent.turn", "failed", {
      // Exactly what a careless call site would hand over.
      body: { subject: "Invoice", text: "Wire the money" },
      recipients: ["a@example.com"],
      agent: "agy",
    } as never);
    const written = readFileSync(logFilePath()!, "utf8");
    expect(written).not.toContain("Wire the money");
    expect(written).not.toContain("a@example.com");
    expect(written).toContain("[unloggable]");
    expect(written).toContain("agy");
  });

  it("keeps one event on one line, whatever the child printed", () => {
    // NDJSON only works if a line break inside a value cannot forge a record.
    const dataDir = tempDataDir();
    configureLog({ dataDir });
    logError("agent.turn", "failed", { stderrTail: 'a\nb\n{"level":"info"}' });
    expect(readFileSync(logFilePath()!, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("redacts without a sink configured too", () => {
    // `redact` is the rule, not a step in the write path, so a later caller
    // cannot get an unredacted value by reaching for it directly.
    expect(redact("Authorization: Bearer sekret-token-value")).not.toContain("sekret");
  });
});

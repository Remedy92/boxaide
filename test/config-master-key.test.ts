import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFirst, loadConfig } from "../src/config.js";

const PASSPHRASE = "correct horse battery staple";
/** sha256(PASSPHRASE) — what Boxaide used as the key before scrypt. */
const LEGACY_SHA256_OF_PASSPHRASE =
  "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a";

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "mailmux-key-"));
}

function keyFor(envKey: string, dir = newDir()): Buffer {
  process.env.BOXAIDE_MASTER_KEY = envKey;
  return loadConfig({ dataDir: dir }).masterKey;
}

afterEach(() => {
  delete process.env.BOXAIDE_MASTER_KEY;
  delete process.env.SLEY_MASTER_KEY;
  delete process.env.MAILMUX_MASTER_KEY;
  delete process.env.BOXAIDE_DATA_DIR;
  delete process.env.SLEY_DATA_DIR;
  delete process.env.MAILMUX_DATA_DIR;
  delete process.env.BOXAIDE_HOST;
  delete process.env.SLEY_HOST;
  delete process.env.MAILMUX_HOST;
  delete process.env.BOXAIDE_TOKEN;
  delete process.env.SLEY_TOKEN;
  delete process.env.MAILMUX_TOKEN;
});

describe("BOXAIDE_MASTER_KEY", () => {
  it("uses a 64-char hex value as the key verbatim", () => {
    const hex = "a".repeat(64);
    expect(keyFor(hex).toString("hex")).toBe(hex);
  });

  it("writes no salt file for a hex key", () => {
    const dir = newDir();
    keyFor("b".repeat(64), dir);
    expect(existsSync(join(dir, "master.salt"))).toBe(false);
  });

  it("stretches a passphrase instead of hashing it once", () => {
    const key = keyFor(PASSPHRASE);
    expect(key).toHaveLength(32);
    // A single hash is guessable at billions of tries per second, so the key
    // must no longer be the value the old derivation produced. The constant is
    // written out rather than computed: calling createHash on a passphrase is
    // the very thing this test exists to forbid, and CodeQL is right to flag
    // that pattern wherever it appears.
    expect(key.toString("hex")).not.toBe(LEGACY_SHA256_OF_PASSPHRASE);
  });

  it("derives the same key from the same passphrase in the same data dir", () => {
    // Stored secrets are decrypted on the next start, so derivation must be
    // stable across runs against one data directory.
    const dir = newDir();
    expect(keyFor("a passphrase", dir).toString("hex")).toBe(
      keyFor("a passphrase", dir).toString("hex"),
    );
  });

  it("derives a different key per install from the same passphrase", () => {
    // The salt is per-install, so one precomputed table cannot cover two
    // installs and cracking one says nothing about the other.
    expect(keyFor("a passphrase", newDir()).toString("hex")).not.toBe(
      keyFor("a passphrase", newDir()).toString("hex"),
    );
  });

  it("never overwrites a salt that is already there", () => {
    // The loser of a race between two starting processes must adopt the salt
    // the winner wrote, not replace it — replacing it would derive a key that
    // does not match the one the stored secrets were encrypted under.
    const dir = newDir();
    const existing = "0".repeat(31) + "1";
    writeFileSync(join(dir, "master.salt"), existing, { mode: 0o600 });
    const key = keyFor(PASSPHRASE, dir);
    expect(readFileSync(join(dir, "master.salt"), "utf8")).toBe(existing);
    expect(key.toString("hex")).toBe(keyFor(PASSPHRASE, dir).toString("hex"));
  });

  it("stores the salt beside the database, owner-readable only", () => {
    const dir = newDir();
    keyFor("a passphrase", dir);
    const saltPath = join(dir, "master.salt");
    expect(existsSync(saltPath)).toBe(true);
    expect(statSync(saltPath).mode & 0o777).toBe(0o600);
  });

  it("falls back to SLEY_MASTER_KEY then MAILMUX_MASTER_KEY", () => {
    process.env.SLEY_MASTER_KEY = "c".repeat(64);
    expect(loadConfig({ dataDir: newDir() }).masterKey.toString("hex")).toBe(
      "c".repeat(64),
    );
    delete process.env.SLEY_MASTER_KEY;
    process.env.MAILMUX_MASTER_KEY = "d".repeat(64);
    expect(loadConfig({ dataDir: newDir() }).masterKey.toString("hex")).toBe(
      "d".repeat(64),
    );
  });

  it("prefers BOXAIDE_MASTER_KEY over SLEY_MASTER_KEY", () => {
    process.env.BOXAIDE_MASTER_KEY = "a".repeat(64);
    process.env.SLEY_MASTER_KEY = "b".repeat(64);
    process.env.MAILMUX_MASTER_KEY = "c".repeat(64);
    expect(loadConfig({ dataDir: newDir() }).masterKey.toString("hex")).toBe(
      "a".repeat(64),
    );
  });
});

describe("envFirst and data dir", () => {
  it("reads BOXAIDE_* before SLEY_* before MAILMUX_*", () => {
    process.env.BOXAIDE_HOST = "10.0.0.1";
    process.env.SLEY_HOST = "10.0.0.2";
    process.env.MAILMUX_HOST = "10.0.0.3";
    expect(envFirst("BOXAIDE_HOST", "SLEY_HOST", "MAILMUX_HOST")).toBe("10.0.0.1");
    expect(loadConfig({ dataDir: newDir() }).host).toBe("10.0.0.1");
  });

  it("uses MAILMUX_DATA_DIR when BOXAIDE_DATA_DIR is unset", () => {
    const dir = newDir();
    process.env.MAILMUX_DATA_DIR = dir;
    expect(loadConfig().dataDir).toBe(dir);
  });
});

describe("generated secret files", () => {
  it("creates the master key and bearer token owner-readable only", () => {
    const dir = newDir();
    loadConfig({ dataDir: dir });
    for (const name of ["master.key", "bearer.token"]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the same key and token across runs", () => {
    const dir = newDir();
    const first = loadConfig({ dataDir: dir });
    const second = loadConfig({ dataDir: dir });
    expect(second.masterKey.toString("hex")).toBe(first.masterKey.toString("hex"));
    expect(second.bearerToken).toBe(first.bearerToken);
  });

  it("adopts a key and token that another process wrote first", () => {
    // The loser of a first-run race must use what is on disk. Overwriting the
    // master key would leave it unable to decrypt the secrets already stored
    // under the winner's key.
    const dir = newDir();
    const key = "b".repeat(64);
    const token = "a-token-another-process-wrote";
    writeFileSync(join(dir, "master.key"), key, { mode: 0o600 });
    writeFileSync(join(dir, "bearer.token"), token, { mode: 0o600 });

    const config = loadConfig({ dataDir: dir });
    expect(config.masterKey.toString("hex")).toBe(key);
    expect(config.bearerToken).toBe(token);
    expect(readFileSync(join(dir, "master.key"), "utf8")).toBe(key);
    expect(readFileSync(join(dir, "bearer.token"), "utf8")).toBe(token);
  });

  it("still creates the data directory when it is missing", () => {
    const dir = join(newDir(), "nested", "mailmux");
    expect(loadConfig({ dataDir: dir }).bearerToken).toBeTruthy();
    expect(existsSync(join(dir, "bearer.token"))).toBe(true);
  });
});

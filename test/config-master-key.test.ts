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
import { loadConfig } from "../src/config.js";

const PASSPHRASE = "correct horse battery staple";
/** sha256(PASSPHRASE) — what mailmux used as the key before scrypt. */
const LEGACY_SHA256_OF_PASSPHRASE =
  "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a";

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "mailmux-key-"));
}

function keyFor(envKey: string, dir = newDir()): Buffer {
  process.env.MAILMUX_MASTER_KEY = envKey;
  return loadConfig({ dataDir: dir }).masterKey;
}

afterEach(() => {
  delete process.env.MAILMUX_MASTER_KEY;
});

describe("MAILMUX_MASTER_KEY", () => {
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
});

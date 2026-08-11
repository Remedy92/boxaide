import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

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
    const passphrase = "correct horse battery staple";
    const key = keyFor(passphrase);
    expect(key).toHaveLength(32);
    // The old derivation. A single hash is guessable at billions of tries per
    // second, so the key must no longer be this value.
    const singleHash = createHash("sha256").update(passphrase).digest();
    expect(key.equals(singleHash)).toBe(false);
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

  it("stores the salt beside the database, owner-readable only", () => {
    const dir = newDir();
    keyFor("a passphrase", dir);
    const saltPath = join(dir, "master.salt");
    expect(existsSync(saltPath)).toBe(true);
    expect(statSync(saltPath).mode & 0o777).toBe(0o600);
  });
});

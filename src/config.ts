import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Origins the browser UI may be served from, beyond loopback.
 * Comma-separated absolute origins in MAILMUX_ALLOWED_ORIGINS, e.g.
 *   https://mailmux-web.vercel.app,https://mail.example.com
 * Defaults to closed: an unset value keeps today's loopback-only behaviour.
 * "*" is deliberately dropped — an any-origin allowlist removes the only
 * defence left against DNS rebinding on a loopback service.
 *
 * This lives in config, not in the route module: it parses an environment
 * variable and knows nothing about HTTP, and importing it from `api/routes.ts`
 * pulled Hono and every route into the config module.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value || value === "*") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    // Only https survives: a plaintext allowlisted origin is trivially spoofed.
    if (url.protocol !== "https:") continue;
    out.push(url.origin.toLowerCase());
  }
  return out;
}

export type AppConfig = {
  dataDir: string;
  host: string;
  port: number;
  masterKey: Buffer;
  bearerToken: string;
  fixtureMode: boolean;
  /**
   * Extra browser origins allowed to call the authenticated API, from
   * MAILMUX_ALLOWED_ORIGINS. Empty by default: loopback only.
   */
  allowedOrigins: string[];
  /**
   * Directory holding the built UI. Normally left unset and discovered from
   * `web-next/`. Set it to pin the lookup — tests use it to exercise both the
   * present and the missing case without depending on a build artifact.
   */
  webRoot?: string;
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * The per-install scrypt salt, created on first use.
 *
 * A salt is not a secret, so keeping it beside the database costs nothing. It
 * still does the two jobs that matter against an attacker who holds both: no
 * precomputed table works, because the table would have to be built for this
 * one file, and the same passphrase on two installs derives two different
 * keys. Only the passphrase and the work factor stand between the attacker
 * and the key, and that is what scrypt is priced for.
 *
 * Deleting this file makes stored mail passwords underivable. It sits in the
 * data directory next to `master.key`, so anything that backs one up takes
 * the other.
 */
function loadOrCreateSalt(dataDir: string): Buffer {
  const saltPath = join(dataDir, "master.salt");
  if (existsSync(saltPath)) {
    return Buffer.from(readFileSync(saltPath, "utf8").trim(), "hex");
  }
  const salt = randomBytes(16);
  writeFileSync(saltPath, salt.toString("hex"), { mode: 0o600 });
  return salt;
}

/**
 * Stretch a human passphrase into a 32-byte AES key.
 *
 * A single hash is wrong here: a passphrase carries far less entropy than the
 * key it produces, and one SHA-256 lets an attacker holding the database try
 * billions of guesses per second. scrypt makes each guess cost memory and
 * time. The parameters below need 128 MB per guess, which is the part an
 * attacker cannot buy their way around cheaply, and cost about 0.2s once at
 * startup on a 2024 laptop.
 *
 * A 64-char random hex MAILMUX_MASTER_KEY skips derivation altogether and
 * stays the documented recommendation.
 */
function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, {
    N: 2 ** 17,
    r: 8,
    p: 1,
    maxmem: 192 * 1024 * 1024,
  });
}

function loadOrCreateKey(dataDir: string): Buffer {
  const envKey = process.env.MAILMUX_MASTER_KEY;
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) return Buffer.from(envKey, "hex");
    return deriveKeyFromPassphrase(envKey, loadOrCreateSalt(dataDir));
  }
  const keyPath = join(dataDir, "master.key");
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

function loadOrCreateToken(dataDir: string): string {
  if (process.env.MAILMUX_TOKEN) return process.env.MAILMUX_TOKEN;
  const tokenPath = join(dataDir, "bearer.token");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = expandHome(
    overrides.dataDir ?? process.env.MAILMUX_DATA_DIR ?? "~/.mailmux",
  );
  const memory = dataDir === ":memory:";
  if (!memory) ensureDir(dataDir);
  const masterKey =
    overrides.masterKey ??
    (memory ? randomBytes(32) : loadOrCreateKey(dataDir));
  const bearerToken =
    overrides.bearerToken ??
    (memory ? randomBytes(16).toString("base64url") : loadOrCreateToken(dataDir));
  return {
    dataDir,
    host: overrides.host ?? process.env.MAILMUX_HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.MAILMUX_PORT ?? 8787),
    masterKey,
    bearerToken,
    fixtureMode:
      overrides.fixtureMode ??
      (process.env.MAILMUX_FIXTURE === "1" ||
        process.env.MAILMUX_FIXTURE === "true"),
    allowedOrigins:
      overrides.allowedOrigins ??
      parseAllowedOrigins(process.env.MAILMUX_ALLOWED_ORIGINS),
    webRoot: overrides.webRoot ?? process.env.MAILMUX_WEB_ROOT,
  };
}

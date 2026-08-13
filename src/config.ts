import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * First non-empty environment value: the Sley name, then the Mailmux fallback.
 */
export function envFirst(sleyKey: string, mailmuxKey: string): string | undefined {
  const next = process.env[sleyKey];
  if (next) return next;
  const prev = process.env[mailmuxKey];
  if (prev) return prev;
  return undefined;
}

/**
 * Origins the browser UI may be served from, beyond loopback.
 * Comma-separated absolute origins in SLEY_ALLOWED_ORIGINS (MAILMUX_* if
 * unset), e.g. https://sley.vercel.app,https://mail.example.com
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
   * SLEY_ALLOWED_ORIGINS (MAILMUX_ALLOWED_ORIGINS if unset). Empty by
   * default: loopback only.
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
  // `recursive` already succeeds on an existing directory, so an existence
  // check would only add a window for someone else to create it first.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Read a generated secret from `path`, creating it on first use.
 *
 * The three files this manages — master key, scrypt salt, bearer token — are
 * generated once and then depended on forever, so first-run creation must not
 * race. Checking existence and then writing loses that race: two processes
 * starting together (the desktop app and a `sley serve`, say) both find no
 * file, both generate, both write, and the loser proceeds with a value that is
 * no longer the one on disk. For the master key or the salt that means
 * deriving a key that does not match the one the stored mail passwords were
 * encrypted under.
 *
 * So absence is an ENOENT from the read, and creation is `wx`, which fails
 * rather than truncating when the file appeared in between. Whoever creates
 * the file wins and everyone else reads what they wrote. The loop runs twice
 * at most in practice: once to find it missing, once to read the winner's.
 */
function loadOrCreateSecretFile(path: string, generate: () => string): string {
  for (;;) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const value = generate();
    try {
      writeFileSync(path, value, { mode: 0o600, flag: "wx" });
      return value;
    } catch (err) {
      // Someone created it between the read and the write. Read theirs.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
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
  const hex = loadOrCreateSecretFile(join(dataDir, "master.salt"), () =>
    randomBytes(16).toString("hex"),
  );
  return Buffer.from(hex, "hex");
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
 * A 64-char random hex SLEY_MASTER_KEY skips derivation altogether and
 * stays the documented recommendation. MAILMUX_MASTER_KEY is still read
 * when SLEY_MASTER_KEY is unset.
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
  const envKey = envFirst("SLEY_MASTER_KEY", "MAILMUX_MASTER_KEY");
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) return Buffer.from(envKey, "hex");
    return deriveKeyFromPassphrase(envKey, loadOrCreateSalt(dataDir));
  }
  const hex = loadOrCreateSecretFile(join(dataDir, "master.key"), () =>
    randomBytes(32).toString("hex"),
  );
  return Buffer.from(hex, "hex");
}

function loadOrCreateToken(dataDir: string): string {
  const envToken = envFirst("SLEY_TOKEN", "MAILMUX_TOKEN");
  if (envToken) return envToken;
  return loadOrCreateSecretFile(join(dataDir, "bearer.token"), () =>
    randomBytes(24).toString("base64url"),
  );
}

/**
 * SLEY_DATA_DIR, else MAILMUX_DATA_DIR, else ~/.sley if it exists, else
 * ~/.mailmux if it exists, else ~/.sley.
 */
export function resolveDefaultDataDir(): string {
  const fromEnv = envFirst("SLEY_DATA_DIR", "MAILMUX_DATA_DIR");
  if (fromEnv) return expandHome(fromEnv);
  const next = join(homedir(), ".sley");
  const prev = join(homedir(), ".mailmux");
  if (existsSync(next)) return next;
  if (existsSync(prev)) return prev;
  return next;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = expandHome(overrides.dataDir ?? resolveDefaultDataDir());
  const memory = dataDir === ":memory:";
  if (!memory) ensureDir(dataDir);
  const masterKey =
    overrides.masterKey ??
    (memory ? randomBytes(32) : loadOrCreateKey(dataDir));
  const bearerToken =
    overrides.bearerToken ??
    (memory ? randomBytes(16).toString("base64url") : loadOrCreateToken(dataDir));
  const fixture = envFirst("SLEY_FIXTURE", "MAILMUX_FIXTURE");
  return {
    dataDir,
    host: overrides.host ?? envFirst("SLEY_HOST", "MAILMUX_HOST") ?? "127.0.0.1",
    port: overrides.port ?? Number(envFirst("SLEY_PORT", "MAILMUX_PORT") ?? 8787),
    masterKey,
    bearerToken,
    fixtureMode:
      overrides.fixtureMode ?? (fixture === "1" || fixture === "true"),
    allowedOrigins:
      overrides.allowedOrigins ??
      parseAllowedOrigins(envFirst("SLEY_ALLOWED_ORIGINS", "MAILMUX_ALLOWED_ORIGINS")),
    webRoot: overrides.webRoot ?? envFirst("SLEY_WEB_ROOT", "MAILMUX_WEB_ROOT"),
  };
}

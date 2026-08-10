import { createHash, randomBytes } from "node:crypto";
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
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadOrCreateKey(dataDir: string): Buffer {
  const envKey = process.env.MAILMUX_MASTER_KEY;
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) return Buffer.from(envKey, "hex");
    return createHash("sha256").update(envKey).digest();
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
  };
}

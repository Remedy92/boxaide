import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  dataDir: string;
  host: string;
  port: number;
  masterKey: Buffer;
  bearerToken: string;
  fixtureMode: boolean;
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
  };
}

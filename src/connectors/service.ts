/**
 * ConnectorsService: which provider keys this server has, and where each one
 * came from.
 *
 * Settings beat the environment. An operator who typed a key into the
 * Connectors screen means that key, and the env variable stays as the
 * fallback for a headless install that never opens the UI.
 *
 * Every read hits SQLite, which is local and synchronous, so nothing is
 * cached: a key saved in settings must change the answer of the very next
 * call, including isConfigured() on the services that depend on it. Caching
 * here would put a restart back in the way, which is the thing this replaces.
 */
import { envNamed } from "../config.js";
import { unreachable, type ConnectorProbe } from "./probe.js";
import { probeFor } from "./probes.js";
import type { ConnectorStore } from "./store.js";
import {
  CONNECTORS,
  connectorById,
  maskKey,
  type Connector,
  type ConnectorCheck,
  type ConnectorCheckMap,
} from "./types.js";

export class ConnectorsService {
  constructor(
    private store: ConnectorStore,
    /** Injection seam for tests. Production reads BOXAIDE_*, SLEY_*, MAILMUX_*. */
    private readEnv: (suffix: string) => string | undefined = envNamed,
    /** Injection seam for tests. Production asks the provider adapters. */
    private findProbe: (id: string) => ConnectorProbe | undefined = probeFor,
  ) {}

  /** The key in use for one provider: settings first, then the environment. */
  getKey(id: string): string | undefined {
    const def = connectorById(id);
    if (!def) return undefined;
    const stored = this.store.getKey(id);
    if (stored) return stored;
    const fromEnv = this.readEnv(def.envSuffix);
    return fromEnv === "" ? undefined : fromEnv;
  }

  /** The REST read shape for every connector. Masked keys only. */
  list(): Connector[] {
    return CONNECTORS.map((def) => this.describe(def.id));
  }

  /** One connector in the same shape as list(). Throws on an unknown id. */
  describe(id: string): Connector {
    const def = connectorById(id);
    if (!def) throw new Error(`unknown connector: ${id}`);
    const stored = this.store.getKey(id);
    const key = stored ?? this.readEnv(def.envSuffix) ?? "";
    return {
      id: def.id,
      label: def.label,
      kind: def.kind,
      configured: key !== "",
      source: key === "" ? null : stored ? "settings" : "env",
      maskedKey: key === "" ? null : maskKey(key),
    };
  }

  /**
   * Save a key, or clear it when the value is empty. Clearing falls the
   * provider back to its environment variable rather than turning it off, so
   * the answer after a clear is whatever a fresh install would have said.
   */
  setKey(id: string, apiKey: string | null | undefined): Connector {
    const def = connectorById(id);
    if (!def) throw new Error(`unknown connector: ${id}`);
    const value = (apiKey ?? "").trim();
    // The verdict was about the old key, so it dies with it. Keeping it would
    // let a working answer sit beside a key nobody has checked.
    this.store.clearCheck(id);
    if (value === "") this.store.clearKey(id);
    else this.store.setKey(id, value);
    return this.describe(id);
  }

  /**
   * The stored verdict for one connector, or null.
   *
   * A verdict is only returned while it is still about the key in force. The
   * mask is the test: a key replaced since the check reads as unchecked rather
   * than borrowing the answer the old one earned.
   */
  checkOf(id: string): ConnectorCheck | null {
    const key = this.getKey(id);
    if (!key) return null;
    const stored = this.store.getCheck(id);
    if (!stored) return null;
    return stored.maskedKey === maskKey(key) ? stored : null;
  }

  /** Every stored verdict still in force, keyed by connector id. */
  checks(): ConnectorCheckMap {
    const out: ConnectorCheckMap = {};
    for (const def of CONNECTORS) {
      const check = this.checkOf(def.id);
      if (check) out[def.id] = check;
    }
    return out;
  }

  /**
   * Ask the provider whether the key in force works, and remember the answer.
   *
   * The key checked is whichever one is in force, so a key set where the
   * server was started is checked exactly like a pasted one. The key itself
   * never leaves this method: what is stored and returned is a verdict, the
   * provider's own words, and the last four characters.
   *
   * Returns null when there is no key to check. A probe never throws, but an
   * adapter that somehow does is reported as "could not reach", because a
   * failure inside Boxaide is not evidence against the operator's key.
   */
  async check(id: string): Promise<ConnectorCheck | null> {
    const def = connectorById(id);
    if (!def) throw new Error(`unknown connector: ${id}`);
    const key = this.getKey(id);
    if (!key) return null;
    const probe = this.findProbe(id);
    const result = probe
      ? await probe(key).catch((err: unknown) =>
          unreachable(err instanceof Error ? err.message : String(err)),
        )
      : unreachable(`Boxaide has no way to check ${def.label}.`);
    const check: ConnectorCheck = {
      verdict: result.verdict,
      reason: redact(result.reason, key),
      checkedAt: new Date().toISOString(),
      maskedKey: maskKey(key),
    };
    this.store.setCheck(id, check);
    return check;
  }

  /** True when at least one search back end has a key today. */
  hasSearchConnector(): boolean {
    return CONNECTORS.filter((def) => def.kind === "search").some((def) =>
      Boolean(this.getKey(def.id)),
    );
  }
}

/**
 * The key out of the provider's own words.
 *
 * Hunter takes its key in the query string, so an error body that echoes the
 * request echoes the key with it. The reason is shown in Settings and stored
 * on disk, and neither is a place a key belongs.
 */
function redact(reason: string | null, key: string): string | null {
  if (reason === null) return null;
  const cleaned = reason.split(key).join(maskKey(key));
  return cleaned.trim() === "" ? null : cleaned;
}

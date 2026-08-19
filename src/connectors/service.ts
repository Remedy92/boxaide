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
import type { ConnectorStore } from "./store.js";
import { CONNECTORS, connectorById, maskKey, type Connector } from "./types.js";

export class ConnectorsService {
  constructor(
    private store: ConnectorStore,
    /** Injection seam for tests. Production reads BOXAIDE_*, SLEY_*, MAILMUX_*. */
    private readEnv: (suffix: string) => string | undefined = envNamed,
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
    if (value === "") this.store.clearKey(id);
    else this.store.setKey(id, value);
    return this.describe(id);
  }

  /** True when at least one search back end has a key today. */
  hasSearchConnector(): boolean {
    return CONNECTORS.filter((def) => def.kind === "search").some((def) =>
      Boolean(this.getKey(def.id)),
    );
  }
}

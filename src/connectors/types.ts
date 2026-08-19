/**
 * The connector registry: the four paid back ends an operator can turn on.
 *
 * This list is the only authority on which ids exist. Routes validate against
 * it, the settings screen renders it, and the services ask it for the env
 * variable that still works as a fallback. Adding a fifth provider is one
 * entry here plus the adapter in its own module.
 *
 * `envSuffix` is the suffix passed to envNamed() in src/config.ts, so the
 * documented BOXAIDE_* name is that prefix plus this.
 */
export type ConnectorKind = "enrichment" | "search";

export type ConnectorDef = {
  id: string;
  label: string;
  kind: ConnectorKind;
  /** Suffix for envNamed(), e.g. "HUNTER_API_KEY" for BOXAIDE_HUNTER_API_KEY. */
  envSuffix: string;
};

/** Where the key in use came from. null when no key is set anywhere. */
export type ConnectorSource = "settings" | "env";

/** The read shape returned over HTTP. It never carries a full key. */
export type Connector = {
  id: string;
  label: string;
  kind: ConnectorKind;
  configured: boolean;
  source: ConnectorSource | null;
  /** Last four characters only, e.g. "****abcd". */
  maskedKey: string | null;
};

export const CONNECTORS: readonly ConnectorDef[] = [
  { id: "hunter", label: "Hunter", kind: "enrichment", envSuffix: "HUNTER_API_KEY" },
  { id: "prospeo", label: "Prospeo", kind: "enrichment", envSuffix: "PROSPEO_API_KEY" },
  { id: "exa", label: "Exa", kind: "search", envSuffix: "EXA_API_KEY" },
  { id: "parallel", label: "Parallel", kind: "search", envSuffix: "PARALLEL_API_KEY" },
];

export function connectorById(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((entry) => entry.id === id);
}

/**
 * Last four characters, nothing else. A key too short to have four is shown
 * as the mask alone rather than as most of itself.
 */
export function maskKey(key: string): string {
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

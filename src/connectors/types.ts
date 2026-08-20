/**
 * The connector registry: the paid back ends an operator can turn on.
 *
 * This list is the only authority on which ids exist. Routes validate against
 * it, the settings screen renders it, and the services ask it for the env
 * variable that still works as a fallback. Adding another provider is one
 * entry here plus the adapter in its own module.
 *
 * `envSuffix` is the suffix passed to envNamed() in src/config.ts, so the
 * documented BOXAIDE_* name is that prefix plus this.
 */
import type { ConnectorProbeVerdict } from "./probe.js";

export type { ConnectorProbeVerdict };

/**
 * What a connector is for. 'prospecting' is finding people and companies
 * nobody named yet, which is neither of the other two: enrichment answers a
 * question about a person you already have, and search reads the public web.
 */
export type ConnectorKind = "enrichment" | "search" | "prospecting";

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

/**
 * The last answer a provider gave about the key in force for a connector.
 *
 * `maskedKey` is what makes a stored verdict safe to show later: it says which
 * key the verdict was about, so a key replaced since is reported as unchecked
 * rather than inheriting the old answer.
 */
export type ConnectorCheck = {
  verdict: ConnectorProbeVerdict;
  /** The provider's own reason for refusing, trimmed. Null when it gave none. */
  reason: string | null;
  /** ISO timestamp of the check. */
  checkedAt: string;
  /** Last four characters of the key that was checked. */
  maskedKey: string;
};

/** Stored verdicts by connector id. Only ids that have one appear. */
export type ConnectorCheckMap = Record<string, ConnectorCheck>;

export const CONNECTORS: readonly ConnectorDef[] = [
  { id: "hunter", label: "Hunter", kind: "enrichment", envSuffix: "HUNTER_API_KEY" },
  { id: "prospeo", label: "Prospeo", kind: "enrichment", envSuffix: "PROSPEO_API_KEY" },
  { id: "exa", label: "Exa", kind: "search", envSuffix: "EXA_API_KEY" },
  { id: "parallel", label: "Parallel", kind: "search", envSuffix: "PARALLEL_API_KEY" },
  { id: "apollo", label: "Apollo", kind: "prospecting", envSuffix: "APOLLO_API_KEY" },
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

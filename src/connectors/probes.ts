/**
 * Which probe belongs to which connector id.
 *
 * The registry in types.ts says an id exists; this says how to find out
 * whether its key works. They are kept apart because the adapters live in the
 * feature modules they belong to, and importing all five of them into the
 * registry would make every reader of the connector list load Apollo, Hunter,
 * Prospeo, Exa and Parallel to learn five names and five env variables.
 *
 * An id with no probe here can still hold a key. It simply cannot be checked,
 * and the service says that rather than pretending the key is fine.
 */
import { probeHunter } from "../enrichment/hunter.js";
import { probeProspeo } from "../enrichment/prospeo.js";
import { probeApollo } from "../prospecting/apollo.js";
import { probeExa, probeParallel } from "../research/providers.js";
import type { ConnectorProbe } from "./probe.js";

const PROBES: Record<string, ConnectorProbe> = {
  apollo: (apiKey) => probeApollo(apiKey),
  hunter: (apiKey) => probeHunter(apiKey),
  prospeo: (apiKey) => probeProspeo(apiKey),
  exa: (apiKey) => probeExa(apiKey),
  parallel: (apiKey) => probeParallel(apiKey),
};

/** The probe for one connector, or undefined when that id has none. */
export function probeFor(id: string): ConnectorProbe | undefined {
  return PROBES[id];
}

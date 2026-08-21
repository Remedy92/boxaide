/**
 * ResearchService: pick a search provider, run a search, read a page.
 *
 * No store and no timers. This module keeps nothing: a search result is a
 * fact about the outside world at one moment, and writing it to SQLite would
 * mean encrypting it (spec invariant 3), ageing it out, and answering
 * questions about whose copy is right. Anything worth keeping goes into the
 * CRM as a note, by an agent that decided it was worth keeping.
 *
 * Construction: new ResearchService() takes the real providers and real DNS.
 * A test passes deps. See docs/specs/agent-platform.md for the module seams.
 */
import { fetchPage, type FetchPageDeps } from "./fetch-page.js";
import { allProviders, EXA_ENV_KEY, PARALLEL_ENV_KEY, type ProviderDeps } from "./providers.js";
import type { FetchedPage, SearchProvider, SearchResult } from "./types.js";

/** Hits returned when the caller does not say. */
export const DEFAULT_NUM_RESULTS = 5;
/**
 * Hits returned at most. Ten results with a thousand characters of snippet
 * each is already a long tool response, and an agent that needs more of the
 * web should search again with a better query rather than read further down a
 * worse ranking.
 */
export const MAX_NUM_RESULTS = 10;

/**
 * The two HTTP seams are named apart on purpose.
 *
 * ProviderDeps and FetchPageDeps both call theirs `fetch`, so intersecting
 * them gave one key that silently drove both. A caller stubbing Exa would also
 * have replaced the transport behind web_fetch, and that transport IS the SSRF
 * guard: fetchPage takes `deps.fetch ?? nodeFetch(resolve)`, so the stub would
 * turn off connect-time address vetting without anybody asking it to. Two
 * names means a stub reaches exactly what it meant to reach.
 */
export type ResearchDeps = Omit<ProviderDeps, "fetch"> &
  Omit<FetchPageDeps, "fetch"> & {
    /** Overrides the built-in Exa and Parallel adapters wholesale. */
    providers?: SearchProvider[];
    /** Injection seam for the search providers' HTTP client. Tests only. */
    providerFetch?: typeof globalThis.fetch;
    /**
     * Injection seam for the page transport behind web_fetch. Tests only, and
     * setting it removes the SSRF guard for this service: production leaves it
     * absent so fetchPage builds the vetting transport itself.
     */
    pageFetch?: typeof globalThis.fetch;
  };

export type SearchArgs = {
  query: string;
  numResults?: number;
  provider?: string;
};

export class ResearchService {
  private providers: SearchProvider[];
  private fetchDeps: FetchPageDeps;

  constructor(deps: ResearchDeps = {}) {
    this.providers =
      deps.providers ??
      allProviders({ fetch: deps.providerFetch, apiKey: deps.apiKey, getKey: deps.getKey });
    this.fetchDeps = { fetch: deps.pageFetch, resolve: deps.resolve };
  }

  /** Provider ids in preference order, and whether each has a key today. */
  listProviders(): Array<{ id: string; configured: boolean }> {
    return this.providers.map((p) => ({ id: p.id, configured: p.isConfigured() }));
  }

  /**
   * The chosen back end. A named provider must exist and must have a key:
   * silently falling back to the other one would answer a question the caller
   * did not ask, with a different index. With no name, the first configured
   * provider wins.
   */
  select(requested?: string): SearchProvider {
    if (requested) {
      const wanted = requested.trim().toLowerCase();
      const found = this.providers.find((p) => p.id === wanted);
      if (!found) {
        const known = this.providers.map((p) => p.id).join(", ");
        throw new Error(`unknown search provider: ${requested} (known providers: ${known})`);
      }
      if (!found.isConfigured()) {
        throw new Error(
          `${found.id} is not configured: set ${envKeyFor(found.id)}, or add the key under Settings > Connectors.`,
        );
      }
      return found;
    }
    const configured = this.providers.find((p) => p.isConfigured());
    if (!configured) throw new Error(NO_PROVIDER_MESSAGE);
    return configured;
  }

  async search(args: SearchArgs): Promise<{
    provider: string;
    query: string;
    results: SearchResult[];
  }> {
    const query = args.query.trim();
    if (query === "") throw new Error("query is required");
    const provider = this.select(args.provider);
    const numResults = clampResults(args.numResults);
    const results = await provider.search(query, { numResults });
    return { provider: provider.id, query, results: results.slice(0, numResults) };
  }

  /** Reads one public URL. Every refusal is thrown, never returned as empty text. */
  async fetch(url: string): Promise<FetchedPage> {
    return fetchPage(url, this.fetchDeps);
  }
}

/**
 * Said in full whenever nothing is configured. An agent that reads only "no
 * provider" tells the user the tool is broken; an agent that reads this tells
 * the user which variable to set, which is the actual fix.
 */
export const NO_PROVIDER_MESSAGE =
  `no search provider is configured. Add a key under Settings > Connectors, or set ${PARALLEL_ENV_KEY} for ` +
  `Parallel or ${EXA_ENV_KEY} for Exa in the environment of the Boxaide server, and search again. Tell the ` +
  `user this; there is no other way to search from here.`;

function envKeyFor(id: string): string {
  if (id === "exa") return EXA_ENV_KEY;
  if (id === "parallel") return PARALLEL_ENV_KEY;
  return `BOXAIDE_${id.toUpperCase()}_API_KEY`;
}

/** Out-of-range values are clamped, not refused: a bad count is not worth a failed call. */
export function clampResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_NUM_RESULTS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  return whole > MAX_NUM_RESULTS ? MAX_NUM_RESULTS : whole;
}

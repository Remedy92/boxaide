/**
 * Search providers: Exa and Parallel, both plain REST over fetch, no SDK.
 *
 * Each one is a thin adapter down to the single SearchResult shape in types.ts.
 * The adapters are forgiving about what comes back, on purpose: these are
 * third-party JSON APIs that add fields between releases, and a missing
 * snippet is a thinner result, not a failed tool call. They are strict about
 * two things only, because both are silent failures otherwise: an HTTP error
 * is raised with the provider name and the status in the message, and a hit
 * with no URL is dropped rather than returned as a link to nowhere.
 *
 * Keys are read per call, not at construction: the Connectors screen writes
 * one to SQLite and the next search must use it, so adding a key never needs
 * a restart of a running serve process. The environment variable named below
 * stays as the fallback for a server nobody opens the UI on.
 */
import { envNamed } from "../config.js";
import {
  probeRequest,
  unreachable,
  verdictForStatus,
  type ConnectorProbeResult,
} from "../connectors/probe.js";
import type { SearchOptions, SearchProvider, SearchResult } from "./types.js";

const EXA_ENDPOINT = "https://api.exa.ai/search";
const PARALLEL_ENDPOINT = "https://api.parallel.ai/v1beta/search";

/** Characters of page text asked of a provider per hit. Enough for a snippet. */
const SNIPPET_CHARS = 1_000;

/** Named in the "nothing configured" error, so the operator is told what to set. */
export const EXA_ENV_KEY = "BOXAIDE_EXA_API_KEY";
export const PARALLEL_ENV_KEY = "BOXAIDE_PARALLEL_API_KEY";

export type ProviderDeps = {
  /** Injection seam for tests. Production uses the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Reads the API key of the one provider this deps object was handed to. */
  apiKey?: () => string | undefined;
  /**
   * Reads the API key for a named provider. Production passes the connectors
   * service, which answers from settings first and the environment second.
   * Called per search, so a key saved in Settings needs no restart.
   */
  getKey?: (providerId: string) => string | undefined;
};

/** apiKey wins when a test injected one; otherwise getKey, otherwise the env. */
function keyReader(
  deps: ProviderDeps,
  providerId: string,
  envSuffix: string,
): () => string | undefined {
  if (deps.apiKey) return deps.apiKey;
  const getKey = deps.getKey;
  if (getKey) return () => getKey(providerId);
  return () => envNamed(envSuffix);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** Trimmed to one snippet's worth so a search of ten hits stays readable. */
function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_CHARS ? collapsed.slice(0, SNIPPET_CHARS) : collapsed;
}

async function readJson(provider: string, res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${provider} search failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new Error(`${provider} search returned a body that is not JSON`);
  }
  return body as Record<string, unknown>;
}

function resultsArray(body: Record<string, unknown>): Record<string, unknown>[] {
  const raw = body.results;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Record<string, unknown> => {
    return typeof entry === "object" && entry !== null;
  });
}

/**
 * Exa. Neural and keyword search over its own index. `contents.text` asks for
 * page text alongside each hit, which is what fills the snippet: Exa's own
 * highlights are a separate paid-ish option and text is always there.
 */
export function exaProvider(deps: ProviderDeps = {}): SearchProvider {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const apiKey = keyReader(deps, "exa", "EXA_API_KEY");
  return {
    id: "exa",
    isConfigured: () => Boolean(apiKey()),
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const key = apiKey();
      if (!key) {
        throw new Error(
          `exa is not configured: set ${EXA_ENV_KEY}, or add the key under Settings > Connectors.`,
        );
      }
      const res = await doFetch(EXA_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          query,
          numResults: opts.numResults,
          contents: { text: { maxCharacters: SNIPPET_CHARS } },
        }),
      });
      const body = await readJson("exa", res);
      const out: SearchResult[] = [];
      for (const entry of resultsArray(body)) {
        const url = textOf(entry.url);
        if (url === "") continue;
        const published = firstString(entry.publishedDate, entry.published_date);
        out.push({
          title: firstString(entry.title) || url,
          url,
          snippet: snippet(firstString(entry.text, entry.snippet, entry.summary)),
          ...(published === "" ? {} : { publishedDate: published }),
        });
      }
      return out;
    },
  };
}

/**
 * Parallel's Search API. It answers an objective rather than a query string,
 * and returns ranked excerpts per URL instead of one blurb, so the excerpts
 * are joined into a single snippet. The query is passed as both the objective
 * and the one search query: giving it only the objective makes it paraphrase,
 * and the caller asked for what they asked for.
 */
export function parallelProvider(deps: ProviderDeps = {}): SearchProvider {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const apiKey = keyReader(deps, "parallel", "PARALLEL_API_KEY");
  return {
    id: "parallel",
    isConfigured: () => Boolean(apiKey()),
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const key = apiKey();
      if (!key) {
        throw new Error(
          `parallel is not configured: set ${PARALLEL_ENV_KEY}, or add the key under Settings > Connectors.`,
        );
      }
      const res = await doFetch(PARALLEL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          objective: query,
          search_queries: [query],
          processor: "base",
          max_results: opts.numResults,
          max_chars_per_result: SNIPPET_CHARS,
        }),
      });
      const body = await readJson("parallel", res);
      const out: SearchResult[] = [];
      for (const entry of resultsArray(body)) {
        const url = textOf(entry.url);
        if (url === "") continue;
        const excerpts = Array.isArray(entry.excerpts)
          ? entry.excerpts.map(textOf).filter(Boolean).join(" ")
          : "";
        const published = firstString(entry.published_date, entry.publishedDate, entry.date);
        out.push({
          title: firstString(entry.title) || url,
          url,
          snippet: snippet(firstString(excerpts, entry.excerpt, entry.snippet, entry.content)),
          ...(published === "" ? {} : { publishedDate: published }),
        });
      }
      return out;
    },
  };
}

/**
 * Every provider, in preference order, whether or not it has a key. Order is
 * the tie-break for an unspecified provider, so it is stated once here rather
 * than being an accident of how a Map iterated.
 */
export function allProviders(deps: ProviderDeps = {}): SearchProvider[] {
  return [exaProvider(deps), parallelProvider(deps)];
}

/**
 * The query both search probes send. It is a real query because both providers
 * only answer real ones, and a short harmless one because whatever is sent is
 * a search somebody pays for.
 */
const PROBE_QUERY = "example";

/**
 * Is this Exa key one Exa accepts?
 *
 * Exa publishes no free endpoint for checking a key, so the cheapest honest
 * check is the smallest real search: one result, and no page contents, which
 * is the part that carries the extra cost. That is a fraction of a penny per
 * check rather than nothing, and the Connectors screen says so before the
 * operator asks for it.
 */
export async function probeExa(
  apiKey: string,
  doFetch?: typeof globalThis.fetch,
): Promise<ConnectorProbeResult> {
  const reply = await probeRequest(
    EXA_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query: PROBE_QUERY, numResults: 1 }),
    },
    doFetch,
  );
  if (!reply.reached) return unreachable(reply.reason);
  return verdictForStatus(reply.status, reply.body);
}

/**
 * Is this Parallel key one Parallel accepts?
 *
 * The same bargain as Exa: Parallel has no free key-check endpoint either, so
 * this is one base-processor search for one result with the shortest excerpt
 * it will return, which is the least Parallel bills for.
 */
export async function probeParallel(
  apiKey: string,
  doFetch?: typeof globalThis.fetch,
): Promise<ConnectorProbeResult> {
  const reply = await probeRequest(
    PARALLEL_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        objective: PROBE_QUERY,
        search_queries: [PROBE_QUERY],
        processor: "base",
        max_results: 1,
        max_chars_per_result: 100,
      }),
    },
    doFetch,
  );
  if (!reply.reached) return unreachable(reply.reason);
  return verdictForStatus(reply.status, reply.body);
}

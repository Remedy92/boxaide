/**
 * Enrichment types: the provider seam and the one normalised result shape
 * every provider is flattened into. Surface: docs/specs/agent-platform.md.
 *
 * Providers disagree about everything. Hunter scores an address 0-100 and
 * calls the outcome "deliverable"; Prospeo answers "valid" with no score at
 * all. The rest of Boxaide should never learn either dialect, so the
 * translation happens once, in each provider, and the module only ever hands
 * out an EnrichmentResult.
 */

/** What a provider was asked to find an address for. */
export type FindEmailQuery = {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  /** Organisation domain, for example "acme.com". Providers need this. */
  domain: string;
};

/**
 * Confidence in the address, on one scale for every provider. A provider that
 * reports no number gets one derived from its status, so a waterfall can
 * compare two answers that were never meant to be compared.
 */
export type EnrichmentStatus = "valid" | "risky" | "unknown" | "invalid";

export type EnrichmentResult = {
  /** Lower-cased address, or null when the provider found nobody. */
  email: string | null;
  /** 0 to 100. Zero when the provider found nothing. */
  confidence: number;
  status: EnrichmentStatus;
  /** Provider id, for example "hunter". Says who to blame for a bad address. */
  provider: string;
  /**
   * The provider's own body, for debugging the call that made it. Never
   * persisted, and never returned past EnrichmentService: the service caches
   * and hands back the four fields above, so a result that reaches a caller
   * has no `raw` whether it was paid for now or answered from the cache.
   */
  raw?: unknown;
};

/**
 * One vendor. Both methods may throw: a 401 or a rate limit is a real failure
 * and the service decides whether to fall through to the next provider or
 * give up, which it cannot do if the provider swallows the error.
 */
export interface EnrichmentProvider {
  /** Stable id used in EnrichmentResult.provider and in operator messages. */
  readonly id: string;
  findEmail(query: FindEmailQuery): Promise<EnrichmentResult>;
  verifyEmail(email: string): Promise<EnrichmentResult>;
}

/**
 * Deadline for one provider call.
 *
 * Every lookup runs one at a time behind the service queue, and the outreach
 * engine now waits on one before each approved send. Node's default header
 * timeout is five minutes, so a vendor that accepts the connection and then
 * says nothing would hold each queued row for five minutes in turn and take
 * hours to drain a day's cap. A vendor that is up answers in well under ten
 * seconds; one that does not is an outage, and an outage must fail fast.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** One vendor reply, already read. */
export type ProviderResponse = { ok: boolean; status: number; body: string };

/**
 * One request under that deadline, body included. The body is read inside the
 * deadline on purpose: a vendor that sends headers and then stalls mid-body
 * hangs the queue exactly as one that never answers at all. The provider id is
 * in the message because the operator reading it has to know which key to go
 * and check.
 */
export async function requestWithTimeout(
  provider: string,
  url: string,
  init: RequestInit = {},
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${provider} timed out after ${PROVIDER_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

/** Nothing found. Providers return this rather than throwing on an empty hit. */
export function emptyResult(provider: string, raw?: unknown): EnrichmentResult {
  return { email: null, confidence: 0, status: "unknown", provider, raw };
}

/**
 * Confidence for a provider that reports a verdict and no number. The values
 * sit either side of the waterfall's acceptance floor on purpose: a plain
 * "valid" is good enough to stop looking, a catch-all "risky" is not.
 */
export function scoreFor(status: EnrichmentStatus): number {
  switch (status) {
    case "valid":
      return 95;
    case "risky":
      return 60;
    case "invalid":
      return 0;
    default:
      return 30;
  }
}

/** 0-100, rounded. Keeps a provider's odd scale from leaking outward. */
export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

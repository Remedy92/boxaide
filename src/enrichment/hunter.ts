/**
 * Hunter.io provider: email-finder and email-verifier over plain fetch.
 *
 * Hunter answers with a numeric score already on a 0-100 scale, so confidence
 * passes through untouched. The word it puts in `result` or `status` is the
 * part that needs translating: "deliverable" is a valid address, "risky" and
 * "accept_all" are the catch-all case a human should look at before mailing,
 * and "undeliverable" is a bounce waiting to happen.
 */
import {
  probeRequest,
  unreachable,
  verdictForStatus,
  type ConnectorProbeResult,
} from "../connectors/probe.js";
import {
  clampScore,
  emptyResult,
  requestWithTimeout,
  scoreFor,
  type EnrichmentProvider,
  type EnrichmentResult,
  type EnrichmentStatus,
  type FindEmailQuery,
} from "./types.js";

const API = "https://api.hunter.io/v2";

type HunterBody = {
  data?: {
    email?: string | null;
    score?: number | null;
    result?: string | null;
    status?: string | null;
  };
  errors?: { details?: string }[];
};

function hunterStatus(word: string | null | undefined): EnrichmentStatus {
  switch ((word ?? "").toLowerCase()) {
    case "deliverable":
    case "valid":
      return "valid";
    case "risky":
    case "accept_all":
    case "webmail":
    case "disposable":
      return "risky";
    case "undeliverable":
    case "invalid":
      return "invalid";
    default:
      return "unknown";
  }
}

export class HunterProvider implements EnrichmentProvider {
  readonly id = "hunter";

  constructor(private apiKey: string) {}

  async findEmail(query: FindEmailQuery): Promise<EnrichmentResult> {
    const params = new URLSearchParams({
      domain: query.domain,
      api_key: this.apiKey,
    });
    // Hunter takes either the split name or the full one. Sending both is
    // accepted but the split pair scores better, so it wins when present.
    if (query.firstName && query.lastName) {
      params.set("first_name", query.firstName);
      params.set("last_name", query.lastName);
    } else if (query.fullName) {
      params.set("full_name", query.fullName);
    }
    const body = await this.call(`/email-finder?${params}`);
    return this.normalize(body);
  }

  async verifyEmail(email: string): Promise<EnrichmentResult> {
    const params = new URLSearchParams({ email, api_key: this.apiKey });
    const body = await this.call(`/email-verifier?${params}`);
    return this.normalize(body, email);
  }

  private async call(path: string): Promise<HunterBody> {
    const res = await requestWithTimeout(this.id, `${API}${path}`);
    if (!res.ok) {
      throw new Error(`hunter HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    return JSON.parse(res.body) as HunterBody;
  }

  /**
   * `fallbackEmail` exists for the verifier, which sometimes echoes no address
   * back. The caller already knows which address it asked about, and losing it
   * here would turn a real verdict into a result nobody can act on.
   */
  private normalize(body: HunterBody, fallbackEmail?: string): EnrichmentResult {
    const email = (body.data?.email ?? fallbackEmail ?? "").trim().toLowerCase();
    if (!email) return emptyResult(this.id, body);
    const status = hunterStatus(body.data?.result ?? body.data?.status);
    const score = Number(body.data?.score);
    return {
      email,
      confidence: Number.isFinite(score) ? clampScore(score) : scoreFor(status),
      status,
      provider: this.id,
      raw: body,
    };
  }
}

/**
 * Is this Hunter key one Hunter accepts?
 *
 * GET /v2/account, which is Hunter's own account endpoint: it reports the plan
 * and the requests left, spends no credits, and needs no name or domain to ask
 * about. That makes it free in both senses, which is what a key check should
 * be. A refused key answers 401 with the reason under errors[].details.
 */
export async function probeHunter(
  apiKey: string,
  doFetch?: typeof globalThis.fetch,
): Promise<ConnectorProbeResult> {
  const params = new URLSearchParams({ api_key: apiKey });
  const reply = await probeRequest(`${API}/account?${params}`, { method: "GET" }, doFetch);
  if (!reply.reached) return unreachable(reply.reason);
  return verdictForStatus(reply.status, reply.body);
}

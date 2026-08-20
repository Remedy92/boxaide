/**
 * Prospeo provider: email-finder and email-verifier over plain fetch.
 *
 * Prospeo posts JSON and authenticates with an X-KEY header rather than a
 * query parameter, and it wraps every answer in `{ error, response }` with
 * HTTP 200 even when the lookup failed. The error flag is therefore checked
 * before the body, or a failed call would read as "nobody found".
 *
 * It reports a verdict word and no score, so confidence is derived from the
 * verdict. That is the whole reason scoreFor exists in types.ts.
 */
import {
  probeRequest,
  reasonFrom,
  rejected,
  unreachable,
  verdictForStatus,
  works,
  type ConnectorProbeResult,
} from "../connectors/probe.js";
import {
  emptyResult,
  requestWithTimeout,
  scoreFor,
  type EnrichmentProvider,
  type EnrichmentResult,
  type EnrichmentStatus,
  type FindEmailQuery,
} from "./types.js";

const API = "https://api.prospeo.io";

type ProspeoBody = {
  error?: boolean;
  message?: string;
  response?: {
    email?: string | null;
    email_status?: string | null;
  };
};

function prospeoStatus(word: string | null | undefined): EnrichmentStatus {
  switch ((word ?? "").toUpperCase()) {
    case "VALID":
      return "valid";
    case "CATCH_ALL":
    case "ACCEPT_ALL":
    case "RISKY":
      return "risky";
    case "INVALID":
      return "invalid";
    default:
      return "unknown";
  }
}

export class ProspeoProvider implements EnrichmentProvider {
  readonly id = "prospeo";

  constructor(private apiKey: string) {}

  async findEmail(query: FindEmailQuery): Promise<EnrichmentResult> {
    const payload: Record<string, string> = { company: query.domain };
    if (query.firstName && query.lastName) {
      payload.first_name = query.firstName;
      payload.last_name = query.lastName;
    } else if (query.fullName) {
      payload.full_name = query.fullName;
    }
    const body = await this.call("/email-finder", payload);
    return this.normalize(body);
  }

  async verifyEmail(email: string): Promise<EnrichmentResult> {
    const body = await this.call("/email-verifier", { email });
    return this.normalize(body, email);
  }

  private async call(
    path: string,
    payload: Record<string, string>,
  ): Promise<ProspeoBody> {
    const res = await requestWithTimeout(this.id, `${API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-key": this.apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`prospeo HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const body = JSON.parse(res.body) as ProspeoBody;
    // A quota or key problem arrives as HTTP 200 with error: true. Treating it
    // as an empty answer would burn the next provider's credits for nothing
    // and hide a broken key from the operator, so it throws like any failure.
    if (body.error) {
      throw new Error(`prospeo error: ${body.message ?? "unknown"}`);
    }
    return body;
  }

  private normalize(body: ProspeoBody, fallbackEmail?: string): EnrichmentResult {
    const email = (body.response?.email ?? fallbackEmail ?? "")
      .trim()
      .toLowerCase();
    if (!email) return emptyResult(this.id, body);
    const status = prospeoStatus(body.response?.email_status);
    return {
      email,
      confidence: scoreFor(status),
      status,
      provider: this.id,
      raw: body,
    };
  }
}

/**
 * Is this Prospeo key one Prospeo accepts?
 *
 * POST /account-information, Prospeo's own account endpoint: it reports the
 * plan, the credits left and the renewal date, and it is documented as free of
 * charge. No name, no domain and no address are needed to ask it, so it costs
 * nothing and reveals nothing.
 *
 * Prospeo answers a key problem with HTTP 200 and `error: true`, exactly as it
 * does for a lookup, so the flag is read before the status is trusted. Without
 * that, a rejected key would be reported as a working one.
 */
export async function probeProspeo(
  apiKey: string,
  doFetch?: typeof globalThis.fetch,
): Promise<ConnectorProbeResult> {
  const reply = await probeRequest(
    `${API}/account-information`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-key": apiKey },
      body: JSON.stringify({}),
    },
    doFetch,
  );
  if (!reply.reached) return unreachable(reply.reason);
  const verdict = verdictForStatus(reply.status, reply.body);
  if (verdict.verdict !== "works") return verdict;
  let body: ProspeoBody | null = null;
  try {
    body = JSON.parse(reply.body) as ProspeoBody;
  } catch {
    return unreachable("Prospeo sent an answer that is not readable.");
  }
  if (body?.error) return rejected(reasonFrom(reply.body));
  return works;
}

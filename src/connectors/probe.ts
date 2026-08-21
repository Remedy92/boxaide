/**
 * The shared parts of a connector probe: the deadline, the three verdicts, and
 * the reading of a vendor reply into one of them.
 *
 * A probe is the smallest authenticated request a provider will answer, made
 * for one reason only: to find out whether the key an operator pasted is a key
 * that provider accepts. It is not a search and it is not a lookup, so nothing
 * here reads the result body for content.
 *
 * Three verdicts, and the difference between them is the whole point:
 *
 *   works       the provider answered the call.
 *   rejected    the provider refused the key, with its own reason.
 *   unreachable nobody answered, or the provider failed for a reason that has
 *               nothing to do with the key. This is never reported as a bad
 *               key, because telling an operator to re-copy a correct key
 *               while the vendor is down wastes their afternoon.
 *
 * The deadline is short on purpose. A person is watching a row in Settings
 * while this runs, so a vendor that accepts the connection and then says
 * nothing has to become an answer in seconds, not in the ten a queued lookup
 * is allowed.
 */

/** Deadline for one probe. Short: somebody is watching the row it fills in. */
export const CONNECTOR_PROBE_TIMEOUT_MS = 5_000;

export type ConnectorProbeVerdict = "works" | "rejected" | "unreachable";

export type ConnectorProbeResult = {
  verdict: ConnectorProbeVerdict;
  /** The provider's own words, trimmed. Null when it gave none. */
  reason: string | null;
};

/** One probe: the key in, a verdict out. Never throws. */
export type ConnectorProbe = (apiKey: string) => Promise<ConnectorProbeResult>;

/** A vendor reply, or the fact that there was not one. */
export type ProbeReply =
  | { reached: true; status: number; body: string }
  | { reached: false; reason: string };

export const works: ConnectorProbeResult = { verdict: "works", reason: null };

export function rejected(reason: string | null): ConnectorProbeResult {
  return { verdict: "rejected", reason: reason === "" ? null : reason };
}

export function unreachable(reason: string | null): ConnectorProbeResult {
  return { verdict: "unreachable", reason: reason === "" ? null : reason };
}

/**
 * One request under the probe deadline. A refusal is a reply like any other,
 * so only the absence of a reply resolves to `reached: false`: a timeout, a
 * DNS failure, a refused connection. The body is read inside the deadline for
 * the same reason src/enrichment/types.ts reads its own: a vendor that stalls
 * mid-body holds the caller exactly as long as one that never answers.
 */
export async function probeRequest(
  url: string,
  init: RequestInit,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProbeReply> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CONNECTOR_PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    return { reached: true, status: res.status, body: await res.text() };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        reached: false,
        reason: `No answer within ${CONNECTOR_PROBE_TIMEOUT_MS / 1000} seconds.`,
      };
    }
    return { reached: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * The default reading of a status code.
 *
 * Every 4xx except 429 is the provider refusing this key: a wrong key, a key
 * without the right scope, a plan that does not include the endpoint, an
 * account out of credits. All four are fixed by the operator and none by
 * waiting, so all four are 'rejected' and the provider's own reason says which
 * one it was.
 *
 * 429 and every 5xx are the provider having a bad minute. The key may be
 * perfect, so neither is allowed to accuse it.
 */
export function verdictForStatus(status: number, body: string): ConnectorProbeResult {
  if (status >= 200 && status < 300) return works;
  const reason = reasonFrom(body);
  if (status === 429) {
    return unreachable(reason ?? `The provider is rate limiting this key (HTTP ${status}).`);
  }
  if (status >= 500) {
    return unreachable(reason ?? `The provider answered HTTP ${status}.`);
  }
  return rejected(reason ?? `The provider refused the key (HTTP ${status}).`);
}

/**
 * The sentence a human should read out of a vendor error body. Providers bury
 * it under a different key each: Hunter under errors[].details, Prospeo under
 * message, Exa and Parallel under error or detail. A body that holds none of
 * them is used as text, trimmed, because a short unknown string still tells an
 * operator more than silence.
 */
export function reasonFrom(body: string): string | null {
  const text = body.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return trimReason(text);
  }
  return trimReason(pickReason(parsed) ?? text);
}

const REASON_KEYS = ["details", "detail", "message", "error", "error_message", "reason"];

function pickReason(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = pickReason(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of REASON_KEYS) {
    if (!(key in record)) continue;
    const found = pickReason(record[key], depth + 1);
    if (found) return found;
  }
  for (const key of ["errors", "error"]) {
    if (!(key in record)) continue;
    const found = pickReason(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** One readable line. Vendor bodies run to pages and a row in Settings does not. */
function trimReason(value: string): string | null {
  const line = value.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

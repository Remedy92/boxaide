/**
 * Checking a connector key: the five probes, the verdicts they normalise a
 * vendor reply into, the route that runs one, and the words the settings panel
 * is allowed to put on the result.
 *
 * The assertion that matters most is the negative one. A provider that cannot
 * be reached must never be reported as a bad key: an operator told to re-copy a
 * correct key goes back to the vendor, regenerates it, and is no better off,
 * which is a worse outcome than the honest "we could not ask".
 *
 * No test here contacts a provider. Every vendor call is a stubbed fetch, so
 * the suite spends no credits and needs no keys.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { ConnectorStore } from "../src/connectors/store.js";
import { ConnectorsService } from "../src/connectors/service.js";
import { registerConnectorRoutes } from "../src/connectors/routes.js";
import {
  CONNECTOR_PROBE_TIMEOUT_MS,
  probeRequest,
  reasonFrom,
  type ConnectorProbeResult,
} from "../src/connectors/probe.js";
import { probeFor } from "../src/connectors/probes.js";
import type { ConnectorCheck } from "../src/connectors/types.js";
import type { Platform } from "../src/platform.js";
import { probeApollo } from "../src/prospecting/apollo.js";
import { probeHunter } from "../src/enrichment/hunter.js";
import { probeProspeo } from "../src/enrichment/prospeo.js";
import { probeExa, probeParallel } from "../src/research/providers.js";
import {
  capabilityStatus,
  connectorStatus,
} from "../apps/web/src/lib/connector-check.ts";
import type { Connector } from "../apps/web/src/lib/types.ts";

const MASTER_KEY = randomBytes(32);

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Records every request and answers with one canned reply. */
function stubVendor(answer: { status?: number; body?: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

/** A vendor nobody can reach: DNS is down, the port is shut, the cable is out. */
function stubOffline(message = "fetch failed"): void {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError(message);
  });
}

const PROBES: Record<string, (key: string) => Promise<ConnectorProbeResult>> = {
  apollo: probeApollo,
  hunter: probeHunter,
  prospeo: probeProspeo,
  exa: probeExa,
  parallel: probeParallel,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider probes", () => {
  for (const [id, probe] of Object.entries(PROBES)) {
    it(`${id}: an answered call is a working key`, async () => {
      const calls = stubVendor({ status: 200, body: { ok: true } });
      expect(await probe("live-key-1234")).toEqual({ verdict: "works", reason: null });
      expect(calls).toHaveLength(1);
    });

    it(`${id}: a 401 is the key being refused, with the provider's reason`, async () => {
      stubVendor({ status: 401, body: { errors: [{ details: "Invalid API key" }] } });
      const result = await probe("wrong-key-1234");
      expect(result.verdict).toBe("rejected");
      expect(result.reason).toBe("Invalid API key");
    });

    it(`${id}: a 403 is refused too, not an outage`, async () => {
      stubVendor({ status: 403, body: { message: "This key has no access here" } });
      const result = await probe("scoped-key-1234");
      expect(result.verdict).toBe("rejected");
      expect(result.reason).toBe("This key has no access here");
    });

    it(`${id}: a network failure is unreachable, never a bad key`, async () => {
      stubOffline();
      const result = await probe("live-key-1234");
      expect(result.verdict).toBe("unreachable");
      expect(result.reason).toContain("fetch failed");
    });

    it(`${id}: the provider having a bad minute is unreachable`, async () => {
      stubVendor({ status: 503, body: {} });
      expect((await probe("live-key-1234")).verdict).toBe("unreachable");
      stubVendor({ status: 429, body: {} });
      expect((await probe("live-key-1234")).verdict).toBe("unreachable");
    });
  }

  it("apollo asks for one row of the free people search and nothing else", async () => {
    const calls = stubVendor({ status: 200, body: { people: [] } });
    await probeApollo("apollo-key-1234");
    expect(calls[0].url).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ page: 1, per_page: 1 });
    expect(calls[0].headers["x-api-key"]).toBe("apollo-key-1234");
  });

  it("hunter asks its free account endpoint", async () => {
    const calls = stubVendor({ status: 200, body: { data: { plan_name: "Free" } } });
    await probeHunter("hunter-key-1234");
    expect(calls[0].url).toBe("https://api.hunter.io/v2/account?api_key=hunter-key-1234");
    expect(calls[0].method).toBe("GET");
  });

  it("prospeo asks its free account endpoint", async () => {
    const calls = stubVendor({ status: 200, body: { error: false, response: {} } });
    await probeProspeo("prospeo-key-1234");
    expect(calls[0].url).toBe("https://api.prospeo.io/account-information");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-key"]).toBe("prospeo-key-1234");
  });

  it("prospeo reads the error flag it hides behind HTTP 200", async () => {
    stubVendor({ status: 200, body: { error: true, message: "INVALID_API_KEY" } });
    expect(await probeProspeo("wrong-key-1234")).toEqual({
      verdict: "rejected",
      reason: "INVALID_API_KEY",
    });
  });

  it("exa and parallel ask for one result, the smallest search each sells", async () => {
    const exaCalls = stubVendor({ status: 200, body: { results: [] } });
    await probeExa("exa-key-1234");
    expect(exaCalls[0].url).toBe("https://api.exa.ai/search");
    expect(exaCalls[0].body).toMatchObject({ numResults: 1 });
    // No contents: page text is the part Exa charges extra for.
    expect(exaCalls[0].body).not.toHaveProperty("contents");
    vi.unstubAllGlobals();
    const parallelCalls = stubVendor({ status: 200, body: { results: [] } });
    await probeParallel("parallel-key-1234");
    expect(parallelCalls[0].url).toBe("https://api.parallel.ai/v1beta/search");
    expect(parallelCalls[0].body).toMatchObject({ processor: "base", max_results: 1 });
  });

  it("gives up on a vendor that never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
      );
      const pending = probeRequest("https://example.test/probe", { method: "GET" });
      await vi.advanceTimersByTimeAsync(CONNECTOR_PROBE_TIMEOUT_MS + 1);
      expect(await pending).toEqual({
        reached: false,
        reason: `No answer within ${CONNECTOR_PROBE_TIMEOUT_MS / 1000} seconds.`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds the sentence a human should read, whichever key it is under", () => {
    expect(reasonFrom(`{"errors":[{"details":"Invalid API key"}]}`)).toBe("Invalid API key");
    expect(reasonFrom(`{"error":{"message":"quota exceeded"}}`)).toBe("quota exceeded");
    expect(reasonFrom(`{"detail":"no access"}`)).toBe("no access");
    expect(reasonFrom("plain text refusal")).toBe("plain text refusal");
    expect(reasonFrom("   ")).toBeNull();
  });

  it("has a probe for every connector in the registry", () => {
    for (const id of Object.keys(PROBES)) expect(probeFor(id)).toBeTypeOf("function");
    expect(probeFor("bing")).toBeUndefined();
  });
});

function newService(env: Record<string, string> = {}): ConnectorsService {
  const store = new ConnectorStore(new Database(":memory:"), MASTER_KEY);
  return new ConnectorsService(store, (suffix) => env[suffix]);
}

describe("checking a connector key", () => {
  it("stores the verdict, so a reload needs no second call to the provider", async () => {
    const service = newService();
    service.setKey("exa", "exa-key-abcd");
    stubVendor({ status: 200, body: { results: [] } });
    const check = await service.check("exa");
    expect(check?.verdict).toBe("works");
    expect(service.checkOf("exa")?.verdict).toBe("works");
    expect(service.checks().exa?.maskedKey).toBe("****abcd");
  });

  it("checks a key set where the server was started", async () => {
    const service = newService({ HUNTER_API_KEY: "env-hunter-key1" });
    stubVendor({ status: 200, body: { data: {} } });
    const check = await service.check("hunter");
    expect(check?.verdict).toBe("works");
    expect(service.describe("hunter").source).toBe("env");
  });

  it("keeps the provider's reason for a refusal", async () => {
    const service = newService();
    service.setKey("prospeo", "prospeo-key-abcd");
    stubVendor({ status: 401, body: { message: "AUTHENTICATION_FAILED" } });
    expect(await service.check("prospeo")).toMatchObject({
      verdict: "rejected",
      reason: "AUTHENTICATION_FAILED",
    });
  });

  it("never writes the key into the reason, even when the provider echoes it", async () => {
    const service = newService();
    service.setKey("hunter", "hunter-key-abcd");
    stubVendor({
      status: 401,
      body: { errors: [{ details: "Invalid key: hunter-key-abcd" }] },
    });
    const check = await service.check("hunter");
    expect(check?.reason).toBe("Invalid key: ****abcd");
    expect(JSON.stringify(check)).not.toContain("hunter-key-abcd");
  });

  it("has nothing to check when no key is set anywhere", async () => {
    const service = newService();
    expect(await service.check("exa")).toBeNull();
  });

  it("forgets the verdict when the key it judged is replaced", async () => {
    const service = newService();
    service.setKey("exa", "exa-key-abcd");
    stubVendor({ status: 200, body: { results: [] } });
    await service.check("exa");
    expect(service.checkOf("exa")?.verdict).toBe("works");
    service.setKey("exa", "exa-key-wxyz");
    expect(service.checkOf("exa")).toBeNull();
    expect(service.checks()).toEqual({});
  });

  it("reports a probe that throws as unreachable rather than as a bad key", async () => {
    const store = new ConnectorStore(new Database(":memory:"), MASTER_KEY);
    const service = new ConnectorsService(
      store,
      () => undefined,
      () => async () => {
        throw new Error("adapter blew up");
      },
    );
    service.setKey("exa", "exa-key-abcd");
    expect(await service.check("exa")).toMatchObject({
      verdict: "unreachable",
      reason: "adapter blew up",
    });
  });

  it("refuses an unknown id", async () => {
    await expect(newService().check("bing")).rejects.toThrow(/unknown connector: bing/);
  });
});

describe("connector check route", () => {
  let service: ConnectorsService;
  let app: Hono;

  beforeEach(() => {
    service = newService({ HUNTER_API_KEY: "env-hunter-key1" });
    app = new Hono();
    registerConnectorRoutes(app, { connectorsService: service } as unknown as Platform);
  });

  it("checks the key in force and answers with the verdict, never the key", async () => {
    stubVendor({ status: 200, body: { data: {} } });
    const res = await app.request("/api/connectors/hunter/check", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: Connector; check: ConnectorCheck };
    expect(body.check.verdict).toBe("works");
    expect(body.connector.source).toBe("env");
    expect(JSON.stringify(body)).not.toContain("env-hunter-key1");
  });

  it("404s an unknown connector id", async () => {
    const res = await app.request("/api/connectors/bing/check", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown connector: bing" });
  });

  it("400s a connector with no key to check", async () => {
    const res = await app.request("/api/connectors/exa/check", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no key set for connector: exa" });
  });

  it("sends the stored verdicts alongside the list, with no key in either", async () => {
    stubVendor({ status: 401, body: { errors: [{ details: "Invalid API key" }] } });
    await app.request("/api/connectors/hunter/check", { method: "POST" });
    const res = await app.request("/api/connectors");
    const body = (await res.json()) as {
      connectors: Connector[];
      checks: Record<string, ConnectorCheck>;
    };
    expect(body.checks.hunter).toMatchObject({
      verdict: "rejected",
      reason: "Invalid API key",
      maskedKey: "****key1",
    });
    expect(JSON.stringify(body)).not.toContain("env-hunter-key1");
  });
});

/** A connector row as the panel receives it. */
function row(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "exa",
    label: "Exa",
    kind: "search",
    configured: true,
    source: "settings",
    maskedKey: "****abcd",
    ...overrides,
  };
}

function checkedAt(): string {
  return new Date("2026-08-20T09:00:00.000Z").toISOString();
}

describe("what a connector row is allowed to say", () => {
  const now = new Date("2026-08-20T09:05:00.000Z");

  it("says a saved key is saved, and not that it works", () => {
    const view = connectorStatus(row(), undefined, false, now);
    expect(view.headline).toBe("Key saved, not checked yet");
    expect(view.tone).not.toBe("success");
  });

  it("only says working after the provider answered", () => {
    const view = connectorStatus(
      row(),
      { verdict: "works", reason: null, checkedAt: checkedAt(), maskedKey: "****abcd" },
      false,
      now,
    );
    expect(view.headline).toBe("Working");
    expect(view.tone).toBe("success");
  });

  it("shows a refusal in the provider's words, with what to do next", () => {
    const view = connectorStatus(
      row(),
      {
        verdict: "rejected",
        reason: "Invalid API key",
        checkedAt: checkedAt(),
        maskedKey: "****abcd",
      },
      false,
      now,
    );
    expect(view.tone).toBe("danger");
    expect(view.reason).toBe("Invalid API key");
    expect(view.hint).toMatch(/copied the whole key/);
  });

  it("reads an unreachable provider as unreachable, never as a bad key", () => {
    const view = connectorStatus(
      row(),
      {
        verdict: "unreachable",
        reason: "No answer within 5 seconds.",
        checkedAt: checkedAt(),
        maskedKey: "****abcd",
      },
      false,
      now,
    );
    expect(view.tone).toBe("warning");
    expect(view.headline).toBe("Could not reach the provider");
    expect(view.hint).toMatch(/does not say the key is wrong/);
  });

  it("says it is checking while the probe runs", () => {
    const view = connectorStatus(row(), undefined, true, now);
    expect(view.busy).toBe(true);
    expect(view.headline).toMatch(/^Checking the key/);
  });

  it("says nothing about a row with no key", () => {
    const view = connectorStatus(
      row({ configured: false, source: null, maskedKey: null }),
      undefined,
      false,
      now,
    );
    expect(view.headline).toBe("No key yet");
    expect(view.tone).toBe("muted");
  });
});

describe("what the capability strip is allowed to claim", () => {
  const working: ConnectorCheck = {
    verdict: "works",
    reason: null,
    checkedAt: checkedAt(),
    maskedKey: "****abcd",
  };

  it("is on only when a provider answered a key", () => {
    expect(capabilityStatus([row()], { exa: working })).toEqual({
      tone: "success",
      words: "on",
    });
  });

  it("never reads as on for a saved but unchecked key", () => {
    expect(capabilityStatus([row()], {}).words).toBe("key saved, not checked yet");
  });

  it("never reads as on for a refused key", () => {
    expect(
      capabilityStatus([row()], {
        exa: { ...working, verdict: "rejected", reason: "Invalid API key" },
      }),
    ).toEqual({ tone: "danger", words: "key refused" });
  });

  it("separates a provider nobody could reach from a refused key", () => {
    expect(
      capabilityStatus([row()], { exa: { ...working, verdict: "unreachable" } }),
    ).toEqual({ tone: "warning", words: "provider not reachable" });
  });

  it("says no key, and says when the server does not offer the capability", () => {
    expect(capabilityStatus([row({ configured: false, source: null })], {}).words).toBe(
      "no key",
    );
    expect(capabilityStatus([], {}).words).toBe("not offered");
  });

  it("counts one working provider even when its neighbour was refused", () => {
    const parallel = row({ id: "parallel", label: "Parallel" });
    expect(
      capabilityStatus([row(), parallel], {
        exa: { ...working, verdict: "rejected" },
        parallel: working,
      }).words,
    ).toBe("on");
  });
});

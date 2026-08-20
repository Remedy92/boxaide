/**
 * Connectors: the store, the settings-beats-environment rule, the REST
 * surface, and the claim that matters most: a key saved after a service was
 * constructed is in force on the very next call, with no restart.
 *
 * Routes are mounted on a bare Hono app rather than through createApi: these
 * assertions are about this module's paths, status codes and payloads, and
 * the auth middleware is covered where it lives (test/security-http.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { ConnectorStore } from "../src/connectors/store.js";
import { ConnectorsService } from "../src/connectors/service.js";
import { registerConnectorRoutes } from "../src/connectors/routes.js";
import { CONNECTORS, maskKey } from "../src/connectors/types.js";
import type { Connector } from "../src/connectors/types.js";
import type { Platform } from "../src/platform.js";
import { EnrichmentService } from "../src/enrichment/service.js";
import { ResearchService } from "../src/research/service.js";

const MASTER_KEY = randomBytes(32);

function newStore(): ConnectorStore {
  return new ConnectorStore(new Database(":memory:"), MASTER_KEY);
}

/** An environment stand-in, so no test touches process.env. */
function envFrom(values: Record<string, string>): (suffix: string) => string | undefined {
  return (suffix) => values[suffix];
}

describe("connector store", () => {
  it("round-trips a key and clears it", () => {
    const store = newStore();
    expect(store.getKey("hunter")).toBeNull();
    store.setKey("hunter", "hunter-secret-1234");
    expect(store.getKey("hunter")).toBe("hunter-secret-1234");
    expect(store.clearKey("hunter")).toBe(true);
    expect(store.getKey("hunter")).toBeNull();
    expect(store.clearKey("hunter")).toBe(false);
  });

  it("overwrites rather than duplicating a provider row", () => {
    const store = newStore();
    store.setKey("exa", "first-key");
    store.setKey("exa", "second-key");
    expect(store.getKey("exa")).toBe("second-key");
    const rows = store.db.prepare(`SELECT COUNT(*) AS n FROM connectors`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("keeps the key out of the row it writes", () => {
    const store = newStore();
    store.setKey("prospeo", "prospeo-secret-9999");
    const row = store.db.prepare(`SELECT key_enc FROM connectors WHERE id = ?`).get("prospeo") as {
      key_enc: string;
    };
    expect(row.key_enc).not.toContain("prospeo-secret-9999");
  });

  it("reports a key it cannot decrypt as absent rather than throwing", () => {
    const store = newStore();
    store.setKey("exa", "good-key");
    const other = new ConnectorStore(store.db, randomBytes(32));
    expect(other.getKey("exa")).toBeNull();
    expect(other.maskedKey("exa")).toBeNull();
  });

  it("masks to the last four characters only", () => {
    expect(maskKey("abcdefgh")).toBe("****efgh");
    expect(maskKey("abc")).toBe("****");
    expect(maskKey("abcd")).toBe("****");
  });
});

describe("connectors service", () => {
  it("lists every connector with its kind", () => {
    const service = new ConnectorsService(newStore(), envFrom({}));
    expect(service.list().map((c) => [c.id, c.kind])).toEqual([
      ["hunter", "enrichment"],
      ["prospeo", "enrichment"],
      ["exa", "search"],
      ["parallel", "search"],
      ["apollo", "prospecting"],
    ]);
    expect(service.list().every((c) => c.configured === false)).toBe(true);
    expect(service.list().every((c) => c.source === null)).toBe(true);
  });

  it("falls back to the environment when settings hold nothing", () => {
    const service = new ConnectorsService(newStore(), envFrom({ EXA_API_KEY: "env-key-wxyz" }));
    const exa = service.describe("exa");
    expect(exa.configured).toBe(true);
    expect(exa.source).toBe("env");
    expect(exa.maskedKey).toBe("****wxyz");
    expect(service.getKey("exa")).toBe("env-key-wxyz");
  });

  it("prefers the settings key over the environment one", () => {
    const store = newStore();
    const service = new ConnectorsService(store, envFrom({ EXA_API_KEY: "env-key-wxyz" }));
    service.setKey("exa", "settings-key-abcd");
    const exa = service.describe("exa");
    expect(exa.source).toBe("settings");
    expect(exa.maskedKey).toBe("****abcd");
    expect(service.getKey("exa")).toBe("settings-key-abcd");
  });

  it("falls back to the environment again once the settings key is cleared", () => {
    const service = new ConnectorsService(newStore(), envFrom({ EXA_API_KEY: "env-key-wxyz" }));
    service.setKey("exa", "settings-key-abcd");
    const cleared = service.setKey("exa", "");
    expect(cleared.source).toBe("env");
    expect(service.getKey("exa")).toBe("env-key-wxyz");
  });

  it("refuses an unknown id", () => {
    const service = new ConnectorsService(newStore(), envFrom({}));
    expect(() => service.describe("bing")).toThrow(/unknown connector: bing/);
    expect(() => service.setKey("bing", "k")).toThrow(/unknown connector: bing/);
    expect(service.getKey("bing")).toBeUndefined();
  });

  it("round-trips the prospecting key like any other connector", () => {
    const service = new ConnectorsService(newStore(), envFrom({ APOLLO_API_KEY: "env-apollo-key1" }));
    expect(service.describe("apollo").source).toBe("env");
    service.setKey("apollo", "settings-apollo-wxyz");
    expect(service.getKey("apollo")).toBe("settings-apollo-wxyz");
    expect(service.describe("apollo").maskedKey).toBe("****wxyz");
  });

  it("answers hasSearchConnector from search providers only", () => {
    const service = new ConnectorsService(newStore(), envFrom({}));
    expect(service.hasSearchConnector()).toBe(false);
    service.setKey("hunter", "hunter-key");
    expect(service.hasSearchConnector()).toBe(false);
    // A prospecting key is not a search key: a launched agent keeps its own
    // CLI web tools until an actual search provider is configured.
    service.setKey("apollo", "apollo-key");
    expect(service.hasSearchConnector()).toBe(false);
    service.setKey("parallel", "parallel-key");
    expect(service.hasSearchConnector()).toBe(true);
  });
});

describe("connector routes", () => {
  let service: ConnectorsService;
  let app: Hono;

  beforeEach(() => {
    service = new ConnectorsService(newStore(), envFrom({ HUNTER_API_KEY: "env-hunter-key1" }));
    app = new Hono();
    registerConnectorRoutes(app, { connectorsService: service } as unknown as Platform);
  });

  it("lists every connector, masked", async () => {
    const res = await app.request("/api/connectors");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: Connector[] };
    expect(body.connectors).toHaveLength(CONNECTORS.length);
    const hunter = body.connectors.find((c) => c.id === "hunter")!;
    expect(hunter).toEqual({
      id: "hunter",
      label: "Hunter",
      kind: "enrichment",
      configured: true,
      source: "env",
      maskedKey: "****key1",
    });
    expect(JSON.stringify(body)).not.toContain("env-hunter-key1");
  });

  it("saves a key and answers with the masked connector only", async () => {
    const res = await app.request("/api/connectors/exa", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "exa-live-key-6789" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: Connector };
    expect(body.connector.source).toBe("settings");
    expect(body.connector.maskedKey).toBe("****6789");
    expect(JSON.stringify(body)).not.toContain("exa-live-key-6789");
    expect(service.getKey("exa")).toBe("exa-live-key-6789");
  });

  it("clears the key when apiKey is empty", async () => {
    service.setKey("hunter", "settings-hunter-0000");
    const res = await app.request("/api/connectors/hunter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connector: Connector };
    expect(body.connector.source).toBe("env");
    expect(service.getKey("hunter")).toBe("env-hunter-key1");
  });

  it("404s an unknown connector id", async () => {
    const res = await app.request("/api/connectors/bing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "k" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown connector: bing" });
  });

  it("400s a body that is not JSON", async () => {
    const res = await app.request("/api/connectors/exa", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be JSON" });
  });

  it("400s an apiKey that is not a string", async () => {
    const res = await app.request("/api/connectors/exa", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: 42 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "apiKey must be a string" });
  });
});

describe("services read keys live", () => {
  it("enrichment turns on the moment a key is saved, with no reconstruction", () => {
    const service = new ConnectorsService(newStore(), envFrom({}));
    const enrichment = new EnrichmentService({ getKey: (id) => service.getKey(id) });
    expect(enrichment.isConfigured()).toBe(false);
    service.setKey("hunter", "hunter-key-1234");
    expect(enrichment.isConfigured()).toBe(true);
    expect(enrichment.configuredProviders()).toEqual(["hunter"]);
    service.setKey("prospeo", "prospeo-key-5678");
    expect(enrichment.configuredProviders()).toEqual(["hunter", "prospeo"]);
    service.setKey("hunter", "");
    expect(enrichment.configuredProviders()).toEqual(["prospeo"]);
  });

  it("enrichment still reads the environment when settings are empty", () => {
    const service = new ConnectorsService(newStore(), envFrom({ PROSPEO_API_KEY: "env-prospeo" }));
    const enrichment = new EnrichmentService({ getKey: (id) => service.getKey(id) });
    expect(enrichment.configuredProviders()).toEqual(["prospeo"]);
  });

  it("research reports each provider against the key set right now", () => {
    const service = new ConnectorsService(newStore(), envFrom({}));
    const research = new ResearchService({ getKey: (id) => service.getKey(id) });
    expect(research.listProviders()).toEqual([
      { id: "exa", configured: false },
      { id: "parallel", configured: false },
    ]);
    service.setKey("parallel", "parallel-key-1234");
    expect(research.listProviders()).toEqual([
      { id: "exa", configured: false },
      { id: "parallel", configured: true },
    ]);
    expect(research.select().id).toBe("parallel");
  });

  it("research keeps the environment as the fallback", () => {
    const service = new ConnectorsService(newStore(), envFrom({ EXA_API_KEY: "env-exa" }));
    const research = new ResearchService({ getKey: (id) => service.getKey(id) });
    expect(research.select().id).toBe("exa");
  });
});

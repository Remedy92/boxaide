/**
 * Connector REST routes, mounted inside createApi after auth.
 *
 *   GET  /api/connectors            every connector, masked, plus the last
 *                                   verdict each provider gave about its key
 *   PUT  /api/connectors/:id        { apiKey } saves; "" or null clears
 *   POST /api/connectors/:id/check  asks the provider whether the key works
 *
 * The check is a POST because it calls out to a third party and writes the
 * verdict down, so it is neither safe nor idempotent in the sense a GET
 * promises. It checks whichever key is in force, so a key set where the server
 * was started is checkable too.
 *
 * A response never carries a full key and nothing here logs one. The masked
 * form is last four characters, which is enough for a human to recognise the
 * key they pasted and useless to anyone who reads it off a screen.
 */
import type { Hono } from "hono";
import type { Platform } from "../platform.js";
import { connectorById } from "./types.js";

async function readJson<T>(c: {
  req: { json: () => Promise<unknown> };
}): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export function registerConnectorRoutes(app: Hono, platform: Platform): void {
  const connectors = platform.connectorsService;

  app.get("/api/connectors", (c) =>
    c.json({ connectors: connectors.list(), checks: connectors.checks() }),
  );

  app.put("/api/connectors/:id", async (c) => {
    const id = c.req.param("id");
    if (!connectorById(id)) {
      return c.json({ error: `unknown connector: ${id}` }, 404);
    }
    const body = await readJson<{ apiKey?: string | null }>(c);
    if (body === null || typeof body !== "object") {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const raw = body.apiKey;
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      return c.json({ error: "apiKey must be a string" }, 400);
    }
    return c.json({ connector: connectors.setKey(id, raw ?? "") });
  });

  app.post("/api/connectors/:id/check", async (c) => {
    const id = c.req.param("id");
    if (!connectorById(id)) {
      return c.json({ error: `unknown connector: ${id}` }, 404);
    }
    const check = await connectors.check(id);
    if (check === null) {
      return c.json({ error: `no key set for connector: ${id}` }, 400);
    }
    return c.json({ connector: connectors.describe(id), check });
  });
}

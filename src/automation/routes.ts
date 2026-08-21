/**
 * Automation REST routes, mounted inside createApi after auth.
 * Surface: docs/specs/agent-platform.md (REST surface).
 */
import type { Hono } from "hono";
import { MAX_LIST_LIMIT as MAX_LIMIT, parseListLimit } from "../input-limits.js";
import type { Platform } from "../platform.js";

/** Every write here can fail on a bad cron or a duplicate name: 400, not 500. */
function badRequest(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseLimit(raw: string | undefined): number | null {
  return parseListLimit(raw, 20);
}

export function registerAutomationRoutes(app: Hono, platform: Platform): void {
  const store = platform.automationStore;

  app.get("/api/automations", (c) => c.json({ automations: store.list() }));

  app.post("/api/automations", async (c) => {
    let body: {
      name?: string;
      cron?: string;
      prompt?: string;
      agentId?: string | null;
      model?: string | null;
      enabled?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (!body.name || !body.cron || !body.prompt) {
      return c.json({ error: "name, cron and prompt are required" }, 400);
    }
    try {
      const automation = store.create({
        name: body.name,
        cron: body.cron,
        prompt: body.prompt,
        agentId: body.agentId ?? null,
        model: body.model ?? null,
        enabled: body.enabled,
      });
      return c.json({ automation }, 201);
    } catch (err) {
      return c.json({ error: badRequest(err) }, 400);
    }
  });

  app.patch("/api/automations/:id", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    try {
      const automation = store.update(c.req.param("id"), {
        name: typeof body.name === "string" ? body.name : undefined,
        cron: typeof body.cron === "string" ? body.cron : undefined,
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
        agentId:
          body.agentId === undefined
            ? undefined
            : typeof body.agentId === "string"
              ? body.agentId
              : null,
        // Same three-way read as agentId: absent leaves it alone, a string
        // sets it, and an explicit null is how a caller says "CLI default".
        model:
          body.model === undefined
            ? undefined
            : typeof body.model === "string"
              ? body.model
              : null,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
      if (!automation) return c.json({ error: "unknown automation" }, 404);
      return c.json({ automation });
    } catch (err) {
      return c.json({ error: badRequest(err) }, 400);
    }
  });

  app.delete("/api/automations/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    return deleted
      ? c.json({ deleted: true })
      : c.json({ error: "unknown automation" }, 404);
  });

  app.post("/api/automations/:id/run", (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "unknown automation" }, 404);
    // Fire and forget: the run may take minutes and the caller is a UI button.
    void platform.scheduler.runNow(id).catch(() => {});
    return c.json({ queued: true }, 202);
  });

  // Polled by the web rail (30s) and the desktop main process (60s), so it
  // stays two COUNTs and nothing else. Registered before the parameterised
  // siblings below so "badge" is never read as an automation id.
  app.get("/api/automations/badge", (c) => c.json(store.badge()));

  // The Automations view calls this when it opens and while it is open: runs
  // that finish under the user's eyes are not news either.
  app.post("/api/automations/runs/seen", (c) => {
    store.markRunsSeen();
    return c.json(store.badge());
  });

  // Registered before the parameterised sibling below so "runs" is never
  // read as an automation id.
  app.get("/api/automations/runs", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400,
      );
    }
    return c.json({ runs: store.listRuns({ limit }) });
  });

  app.get("/api/automations/:id/runs", (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "unknown automation" }, 404);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400,
      );
    }
    return c.json({ runs: store.listRuns({ automationId: id, limit }) });
  });
}

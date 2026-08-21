/**
 * Outreach REST routes, mounted inside createApi after auth.
 * Surface: docs/specs/agent-platform.md (REST surface). This is where
 * approval lives: POST /api/outreach/outbox/:id/approve|reject exist ONLY
 * here, never as MCP tools.
 */
import type { Context, Hono } from "hono";
import type { Platform } from "../platform.js";
import { MAX_LIST_LIMIT as MAX_LIMIT, parseListLimit } from "../input-limits.js";
import type { OutboxStatus } from "./store.js";

const OUTBOX_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "sent",
  "rejected",
  "failed",
]);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseLimit(raw: string | undefined): number | null {
  return parseListLimit(raw, 50);
}

export function registerOutreachRoutes(app: Hono, platform: Platform): void {
  const store = platform.outreachStore;

  /**
   * The spec'd "on-demand" engine tick: the hourly timer alone would leave an
   * approved row unsent for up to an hour. Fire-and-forget so the HTTP
   * response is not held behind the 60s send gap; the engine coalesces
   * overlapping ticks.
   */
  const kickEngine = () => {
    void platform.engine.tick().catch(() => {});
  };

  app.get("/api/outreach/outbox", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400,
      );
    }
    const status = c.req.query("status");
    if (status !== undefined && !OUTBOX_STATUSES.has(status)) {
      return c.json({ error: `unknown status: ${status}` }, 400);
    }
    return c.json({
      outbox: store.listOutbox({ status: status as OutboxStatus, limit }),
    });
  });

  /**
   * The human decision. It exists here and nowhere else: no MCP tool approves,
   * rejects, or sends an outbox row (spec invariant 1).
   */
  app.post("/api/outreach/outbox/:id/approve", (c) => decide(c, "approved"));
  app.post("/api/outreach/outbox/:id/reject", (c) => decide(c, "rejected"));

  function decide(c: Context, next: "approved" | "rejected") {
    const id = c.req.param("id") ?? "";
    try {
      const row = store.decide(id, next);
      if (!row) return c.json({ error: "not found" }, 404);
      // The approval IS the send trigger: the engine picks the row up now
      // instead of on the next hourly tick.
      if (next === "approved") kickEngine();
      return c.json({ outbox: row });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  }

  app.get("/api/outreach/suppression", (c) =>
    c.json({ suppression: store.listSuppression() }),
  );

  app.post("/api/outreach/suppression", async (c) => {
    const body = await c.req.json<{ email?: string; reason?: string }>();
    try {
      return c.json(
        {
          suppressed: store.addSuppression(
            String(body.email ?? ""),
            String(body.reason ?? "manual"),
          ),
        },
        201,
      );
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.delete("/api/outreach/suppression/:email", (c) => {
    const email = decodeURIComponent(c.req.param("email"));
    const removed = store.removeSuppression(email);
    if (!removed) return c.json({ error: "not found" }, 404);
    // The human has answered the stored "stop": withdraw the interaction
    // flags too, or a later reply check re-suppresses from the same old
    // rows. A new "stop" flags anew and suppresses again.
    platform.crmStore.clearOptOutFlags(email);
    kickEngine();
    return c.json({ deleted: true });
  });

  // Polled by the web rail (30s) and the desktop main process (60s), so it
  // stays a single COUNT and nothing else.
  app.get("/api/outreach/badge", (c) =>
    c.json({ pending: store.pendingCount() }),
  );
}

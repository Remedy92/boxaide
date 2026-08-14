/**
 * Outreach REST routes, mounted inside createApi after auth.
 * Surface: docs/specs/agent-platform.md (REST surface). This is where
 * approval lives: POST /api/outreach/outbox/:id/approve|reject exist ONLY
 * here, never as MCP tools.
 */
import type { Context, Hono } from "hono";
import type { Platform } from "../platform.js";
import { MAX_LIMIT } from "../api/routes.js";
import { readContacts } from "./crm-read.js";
import type { CampaignStatus, OutboxStatus, StepInput } from "./store.js";

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
  if (raw === undefined || raw === "") return 50;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
}

function stepsOf(raw: unknown): StepInput[] {
  if (!Array.isArray(raw)) throw new Error("steps must be an array");
  return raw.map((entry) => {
    const step = (entry ?? {}) as Record<string, unknown>;
    return {
      subject: String(step.subject ?? ""),
      body: String(step.body ?? ""),
      waitDays: Number(step.waitDays ?? 0),
    };
  });
}

export function registerOutreachRoutes(app: Hono, platform: Platform): void {
  const store = platform.outreachStore;

  /**
   * The spec'd "on-demand" engine tick: the hourly timer alone would leave an
   * approved row unsent (and a newly added contact unqueued) for up to an
   * hour. Fire-and-forget so the HTTP response is not held behind the 60s
   * send gap; the engine coalesces overlapping ticks.
   */
  const kickEngine = () => {
    void platform.engine.tick().catch(() => {});
  };

  app.get("/api/outreach/campaigns", (c) =>
    c.json({ campaigns: store.listCampaigns() }),
  );

  app.post("/api/outreach/campaigns", async (c) => {
    const body = await c.req.json<{
      name?: string;
      account?: string;
      steps?: unknown;
    }>();
    try {
      const campaign = store.createCampaign({
        name: String(body.name ?? ""),
        accountId: String(body.account ?? ""),
        steps: stepsOf(body.steps),
      });
      return c.json({ campaign, steps: store.listSteps(campaign.id) }, 201);
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.patch("/api/outreach/campaigns/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      name?: string;
      status?: string;
      steps?: unknown;
    }>();
    if (!store.getCampaign(id)) return c.json({ error: "not found" }, 404);
    try {
      const campaign = store.updateCampaign(id, {
        name: body.name,
        status: body.status as CampaignStatus | undefined,
        steps: body.steps === undefined ? undefined : stepsOf(body.steps),
      });
      // Activation is the human saying "go": queue step 0 now, not in an hour.
      if (campaign?.status === "active") kickEngine();
      return c.json({ campaign, steps: store.listSteps(id) });
    } catch (err) {
      return c.json({ error: errMessage(err) }, 400);
    }
  });

  app.post("/api/outreach/campaigns/:id/contacts", async (c) => {
    const id = c.req.param("id");
    if (!store.getCampaign(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ contactIds?: string[] }>();
    const ids = (body.contactIds ?? []).map((v) => String(v));
    const contacts = readContacts(platform.crmStore.db, ids);
    const known = new Set(contacts.map((k) => k.id));
    const refused = contacts
      .filter((k) => store.isSuppressed(k.email))
      .map((k) => ({ contactId: k.id, email: k.email, reason: "suppressed" }));
    const refusedIds = new Set(refused.map((r) => r.contactId));
    const added = store.addCampaignContacts(
      id,
      ids.filter((v) => known.has(v) && !refusedIds.has(v)),
    );
    // A contact added to an active campaign is due immediately (step 0).
    if (added > 0) kickEngine();
    return c.json({
      added,
      refused,
      unknown: ids.filter((v) => !known.has(v)),
    });
  });

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
    // flags too, or the windowed reply check re-suppresses from the same old
    // rows on the next pass. A new "stop" flags anew and suppresses again.
    platform.crmStore.clearOptOutFlags(email);
    return c.json({ deleted: true });
  });

  // Polled by the web rail (30s) and the desktop main process (60s), so it
  // stays a single COUNT and nothing else.
  app.get("/api/outreach/badge", (c) =>
    c.json({ pending: store.pendingCount() }),
  );
}

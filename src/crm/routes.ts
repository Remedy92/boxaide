/**
 * CRM REST routes, mounted inside createApi AFTER the /api/* auth middleware,
 * so every route here is token-gated already. Surface:
 * docs/specs/agent-platform.md (REST surface). Follow the error-body and
 * limit-clamping conventions of src/api/routes.ts.
 */
import type { Context, Hono } from "hono";
import type { Platform } from "../platform.js";
import { resolveOrgForContact } from "./tools.js";

/** Same ceiling as the mail routes; see MAX_LIMIT in src/api/routes.ts. */
const MAX_LIMIT = 200;

export function registerCrmRoutes(app: Hono, platform: Platform): void {
  const store = platform.crmStore;

  app.get("/api/crm/contacts", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return badLimit(c);
    return c.json({
      contacts: store.searchContacts({
        query: c.req.query("query") ?? c.req.query("q"),
        tag: c.req.query("tag"),
        limit,
      }),
    });
  });

  app.post("/api/crm/contacts", async (c) => {
    const body = await readJson<{
      email?: string;
      name?: string;
      title?: string;
      org?: string;
      orgDomain?: string;
      tags?: unknown;
      source?: string;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const email = (body.email ?? "").trim();
    if (!email.includes("@")) return c.json({ error: "email is required" }, 400);
    try {
      const org = resolveOrgForContact(
        store,
        body.org?.trim() || undefined,
        body.orgDomain?.trim() || undefined,
      );
      const contact = store.upsertContact({
        email,
        name: body.name,
        title: body.title,
        orgId: org?.id ?? null,
        source: body.source ?? "manual",
        force: true,
      });
      if (Array.isArray(body.tags)) {
        store.addTags(contact.id, body.tags.map(String));
      }
      return c.json({ contact: store.getContact(contact.id) }, 201);
    } catch (err) {
      return c.json({ error: errText(err) }, 400);
    }
  });

  app.get("/api/crm/contacts/:id", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return badLimit(c);
    const detail = store.contactDetail(
      { contactId: c.req.param("id") },
      { interactionLimit: limit },
    );
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  app.delete("/api/crm/contacts/:id", (c) => {
    const deleted = store.deleteContact(c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ deleted });
  });

  app.post("/api/crm/contacts/:id/notes", async (c) => {
    const id = c.req.param("id");
    if (!store.getContact(id)) return c.json({ error: "not found" }, 404);
    const body = await readJson<{ text?: unknown }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text is required" }, 400);
    return c.json({ note: store.addNote(id, text) }, 201);
  });

  app.get("/api/crm/contacts/:id/interactions", (c) => {
    const id = c.req.param("id");
    if (!store.getContact(id)) return c.json({ error: "not found" }, 404);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return badLimit(c);
    return c.json({ interactions: store.listInteractions(id, limit) });
  });

  app.get("/api/crm/orgs", (c) => c.json({ orgs: store.listOrgs() }));

  app.post("/api/crm/orgs", async (c) => {
    const body = await readJson<{ name?: string; domain?: string }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const name = (body.name ?? "").trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    try {
      return c.json(
        { org: store.upsertOrg({ name, domain: body.domain ?? null }) },
        201,
      );
    } catch (err) {
      return c.json({ error: errText(err) }, 400);
    }
  });

  app.get("/api/crm/pipeline", (c) => c.json({ stages: store.pipeline() }));

  app.post("/api/crm/deals", async (c) => {
    const body = await readJson<{
      dealId?: string;
      title?: string;
      contactId?: string | null;
      orgId?: string | null;
      stageId?: string;
      value?: number | null;
      currency?: string | null;
    }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    try {
      const deal = store.upsertDeal(body);
      // A dealId that matches nothing is a 404, not a silent create — see
      // upsertDeal, which returns null rather than inventing a second deal.
      if (!deal) return c.json({ error: "not found" }, 404);
      return c.json({ deal }, body.dealId ? 200 : 201);
    } catch (err) {
      return c.json({ error: errText(err) }, 400);
    }
  });

  app.post("/api/crm/deals/:id/move", async (c) => {
    const body = await readJson<{ stageId?: string; position?: unknown }>(c);
    if (!body) return c.json({ error: "body must be JSON" }, 400);
    const stageId = (body.stageId ?? "").trim();
    if (!stageId) return c.json({ error: "stageId is required" }, 400);
    try {
      const deal = store.moveDeal(
        c.req.param("id"),
        stageId,
        body.position === undefined || body.position === null
          ? undefined
          : Number(body.position),
      );
      if (!deal) return c.json({ error: "not found" }, 404);
      return c.json({ deal });
    } catch (err) {
      return c.json({ error: errText(err) }, 400);
    }
  });

  app.delete("/api/crm/deals/:id", (c) => {
    const deleted = store.deleteDeal(c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ deleted });
  });

  app.post("/api/crm/sync", async (c) => {
    try {
      return c.json(await platform.crmService.syncFromMail());
    } catch (err) {
      return c.json({ error: errText(err) }, 400);
    }
  });
}

/** Returns the limit, or null when the raw value is not a usable number. */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return 50;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
}

function badLimit(c: Context): Response {
  return c.json(
    { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
    400,
  );
}

/** Null when the request carried no parseable JSON body. */
async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Outreach REST routes, mounted inside createApi after auth.
 * Surface: docs/specs/agent-platform.md (REST surface). This is where
 * approval lives: POST /api/outreach/outbox/:id/approve|reject exist ONLY
 * here, never as MCP tools.
 */
import type { Hono } from "hono";
import type { Platform } from "../platform.js";

export function registerOutreachRoutes(_app: Hono, _platform: Platform): void {
  // TODO(outreach): /api/outreach/* routes per spec, including /badge.
}

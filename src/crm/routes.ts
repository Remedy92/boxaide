/**
 * CRM REST routes, mounted inside createApi AFTER the /api/* auth middleware,
 * so every route here is token-gated already. Surface:
 * docs/specs/agent-platform.md (REST surface). Follow the error-body and
 * limit-clamping conventions of src/api/routes.ts.
 */
import type { Hono } from "hono";
import type { Platform } from "../platform.js";

export function registerCrmRoutes(_app: Hono, _platform: Platform): void {
  // TODO(crm): /api/crm/* routes per spec.
}

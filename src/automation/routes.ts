/**
 * Automation REST routes, mounted inside createApi after auth.
 * Surface: docs/specs/agent-platform.md (REST surface).
 */
import type { Hono } from "hono";
import type { Platform } from "../platform.js";

export function registerAutomationRoutes(_app: Hono, _platform: Platform): void {
  // TODO(automation): /api/automations* routes per spec.
}

import { join } from "node:path";

/**
 * How the bearer token is reported at startup.
 *
 * A terminal gets the token itself: a human is reading it, and first run needs
 * it. Anything else — a service manager, a log collector, a CI job capturing
 * stdout — gets the file path, because those keep what they capture and the
 * token grants full access to the mailboxes.
 *
 * This lives outside `cli.ts` because that module runs `main()` on import, so
 * a test importing it would start a server.
 */
export function tokenLine(token: string, dataDir: string): string {
  if (process.stdout.isTTY) return `bearer token: ${token}`;
  if (process.env.MAILMUX_TOKEN) {
    return "bearer token: set via MAILMUX_TOKEN (not printed)";
  }
  return `bearer token: ${join(dataDir, "bearer.token")} (not printed)`;
}

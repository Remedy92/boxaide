import type { Context, MiddlewareHandler } from "hono";

/**
 * Content-Security-Policy for the self-hosted UI.
 *
 * `connect-src` is not `'self'`. The Server URL is user-configurable: the page
 * ships pointing at `127.0.0.1:8787` and is reachable on whatever port you
 * launched, so a same-origin-only rule blocks the app's own health check the
 * moment those differ. Loopback on any port plus `https:` is what the app
 * legitimately does. Plain `http:` to a remote host stays blocked, which is
 * the case worth blocking — that is the one that would put mail on the wire in
 * clear text.
 *
 * `'unsafe-inline'` in script-src is forced, not chosen. The UI is a Next.js
 * static export; its hydration bootstrap is an inline script and a static
 * export has no server to mint a per-response nonce. The value it still buys
 * is the origin restriction: no attacker-controlled *external* script can
 * load. The defence that actually stops sender-controlled markup is upstream —
 * `bodyHtml` is never rendered and `react/no-danger` is an ESLint error.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:* https:",
  // No mail is rendered in a frame and no plugin content is ever loaded.
  "frame-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "worker-src 'self' blob:",
  // Clickjacking: nothing may embed this page. A local UI that holds mail
  // credentials must not be framable by a page you happen to be visiting.
  "frame-ancestors 'none'",
  // Blocks a <base> injection from re-pointing every relative URL.
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * Headers applied to every response the mailmux server sends.
 *
 * These are cheap and unconditional. They are not a substitute for the origin
 * allowlist or the bearer token; they close the classes of problem those two
 * do not touch — framing, MIME sniffing, and referrer leakage.
 */
export function applySecurityHeaders(c: Context): void {
  c.header("Content-Security-Policy", CSP_DIRECTIVES);
  // Legacy sibling of frame-ancestors, for browsers that predate CSP L2.
  c.header("X-Frame-Options", "DENY");
  // Stops a browser from re-interpreting a mail attachment or a JSON body as
  // HTML and running it.
  c.header("X-Content-Type-Options", "nosniff");
  // A server URL can carry a port and a path worth not leaking outward.
  c.header("Referrer-Policy", "no-referrer");
  // mailmux asks for none of these; deny them so an injected script cannot.
  c.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  // Isolates this origin from cross-origin window handles.
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
}

/** Hono middleware form of {@link applySecurityHeaders}. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    applySecurityHeaders(c);
  };
}

/** Exported for tests that assert the policy has not silently loosened. */
export const CSP_FOR_TEST = CSP_DIRECTIVES;

/**
 * Every failure the browser can hit when talking to a mailmux server, and the
 * one place raw server / driver text is translated into something a person can
 * act on. Nothing here fetches.
 */

export type FailureKind =
  | "no-base-url"
  | "unreachable"
  | "cors"
  | "lna-denied"
  | "mixed-content"
  | "unauthorized"
  | "forbidden-origin"
  | "bad-request"
  | "not-found"
  | "server"
  | "unknown";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: FailureKind,
    /** The untouched response text (or thrown message). Always reachable in the UI. */
    readonly raw: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when the URL names the loopback interface exactly. */
export function isLoopback(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** True for an https base or an https page — used by the transport classifier. */
function protocolOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).protocol;
  } catch {
    return null;
  }
}

/** Safari and every other WebKit shell, but not Chromium's UA which also says "Safari". */
function isWebKitOnly(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua);
}

/**
 * Extra facts the caller may know that a bare TypeError cannot carry.
 * `healthReachable` — an unauthenticated GET /health succeeded (no preflight,
 * so it isolates CORS from "the box is down"). `preflightFailed` — a preceding
 * OPTIONS also failed.
 */
export type TransportContext = {
  healthReachable?: boolean;
  preflightFailed?: boolean;
};

/**
 * Mixed content, a Local Network Access denial, a Safari loopback block and a
 * plain CORS rejection all surface to JavaScript as an indistinguishable
 * `TypeError: Failed to fetch`. This is the decision procedure from §7.4; the
 * first match wins.
 */
export function classifyFailure(
  err: unknown,
  baseUrl: string,
  ctx: TransportContext = {},
): FailureKind {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const pageIsHttps =
    typeof window !== "undefined" && window.location.protocol === "https:";
  const baseProtocol = protocolOf(baseUrl);
  const baseIsHttp = baseProtocol === "http:";
  const baseIsLoopback = isLoopback(baseUrl);

  // 1. https page → http non-loopback target. The browser blocks it outright.
  if (pageIsHttps && baseIsHttp && !baseIsLoopback) return "mixed-content";

  // 2. WebKit refuses https → http://127.0.0.1 with no workaround.
  if (pageIsHttps && baseIsHttp && baseIsLoopback && isWebKitOnly()) {
    return "mixed-content";
  }

  // 3. Chromium 142+ Local Network Access.
  if (/address space/i.test(message)) return "lna-denied";
  if (pageIsHttps && baseIsLoopback && ctx.preflightFailed) return "lna-denied";

  // 4. Unauthenticated /health answers while an authenticated call does not:
  //    the server is up and rejecting the origin (or its preflight).
  if (ctx.healthReachable) return "cors";

  return "unreachable";
}

/** Wrap a transport-level throw as an ApiError with status 0. */
export function classifyNetworkFailure(
  err: unknown,
  baseUrl: string,
  ctx: TransportContext = {},
): ApiError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const kind = classifyFailure(err, baseUrl, ctx);
  return new ApiError(MESSAGE_FOR_KIND[kind], 0, kind, raw);
}

const MESSAGE_FOR_KIND: Record<FailureKind, string> = {
  "no-base-url": "No server URL set.",
  unreachable: "Could not reach your mailmux server.",
  cors: "Your server refused this page's origin.",
  "lna-denied": "Your browser blocked the request to your own machine.",
  "mixed-content": "Your browser blocked this connection.",
  unauthorized: "Your server rejected this token.",
  "forbidden-origin": "Your server refused this page's origin.",
  "bad-request": "The server rejected the request.",
  "not-found": "Not found.",
  server: "The server hit an error.",
  unknown: "Something went wrong.",
};

/** Pull an error string out of any body shape the server can emit. */
function messageFromBody(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.error === "string" && record.error) return record.error;
  }
  return fallback;
}

/**
 * Map a non-2xx response onto an ApiError. `data` is undefined when the body
 * was not JSON — several routes parse their request body outside the try and
 * hand back a text/plain 500.
 */
export function toApiError(status: number, data: unknown, text: string): ApiError {
  let kind: FailureKind;
  if (status === 401) kind = "unauthorized";
  else if (status === 403) kind = "forbidden-origin";
  else if (status === 404) kind = "not-found";
  else if (status >= 500) kind = "server";
  else if (status >= 400) kind = "bad-request";
  else kind = "unknown";

  const raw = messageFromBody(data, text);
  // 401 and 403 take their canonical copy rather than friendlyError's. The
  // ERROR_HINTS table is carried over from web/app.js verbatim, and its first
  // row matches /auth/ — which also matches the literal body "unauthorized",
  // so routing a rejected token through it would tell the user to check their
  // IMAP app password. The status is unambiguous; use it.
  const message =
    kind === "unauthorized" || kind === "forbidden-origin"
      ? MESSAGE_FOR_KIND[kind]
      : friendlyError(raw) || MESSAGE_FOR_KIND[kind];
  return new ApiError(message, status, kind, raw);
}

/**
 * Raw IMAP / SMTP / transport text → one plain sentence. Carried over verbatim
 * from web/app.js:42-68 and extended with the three browser-transport cases the
 * bundled UI never had to face. web/app.js keeps its own copy; the two are
 * independent and neither imports the other.
 */
const ERROR_HINTS: Array<[RegExp, string]> = [
  /* The three transport rows come FIRST and must stay there. The IMAP row
     below matches /auth/, and the literal body "unauthorized" contains "auth"
     — ordered the other way round, friendlyError("unauthorized") tells the user
     to check their Gmail app password. toApiError sidesteps this for an HTTP
     401, but the raw paths do not: the MCP test rethrows a JSON-RPC message as
     a plain Error, and errors[] strings go straight through the banner. */
  [
    /forbidden origin/i,
    "Your mailmux server refused this page's origin. Set MAILMUX_ALLOWED_ORIGINS on the machine running mailmux.",
  ],
  [/unauthorized/i, "Your server rejected this token."],
  [
    /address space/i,
    "Your browser blocked the request to your own machine. Allow local network access and reload.",
  ],
  // Carried over verbatim from web/app.js:42-68.
  [
    /auth|invalid credential|login failed|password|AUTHENTICATIONFAILED|535|534/i,
    "Wrong username or app password. Gmail, iCloud and Outlook need an app password, not your normal password.",
  ],
  [
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|EHOSTUNREACH|ENETUNREACH|connection refused/i,
    "Cannot reach that IMAP server — check the host and port.",
  ],
  [
    /ETIMEDOUT|ESOCKETTIMEDOUT|timed out|timeout/i,
    "The mail server did not respond.",
  ],
  [
    /certificate|self[- ]signed|TLS|SSL/i,
    "The server refused the secure connection — check the port and whether TLS is required.",
  ],
];

export function friendlyError(raw: unknown): string {
  const msg = String(raw ?? "").trim();
  if (!msg) return "Something went wrong.";
  for (const [re, plain] of ERROR_HINTS) if (re.test(msg)) return plain;
  return msg;
}

/**
 * True when friendlyError replaced the text, i.e. the raw string is still worth
 * showing behind a `Technical details` disclosure.
 */
export function hasTechnicalDetails(raw: unknown): boolean {
  const msg = String(raw ?? "").trim();
  return msg.length > 0 && friendlyError(msg) !== msg;
}

/**
 * The only module in this app that calls fetch.
 *
 * Every request goes from the browser straight to the user's own mailmux
 * server. There is no proxy, no route handler and no server action anywhere in
 * apps/web, so the host serving this page never sees the bearer token, the
 * mail credentials, or a message body.
 */

import {
  ApiError,
  classifyNetworkFailure,
  isLoopback,
  toApiError,
  type FailureKind,
  type TransportContext,
} from "@/lib/api/errors";

export { ApiError, isLoopback };
export type { FailureKind, TransportContext };

export type Options = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  baseUrl: string;
  /** Empty string sends no Authorization header — used by GET /health. */
  token: string;
  /** Extra facts for the transport classifier when a fetch throws (§7.4). */
  transport?: TransportContext;
};

/** Strip trailing slashes so `${base}${path}` never doubles up. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export async function request<T>(path: string, o: Options): Promise<T> {
  if (!o.baseUrl) throw new ApiError("No server URL set.", 0, "no-base-url", "");
  const url = `${normalizeBaseUrl(o.baseUrl)}${path}`;
  const headers: Record<string, string> = {};
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: o.method ?? "GET",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: o.signal,
      mode: "cors",
      credentials: "omit",
      // Chromium 142+ Local Network Access: declaring the target address space
      // makes the browser prompt deterministically instead of failing on
      // address-space inference. Not yet in lib.dom, so the cast is local.
      ...({
        targetAddressSpace: isLoopback(o.baseUrl) ? "loopback" : "public",
      } as object),
    });
  } catch (err) {
    // An abort is the caller's own doing — never reclassify it as a network
    // failure, or a superseded request looks like the server went down.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw classifyNetworkFailure(err, o.baseUrl, o.transport);
  }

  // Some endpoints throw before Hono can serialise JSON and return text/plain
  // 500s (POST /api/accounts, /api/accounts/test, /api/messages/send parse
  // their body outside the try). Never assume the error body is JSON.
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* text/plain */
  }

  if (!res.ok) throw toApiError(res.status, data, text);
  return data as T;
}

/** Build a query string, dropping undefined and empty values. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

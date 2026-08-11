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

/**
 * Read a Server-Sent Events endpoint to completion.
 *
 * Not EventSource. EventSource cannot send an Authorization header, and the
 * only way around that is the bearer token in the query string, which would put
 * it in every access log, in browser history and in any Referer the page later
 * emits. So the body stream is read and framed by hand.
 *
 * Resolves when the server closes the stream; rejects on a transport failure so
 * the caller can back off and retry. An abort resolves rather than rejecting —
 * the caller asked for it.
 */
export async function stream(
  path: string,
  o: Options & { onEvent: (event: string, data: string) => void },
): Promise<void> {
  if (!o.baseUrl) throw new ApiError("No server URL set.", 0, "no-base-url", "");
  const url = `${normalizeBaseUrl(o.baseUrl)}${path}`;
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers,
      signal: o.signal,
      mode: "cors",
      credentials: "omit",
      ...({
        targetAddressSpace: isLoopback(o.baseUrl) ? "loopback" : "public",
      } as object),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw classifyNetworkFailure(err, o.baseUrl, o.transport);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* text/plain */
    }
    throw toApiError(res.status, data, text);
  }
  // A 200 with no body is not something a healthy server does; it means an
  // intermediary stripped the stream, which is a transport problem, not ours.
  if (!res.body) {
    throw new ApiError("The server sent no stream.", 0, "unreachable", "");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. \r\n is legal in the grammar and
      // some proxies rewrite to it, so both endings are accepted.
      let split = buffer.search(/\r?\n\r?\n/);
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + (/\r\n\r\n/.test(buffer.slice(split, split + 4)) ? 4 : 2));
        emit(frame, o.onEvent);
        split = buffer.search(/\r?\n\r?\n/);
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw classifyNetworkFailure(err, o.baseUrl, o.transport);
  } finally {
    // Cancelling releases the connection; an already-closed reader throws here
    // and there is nothing left to do about it.
    reader.cancel().catch(() => {});
  }
}

/** Parse one SSE frame. A frame with no data line is a comment or a keepalive. */
function emit(frame: string, onEvent: (event: string, data: string) => void): void {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length > 0) onEvent(event, data.join("\n"));
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

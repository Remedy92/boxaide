/**
 * The transport web_fetch uses in production: a small node:http and node:https
 * adapter that returns a real Response, so everything above it stays written
 * against fetch.
 *
 * It exists for one reason. The global fetch offers no hook on the address it
 * connects to, so the only guard it can carry is "resolve, check, then fetch",
 * and the fetch resolves the name a second time. A node request takes a
 * `lookup`, which is the resolution the socket actually uses, so the check and
 * the connect see the same answer. Everything else here is the cost of that:
 * headers, decompression and body shape that fetch would have done for us.
 *
 * The hostname goes in as a name, never as the vetted IP. Passing an IP would
 * mean setting SNI and the Host header by hand to keep TLS and virtual hosts
 * working, and getting either wrong is silent. Node derives both from the
 * hostname on its own, and the lookup still decides the address.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { type LookupFunction } from "node:net";
import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { vettingLookup, type HostResolver } from "./safe-url.js";

/** Statuses whose Response must be constructed with no body, or it throws. */
const BODYLESS_STATUS = new Set([204, 205, 304]);

/** The reason phrase Response accepts: tab, space, visible ASCII, obs-text. */
const VALID_STATUS_TEXT = /^[\t \x21-\x7e\x80-\xff]*$/;

/**
 * A status the Response constructor will take. llhttp parses any three digits
 * on the status line, and the remote end writes that line, so `999` and `600`
 * both arrive here. Response throws outside 200 to 599, and the throw would
 * happen in the "response" callback where nothing is catching. Report a status
 * we cannot represent as the bad gateway it is.
 */
function safeStatus(status: number): number {
  return status >= 200 && status <= 599 ? status : 502;
}

/** What we ask for, and therefore all we have to know how to undo. */
const ACCEPT_ENCODING = "gzip, deflate, br";

function decoderFor(encoding: string): Transform | null {
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  return null;
}

/**
 * The readable the caller should see. Decompressing here rather than leaving it
 * to the reader is what keeps the byte cap meaningful: the cap has to count
 * bytes of page, not bytes on the wire, or a compressed body sails past it.
 */
function bodyStream(res: IncomingMessage): Readable {
  const encoding = (res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decoder = decoderFor(encoding);
  if (!decoder) return res;
  // Cancelling the reader at the cap destroys the decoder. Take the socket down
  // with it, or a hostile server keeps sending into something nobody reads.
  decoder.on("close", () => res.destroy());
  res.on("error", (err) => decoder.destroy(err));
  res.pipe(decoder);
  return decoder;
}

function toHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.append(name, value);
  }
  return headers;
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = { "accept-encoding": ACCEPT_ENCODING };
  if (!init) return out;
  new Headers(init).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/**
 * The adapter, given the lookup that vets addresses.
 *
 * Separate from `nodeFetch` only so a test can reach a server on an address the
 * real guard refuses, which is every address a test can bind to. Production has
 * one caller and it is `nodeFetch`.
 */
export function nodeFetchWithLookup(lookup: LookupFunction): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return await new Promise<Response>((settle, fail) => {
      const req = send({
        protocol: url.protocol,
        // Any credentials in the URL are dropped rather than forwarded, and an
        // IPv6 literal arrives bracketed from the URL parser but must not.
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        headers: headerRecord(init?.headers),
        // Never a shared keep-alive agent: a pooled socket skips the lookup, so
        // the second request through it would run with no guard at all.
        agent: false,
        lookup,
        signal: init?.signal ?? undefined,
      });
      req.on("error", fail);
      req.on("response", (res) => {
        // Everything in here runs inside an event callback, so a throw escapes
        // the promise and lands as an uncaughtException. The remote end writes
        // the status line and the headers, so it chooses what is thrown. Catch
        // it, drop the socket, and reject the way any other transport error
        // rejects.
        try {
          const status = safeStatus(res.statusCode ?? 502);
          const statusText = res.statusMessage ?? "";
          const body = BODYLESS_STATUS.has(status)
            ? null
            : (Readable.toWeb(bodyStream(res)) as unknown as ReadableStream<Uint8Array>);
          // A bodyless response hands the caller nothing to read, so nothing
          // will ever close this socket for us. Close it here.
          if (body === null) res.destroy();
          settle(
            new Response(body, {
              status,
              statusText: VALID_STATUS_TEXT.test(statusText) ? statusText : "",
              headers: toHeaders(res),
            }),
          );
        } catch (err) {
          res.destroy();
          fail(err as Error);
        }
      });
      req.end();
    });
  }) as typeof globalThis.fetch;
}

/** The production transport: node:https with the SSRF guard as its lookup. */
export function nodeFetch(resolve: HostResolver): typeof globalThis.fetch {
  return nodeFetchWithLookup(vettingLookup(resolve));
}

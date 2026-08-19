/**
 * Read one public web page as plain text.
 *
 * Four limits, all deliberate. The SSRF guard in safe-url.ts decides which
 * addresses may be reached, and is re-run on every redirect hop. Redirects are
 * followed by hand, at most three, because `redirect: "follow"` would hand the
 * hop decision to fetch and there would be no place left to re-check. The body
 * is read through the stream and abandoned at two megabytes, so a hostile or
 * merely enormous URL cannot fill memory. The whole thing is under one fifteen
 * second deadline covering every hop, not fifteen seconds each.
 *
 * The text conversion is deliberately crude: tags out, entities in, whitespace
 * collapsed. A real reader-mode extractor is a dependency, and this module may
 * not add one. Crude text of the whole page beats an elegant extract of the
 * wrong part of it.
 */
import { appVersion } from "../version.js";
import { assertPublicHost, dnsHostResolver, parseFetchUrl, type HostResolver } from "./safe-url.js";
import type { FetchedPage } from "./types.js";

/** Characters of readable text returned at most. Roughly ten thousand tokens. */
export const MAX_PAGE_CHARS = 40_000;
/** Bytes read off the wire before we give up on a page. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** Deadline for the whole fetch, redirects included. */
export const FETCH_TIMEOUT_MS = 15_000;
/** Hops followed before we call it a loop. */
export const MAX_REDIRECTS = 3;

/**
 * An honest User-Agent. A site owner who wants to see who read their page, or
 * to block us, is entitled to both, and a browser string pretending to be a
 * person would be a lie told on the user's behalf.
 */
function userAgent(): string {
  return `Boxaide/${appVersion()} (+https://boxaide.tech; self-hosted agentic inbox)`;
}

export type FetchPageDeps = {
  /** Injection seam for tests. Production uses the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Host resolver used by the SSRF guard. Production uses DNS. */
  resolve?: HostResolver;
};

/**
 * Content types we will try to read. Anything else (a PDF, an image, a zip)
 * would come back as mangled bytes pretending to be prose, which is worse for
 * an agent than a clear refusal.
 */
function readableContentType(value: string | null): boolean {
  if (!value) return true; // No header at all: try it, the text pass copes.
  const type = value.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  return (
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/json" ||
    type === "application/ld+json"
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * The character a numeric entity names, or the entity as written when it names
 * no character at all. The range check is the point: String.fromCodePoint
 * throws above U+10FFFF, and one `&#99999999;` in a corrupted page would
 * otherwise take the whole read down with a RangeError.
 */
function codePointText(code: number, whole: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
  return String.fromCodePoint(code);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known !== undefined) return known;
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return codePointText(Number.parseInt(name.slice(2), 16), whole);
    }
    if (name.startsWith("#")) {
      return codePointText(Number.parseInt(name.slice(1), 10), whole);
    }
    return whole;
  });
}

/**
 * The document title, when the markup has one. Found by scanning rather than
 * by `/<title[^>]*>/`, for the same reason htmlToText scans: that pattern
 * rescans the whole body from every `<title` when no `>` follows one.
 */
export function extractTitle(html: string): string | undefined {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open === -1) return undefined;
  const start = html.indexOf(">", open);
  if (start === -1) return undefined;
  const end = lower.indexOf("</title", start + 1);
  if (end === -1) return undefined;
  const title = decodeEntities(html.slice(start + 1, end)).replace(/\s+/g, " ").trim();
  return title === "" ? undefined : title;
}

/**
 * Elements whose contents are never prose. The element goes, not just its
 * tags, or a page's script source would arrive as text.
 */
const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "head"]);

/**
 * Closing tags that end a block of text. They become line breaks, so the
 * result keeps paragraph shape instead of collapsing a whole article onto one
 * line, which is what makes it readable to a model at all.
 */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "blockquote",
  "pre",
]);

/** The lower-cased element name of the tag starting at `start`, or null. */
function tagNameAt(lower: string, start: number): string | null {
  const from = lower[start + 1] === "/" ? start + 2 : start + 1;
  // A bounded slice, so a two megabyte body is never scanned as one name.
  const match = /^[a-z][a-z0-9]*/.exec(lower.slice(from, from + 32));
  return match ? match[0] : null;
}

/**
 * Markup to readable text.
 *
 * One forward scan rather than a chain of replaces, on purpose. The obvious
 * `/<[^>]+>/g` rescans to the end of the body from every `<` that has no `>`
 * after it, which is quadratic, and the body is written by whoever owns the
 * page the agent was pointed at. Two megabytes of `<` would freeze this single
 * process for half an hour. Every step below either moves forward or stops, so
 * the cost stays linear in the length of the page.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  // Element names with no closing tag left in the rest of the body. Searching
  // for one again on every later occurrence is the other way to go quadratic.
  const unclosed = new Set<string>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));

    if (lower.startsWith("<!--", lt)) {
      out.push(" ");
      const end = lower.indexOf("-->", lt + 4);
      if (end === -1) break; // Unterminated comment: the rest of the page is it.
      i = end + 3;
      continue;
    }

    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      // No closing bracket anywhere after this, so this "<" is prose and not a
      // tag, and so is every later one. Keep the text rather than lose it.
      out.push(html.slice(lt));
      break;
    }

    const closing = html[lt + 1] === "/";
    const name = tagNameAt(lower, lt);
    if (name && !closing && DROPPED_ELEMENTS.has(name) && !unclosed.has(name)) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeEnd = close === -1 ? -1 : html.indexOf(">", close);
      if (closeEnd === -1) {
        unclosed.add(name);
      } else {
        out.push(" ");
        i = closeEnd + 1;
        continue;
      }
    }

    if (name === "br" || name === "li") out.push("\n");
    else if (closing && name && BLOCK_ELEMENTS.has(name)) out.push("\n");
    else out.push(" ");
    i = gt + 1;
  }
  return decodeEntities(out.join(""))
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reads the body, stopping at the byte cap rather than buffering it all. */
async function readCapped(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      if (bytes >= MAX_PAGE_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

/**
 * GET a public URL and return its readable text.
 *
 * Throws with a specific, lower-case message on every refusal: a bad scheme, a
 * private address at any hop, too many hops, a non-text body, an HTTP error.
 * The agent is expected to read the message and tell the user, not to retry.
 */
export async function fetchPage(raw: string, deps: FetchPageDeps = {}): Promise<FetchedPage> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const resolve = deps.resolve ?? dnsHostResolver;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = parseFetchUrl(raw);
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url, resolve);
      try {
        res = await doFetch(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": userAgent(),
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url.toString()}`);
        }
        throw new Error(`fetch failed: ${(err as Error).message}`);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`too many redirects (limit ${MAX_REDIRECTS}): ${raw}`);
      }
      // Resolved against the current URL, then re-checked from scratch at the
      // top of the loop. A public host redirecting to 127.0.0.1 is the whole
      // reason redirects are followed here rather than by fetch.
      url = parseFetchUrl(new URL(location, url).toString());
    }
    if (!res) throw new Error(`fetch failed: ${raw}`);
    if (!res.ok) {
      throw new Error(`fetch failed with HTTP ${res.status}: ${url.toString()}`);
    }
    const contentType = res.headers.get("content-type");
    if (!readableContentType(contentType)) {
      throw new Error(`page is not readable text (content-type ${contentType}): ${url.toString()}`);
    }
    const body = await readCapped(res);
    const full = htmlToText(body);
    const truncated = full.length > MAX_PAGE_CHARS;
    return {
      url: url.toString(),
      title: extractTitle(body),
      text: truncated ? full.slice(0, MAX_PAGE_CHARS) : full,
      truncated,
    };
  } finally {
    clearTimeout(deadline);
  }
}

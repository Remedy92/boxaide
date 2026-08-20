"use client";

import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";

/**
 * §6.4.6. The one sanitiser in apps/web, and the only way sender HTML is
 * allowed to leave a string.
 *
 * Two callers, both of which hand sender markup to something that will parse
 * it: `HtmlBody` renders it in the sandboxed frame, and the forward path puts
 * it in a message bound for a stranger's mail client. The second has no
 * sandbox to fall back on, which is exactly why it uses the same config: what
 * this client refuses to run, it also refuses to relay.
 */

const SANITIZE_CONFIG = {
  // HTML only: mail needs no inline SVG or MathML, and both are recurring
  // sources of sanitiser bypasses. SVG *images* still render: a data: or
  // remote URI in <img src> is an image load, not markup.
  USE_PROFILES: { html: true },
  // On top of the profile: no interactive or document-level tags. Forms
  // cannot submit in the reader's sandbox anyway; removing them keeps dead
  // controls out of the reading pane. <input type="image"> fetches its src
  // even with scripting off. <meta>/<base>/<link> could redefine CSP,
  // targets, or fetch styles, and the frame builds its own head.
  FORBID_TAGS: [
    "form",
    "input",
    "button",
    "select",
    "option",
    "textarea",
    "meta",
    "base",
    "link",
    "dialog",
  ],
  FORBID_ATTR: ["action", "formaction", "ping", "usemap", "ismap"],
  // Mail is a document, not an app: no ARIA needed from the sender, and
  // data-* attributes have no consumer inside the frame.
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
} satisfies DOMPurifyConfig;

/**
 * A private DOMPurify instance, not the module singleton. The anchor hook is
 * the only thing keeping `rel` and `target` on mail links, and on the shared
 * instance any future consumer calling `removeAllHooks()` would strip it with
 * no test failing. Built lazily because `DOMPurify(window)` needs a DOM: Next
 * prerenders this module at build time, where there is no window and no
 * message data to sanitise either.
 */
let purifier: ReturnType<typeof DOMPurify> | null = null;

function getPurifier(): ReturnType<typeof DOMPurify> | null {
  if (typeof window === "undefined") return null;
  if (!purifier) {
    const instance = DOMPurify(window);
    if (!instance.isSupported) return null;
    /* Every anchor opens a fresh, opener-less, referrer-less tab via its own
       attributes: the only navigation the reader's sandbox permits. */
    instance.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
    purifier = instance;
  }
  return purifier;
}

/**
 * Sanitised markup, or `null` when there is no DOM to sanitise with.
 *
 * `null` rather than `""` on purpose: DOMPurify's own unsupported path returns
 * the input UNCHANGED (purify.es.mjs, "Return dirty HTML if DOMPurify cannot
 * run"), so a caller that cannot tell "empty" from "never ran" is one refactor
 * away from shipping raw sender HTML. Callers must handle `null` by falling
 * back to text.
 */
export function sanitizeMailHtml(html: string): string | null {
  const instance = getPurifier();
  return instance ? instance.sanitize(html, SANITIZE_CONFIG) : null;
}

/**
 * Sanitising is synchronous and lands on the render path, and the HTML
 * parser's misnesting recovery is superlinear: 250 000 chars of `<b>` soup
 * measures over six seconds of blocked main thread, which anyone who can send
 * you mail can do for free. Markup past this point needs an explicit opt-in,
 * so the cost is never paid without a click.
 *
 * Inlined `data:` payloads are excluded from the measurement. A photo is
 * megabytes of base64 that the parser walks in one pass; it is the tag count
 * that is expensive, not the byte count.
 */
export const MAX_RENDERED_MARKUP_CHARS = 100_000;

const DATA_URI_PAYLOAD = /data:[a-z0-9.+-]+\/[a-z0-9.+-]*;base64,[a-z0-9+/=]+/gi;

export function markupLength(html: string): number {
  return html.replace(DATA_URI_PAYLOAD, "").length;
}

"use client";

import * as React from "react";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { ImageOff } from "lucide-react";
import { BodyText } from "@/components/reader/body-text";

/**
 * §6.4.6. Renders `bodyHtml` — sanitised, framed, and fenced.
 *
 * Sender HTML is hostile input. Four independent layers stand between it and
 * the app origin, and no single failure is enough to breach them:
 *
 * 1. DOMPurify strips scripts, event handlers, forms and document-level tags
 *    before the markup exists anywhere but a string.
 * 2. The iframe `sandbox` omits `allow-scripts`, so the browser refuses to
 *    execute script in the frame no matter what survived sanitisation.
 * 3. The sandbox also omits `allow-same-origin`: the frame is an opaque
 *    origin. Even script running there — which layer 2 forbids — would find
 *    no app DOM, no localStorage, no token, and no origin to speak from.
 * 4. A `<meta>` CSP of `default-src 'none'` inside the frame blocks every
 *    fetch the document could still express, and intersects with the page
 *    CSP the srcdoc document inherits.
 *
 * The opaque origin has a price paid on purpose: the parent cannot read the
 * frame's document, so the frame cannot auto-size to its content and scrolls
 * internally instead. Height measurement is not worth a same-origin frame
 * one browser bug away from the bearer token.
 *
 * Remote images are blocked by default — a tracking pixel is a read receipt
 * the sender did not ask permission for. `cid:` inline images arrive as
 * `data:` URIs (mailparser inlines them at parse time) and always render.
 * "Load images" re-renders the frame with `img-src` widened, per message,
 * not persisted.
 *
 * Links: every anchor is rewritten to `target="_blank"` with
 * `rel="noopener noreferrer nofollow"` after sanitisation. The sandbox
 * allows exactly the popup that a user's click opens (`allow-popups`,
 * escaping the sandbox so the target site works); the frame itself can
 * never navigate anywhere.
 */

/** Everything the frame may fetch with remote images blocked: inline images
    only. `default-src 'none'` already implies the rest; script-src, object-src,
    frame-src, base-uri and form-action are spelled out so a loosening shows
    up in a diff as the removal of a 'none', not the absence of a default. */
const CSP_BLOCKED =
  "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
/** After the user opts in, images may also come from the network. */
const CSP_ALLOWED =
  "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data:";

/* Every anchor opens a fresh, opener-less, referrer-less tab via its own
   attributes — the only navigation the sandbox permits. Registered once,
   module-wide: this is the sole DOMPurify consumer in apps/web. The
   isSupported guard skips Next's build-time prerender, where DOMPurify has
   no DOM to work with; in that pass no message data exists to sanitise. */
if (DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

const SANITIZE_CONFIG = {
  // HTML only: mail needs no inline SVG or MathML, and both are recurring
  // sources of sanitiser bypasses. SVG *images* still render — a data: or
  // remote URI in <img src> is an image load, not markup.
  USE_PROFILES: { html: true },
  // On top of the profile: no interactive or document-level tags. Forms
  // cannot submit in the sandbox anyway; removing them keeps dead controls
  // out of the reading pane. <meta>/<base>/<link> could redefine CSP,
  // targets, or fetch styles — the frame builds its own head.
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

/** True when the sanitised markup references anything fetched over the network. */
function referencesRemoteContent(html: string): boolean {
  return /\s(?:src|srcset|background)\s*=\s*["']?https?:/i.test(html) ||
    /url\(\s*["']?https?:/i.test(html);
}

function buildSrcDoc(sanitized: string, allowRemote: boolean): string {
  const csp = allowRemote ? CSP_ALLOWED : CSP_BLOCKED;
  // The frame supplies its own head: the CSP fence, no referrer on any link
  // click, and reset styles. Mail expects a white canvas — newsletters bake
  // that assumption into their palettes — so the frame stays light in both
  // app themes.
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    padding: 12px 16px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111111;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
</style>
</head><body>${sanitized}</body></html>`;
}

export function HtmlBody({ html, text }: { html: string; text: string }) {
  const [allowRemote, setAllowRemote] = React.useState(false);

  const sanitized = React.useMemo(
    () => DOMPurify.sanitize(html, SANITIZE_CONFIG),
    [html],
  );
  const hasRemote = React.useMemo(
    () => referencesRemoteContent(sanitized),
    [sanitized],
  );
  const srcDoc = React.useMemo(
    () => buildSrcDoc(sanitized, allowRemote),
    [sanitized, allowRemote],
  );

  /* HTML that sanitises to nothing (or was nothing) falls back to the
     plain-text reader rather than an empty frame. hasHtml stays true: the
     raw source exists and "View HTML source" can still show it. */
  if (!sanitized.trim()) return <BodyText text={text} hasHtml />;

  return (
    <div className="mt-5">
      {hasRemote && !allowRemote && (
        <p className="mb-3 flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
          <ImageOff aria-hidden="true" className="size-3" strokeWidth={1.5} />
          Remote images blocked.
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-fg"
            onClick={() => setAllowRemote(true)}
          >
            Load images
          </button>
        </p>
      )}
      {/* The opaque origin makes the frame unmeasurable, so it takes the
          viewport's remaining height and scrolls internally. */}
      <iframe
        title="Message body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        className="w-full rounded-[var(--radius-md)] bg-white"
        style={{
          height: "max(480px, calc(100dvh - 340px))",
          border: "none",
          colorScheme: "light",
        }}
      />
    </div>
  );
}

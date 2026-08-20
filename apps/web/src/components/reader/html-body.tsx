"use client";

import * as React from "react";
import { ImageOff } from "lucide-react";
import { BodyText } from "@/components/reader/body-text";
import {
  MAX_RENDERED_MARKUP_CHARS,
  markupLength,
  sanitizeMailHtml,
} from "@/lib/mail/sanitize";

/**
 * §6.4.6. Renders `bodyHtml` - sanitised, framed, and fenced.
 *
 * Sender HTML is hostile input. Four independent layers stand between it and
 * the app origin, and no single failure is enough to breach them:
 *
 * 1. DOMPurify strips scripts, event handlers, forms and document-level tags
 *    before the markup exists anywhere but a string.
 * 2. The iframe `sandbox` omits `allow-scripts`, so the browser refuses to
 *    execute script in the frame no matter what survived sanitisation.
 * 3. The sandbox also omits `allow-same-origin`: the frame is an opaque
 *    origin. Even script running there, which layer 2 forbids, would find no
 *    app DOM, no localStorage, no token, and no origin to speak from.
 * 4. A `<meta>` CSP of `default-src 'none'` inside the frame blocks every
 *    fetch the document could still express, and intersects with the page
 *    CSP the srcdoc document inherits.
 *
 * The opaque origin has a price paid on purpose: the parent cannot read the
 * frame's document, so the frame cannot auto-size to its content and scrolls
 * internally instead. Height measurement is not worth a same-origin frame one
 * browser bug away from the bearer token.
 *
 * Remote images are blocked by default: a tracking pixel is a read receipt the
 * sender did not ask permission for. `cid:` inline images arrive as `data:`
 * URIs, inlined by mailparser at parse time (simple-parser.js calls
 * `updateImageLinks` unless `keepCidLinks` is set, and nothing here sets it),
 * so they always render. "Load images" re-renders the frame with `img-src`
 * widened. The choice is per message and is not persisted, which is why
 * `Reader` gives this component `key={full.id}`: without the key React keeps
 * the instance across a selection change and the consent leaks into the next
 * sender's mail.
 *
 * Links: every anchor is rewritten to `target="_blank"` with
 * `rel="noopener noreferrer nofollow"` after sanitisation. The sandbox allows
 * exactly the popup that a user's click opens (`allow-popups`, escaping the
 * sandbox so the target site works); the frame itself can never navigate.
 */

/**
 * Everything the frame may fetch. `default-src 'none'` already implies the
 * rest; script-src, object-src, frame-src, base-uri and form-action are spelt
 * out so a loosening shows up in a diff as the removal of a 'none', not the
 * absence of a default. The two policies differ in `img-src` alone, so they
 * are built from one base rather than written out twice.
 */
const CSP_BASE =
  "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; font-src data:";
/** Inline images only, which is every `cid:` image and nothing off the network. */
const CSP_IMG_BLOCKED = "img-src data:";
/**
 * After the user opts in, images may also come from the network. `https:`
 * only: the page header does not allow plain `http:` to a remote host either,
 * and a widening the header would refuse is a widening that cannot work.
 */
const CSP_IMG_ALLOWED = "img-src data: https:";

/**
 * True when the sanitised markup references something fetched over the
 * network, which is what the "Load images" notice is offered for. The frame
 * CSP is the gate, not this: a miss here means the image is still blocked and
 * the user is simply never told why. Hence the optional scheme, which catches
 * the protocol-relative `//host/pixel.gif` that bulk mail favours.
 */
function referencesRemoteContent(html: string): boolean {
  return (
    /\s(?:src|srcset|poster|background)\s*=\s*["']?(?:https?:)?\/\//i.test(html) ||
    /url\(\s*["']?(?:https?:)?\/\//i.test(html)
  );
}

function buildSrcDoc(sanitized: string, allowRemote: boolean): string {
  const csp = `${CSP_BASE}; ${allowRemote ? CSP_IMG_ALLOWED : CSP_IMG_BLOCKED}`;
  // The frame supplies its own head: the CSP fence, no referrer on any link
  // click, and reset styles. Mail expects a white canvas - newsletters bake
  // that assumption into their palettes - so the frame stays light in both
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
  const [forceRender, setForceRender] = React.useState(false);

  const oversized = React.useMemo(
    () => markupLength(html) > MAX_RENDERED_MARKUP_CHARS,
    [html],
  );
  const skipped = oversized && !forceRender;

  const sanitized = React.useMemo(() => {
    if (skipped) return "";
    /* null means no DOM or an unsupported browser. Falling back to text is
       the only answer that cannot hand the frame un-sanitised markup. */
    return sanitizeMailHtml(html) ?? "";
  }, [html, skipped]);

  const hasRemote = React.useMemo(
    () => referencesRemoteContent(sanitized),
    [sanitized],
  );
  const srcDoc = React.useMemo(
    () => buildSrcDoc(sanitized, allowRemote),
    [sanitized, allowRemote],
  );

  if (skipped) {
    return (
      <div className="mt-5">
        <p className="mb-3 text-[12px] leading-4 text-fg-tertiary">
          This message has an unusually large HTML body. Showing the plain text
          instead.{" "}
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-fg"
            onClick={() => setForceRender(true)}
          >
            Show HTML anyway
          </button>
        </p>
        <BodyText text={text} hasHtml />
      </div>
    );
  }

  /* HTML that sanitises to nothing (or was nothing) falls back to the
     plain-text reader rather than an empty frame. hasHtml stays true: the
     raw source exists and "View HTML source" can still show it. */
  if (!sanitized.trim()) return <BodyText text={text} hasHtml />;

  return (
    <div className="mt-5">
      {hasRemote && (
        <p className="mb-3 flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
          <ImageOff aria-hidden="true" className="size-3" strokeWidth={1.5} />
          {allowRemote ? (
            /* The row stays put once the images load. Removing it would drop
               the focus of whoever pressed the button to <body>. */
            <span role="status">Remote images loaded for this message.</span>
          ) : (
            <>
              Remote images blocked.
              <button
                type="button"
                className="cursor-pointer underline underline-offset-2 hover:text-fg"
                onClick={() => setAllowRemote(true)}
              >
                Load images
              </button>
            </>
          )}
        </p>
      )}
      {/* The opaque origin makes the frame unmeasurable, so it takes the
          viewport's remaining height and scrolls internally. */}
      <iframe
        title="Message body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        className="w-full rounded-[var(--radius-md)] border border-border-subtle bg-white"
        style={{
          height: "max(320px, calc(100dvh - 340px))",
          colorScheme: "light",
        }}
      />
    </div>
  );
}

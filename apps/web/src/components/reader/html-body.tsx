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
 * Renders `bodyHtml`: sanitised, framed, and fenced.
 *
 * The four layers that stand between hostile sender markup and the app origin
 * are stated once in SECURITY.md, "HTML mail rendering" (cited in the tree as
 * §6.4.6). Read it before changing anything here. This file implements three
 * of them and must keep implementing all three:
 *
 * 1. `sanitizeMailHtml` runs before the markup exists anywhere but a string.
 * 2. `sandbox` omits `allow-scripts`, so nothing in the frame executes.
 * 3. `sandbox` also omits `allow-same-origin`, so the frame has no origin, no
 *    app DOM and no token to reach for. Adding it back defeats layer 3 and
 *    layer 4 at once, whatever the reason looks like at the time.
 *
 * That opaque origin is why this component measures the *pane* it sits in and
 * never the frame's content: the parent cannot read the frame's document, by
 * design and permanently.
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
 * The frame is sized from the reading pane it sits in, not from the viewport
 * and not from its content: the opaque origin makes the content unmeasurable
 * for good, and a viewport formula has to guess at everything drawn above the
 * frame, which is what the old `calc(100dvh - 340px)` was doing. Two
 * constants survive, and both describe the frame rather than the chrome
 * around it.
 */
/** Floor. Below roughly this the frame shows one line of a newsletter with a
    scrollbar beside it, which is worse than overflowing the pane. */
const MIN_FRAME_HEIGHT = 320;
/** Breathing room under the frame, so the reply composer that follows reads as
    the next thing rather than as a strip clipped by the fold. */
const FRAME_BOTTOM_GUTTER = 24;

/**
 * The scrollable ancestor the frame has to fit inside. Found by computed style
 * rather than by class name so it survives a refactor of the reader's layout:
 * whichever element actually scrolls is the one whose height is the budget.
 */
function nearestScrollParent(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return parent;
    parent = parent.parentElement;
  }
  return null;
}

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

/**
 * The plain text, plus the one thing `BodyText` cannot know: that raw HTML is
 * still there. Both fallbacks below reach it, and what the user needs to read
 * differs from the reader's text-only case, where there is no HTML to open.
 * Without this line a message whose HTML sanitised away and that carries no
 * text reads as empty, with no hint that anything is recoverable.
 */
function TextFallback({ text }: { text: string }) {
  return (
    <>
      <BodyText text={text} />
      {!text && (
        <p className="mt-1 text-[13px] leading-[18px] text-fg-tertiary">
          It has an HTML body. Open “View HTML source” to read it as text.
        </p>
      )}
    </>
  );
}

export function HtmlBody({ html, text }: { html: string; text: string }) {
  const [allowRemote, setAllowRemote] = React.useState(false);
  const [forceRender, setForceRender] = React.useState(false);
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = React.useState(MIN_FRAME_HEIGHT);

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

  /* Both fallbacks below render text instead of a frame, so there is nothing
     to size in those states, and the effect has to re-run when "Show HTML
     anyway" turns one of them back into a frame. */
  const framed = !skipped && sanitized.trim() !== "";

  /* Give the frame the height the pane has left below it, so it ends where the
     visible pane ends instead of at a guessed viewport offset. Layout, not
     effect: the frame paints at its real height with no flash of a wrong one. */
  React.useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!framed || !frame) return;
    const pane = nearestScrollParent(frame);
    if (!pane) return;

    const measure = () => {
      /* The frame's top in the pane's *content* coordinates. Scroll position
         cancels between the two rects and scrollTop, so scrolling cannot feed
         back into the height. Nothing below the frame is read either, so the
         composer growing does not resize it. */
      const top =
        frame.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        pane.scrollTop;
      const available = pane.clientHeight - top - FRAME_BOTTOM_GUTTER;
      setFrameHeight(Math.max(MIN_FRAME_HEIGHT, Math.round(available)));
    };

    measure();
    /* The pane resizes with the window and with the panes beside it; the
       article and this component's wrapper resize when the subject wraps, the
       identity block expands, or the blocked-images row appears above the
       frame. Each moves the frame's top, which is the only input that counts. */
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    for (const node of [frame.parentElement, frame.closest("article")]) {
      if (node && node !== pane) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [framed]);

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
        <TextFallback text={text} />
      </div>
    );
  }

  /* HTML that sanitises to nothing (or was nothing) falls back to the
     plain-text reader rather than an empty frame. */
  if (!framed) return <TextFallback text={text} />;

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
      {/* The opaque origin makes the frame unmeasurable, so it takes the height
          the pane has left below it and scrolls internally. */}
      <iframe
        ref={frameRef}
        title="Message body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        className="w-full rounded-[var(--radius-md)] border border-border-subtle bg-white"
        style={{ height: frameHeight, colorScheme: "light" }}
      />
    </div>
  );
}

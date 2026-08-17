"use client";

import * as React from "react";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { ImageOff } from "lucide-react";
import { BodyText } from "@/components/reader/body-text";

/**
 * §6.4.6. Renders `bodyHtml` — sanitised, framed, and fenced.
 *
 * Sender HTML is hostile input. Three independent layers stand between it and
 * the app origin, and any one of them alone is enough to stop script:
 *
 * 1. DOMPurify strips scripts, event handlers, forms and frame-busting tags
 *    before the markup exists anywhere but a string.
 * 2. The iframe `sandbox` omits `allow-scripts`, so the browser refuses to
 *    execute script in the frame no matter what survived sanitisation.
 * 3. A `<meta>` CSP of `default-src 'none'` inside the frame blocks every
 *    fetch the document could still express, and intersects with the page
 *    CSP the srcdoc document inherits.
 *
 * `allow-same-origin` is present only so the parent can measure the document
 * height; it is safe because layer 2 means nothing can run inside the frame.
 *
 * Remote images are blocked by default — a tracking pixel is a read receipt
 * the sender did not ask permission for. `cid:` inline images arrive as
 * `data:` URIs (mailparser inlines them at parse time) and always render.
 * "Load remote images" re-renders the frame with `img-src` widened, per
 * message, not persisted.
 */

/** Everything the frame may fetch with remote images blocked: inline images only. */
const CSP_BLOCKED =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
/** After the user opts in, images may also come from the network. */
const CSP_ALLOWED =
  "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data:";

const SANITIZE_CONFIG: DOMPurifyConfig = {
  // On top of DOMPurify's defaults: no interactive or document-level tags.
  // Forms cannot submit in the sandbox anyway; removing them keeps dead
  // controls out of the reading pane. <meta>/<base>/<link> could redefine
  // CSP, targets, or fetch styles — the frame builds its own head.
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
  FORBID_ATTR: ["action", "formaction", "target", "ping"],
  // Mail is a document, not an app: no ARIA needed from the sender, and
  // data-* attributes have no consumer inside the frame.
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
};

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
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #111111;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
</style>
</head><body>${sanitized}</body></html>`;
}

export function HtmlBody({ html, text }: { html: string; text: string }) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(120);
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

  /* Height: srcdoc + allow-same-origin lets the parent read scrollHeight.
     A ResizeObserver on the frame's body follows late image loads without
     polling. Re-runs on srcDoc change because load replaces the document;
     the previous document's observer is disconnected first. */
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const onLoad = React.useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    const measure = () =>
      setHeight(Math.max(doc.documentElement.scrollHeight, 40));
    measure();
    observerRef.current?.disconnect();
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(doc.body);
  }, []);
  React.useEffect(() => () => observerRef.current?.disconnect(), []);

  /* Links: the sandbox has no allow-popups and sanitisation drops target=,
     so clicks inside the frame navigate nowhere on their own. The parent
     intercepts them (same-origin allows it) and opens a fresh, unsandboxed,
     opener-less tab — the frame itself never navigates. */
  const onFrameClick = React.useCallback((event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }, []);

  const bindFrame = React.useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    doc?.addEventListener("click", onFrameClick);
    onLoad();
  }, [onFrameClick, onLoad]);

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
      <iframe
        ref={frameRef}
        title="Message body"
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={bindFrame}
        className="w-full rounded-[var(--radius-md)] bg-white"
        style={{ height, border: "none", colorScheme: "light" }}
      />
    </div>
  );
}

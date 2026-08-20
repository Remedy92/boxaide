"use client";

import { QuotedBlock } from "@/components/reader/quoted-block";
import { linkifyToElements } from "@/lib/format/linkify";
import { splitQuotedTail } from "@/lib/format/quote";

const TRUNCATION_LIMIT = 50_000;

/**
 * §6.4.6. Renders `bodyText` and only `bodyText`.
 *
 * `bodyHtml` is raw, unsanitised sender HTML. It renders only through
 * `HtmlBody` — DOMPurify plus a script-disabled sandboxed frame — never
 * through the React tree. `react/no-danger` is an ESLint error. The only
 * `dangerouslySetInnerHTML` in apps/web is the desktop UA marker in
 * layout.tsx, not mail. Links come back from linkifyToElements as React
 * elements; no HTML string is ever built here.
 */
export function BodyText({
  text,
  hasHtml,
}: {
  text: string;
  hasHtml: boolean;
}) {
  if (!text) {
    return (
      <div className="mt-5 space-y-1">
        <p className="text-[13px] leading-[18px] text-fg-tertiary">
          This message has no plain-text body.
        </p>
        {hasHtml && (
          <p className="text-[13px] leading-[18px] text-fg-tertiary">
            It has an HTML body. Open “View HTML source” to read it as text.
          </p>
        )}
      </div>
    );
  }

  const { body, quoted, quotedLines } = splitQuotedTail(text);

  return (
    <div className="mt-5" style={{ maxWidth: "var(--reader-measure)" }}>
      <div
        className="text-fg select-text"
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontSize: "var(--text-read)",
          lineHeight: "var(--leading-read)",
        }}
      >
        {linkifyToElements(body)}
      </div>

      {quoted && <QuotedBlock text={quoted} lines={quotedLines} />}

      {text.length >= TRUNCATION_LIMIT && (
        <p className="mt-4 text-[12px] leading-4 text-fg-tertiary">
          Message truncated at 50,000 characters.
        </p>
      )}
    </div>
  );
}

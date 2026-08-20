"use client";

import { QuotedBlock } from "@/components/reader/quoted-block";
import { linkifyToElements } from "@/lib/format/linkify";
import { splitQuotedTail } from "@/lib/format/quote";

const TRUNCATION_LIMIT = 50_000;

/**
 * Renders `bodyText` and only `bodyText`. No HTML string is ever built here:
 * links come back from `linkifyToElements` as React elements.
 *
 * Sender HTML never reaches this component. `bodyHtml` renders only through
 * `HtmlBody`, behind the four layers in SECURITY.md, "HTML mail rendering"
 * (cited in the tree as §6.4.6). Callers with HTML in hand fall back to this
 * component for the *text*, and own any notice about the HTML they still
 * hold, because only they know it exists.
 */
export function BodyText({ text }: { text: string }) {
  if (!text) {
    return (
      <p className="mt-5 text-[13px] leading-[18px] text-fg-tertiary">
        This message has no plain-text body.
      </p>
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

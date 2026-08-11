import * as React from "react";
import { linkifyToElements } from "@/lib/format/linkify";

/**
 * A deliberately small Markdown subset, rendered to React elements.
 *
 * No library and no HTML string. Every other renderer either takes an HTML
 * detour — which this app forbids everywhere, see linkify and the reader's
 * refusal to touch bodyHtml — or ships a parser and a sanitiser to audit. The
 * agent writes prose about email, so the grammar it actually uses is short:
 *
 *   # heading            fenced code       ```
 *   - bullet             inline `code`
 *   1. numbered          **bold**  *italic*
 *   > quote              paragraphs and blank lines
 *
 * Anything outside that renders as its literal text, which is the correct
 * failure: a stray asterisk is a stray asterisk, never a swallowed line.
 *
 * Raw HTML in the source is never parsed. It arrives as a string child and
 * React escapes it by construction.
 */

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; text: string };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (FENCE.test(line)) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index++;
      }
      index++; // closing fence, or the end of the string
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      index++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Two visual levels only. The type scale has four sizes and a
      // conversation does not get to invent a fifth.
      blocks.push({
        kind: "heading",
        level: heading[1].length <= 2 ? 2 : 3,
        text: heading[2],
      });
      index++;
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = BULLET.exec(lines[index]);
        if (!match) break;
        items.push(match[1]);
        index++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (NUMBERED.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = NUMBERED.exec(lines[index]);
        if (!match) break;
        items.push(match[1]);
        index++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]);
        if (!match) break;
        body.push(match[1]);
        index++;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (
        !next.trim() ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        BULLET.test(next) ||
        NUMBERED.test(next) ||
        QUOTE.test(next)
      ) {
        break;
      }
      paragraph.push(next);
      index++;
    }
    blocks.push({ kind: "p", lines: paragraph });
  }

  return blocks;
}

/**
 * Inline spans: `code`, **bold**, *italic*, then URLs in whatever is left.
 *
 * One pass, longest marker first, so `**a**` is never read as two italics. Code
 * wins over everything: backticks are the escape hatch a person reaches for
 * precisely when they want the asterisks left alone.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(...linkifyToElements(text.slice(last, at)));
    const token = match[0];

    if (token.startsWith("`")) {
      out.push(
        <code
          key={`${keyPrefix}-c${key++}`}
          className="rounded-[var(--radius-xs)] border border-border-subtle bg-surface-0 px-1 py-px font-mono text-[12px]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={`${keyPrefix}-b${key++}`} className="font-medium text-fg">
          {linkifyToElements(token.slice(2, -2))}
        </strong>,
      );
    } else {
      out.push(
        <em key={`${keyPrefix}-i${key++}`} className="italic">
          {linkifyToElements(token.slice(1, -1))}
        </em>,
      );
    }
    last = at + token.length;
  }

  if (last < text.length) out.push(...linkifyToElements(text.slice(last)));
  return out;
}

/** A paragraph's own line breaks are kept — an agent lays out lists by hand. */
function withBreaks(lines: string[], keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br${i}`} />);
    out.push(...inline(line, `${keyPrefix}-${i}`));
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => parse(text), [text]);

  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) => {
        const key = `b${i}`;
        switch (block.kind) {
          case "heading":
            return (
              <p
                key={key}
                className={
                  block.level === 2
                    ? "title-15 pt-1 text-fg"
                    : "pt-0.5 text-[13px] leading-[18px] font-medium text-fg"
                }
              >
                {inline(block.text, key)}
              </p>
            );
          case "ul":
            return (
              <ul key={key} className="space-y-1 pl-1">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`} className="flex gap-2">
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-1.5 shrink-0 items-center text-fg-tertiary"
                    >
                      <span className="block size-[3px] rounded-[var(--radius-full)] bg-current" />
                    </span>
                    <span className="min-w-0 flex-1">{inline(item, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="space-y-1 pl-1">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`} className="flex gap-2">
                    <span className="tnum shrink-0 text-fg-tertiary">{j + 1}.</span>
                    <span className="min-w-0 flex-1">{inline(item, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote
                key={key}
                className="border-l border-border-strong pl-3 text-fg-secondary"
              >
                {withBreaks(block.lines, key)}
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={key}
                className="pane-scroll overflow-x-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface-0 p-3 font-mono text-[12px] leading-[18px] whitespace-pre"
              >
                {block.text}
              </pre>
            );
          default:
            return <p key={key}>{withBreaks(block.lines, key)}</p>;
        }
      })}
    </div>
  );
}

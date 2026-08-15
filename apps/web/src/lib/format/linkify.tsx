import * as React from "react";

/**
 * Turn plain text into an array of React elements and strings. It never builds
 * an HTML string. React escapes every string child by construction.
 *
 * The allowlist is strict on purpose: `https?://` and `mailto:` only. No bare
 * `www.`, no scheme-less hosts, because guessing a scheme for text a stranger
 * sent is how a reader turns into a phishing surface.
 */
const URL_PATTERN = /(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;

/** Trailing punctuation almost never belongs to the URL. */
function trimTrailing(match: string): string {
  let end = match.length;
  while (end > 0 && /[.,;:!?)\]}>'"]/.test(match[end - 1])) {
    // Keep a closing bracket that has a matching opener inside the match.
    const ch = match[end - 1];
    const opener = ch === ")" ? "(" : ch === "]" ? "[" : ch === "}" ? "{" : null;
    if (opener) {
      const slice = match.slice(0, end);
      const opens = slice.split(opener).length - 1;
      const closes = slice.split(ch).length - 1;
      if (opens >= closes) break;
    }
    end--;
  }
  return match.slice(0, end);
}

export function linkifyToElements(text: string): React.ReactNode[] {
  if (!text) return [];
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const url = trimTrailing(raw);
    if (!url) continue;

    if (index > lastIndex) out.push(text.slice(lastIndex, index));
    out.push(
      <a
        key={`link-${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline decoration-1 underline-offset-2"
      >
        {url}
      </a>,
    );
    lastIndex = index + url.length;
  }

  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

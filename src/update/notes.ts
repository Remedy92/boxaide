/**
 * What a release body has to become before a person reads it in the app.
 *
 * The two channels hand us two different things and neither is display text.
 * electron-updater reads GitHub's releases *feed*, whose body is already
 * rendered HTML — `<h2>`, `<ul>`, and an `<a class="issue-link">` carrying
 * eight data attributes for every `(#84)` in a commit subject. The manual
 * channel reads the REST API, whose `body` is the markdown that HTML was made
 * from. Printing either one raw is what put `<h2>What is new</h2>` on screen.
 *
 * So both are flattened here, once, before anything stores or renders them:
 * tags out, entities decoded, list items to "- ", pull-request numbers and
 * their links dropped, blank lines collapsed. The result is plain text, which
 * is what both surfaces render with `whitespace-pre-wrap`.
 *
 * The app deliberately has no markdown renderer for this. A changelog is a
 * heading and a list; a second markdown pipeline for it would be more code to
 * keep honest than the thing it draws.
 */

/** Blocks whose content is markup, never prose. */
const DROP_ELEMENTS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Anything that ends a line when the tags are gone. `</li>` is not in it: the
 * next `<li>` opens its own line, and closing one too would put a blank line
 * between every pair of bullets.
 */
const BLOCK_END = /<\/(p|div|h[1-6]|ul|ol|tr|blockquote|pre)\s*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/**
 * Plain, readable release notes, or null when there is nothing to say.
 *
 * Safe on text that was never HTML: a markdown body passes through the same
 * steps and loses only its heading marks and its pull-request numbers.
 */
export function readableNotes(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  let text = raw.replace(DROP_ELEMENTS, " ");

  if (looksLikeHtml(text)) {
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      // The whitespace before an opening tag is the source file's own
      // indentation; eating it stops "</li>\n<li>" becoming a blank line
      // between two bullets.
      .replace(/\s*<li\b[^>]*>/gi, "\n- ")
      .replace(/\s*<(p|div|h[1-6]|tr|blockquote|pre)\b[^>]*>/gi, "\n")
      .replace(BLOCK_END, "\n");
    text = stripTags(text);
    // A lone angle bracket left over from something that was never a whole
    // tag — "<scr<x>ipt>" — is markup debris, not a word. In a body that is
    // HTML there is no other way to write one: prose uses &lt;, which is
    // decoded a step later and survives.
    text = text.replace(/[<>]/g, "");
  }

  text = decodeEntities(text);
  text = stripMarkdown(text);
  text = dropPullRequestRefs(text);

  const lines: string[] = [];
  for (const line of text.split("\n")) {
    // A tab or a run of spaces inside one line is layout from the source, not
    // meaning: the popover is 288px wide and wraps everything anyway.
    const trimmed = line.replace(/[ \t]+/g, " ").trim();
    // The app writes its own "What is new in 0.2.25" above this text. The
    // release body's own heading would be the same sentence twice.
    if (isRedundantHeading(trimmed)) continue;
    if (trimmed === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(trimmed);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out = lines.join("\n").trim();
  return out.length === 0 ? null : out;
}

/**
 * Drop every remaining tag, in one pass over the string.
 *
 * Deliberately not `replace(/<[^>]+>/g, "")`. That leaves anything after an
 * unterminated `<` — a truncated release body ends mid-tag often enough — and
 * one pass of it can rebuild a tag out of two overlapping ones. Reading
 * forward from each `<` to the next `>` cannot: what is not a complete tag is
 * the tail of the body, and the tail of a body that ends mid-tag is dropped.
 *
 * This is extraction, not sanitization. Both surfaces render the result as
 * text, never as HTML, and nothing downstream may assume otherwise.
 */
function stripTags(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    if (open === -1) return out + html.slice(at);
    out += html.slice(at, open);
    const close = html.indexOf(">", open + 1);
    if (close === -1) return out;
    at = close + 1;
  }
}

/**
 * A body is HTML when it holds a tag we would otherwise print. Markdown that
 * merely mentions `<thing>` in prose has no closing tag and stays as written.
 */
function looksLikeHtml(text: string): boolean {
  return /<(\/?)(a|p|div|h[1-6]|ul|ol|li|br|em|strong|code|pre|blockquote|img|table)\b[^>]*>/i.test(
    text,
  );
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Heading marks, bullet marks and link syntax, left as the words they wrap. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[*+][ \t]+/gm, "- ")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/(^|\s)\*\*([^*]+)\*\*/g, "$1$2")
    .replace(/(^|\s)`([^`]+)`/g, "$1$2");
}

/**
 * `(#84)` is the pull request the change landed in. It is the most reliable
 * thing in the line and the least useful one to somebody deciding whether to
 * restart, and it is what GitHub expands into an anchor full of attributes.
 */
function dropPullRequestRefs(text: string): string {
  return text
    .replace(/https?:\/\/github\.com\/[^\s)]+\/(?:pull|issues)\/\d+/g, "")
    .replace(/[ \t]*\((?:#\d+(?:,[ \t]*#\d+)*)\)/g, "")
    .replace(/[ \t]+([.,;:])/g, "$1");
}

/** The heading the app already draws for itself. */
function isRedundantHeading(line: string): boolean {
  return /^what(?:'|’)?s? (?:is )?new\??$/i.test(line);
}

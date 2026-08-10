/**
 * Split a plain-text body into what the sender wrote and the quoted tail they
 * replied over. Pure client-side text work — the biggest readability win a
 * plain-text reader has.
 */

export type QuoteSplit = {
  /** Everything above the quote run. */
  body: string;
  /** The trailing quote run, or `""` when there is none. */
  quoted: string;
  /** Line count of the quote run, for the collapsed pill's label. */
  quotedLines: number;
};

const ATTRIBUTION = /^\s*On .+ wrote:\s*$/;
const ENDS_IN_WROTE = /wrote:\s*$/;

function isQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

export function splitQuotedTail(text: string): QuoteSplit {
  const empty: QuoteSplit = { body: text, quoted: "", quotedLines: 0 };
  if (!text) return empty;

  const lines = text.split("\n");

  // Walk back over trailing blanks, then over the unbroken run of `>` lines
  // (blank lines inside the run are part of it).
  let end = lines.length - 1;
  while (end >= 0 && isBlank(lines[end])) end--;
  if (end < 0) return empty;

  let start = end;
  let sawQuote = false;
  while (start >= 0 && (isQuoteLine(lines[start]) || isBlank(lines[start]))) {
    if (isQuoteLine(lines[start])) sawQuote = true;
    start--;
  }
  start++;

  if (!sawQuote) {
    // No `>` run. A bare "On … wrote:" attribution with unquoted text under it
    // is still a quote run when it is the last such line in the message.
    for (let i = lines.length - 1; i >= 1; i--) {
      if (ATTRIBUTION.test(lines[i])) {
        return build(lines, i);
      }
    }
    return empty;
  }

  // Pull the attribution line above the run into the quote when there is one.
  let attribution = start - 1;
  while (attribution >= 0 && isBlank(lines[attribution])) attribution--;
  if (
    attribution >= 0 &&
    (ATTRIBUTION.test(lines[attribution]) || ENDS_IN_WROTE.test(lines[attribution]))
  ) {
    start = attribution;
  }

  if (start <= 0) {
    // The whole message is quoted. Leave it alone; collapsing everything would
    // show an empty reader.
    return empty;
  }
  return build(lines, start);
}

function build(lines: string[], start: number): QuoteSplit {
  const body = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const quotedLines = lines.slice(start);
  while (quotedLines.length > 0 && isBlank(quotedLines[quotedLines.length - 1])) {
    quotedLines.pop();
  }
  if (quotedLines.length === 0) return { body, quoted: "", quotedLines: 0 };
  return { body, quoted: quotedLines.join("\n"), quotedLines: quotedLines.length };
}

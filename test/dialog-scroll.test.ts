import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = join(process.cwd(), "apps", "web", "src", "components");

/**
 * A dialog is centred and fixed. A tall one grows past both edges of the window
 * and the page cannot scroll to reach it, so the buttons at the bottom are
 * simply not clickable. <DialogContent> caps its own height for that reason,
 * which makes a scrolling <DialogBody> the only way overflowing content stays
 * reachable. These two files scroll their own middle band by hand instead.
 */
const SELF_SCROLLING = new Map([
  ["ui/command.tsx", "CommandList is the scroll region"],
  ["dialogs/agent-connect-dialog.tsx", "hand-built pinned header and footer"],
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Every `<DialogContent …>…</DialogContent>` in a file, as raw source. */
function dialogBlocks(source: string): string[] {
  const blocks: string[] = [];
  let at = source.indexOf("<DialogContent");
  while (at !== -1) {
    const end = source.indexOf("</DialogContent>", at);
    blocks.push(source.slice(at, end === -1 ? source.length : end));
    at = source.indexOf("<DialogContent", at + 1);
  }
  return blocks;
}

describe("dialog scrolling", () => {
  const files = tsxFiles(COMPONENTS)
    .map((path) => ({
      id: relative(COMPONENTS, path).split(/[\\/]/).join("/"),
      source: readFileSync(path, "utf8"),
    }))
    .filter(({ source }) => source.includes("<DialogContent"));

  it("finds the dialogs it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("gives every dialog a scroll region", () => {
    const missing = files
      .filter(({ id }) => !SELF_SCROLLING.has(id))
      .filter(({ source }) =>
        dialogBlocks(source).some((block) => !block.includes("<DialogBody")),
      )
      .map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  it("leaves the height cap to DialogContent itself", () => {
    const capped = files
      .filter(({ source }) =>
        dialogBlocks(source).some((block) => {
          const open = block.slice(0, block.indexOf(">"));
          return /max-h-|overflow-y-auto/.test(open);
        }),
      )
      .map(({ id }) => id);
    expect(capped).toEqual([]);
  });
});

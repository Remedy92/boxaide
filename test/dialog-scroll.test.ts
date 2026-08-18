import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = join(process.cwd(), "apps", "web", "src", "components");

/**
 * A dialog is centred and fixed. A tall one grows past both edges of the window
 * and the page cannot scroll to reach it, so the buttons at the bottom are
 * simply not clickable. <DialogContent> caps its own height for that reason,
 * which makes a scrolling <DialogBody> the only way overflowing content stays
 * reachable. Every dialog uses it — there is no second way to do this.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * Every dialog body in a file, as raw source. A wrapper that renders `{children}`
 * verbatim defines no body of its own, so the duty falls to whoever calls it —
 * and that caller is scanned here too, by the tag it uses.
 */
const OPENERS = ["DialogContent", "CommandDialog"];

function dialogBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const tag of OPENERS) {
    let at = source.indexOf(`<${tag}`);
    while (at !== -1) {
      const end = source.indexOf(`</${tag}>`, at);
      const block = source.slice(at, end === -1 ? source.length : end);
      if (!block.includes("{children}")) blocks.push(block);
      at = source.indexOf(`<${tag}`, at + 1);
    }
  }
  return blocks;
}

describe("dialog scrolling", () => {
  const files = tsxFiles(COMPONENTS)
    .map((path) => ({
      id: relative(COMPONENTS, path).split(/[\\/]/).join("/"),
      source: readFileSync(path, "utf8"),
    }))
    .filter(({ source }) => dialogBlocks(source).length > 0);

  it("finds the dialogs it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("gives every dialog a scroll region", () => {
    const missing = files
      .filter(({ source }) =>
        dialogBlocks(source).some((block) => !block.includes("<DialogBody")),
      )
      .map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  /**
   * <DialogContent> derives its cap from being centred, so a dialog that moves
   * itself elsewhere has to restate one. Nothing else may: a second cap, or a
   * second scroller, is the bug this whole pattern replaced.
   */
  it("leaves the height cap to DialogContent unless the dialog is moved", () => {
    const capped = files
      .filter(({ source }) =>
        dialogBlocks(source).some((block) => {
          const open = block.slice(0, block.indexOf(">"));
          if (/overflow-y-auto/.test(open)) return true;
          return /max-h-/.test(open) && !/\btop-\[/.test(open);
        }),
      )
      .map(({ id }) => id);
    expect(capped).toEqual([]);
  });
});

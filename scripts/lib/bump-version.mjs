/**
 * Set the product version in the four packages that must stay in lockstep.
 *
 * Lockfiles also record some dependency as 0.2.1 (node-api-version,
 * is-arrayish). Those lines must not move. Only the top-level version and
 * packages[""].version change — the same two lines the "Cut 0.2.1" commit
 * touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "apps/desktop/package.json",
  "apps/desktop/package-lock.json",
  "apps/web/package.json",
  "apps/web/package-lock.json",
  "apps/mcpb/manifest.json",
];

export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a patchable version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function readVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string") throw new Error("package.json has no version");
  return pkg.version;
}

/**
 * Replace the package's own version fields. First 2-space "version" is the
 * file top-level; first 6-space "version" after `"": {` is packages[""].
 */
export function applyVersion(text, from, to) {
  const needle = `"version": "${from}"`;
  const repl = `"version": "${to}"`;
  const lines = text.split("\n");
  let top = false;
  let inRootPkg = false;
  let rootPkg = false;
  let hits = 0;
  const out = lines.map((line) => {
    if (!top && /^ {2}"version": "/.test(line)) {
      if (!line.includes(needle)) {
        throw new Error(`top-level version is not ${from}`);
      }
      top = true;
      hits += 1;
      return line.replace(needle, repl);
    }
    if (/^ {4}"": \{/.test(line)) inRootPkg = true;
    if (inRootPkg && !rootPkg && /^ {6}"version": "/.test(line)) {
      if (!line.includes(needle)) {
        throw new Error(`packages[""].version is not ${from}`);
      }
      rootPkg = true;
      hits += 1;
      return line.replace(needle, repl);
    }
    return line;
  });
  if (!top) throw new Error("no top-level version field");
  return { text: out.join("\n"), hits };
}

export function bumpRoot(root, to) {
  const from = readVersion(root);
  if (from === to) throw new Error(`already ${to}`);
  for (const rel of VERSION_FILES) {
    const path = join(root, rel);
    const before = readFileSync(path, "utf8");
    const { text } = applyVersion(before, from, to);
    writeFileSync(path, text);
  }
  return { from, to };
}

function main(argv) {
  const printOnly = argv.includes("--print");
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? argv[rootFlag + 1] : process.cwd();
  const requested = argv.find(
    (a, i) => a !== "--print" && a !== "--root" && i !== rootFlag + 1,
  );
  const current = readVersion(root);
  const to = requested ?? nextPatch(current);
  if (printOnly) {
    process.stdout.write(`${to}\n`);
    return;
  }
  const result = bumpRoot(root, to);
  process.stdout.write(`${result.from} -> ${result.to}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

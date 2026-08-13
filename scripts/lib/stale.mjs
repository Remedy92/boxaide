/**
 * Skip work the desktop runner already did.
 *
 * Git checkout rewrites mtimes, so a clock comparison thinks every worktree
 * is stale. Content hashes do not move when the files did not.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

export async function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = entry.parentPath ? join(entry.parentPath, entry.name) : join(dir, entry.name);
    const time = await mtime(full);
    if (time > newest) newest = time;
  }
  return newest;
}

/** True when `to` is missing or older than anything in `from`. */
export async function sourceNeedsCopy(from, to) {
  if (!(await exists(to))) return true;
  return (await newestMtime(from)) > (await newestMtime(to));
}

export async function readStamp(path) {
  return (await readFile(path, "utf8").catch(() => "")).trim();
}

export async function writeStamp(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${value}\n`);
}

export async function fileHash(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "";
  }
}

export async function treeHash(dir) {
  const hash = createHash("sha256");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return hash.digest("hex");
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => (entry.parentPath ? join(entry.parentPath, entry.name) : join(dir, entry.name)))
    .sort();
  for (const file of files) {
    hash.update(relative(dir, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function lockStampPath(dir) {
  return join(dir, "node_modules", ".mailmux-lock");
}

export async function lockHash(dir) {
  return fileHash(join(dir, "package-lock.json"));
}

/**
 * Missing node_modules, or a folder with no install in it → install.
 * A leftover empty node_modules (vitest cache, a stamp we wrote) is not an install.
 * No stamp yet, but a real install is present → adopt (caller writes the stamp).
 * Stamp does not match the lockfile → install.
 */
export async function needsNpmInstall(dir) {
  const nm = join(dir, "node_modules");
  if (!(await exists(nm))) return true;
  const installed =
    (await exists(join(nm, ".package-lock.json"))) || (await exists(join(nm, ".bin")));
  if (!installed) return true;
  const stamp = await readStamp(lockStampPath(dir));
  if (!stamp) return false;
  return stamp !== (await lockHash(dir));
}

export async function markNpmInstalled(dir) {
  await writeStamp(lockStampPath(dir), await lockHash(dir));
}

/** Electron 43 has no package postinstall. The binary arrives on first require. */
export async function electronBinaryReady(desktopRoot) {
  const electron = join(desktopRoot, "node_modules", "electron");
  const pathFile = join(electron, "path.txt");
  if (!(await exists(pathFile))) return false;
  const rel = (await readFile(pathFile, "utf8")).trim();
  if (!rel) return false;
  return exists(join(electron, "dist", rel));
}

export function webStampPath(root) {
  return join(root, "apps", "web", ".mailmux-export");
}

export async function webSourceHash(root) {
  const hash = createHash("sha256");
  hash.update(await treeHash(join(root, "apps", "web", "src")));
  hash.update(await fileHash(join(root, "apps", "web", "package-lock.json")));
  return hash.digest("hex");
}

/**
 * Rebuild unless a stamp from `web:sync` matches the current source.
 * An unstamped export is stale: it may be an older checkout's build.
 * Only `scripts/web-sync.mjs` writes the stamp, after a real copy from out/.
 */
export async function webExportStale(root) {
  if (!(await exists(join(root, "web-next", "index.html")))) return true;
  const stamp = await readStamp(webStampPath(root));
  if (!stamp) return true;
  return stamp !== (await webSourceHash(root));
}

export async function markWebExport(root) {
  await writeStamp(webStampPath(root), await webSourceHash(root));
}

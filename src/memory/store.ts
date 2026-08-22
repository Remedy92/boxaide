/**
 * Workspace memory: the agent's own notes, kept as plain markdown files.
 *
 * The agent builds its notes while it works — `MEMORY.md` as the index, plus
 * topic files like `company.md` or `people.md` — and reads them back on later
 * sessions. This module is the server's only handle on those files: it never
 * authors content, it only reads what is there and writes what a human edited
 * through the REST routes (src/memory/routes.ts). Agents write with their own
 * native file tools, not through here.
 *
 * Every path here is opened as if the agent were hostile, because the agent
 * writes these files and this server reads them. A note is not only content:
 * it is a name the agent chose in a directory the agent owns. Left to plain
 * `readFile`, `memory/company.md` could be a symlink at `../../boxaide/
 * bearer.token`, and this process — which is NOT sandboxed and holds the
 * master credential's own filesystem rights — would dereference it and paste
 * the result into the next prompt. The sandbox cannot stop that: the read is
 * ours, made on the agent's behalf, which is the whole shape of a confused
 * deputy. So: O_NOFOLLOW on every open, a regular-file check on the handle
 * itself, symlinks skipped rather than listed, and the memory directory
 * proven to be a real directory that still sits inside the agent subtree
 * before any of it. Name validation answers a different question and never
 * this one — `MEMORY.md` is a perfectly valid name for a symlink.
 *
 * The files are deliberately PLAINTEXT, which is safe for one reason worth
 * restating wherever they are touched: they live inside the agent-owned
 * subtree (`<agentWorkDir>/memory/`, see src/agent/paths.ts), outside the data
 * directory that holds `bearer.token` and `master.key`. The same layout rule
 * that keeps a launched CLI from reading the secrets by walking up also keeps
 * these readable notes from sitting beside them. Nothing here may move them
 * into the data directory, and no encrypted variant is wanted — an agent that
 * cannot read its own notes has none.
 */
import {
  closeSync,
  writeFileSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { agentRoot, agentWorkDir } from "../agent/paths.js";

/** The index file an agent keeps at the root of its memory directory. */
export const MEMORY_INDEX = "MEMORY.md";

/** Highest number of bytes one memory file may hold. */
export const MAX_MEMORY_FILE_BYTES = 64 * 1024;

/**
 * What a memory file may be named. Deliberately narrow: this name arrives
 * over HTTP (the route parameter) and is joined onto a filesystem path, so
 * anything a traversal needs — separators, dots leading a segment, case
 * tricks — is refused before the join happens. It also matches how agents
 * actually name topics: short, lowercase, hyphenated.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/;

/** The memory directory for an install: <agentWorkDir>/memory/. */
export function memoryDir(dataDir: string): string {
  return join(agentWorkDir(dataDir), "memory");
}

/**
 * True when a name is one the REST routes may serve. The index is the single
 * name outside NAME_PATTERN — uppercase by convention, and the file a person
 * most wants to correct — so it is admitted by exact match rather than by
 * loosening a rule whose whole job is refusing traversal. Listing and
 * reading/writing ask this same question, because a listing offering a name
 * the reader then rejects is a panel whose first row is an error.
 */
function servable(name: string): boolean {
  return name === MEMORY_INDEX || NAME_PATTERN.test(name);
}

function assertName(name: string): void {
  if (!servable(name)) {
    throw new Error(`invalid memory file name: ${JSON.stringify(name)}`);
  }
}

/**
 * The memory directory, proven safe to read from, or null when there is not
 * one yet.
 *
 * Two things are checked and both are about the agent owning this subtree.
 * `lstat` rather than `stat`, so a `memory` symlink is refused instead of
 * followed — pointing it at the data directory would make every note read a
 * read of whatever sits there. And the resolved path must still be inside the
 * agent root, which catches the same trick played one level up, on `workdir`.
 * The root itself is the anchor because its parent is not writable by any
 * launch: replacing it would take rights the sandbox does not grant.
 *
 * Real paths on both sides of the comparison, because macOS reaches its
 * temporary directory through a symlink and an install rooted there is the
 * normal case in tests.
 */
function safeMemoryDir(dataDir: string): string | null {
  const dir = memoryDir(dataDir);
  let stats: Stats;
  try {
    stats = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!stats.isDirectory()) {
    throw new Error("memory directory is not a directory");
  }
  const real = realpathSync(dir);
  const root = realpathSync(agentRoot(dataDir));
  const step = relative(root, real);
  if (step.startsWith("..") || isAbsolute(step)) {
    throw new Error("memory directory escapes the agent subtree");
  }
  return real;
}

/**
 * One note's text, read through a handle that refuses to follow a symlink and
 * is checked to be a regular file after opening — the check has to be on the
 * handle, not on the path, or it answers about a file that was there a moment
 * ago. Null for a note that is not there; a symlink or a device or a
 * directory throws, because those are not absent, they are planted.
 */
function readNoteAt(dir: string, name: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      join(dir, name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // ELOOP is what O_NOFOLLOW answers on a symlink. Say what it means.
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`memory file is a symlink, refusing to read: ${name}`);
    }
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`memory file is not a regular file: ${name}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * True when MEMORY.md exists — i.e. the agent has already built its notes.
 * Sync because prompt building at launch is sync and asks exactly this. A
 * symlink standing in for the index does not count as having notes; the read
 * that follows would refuse it anyway.
 */
export function hasMemoryIndex(dataDir: string): boolean {
  let dir: string | null;
  try {
    dir = safeMemoryDir(dataDir);
  } catch {
    return false;
  }
  if (!dir) return false;
  try {
    return lstatSync(join(dir, MEMORY_INDEX)).isFile();
  } catch {
    return false;
  }
}

/**
 * One memory file's text, or null when there is nothing there yet. An absent
 * file is the normal first-session state, not an error; a name that fails
 * validation throws rather than reading as "absent", so a bad request cannot
 * masquerade as an empty memory.
 */
export async function readMemoryFile(
  dataDir: string,
  name: string,
): Promise<string | null> {
  return readMemoryFileSync(dataDir, name);
}

/**
 * Sync twin of readMemoryFile, for prompt building at launch time.
 */
export function readMemoryFileSync(dataDir: string, name: string): string | null {
  assertName(name);
  const dir = safeMemoryDir(dataDir);
  if (!dir) return null;
  return readNoteAt(dir, name);
}

/**
 * Write one memory file on a human's behalf. Creates the directory when the
 * agent has not yet — mode 0o700, matching the subtree's owner-only posture —
 * and the file itself at 0o600. Refuses names that fail validation and
 * content above MAX_MEMORY_FILE_BYTES: memory is notes, not a dump ground,
 * and a file past this size stops being something an agent re-reads whole.
 */
export async function writeMemoryFile(
  dataDir: string,
  name: string,
  content: string,
): Promise<void> {
  assertName(name);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_MEMORY_FILE_BYTES) {
    throw new Error(
      `memory file too large: ${bytes} bytes (max ${MAX_MEMORY_FILE_BYTES})`,
    );
  }
  await mkdir(memoryDir(dataDir), { recursive: true, mode: 0o700 });
  const dir = safeMemoryDir(dataDir);
  if (!dir) throw new Error("memory directory could not be created");
  // O_NOFOLLOW on the write too, and for the worse half of the same trick: a
  // symlink here would have this process truncate and overwrite whatever it
  // names, with the server's rights, on a person pressing Save.
  let fd: number;
  try {
    fd = openSync(
      join(dir, name),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`memory file is a symlink, refusing to write: ${name}`);
    }
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`memory file is not a regular file: ${name}`);
    }
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

export type MemoryFileEntry = {
  name: string;
  bytes: number;
  updatedAt: string;
};

/**
 * Every markdown file in the memory directory, sorted by name with the index
 * pinned first — it is the table of contents, and every listing starts with
 * it. Only names the routes can serve are listed: a note the agent named
 * outside the rule (`Notes.md`, `my_notes.md`) would 400 the moment a person
 * clicked it, so it is left out rather than offered.
 */
export async function listMemoryFiles(
  dataDir: string,
): Promise<MemoryFileEntry[]> {
  const dir = safeMemoryDir(dataDir);
  if (!dir) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: MemoryFileEntry[] = [];
  for (const entry of entries) {
    if (!servable(entry)) continue;
    const path = join(dir, entry);
    let stats: Stats;
    try {
      // lstat: a symlink is skipped rather than described by whatever it
      // points at. Offering it as a row would invite a click the reader then
      // refuses, and listing its target's size would leak that the target is
      // there at all.
      stats = lstatSync(path);
    } catch {
      continue; // Removed between the readdir and the stat.
    }
    if (!stats.isFile()) continue;
    files.push({
      name: entry,
      bytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
    });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // The index leads, whatever the alphabet says.
  const indexAt = files.findIndex((file) => file.name === MEMORY_INDEX);
  if (indexAt > 0) files.unshift(...files.splice(indexAt, 1));
  return files;
}

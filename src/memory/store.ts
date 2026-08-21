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
 * The files are deliberately PLAINTEXT, which is safe for one reason worth
 * restating wherever they are touched: they live inside the agent-owned
 * subtree (`<agentWorkDir>/memory/`, see src/agent/paths.ts), outside the data
 * directory that holds `bearer.token` and `master.key`. The same layout rule
 * that keeps a launched CLI from reading the secrets by walking up also keeps
 * these readable notes from sitting beside them. Nothing here may move them
 * into the data directory, and no encrypted variant is wanted — an agent that
 * cannot read its own notes has none.
 */
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkDir } from "../agent/paths.js";

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

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`invalid memory file name: ${JSON.stringify(name)}`);
  }
}

/**
 * True when MEMORY.md exists — i.e. the agent has already built its notes.
 * Sync because prompt building at launch is sync and asks exactly this.
 */
export function hasMemoryIndex(dataDir: string): boolean {
  return existsSync(join(memoryDir(dataDir), MEMORY_INDEX));
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
  assertName(name);
  try {
    return await readFile(join(memoryDir(dataDir), name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Sync twin of readMemoryFile, for prompt building at launch time.
 */
export function readMemoryFileSync(dataDir: string, name: string): string | null {
  assertName(name);
  try {
    return readFileSync(join(memoryDir(dataDir), name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The index's text, or null when the agent has not written it yet.
 *
 * Not readMemoryFileSync on purpose: that validates its name because a route
 * hands it one, and the uppercase index is deliberately outside that rule —
 * the agent owns this one file and writes it with its native tools. Here the
 * name is MEMORY_INDEX itself, so the rule has nothing to protect, and
 * applying it anyway would make the index unreadable to the launch prompt
 * building this sync path exists for.
 */
export function readMemoryIndexSync(dataDir: string): string | null {
  try {
    return readFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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
  const dir = memoryDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, name), content, { encoding: "utf8", mode: 0o600 });
}

export type MemoryFileEntry = {
  name: string;
  bytes: number;
  updatedAt: string;
};

/**
 * Every markdown file in the memory directory, sorted by name with the index
 * pinned first — it is the table of contents, and every listing starts with
 * it. Any *.md file the agent wrote is listed whatever its case or shape; only
 * directories are excluded.
 */
export async function listMemoryFiles(
  dataDir: string,
): Promise<MemoryFileEntry[]> {
  const dir = memoryDir(dataDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: MemoryFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    let stats: Stats;
    try {
      stats = statSync(path);
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

/**
 * The workspace-memory file store: name validation, the byte ceiling, and the
 * listing order. Run against a throwaway data directory — the memory files
 * land in the agent-owned subtree beside it (`<dataDir>-agents/workdir/
 * memory`), so the whole tree is removed afterwards.
 */
import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_MEMORY_FILE_BYTES,
  MEMORY_INDEX,
  hasMemoryIndex,
  listMemoryFiles,
  memoryDir,
  readMemoryFile,
  readMemoryFileSync,
  readMemoryIndexSync,
  writeMemoryFile,
} from "../src/memory/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * A data directory whose whole agent subtree sits under one removable parent,
 * because the sibling `<dataDir>-agents` would otherwise survive the cleanup.
 */
function tempDataDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "boxaide-memory-"));
  const dataDir = join(parent, "data");
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  return dataDir;
}

describe("memory store paths", () => {
  it("puts memory inside the agent-owned workdir subtree", () => {
    expect(memoryDir("/home/ada/.boxaide")).toBe(
      "/home/ada/.boxaide-agents/workdir/memory",
    );
  });

  it("mirrors the launcher's :memory: fallback to the shared scratch root", () => {
    expect(memoryDir(":memory:")).toBe(
      join(tmpdir(), "boxaide-agent", "workdir", "memory"),
    );
  });
});

describe("memory file names", () => {
  const BAD_NAMES = [
    "../x.md",
    "a/b.md",
    ".md",
    "Company.md",
    "",
    "notes.txt",
    "..md",
    "x.MD",
    "sub/x.md",
    "x%2Fy.md",
  ];

  for (const name of BAD_NAMES) {
    it(`refuses ${JSON.stringify(name)} on write`, async () => {
      const dataDir = tempDataDir();
      await expect(writeMemoryFile(dataDir, name, "hi")).rejects.toThrow(
        /invalid memory file name/,
      );
    });

    it(`refuses ${JSON.stringify(name)} on read`, async () => {
      const dataDir = tempDataDir();
      await expect(readMemoryFile(dataDir, name)).rejects.toThrow(
        /invalid memory file name/,
      );
      expect(() => readMemoryFileSync(dataDir, name)).toThrow(
        /invalid memory file name/,
      );
    });
  }

  it("never touches the filesystem for a rejected name", async () => {
    const dataDir = tempDataDir();
    await expect(
      writeMemoryFile(dataDir, "../../etc/passwd.md", "hi"),
    ).rejects.toThrow();
    // No directory was created by the refused write.
    expect(existsSync(memoryDir(dataDir))).toBe(false);
  });
});

describe("memory roundtrip", () => {
  it("writes and reads back a topic file", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "company.md", "# Acme\n\nShips boats.\n");
    await expect(readMemoryFile(dataDir, "company.md")).resolves.toBe(
      "# Acme\n\nShips boats.\n",
    );
    expect(readMemoryFileSync(dataDir, "company.md")).toBe(
      "# Acme\n\nShips boats.\n",
    );
  });

  it("answers null for a file that does not exist yet", async () => {
    const dataDir = tempDataDir();
    await expect(readMemoryFile(dataDir, "voice.md")).resolves.toBeNull();
    expect(readMemoryFileSync(dataDir, "voice.md")).toBeNull();
  });

  it("overwrites an existing file whole", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "company.md", "first");
    await writeMemoryFile(dataDir, "company.md", "second");
    await expect(readMemoryFile(dataDir, "company.md")).resolves.toBe("second");
  });

  it("creates the directory owner-only and the file private", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "people.md", "Ada\n");
    const dirMode = statSync(memoryDir(dataDir)).mode & 0o777;
    const fileMode = statSync(join(memoryDir(dataDir), "people.md")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("the memory size ceiling", () => {
  it(`accepts a file of exactly ${MAX_MEMORY_FILE_BYTES} bytes`, async () => {
    const dataDir = tempDataDir();
    const exact = "a".repeat(MAX_MEMORY_FILE_BYTES);
    await writeMemoryFile(dataDir, "big.md", exact);
    await expect(readMemoryFile(dataDir, "big.md")).resolves.toBe(exact);
  });

  it("throws a clear error above the ceiling, before writing anything", async () => {
    const dataDir = tempDataDir();
    const over = "a".repeat(MAX_MEMORY_FILE_BYTES + 1);
    await expect(writeMemoryFile(dataDir, "big.md", over)).rejects.toThrow(
      /memory file too large/,
    );
    expect(existsSync(join(memoryDir(dataDir), "big.md"))).toBe(false);
  });
});

describe("readMemoryIndexSync", () => {
  it("reads the uppercase index the REST name rule refuses", async () => {
    const dataDir = tempDataDir();
    // The index is the agent's own file, written with its native tools and
    // deliberately outside NAME_PATTERN — see hasMemoryIndex above.
    mkdirSync(memoryDir(dataDir), { recursive: true });
    writeFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "# Memory\n");
    expect(readMemoryIndexSync(dataDir)).toBe("# Memory\n");
  });

  it("answers null before the agent has written any notes", () => {
    expect(readMemoryIndexSync(tempDataDir())).toBeNull();
  });
});

describe("hasMemoryIndex", () => {
  it("is false until the agent has written its index", async () => {
    const dataDir = tempDataDir();
    expect(hasMemoryIndex(dataDir)).toBe(false);
    // The index is the agent's own file, written with its native tools —
    // never through this store, whose name rule refuses the uppercase form.
    mkdirSync(memoryDir(dataDir), { recursive: true });
    writeFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "# Memory\n");
    expect(hasMemoryIndex(dataDir)).toBe(true);
  });
});

describe("listMemoryFiles", () => {
  it("returns nothing when the agent has never written memory", async () => {
    const dataDir = tempDataDir();
    expect(await listMemoryFiles(dataDir)).toEqual([]);
  });

  it("lists markdown files sorted, index first", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "voice.md", "warm, plain\n");
    await writeMemoryFile(dataDir, "company.md", "Acme\n");
    mkdirSync(memoryDir(dataDir), { recursive: true });
    writeFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "# Memory\n");

    const files = await listMemoryFiles(dataDir);
    expect(files.map((file) => file.name)).toEqual([
      MEMORY_INDEX,
      "company.md",
      "voice.md",
    ]);
    const company = files.find((file) => file.name === "company.md")!;
    expect(company.bytes).toBe(Buffer.byteLength("Acme\n"));
    expect(Number.isNaN(Date.parse(company.updatedAt))).toBe(false);
  });

  it("ignores non-markdown files and directories", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "keep.md", "yes\n");
    mkdirSync(memoryDir(dataDir), { recursive: true });
    writeFileSync(join(memoryDir(dataDir), "scratch.txt"), "no\n");
    mkdirSync(join(memoryDir(dataDir), "folder.md"), { recursive: true });

    const files = await listMemoryFiles(dataDir);
    expect(files.map((file) => file.name)).toEqual(["keep.md"]);
  });
});

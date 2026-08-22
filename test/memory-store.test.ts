/**
 * The workspace-memory file store: name validation, the byte ceiling, and the
 * listing order. Run against a throwaway data directory — the memory files
 * land in the agent-owned subtree beside it (`<dataDir>-agents/workdir/
 * memory`), so the whole tree is removed afterwards.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_MEMORY_FILE_BYTES,
  MEMORY_INDEX,
  hasMemoryIndex,
  listMemoryFiles,
  memoryDir,
  readMemoryFile,
  readMemoryFileSync,
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
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  return dataDir;
}

describe("memory store paths", () => {
  it("puts memory inside the agent-owned workdir subtree", () => {
    expect(memoryDir("/home/ada/.boxaide")).toBe(
      "/home/ada/.boxaide-agents/workdir/memory",
    );
  });

  // Unguessable and owner-only, not a fixed name in a world-writable
  // directory: on a shared machine that name is whoever creates it first, and
  // what goes inside is an agent's config homes and the user's workspace notes.
  it("gives a :memory: install a private scratch root, stable per process", () => {
    const first = memoryDir(":memory:");
    expect(first.startsWith(join(tmpdir(), "boxaide-agent-"))).toBe(true);
    expect(first.endsWith(join("workdir", "memory"))).toBe(true);
    expect(memoryDir(":memory:")).toBe(first);
    expect(statSync(dirname(dirname(first))).mode & 0o777).toBe(0o700);
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

describe("the index as a servable name", () => {
  it("reads the uppercase index like any other note", async () => {
    const dataDir = tempDataDir();
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "# Memory\n", {
    mode: 0o600,
  });
    expect(readMemoryFileSync(dataDir, MEMORY_INDEX)).toBe("# Memory\n");
    expect(await readMemoryFile(dataDir, MEMORY_INDEX)).toBe("# Memory\n");
  });

  it("answers null before the agent has written any notes", async () => {
    const dataDir = tempDataDir();
    expect(readMemoryFileSync(dataDir, MEMORY_INDEX)).toBeNull();
    expect(await readMemoryFile(dataDir, MEMORY_INDEX)).toBeNull();
  });

  /* The one file a person most wants to correct: the panel opens on it. */
  it("takes a human correction through writeMemoryFile", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, MEMORY_INDEX, "# Memory\n- company.md\n");
    expect(await readMemoryFile(dataDir, MEMORY_INDEX)).toBe(
      "# Memory\n- company.md\n",
    );
  });

  it("still refuses every other shape outside the rule", async () => {
    const dataDir = tempDataDir();
    await expect(writeMemoryFile(dataDir, "MEMORY.MD", "x")).rejects.toThrow(
      /invalid memory file name/,
    );
    await expect(
      writeMemoryFile(dataDir, "../MEMORY.md", "x"),
    ).rejects.toThrow(/invalid memory file name/);
  });
});

describe("hasMemoryIndex", () => {
  it("is false until the agent has written its index", async () => {
    const dataDir = tempDataDir();
    expect(hasMemoryIndex(dataDir)).toBe(false);
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "# Memory\n", {
    mode: 0o600,
  });
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
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(memoryDir(dataDir), MEMORY_INDEX), "# Memory\n", {
    mode: 0o600,
  });

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

  it("omits markdown the routes could not serve", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "keep.md", "yes\n");
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    // Agent-chosen names outside the rule: listing one would offer a row that
    // 400s the moment somebody clicked it.
    writeFileSync(join(memoryDir(dataDir), "Notes.md"), "no\n", {
    mode: 0o600,
  });
    writeFileSync(join(memoryDir(dataDir), "my_notes.md"), "no\n", {
    mode: 0o600,
  });

    const files = await listMemoryFiles(dataDir);
    expect(files.map((file) => file.name)).toEqual(["keep.md"]);
  });

  it("ignores non-markdown files and directories", async () => {
    const dataDir = tempDataDir();
    await writeMemoryFile(dataDir, "keep.md", "yes\n");
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(memoryDir(dataDir), "scratch.txt"), "no\n", {
    mode: 0o600,
  });
    mkdirSync(join(memoryDir(dataDir), "folder.md"), {
      recursive: true,
      mode: 0o700,
    });

    const files = await listMemoryFiles(dataDir);
    expect(files.map((file) => file.name)).toEqual(["keep.md"]);
  });
});

/**
 * The confused-deputy suite.
 *
 * The agent writes these files; this server reads them, unsandboxed, with
 * rights the agent does not have. So a note is not only content — it is a
 * name the agent chose, and a name can be a symlink to `bearer.token`. Name
 * validation cannot answer that: `MEMORY.md` is a perfectly valid name for
 * one. These are about what the open does, not what the name looks like.
 */
describe("a note that is really a symlink", () => {
  /** A secret outside the agent subtree, as bearer.token is. */
  function plantSecret(dataDir: string): string {
    const path = join(dataDir, "bearer.token");
    writeFileSync(path, "SUPER-SECRET-TOKEN\n", { mode: 0o600 });
    return path;
  }

  it("refuses to read one, rather than dereferencing it", async () => {
    const dataDir = tempDataDir();
    const secret = plantSecret(dataDir);
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    symlinkSync(secret, join(memoryDir(dataDir), "company.md"));

    expect(() => readMemoryFileSync(dataDir, "company.md")).toThrow(/symlink/);
    await expect(readMemoryFile(dataDir, "company.md")).rejects.toThrow(
      /symlink/,
    );
  });

  it("refuses the index too, and does not count it as having notes", () => {
    const dataDir = tempDataDir();
    const secret = plantSecret(dataDir);
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    symlinkSync(secret, join(memoryDir(dataDir), MEMORY_INDEX));

    expect(hasMemoryIndex(dataDir)).toBe(false);
    expect(() => readMemoryFileSync(dataDir, MEMORY_INDEX)).toThrow(/symlink/);
  });

  it("never lists one", async () => {
    const dataDir = tempDataDir();
    const secret = plantSecret(dataDir);
    await writeMemoryFile(dataDir, "real.md", "genuine\n");
    symlinkSync(secret, join(memoryDir(dataDir), "planted.md"));

    const files = await listMemoryFiles(dataDir);
    expect(files.map((file) => file.name)).toEqual(["real.md"]);
  });

  /* The worse half: a save would otherwise truncate whatever it points at. */
  it("refuses to write through one", async () => {
    const dataDir = tempDataDir();
    const secret = plantSecret(dataDir);
    mkdirSync(memoryDir(dataDir), { recursive: true, mode: 0o700 });
    symlinkSync(secret, join(memoryDir(dataDir), "voice.md"));

    await expect(
      writeMemoryFile(dataDir, "voice.md", "overwritten\n"),
    ).rejects.toThrow(/symlink/);
    expect(readFileSync(secret, "utf8")).toBe("SUPER-SECRET-TOKEN\n");
  });

  it("refuses a memory directory that is itself a symlink", async () => {
    const dataDir = tempDataDir();
    plantSecret(dataDir);
    mkdirSync(join(dataDir + "-agents", "workdir"), {
      recursive: true,
      mode: 0o700,
    });
    // The same trick one level up: point the whole directory at the secrets.
    symlinkSync(dataDir, memoryDir(dataDir));

    expect(() => readMemoryFileSync(dataDir, "company.md")).toThrow(
      /not a directory|escapes/,
    );
    await expect(listMemoryFiles(dataDir)).rejects.toThrow(
      /not a directory|escapes/,
    );
  });

  it("refuses a note that is a directory", async () => {
    const dataDir = tempDataDir();
    mkdirSync(join(memoryDir(dataDir), "company.md"), {
      recursive: true,
      mode: 0o700,
    });
    expect(() => readMemoryFileSync(dataDir, "company.md")).toThrow(
      /not a regular file|EISDIR/,
    );
  });
});

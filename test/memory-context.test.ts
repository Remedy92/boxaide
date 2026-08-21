/**
 * The workspace-memory text a launch's prompt carries: ask-first while there
 * is no index, index-plus-update-duty once there is one, and for automation
 * runs only inlined background — never the offer to build notes, which a run
 * has nobody to consent to. Run against a throwaway data directory; the
 * memory files land in the agent-owned subtree beside it
 * (`<dataDir>-agents/workdir/memory`), so the whole tree is removed after.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatMemoryBlock,
  INDEX_CAP,
  runMemoryBlock,
  TOPIC_CAP,
} from "../src/agent/memory-context.js";
import { MEMORY_INDEX, memoryDir } from "../src/memory/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * A data directory whose whole agent subtree sits under one removable parent,
 * because the sibling `<dataDir>-agents` would otherwise survive the cleanup.
 */
function tempDataDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "boxaide-memory-ctx-"));
  const dataDir = join(parent, "data");
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  return dataDir;
}

/**
 * Writes one file into the install's memory directory. The index goes through
 * a plain write on purpose: it is the agent's own file, and the store's name
 * rule refuses the uppercase form an agent writes directly.
 */
function writeNote(dataDir: string, name: string, content: string): void {
  mkdirSync(memoryDir(dataDir), { recursive: true });
  writeFileSync(join(memoryDir(dataDir), name), content);
}

describe("chatMemoryBlock", () => {
  it("asks first, naming the consent step and the ./memory/ paths", () => {
    const block = chatMemoryBlock(tempDataDir());
    expect(block).toContain("./memory/");
    expect(block).toContain("MEMORY.md");
    // The offer is one sentence, and building waits for a yes.
    expect(block).toContain("want me to?");
    expect(block).toContain("only if I agree");
    expect(block).toContain("If I decline");
    // The files it would write, and the ceiling on the skim.
    expect(block).toContain("company.md");
    expect(block).toContain("voice.md");
    expect(block).toContain("people.md");
    expect(block).toContain("fifteen tool calls");
    // Every fact names its source; nothing secret is stored.
    expect(block).toContain("names its source");
    expect(block).toContain("Never store a password");
  });

  it("names the tools the skim is allowed to use", () => {
    const block = chatMemoryBlock(tempDataDir());
    for (const tool of [
      "accounts_list",
      "folders_list",
      "messages_list",
      "messages_search",
      "message_get",
      "crm_sync",
      "crm_orgs_list",
      "crm_contacts_search",
      "calendar_accounts_list",
      "agenda_view",
      "web_fetch",
    ]) {
      expect(block).toContain(tool);
    }
  });

  it("carries the index and the update duty once notes exist", () => {
    const dataDir = tempDataDir();
    writeNote(
      dataDir,
      MEMORY_INDEX,
      "# Memory\n- company.md — Acme ships boats\n",
    );
    const block = chatMemoryBlock(dataDir);
    expect(block).toContain("Acme ships boats");
    expect(block).toContain("update those files yourself");
    // Notes exist, so the offer must be gone: asking twice is how an agent
    // ends up rebuilding what it already wrote.
    expect(block).not.toContain("want me to?");
  });

  it(`caps the index at ${INDEX_CAP} characters and marks the cut`, () => {
    const dataDir = tempDataDir();
    writeNote(
      dataDir,
      MEMORY_INDEX,
      `${"a".repeat(INDEX_CAP)}\nTAIL-SENTINEL-xyz\n`,
    );
    const block = chatMemoryBlock(dataDir);
    expect(block).toContain("[… truncated]");
    expect(block).not.toContain("TAIL-SENTINEL-xyz");
    // The cap bounds the index itself — ellipsis included — not the framing
    // around it.
    const indexSection = block.slice(block.indexOf("MEMORY.md:\n") + "MEMORY.md:\n".length);
    expect(indexSection.length).toBe(INDEX_CAP);
  });

  it("falls back to ask-first when the index exists but cannot be read", () => {
    const dataDir = tempDataDir();
    // A directory sitting where MEMORY.md belongs: hasMemoryIndex answers
    // true, the read throws, and the launch must degrade rather than fail.
    mkdirSync(memoryDir(dataDir), { recursive: true });
    mkdirSync(join(memoryDir(dataDir), MEMORY_INDEX));
    expect(chatMemoryBlock(dataDir)).toContain("want me to?");
  });
});

describe("runMemoryBlock", () => {
  it("is empty when there are no notes at all", () => {
    expect(runMemoryBlock(tempDataDir())).toBe("");
  });

  it("inlines the index, company and voice when they exist", () => {
    const dataDir = tempDataDir();
    writeNote(dataDir, MEMORY_INDEX, "- company.md — what Acme does\n");
    writeNote(dataDir, "company.md", "Acme ships boats.\n");
    writeNote(dataDir, "voice.md", "Plain, warm, short sentences.\n");
    const block = runMemoryBlock(dataDir);
    expect(block).toContain("what Acme does");
    expect(block).toContain("Company notes:");
    expect(block).toContain("Acme ships boats.");
    expect(block).toContain("Voice notes:");
    expect(block).toContain("Plain, warm, short sentences.");
  });

  it("never carries the ask-first wording or a path to build at", () => {
    const dataDir = tempDataDir();
    writeNote(dataDir, MEMORY_INDEX, "- company.md — what Acme does\n");
    writeNote(dataDir, "company.md", "Acme ships boats.\n");
    const block = runMemoryBlock(dataDir);
    expect(block).not.toContain("want me to?");
    expect(block).not.toContain("only if I agree");
    // A run works in its own throwaway directory, so no instruction may send
    // it looking for ./memory/ — the contents come to it instead.
    expect(block).not.toContain("./memory/");
  });

  it("omits a topic file that is absent", () => {
    const dataDir = tempDataDir();
    writeNote(dataDir, MEMORY_INDEX, "- company.md — what Acme does\n");
    const block = runMemoryBlock(dataDir);
    expect(block).toContain("what Acme does");
    expect(block).not.toContain("Voice notes:");
  });

  it(`caps each topic file at ${TOPIC_CAP} characters`, () => {
    const dataDir = tempDataDir();
    writeNote(dataDir, MEMORY_INDEX, "- voice.md\n");
    writeNote(
      dataDir,
      "voice.md",
      `${"v".repeat(TOPIC_CAP)}\nVOICE-TAIL-xyz\n`,
    );
    const block = runMemoryBlock(dataDir);
    expect(block).toContain("[… truncated]");
    expect(block).not.toContain("VOICE-TAIL-xyz");
  });
});

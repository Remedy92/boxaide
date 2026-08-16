/**
 * The parsers are fed the real shapes captured from `agy models`,
 * `opencode models` and `grok models`, so a CLI that changes its output
 * breaks here rather than in a picker the user has to notice is wrong.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchModels,
  parseBareModels,
  parseBulletModels,
  parseTabbedModels,
} from "../src/agent/model-list.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Writes an executable shell script and returns its path. */
function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "boxaide-models-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-cli");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("model list parsers", () => {
  it("reads agy's tab-separated ids and labels", () => {
    const output = [
      "Fetching available models...",
      "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
      "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "",
    ].join("\n");
    expect(parseTabbedModels(output)).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("reads opencode's bare provider/model lines", () => {
    const output = "opencode/big-pickle\nopencode-go/glm-5.3\nnot-a-model\n\n";
    expect(parseBareModels(output)).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle" },
      { id: "opencode-go/glm-5.3", label: "opencode-go/glm-5.3" },
    ]);
  });

  it("reads grok's bullet list and keeps the default marker", () => {
    const output = [
      "You are using XAI_API_KEY.",
      "",
      "Default model: grok-4.6",
      "",
      "Available models:",
      "  * grok-4.6 (default)",
      "  - grok-4.5",
    ].join("\n");
    expect(parseBulletModels(output)).toEqual([
      { id: "grok-4.6", label: "grok-4.6 (default)" },
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
  });
});

describe("fetchModels", () => {
  it("runs the CLI's listing command and returns what it printed", async () => {
    const bin = fakeBin("#!/bin/sh\nprintf 'a\\tA\\nb\\tB\\n'\n");
    await expect(
      fetchModels(bin, { args: ["models"], parse: parseTabbedModels }, {}),
    ).resolves.toEqual([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
  });

  it("reads a list the CLI prints on stderr", async () => {
    const bin = fakeBin("#!/bin/sh\nprintf 'a\\tA\\n' >&2\n");
    await expect(
      fetchModels(bin, { args: ["models"], parse: parseTabbedModels }, {}),
    ).resolves.toEqual([{ id: "a", label: "A" }]);
  });

  it("drops ids that could be read as a flag or carry whitespace", async () => {
    const bin = fakeBin(
      "#!/bin/sh\nprintf -- '--rm -rf /\\tEvil\\nok-1\\tOK\\na b\\tSpaced\\n$(id)\\tSub\\n'\n",
    );
    await expect(
      fetchModels(bin, { args: ["models"], parse: parseTabbedModels }, {}),
    ).resolves.toEqual([{ id: "ok-1", label: "OK" }]);
  });

  it("returns null when the CLI fails, prints nothing usable, or is missing", async () => {
    const failing = fakeBin("#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
    await expect(
      fetchModels(failing, { args: ["models"], parse: parseTabbedModels }, {}),
    ).resolves.toBeNull();

    await expect(
      fetchModels(
        "/nonexistent/cli",
        { args: ["models"], parse: parseTabbedModels },
        {},
      ),
    ).resolves.toBeNull();
  });

  it("kills a CLI that hangs instead of waiting on it", async () => {
    const bin = fakeBin("#!/bin/sh\nsleep 30\n");
    const started = Date.now();
    await expect(
      fetchModels(bin, { args: ["models"], parse: parseTabbedModels }, {}, 300),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("drops duplicate ids", async () => {
    const bin = fakeBin("#!/bin/sh\nprintf 'a\\tA\\na\\tA again\\n'\n");
    await expect(
      fetchModels(bin, { args: ["models"], parse: parseTabbedModels }, {}),
    ).resolves.toEqual([{ id: "a", label: "A" }]);
  });
});

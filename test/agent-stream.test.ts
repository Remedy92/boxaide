import { describe, expect, it } from "vitest";
import {
  lineSplitter,
  readClaudeEvent,
  readGrokEvent,
  readOpenCodeEvent,
  renderClaudeRunLine,
} from "../src/agent/agent-stream.js";

/**
 * The fixtures below are real lines, trimmed of their bulk: captured by running
 * `claude --output-format stream-json --verbose` and `grok --output-format
 * streaming-json` against a prompt that reads a file. Hand-written shapes would
 * only prove this file agrees with itself.
 */
describe("readClaudeEvent", () => {
  it("names the tool on an assistant tool_use block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "..." },
          { type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } },
        ],
      },
    });
    expect(readClaudeEvent(line)).toBe("Read");
  });

  it("strips the MCP prefix so Boxaide's own tools keep one name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "mcp__boxaide__messages_list" }],
      },
    });
    expect(readClaudeEvent(line)).toBe("messages_list");
  });

  it("names nothing for text, results and hook records", () => {
    for (const event of [
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "system", subtype: "hook_started", hook_name: "SessionStart" },
      { type: "result", subtype: "success" },
    ]) {
      expect(readClaudeEvent(JSON.stringify(event))).toBeNull();
    }
  });

  it("survives a line that is not JSON", () => {
    expect(readClaudeEvent("Loading...")).toBeNull();
    expect(readClaudeEvent("{ truncated")).toBeNull();
  });
});

describe("readGrokEvent", () => {
  it("names the tool on a tool_call line", () => {
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-1",
      title: "read_file",
      toolName: "read_file",
      rawInput: { target_file: "/etc/hosts" },
    });
    expect(readGrokEvent(line)).toBe("read_file");
  });

  it("ignores the updates that follow it", () => {
    const line = JSON.stringify({
      type: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
    });
    expect(readGrokEvent(line)).toBeNull();
  });

  it("names nothing for thought and text deltas", () => {
    expect(readGrokEvent(JSON.stringify({ type: "thought", data: "The" }))).toBeNull();
    expect(readGrokEvent(JSON.stringify({ type: "text", data: "ok" }))).toBeNull();
  });
});

describe("readOpenCodeEvent", () => {
  it("names the tool on a tool_use line", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        callID: "call-1",
        state: { status: "completed", input: { filePath: "/etc/hosts" } },
      },
    });
    expect(readOpenCodeEvent(line)).toBe("read");
  });

  it("strips the MCP prefix so Boxaide's own tools keep one name", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "boxaide_chat_await_message" },
    });
    expect(readOpenCodeEvent(line)).toBe("chat_await_message");
  });

  it("names nothing for step and text lines", () => {
    expect(
      readOpenCodeEvent(
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      ),
    ).toBeNull();
    expect(
      readOpenCodeEvent(
        JSON.stringify({ type: "text", part: { type: "text", text: "OK" } }),
      ),
    ).toBeNull();
  });
});

describe("renderClaudeRunLine", () => {
  it("hands back a line it cannot read, because it is still information", () => {
    expect(renderClaudeRunLine("Loading...")).toBe("Loading...");
    expect(renderClaudeRunLine("{ truncated")).toBe("{ truncated");
  });

  it("announces the session, with the model when the event names one", () => {
    expect(
      renderClaudeRunLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "abc",
          model: "claude-opus-4-6",
        }),
      ),
    ).toBe("[claude] session started (model claude-opus-4-6)");
    expect(
      renderClaudeRunLine(JSON.stringify({ type: "system", subtype: "init" })),
    ).toBe("[claude] session started");
  });

  it("says nothing for other system lines", () => {
    expect(
      renderClaudeRunLine(
        JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart" }),
      ),
    ).toBeNull();
  });

  it("renders assistant text and tool calls, one per line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Checking the inbox." },
          { type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } },
          { type: "tool_use", name: "mcp__boxaide__messages_list" },
        ],
      },
    });
    expect(renderClaudeRunLine(line)).toBe(
      "Checking the inbox.\n[tool] Read\n[tool] messages_list",
    );
  });

  it("says nothing for an assistant line with no text and no tools", () => {
    expect(
      renderClaudeRunLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "..." }] },
        }),
      ),
    ).toBeNull();
    expect(
      renderClaudeRunLine(JSON.stringify({ type: "assistant", message: {} })),
    ).toBeNull();
  });

  it("renders the final result, and names the subtype when it is not success", () => {
    expect(
      renderClaudeRunLine(
        JSON.stringify({ type: "result", subtype: "success", result: "Sent 3 replies." }),
      ),
    ).toBe("[claude] result: Sent 3 replies.");
    expect(
      renderClaudeRunLine(
        JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
      ),
    ).toBe("[claude] error_max_turns");
  });

  it("says why a run failed when the result carries errors", () => {
    expect(
      renderClaudeRunLine(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["MCP server boxaide failed to start", "no tools available"],
        }),
      ),
    ).toBe(
      "[claude] error_during_execution: MCP server boxaide failed to start; no tools available",
    );
    expect(
      renderClaudeRunLine(
        JSON.stringify({ type: "result", subtype: "error_during_execution", errors: [] }),
      ),
    ).toBe("[claude] error_during_execution");
  });

  it("says nothing for tool results and unnamed events", () => {
    expect(
      renderClaudeRunLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      ),
    ).toBeNull();
    expect(
      renderClaudeRunLine(JSON.stringify({ type: "stream_event", event: {} })),
    ).toBeNull();
  });
});

describe("lineSplitter", () => {
  it("joins a JSON object split across chunks", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line));
    feed('{"type":"tool_');
    expect(seen).toEqual([]);
    feed('call","toolName":"grep"}\n');
    expect(seen).toEqual(['{"type":"tool_call","toolName":"grep"}']);
  });

  it("emits every line in one chunk, and drops blank ones", () => {
    const seen: string[] = [];
    lineSplitter((line) => seen.push(line))("a\n\nb\n");
    expect(seen).toEqual(["a", "b"]);
  });

  it("holds a partial line back until its newline arrives", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line));
    feed("whole\npart");
    expect(seen).toEqual(["whole"]);
    feed("ial\n");
    expect(seen).toEqual(["whole", "partial"]);
  });

  it("keeps the head of an oversized line and drops the rest", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line));
    feed("x".repeat(300_000));
    feed("still the same line\n");
    expect(seen).toEqual(["x".repeat(256 * 1024)]);
    feed("next\n");
    expect(seen).toEqual(["x".repeat(256 * 1024), "next"]);
  });

  it("flushes the partial line a killed child left behind", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line));
    feed("whole\nhalf a li");
    expect(seen).toEqual(["whole"]);
    feed.flush();
    expect(seen).toEqual(["whole", "half a li"]);
  });

  it("flushes nothing when the buffer is empty or blank, and twice is safe", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line));
    feed.flush();
    feed("done\n   ");
    feed.flush();
    feed.flush();
    expect(seen).toEqual(["done"]);
  });
});

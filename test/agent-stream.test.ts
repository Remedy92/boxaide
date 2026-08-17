import { describe, expect, it } from "vitest";
import {
  claudeTurnReader,
  lineSplitter,
  readClaudeLine,
  readGrokEvent,
  readOpenCodeEvent,
  renderClaudeRunLine,
  type ClaudeTurnOutcome,
} from "../src/agent/agent-stream.js";

/**
 * The fixtures below are real lines, trimmed of their bulk: captured by running
 * `claude --output-format stream-json --verbose` and `grok --output-format
 * streaming-json` against a prompt that reads a file. Hand-written shapes would
 * only prove this file agrees with itself.
 */
function outcome(): ClaudeTurnOutcome {
  return { text: null, sessionId: null, error: null };
}

describe("readClaudeLine", () => {
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
    expect(readClaudeLine(line, outcome())).toBe("Read");
  });

  it("strips the MCP prefix so Boxaide's own tools keep one name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "mcp__boxaide__messages_list" }],
      },
    });
    expect(readClaudeLine(line, outcome())).toBe("messages_list");
  });

  it("names nothing for text, results and hook records", () => {
    for (const event of [
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "system", subtype: "hook_started", hook_name: "SessionStart" },
      { type: "result", subtype: "success" },
    ]) {
      expect(readClaudeLine(JSON.stringify(event), outcome())).toBeNull();
    }
  });

  it("survives a line that is not JSON", () => {
    expect(readClaudeLine("Loading...", outcome())).toBeNull();
    expect(readClaudeLine("{ truncated", outcome())).toBeNull();
  });

  it("reads the session id off any line, and the answer off the result", () => {
    const found = outcome();
    readClaudeLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "ses-1" }),
      found,
    );
    expect(found.sessionId).toBe("ses-1");
    // A tool line is both a label and part of the turn: one parse serves both.
    expect(
      readClaudeLine(
        JSON.stringify({
          type: "assistant",
          session_id: "ses-1",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        }),
        found,
      ),
    ).toBe("Bash");
    readClaudeLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "  two invoices came in  ",
        session_id: "ses-1",
      }),
      found,
    );
    expect(found).toEqual({
      text: "two invoices came in",
      sessionId: "ses-1",
      error: null,
    });
  });

  it("reads a refused resume as the turn's error, with the session it reported", () => {
    const found = outcome();
    readClaudeLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["No conversation found with session ID: ses-gone"],
        session_id: "ses-gone",
      }),
      found,
    );
    expect(found.text).toBeNull();
    expect(found.sessionId).toBe("ses-gone");
    expect(found.error).toContain("No conversation found");
  });
});

describe("claudeTurnReader", () => {
  it("reports every line as liveness and keeps the answer", () => {
    const found = outcome();
    const tools: Array<string | null> = [];
    const feed = claudeTurnReader(found, (tool) => tools.push(tool));
    feed(`${JSON.stringify({ type: "system", session_id: "ses-1" })}\n`);
    feed(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep" }] },
      })}\n`,
    );
    feed(
      `${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`,
    );
    expect(tools).toEqual([null, "Grep", null]);
    expect(found).toEqual({ text: "done", sessionId: "ses-1", error: null });
  });

  it("reads a result line that arrived without its closing newline", () => {
    const found = outcome();
    const feed = claudeTurnReader(found, () => {});
    // The CLI is not required to newline-terminate its last write, and the last
    // thing a turn writes is what the turn is worth.
    feed(JSON.stringify({ type: "result", is_error: false, result: "the answer" }));
    expect(found.text).toBeNull();
    feed.flush();
    expect(found.text).toBe("the answer");
  });

  it("keeps a result line far past the presence reader's cap", () => {
    const found = outcome();
    const feed = claudeTurnReader(found, () => {});
    // Over 256KB: the presence cap would drop this, scoring a finished turn as
    // "no answer", re-running it and dead-lettering the message.
    const long = "x".repeat(400_000);
    feed(`${JSON.stringify({ type: "result", is_error: false, result: long })}\n`);
    expect(found.text).toHaveLength(400_000);
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

  it("flushes the unterminated tail, and nothing when there is none", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line));
    feed("done\ntrailing");
    feed.flush();
    expect(seen).toEqual(["done", "trailing"]);
    // Flushing twice, or on an empty buffer, reports nothing.
    feed.flush();
    expect(seen).toEqual(["done", "trailing"]);
  });

  it("flushes nothing from a line it already gave up on", () => {
    const seen: string[] = [];
    const feed = lineSplitter((line) => seen.push(line), { maxLine: 100 });
    feed("x".repeat(200));
    expect(seen).toEqual(["x".repeat(100)]);
    feed.flush();
    expect(seen).toEqual(["x".repeat(100)]);
  });
});

import { describe, expect, it } from "vitest";
import {
  claudeAuthFailed,
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

/**
 * The sign-out classifier, which is only interesting at its edges: what it
 * catches decides whether a user's question is answered, and what it catches by
 * mistake is an answer thrown away.
 */
describe("claudeAuthFailed", () => {
  it("catches the sign-out notice arriving where the answer goes", () => {
    // The observed failure: exit 0, subtype success, and the notice in
    // `result`. Read as an answer, this is what gets posted to the user.
    const found = outcome();
    readClaudeLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Not logged in · Please run /login",
        session_id: "ses-1",
      }),
      found,
    );
    expect(found.text).toBe("Not logged in · Please run /login");
    expect(claudeAuthFailed(found)).toBe(true);
  });

  it("catches a result event that carried nothing at all", () => {
    const found = outcome();
    readClaudeLine(
      JSON.stringify({ type: "result", subtype: "success", session_id: "ses-1" }),
      found,
    );
    // "claude: success" is the whole error a user was shown for this. It says
    // nothing, and the turn produced nothing, so it counts as the same failure.
    expect(found.error).toBe("claude: success");
    expect(claudeAuthFailed(found)).toBe(true);
  });

  it("catches a refused key on the error side", () => {
    const found = outcome();
    readClaudeLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Invalid API key · Please run /login"],
      }),
      found,
    );
    expect(claudeAuthFailed(found)).toBe(true);
  });

  it("leaves every other failure, and every real answer, alone", () => {
    expect(claudeAuthFailed({ text: null, sessionId: null, error: "Overloaded" })).toBe(
      false,
    );
    expect(
      claudeAuthFailed({
        text: null,
        sessionId: null,
        error: "No conversation found with session ID: abc",
      }),
    ).toBe(false);
    expect(
      claudeAuthFailed({ text: "two invoices came in", sessionId: null, error: null }),
    ).toBe(false);
    // A turn that failed on something else still carries a session id and no
    // text; that alone must not read as a sign-out.
    expect(
      claudeAuthFailed({ text: null, sessionId: "ses-1", error: "claude exited 1" }),
    ).toBe(false);
  });

  it("keeps a short real answer about the user's own accounts", () => {
    // The broad signs are for the error side only. An inbox agent SAYS these
    // things — about IMAP accounts, about API keys — and an answer must never
    // be discarded on them. Only the CLI's own "run /login" instruction may
    // condemn answer text.
    expect(
      claudeAuthFailed({
        text: "You're not logged in to that IMAP account — reconnect it in settings.",
        sessionId: "ses-1",
        error: null,
      }),
    ).toBe(false);
    expect(
      claudeAuthFailed({
        text: "The sync failed: Mailgun rejected an invalid API key.",
        sessionId: "ses-1",
        error: null,
      }),
    ).toBe(false);
  });

  it("still reads the broad signs off the error side", () => {
    expect(
      claudeAuthFailed({ text: null, sessionId: null, error: "Not logged in" }),
    ).toBe(true);
    expect(
      claudeAuthFailed({ text: null, sessionId: null, error: "OAuth token expired" }),
    ).toBe(true);
  });

  it("keeps a long answer that happens to be about logging in", () => {
    // The classifier discards what it matches, so this is the failure it could
    // cause: the user asked about the phrase, and the answer is the answer.
    const essay = `Here is what that message means. "Not logged in" is printed
      by the CLI when it cannot find a credential, and "Please run /login" is
      its suggestion. ${"It is not an error from your mail. ".repeat(10)}`;
    expect(claudeAuthFailed({ text: essay, sessionId: null, error: null })).toBe(false);
  });
});

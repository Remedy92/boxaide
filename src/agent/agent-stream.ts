/**
 * Reading a launched CLI's own event stream.
 *
 * MCP is the only thing Boxaide can see of an agent it did not start: the
 * client calls in, or it does not, and a gap between calls is indistinguishable
 * from a dead process. That is why `channel.ts` treats a stale timestamp as
 * absence.
 *
 * An agent Boxaide launched is a different case entirely. It is a child
 * process this server owns, and both supported CLIs will narrate themselves on
 * stdout in NDJSON if asked. Every line is proof the process is alive, and the
 * tool lines say what it is doing — file reads, shell commands, web fetches —
 * none of which touch Boxaide and none of which MCP would ever reveal.
 *
 * So the launcher asks for that stream and feeds it to the channel. A launched
 * agent thinking for two minutes stays visibly at work, because it is.
 *
 * Formats verified by running each CLI, not from documentation:
 *   claude --output-format stream-json  →  {"type":"assistant","message":
 *                                          {"content":[{"type":"tool_use",...}]}}
 *   grok --output-format streaming-json →  {"type":"tool_call","toolName":...}
 *
 * Both also emit lines this file has no name for — hook records, token deltas,
 * usage totals. Those are deliberately not parsed into anything. They are still
 * proof of life, and the launcher counts them as such.
 */

/** How a CLI namespaces the Boxaide MCP server's tools on its own wire. */
const MCP_PREFIXES = ["mcp__boxaide__", "boxaide__", "boxaide_"];

/**
 * Boxaide's own tools come back through here under a client-specific prefix.
 * Stripping it means one tool has one name whether it arrived on the stream or
 * through `noteToolCall`, so the UI's word list only needs one entry for it.
 */
function unprefix(name: string): string {
  for (const prefix of MCP_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/**
 * The tool a line says the agent just started, or null for every other line.
 *
 * Null is not "nothing happened" — the caller already counts the line as
 * liveness. It only means this line does not rename what the agent is doing.
 */
export type ReadEvent = (line: string) => string | null;

function parse(line: string): unknown {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A CLI is free to print whatever it likes. An unreadable line is still a
    // live process, which is the caller's business, not this function's.
    return null;
  }
}

/** What one `claude -p` process produced, folded together line by line. */
export type ClaudeTurnOutcome = {
  /** The `result` event's text, when the turn succeeded. */
  text: string | null;
  /** The session id the CLI reported, on success or failure. */
  sessionId: string | null;
  /** Why it failed, in a form fit for the exit the user is shown. */
  error: string | null;
};

/**
 * One Claude Code stream-json line: the tool it names, and what it adds to the
 * turn's outcome.
 *
 * Both readings come off one parse. They used to be two functions over the same
 * line — a tool label here, the session id and the result there — which parsed
 * every line twice and split ownership of this wire format across two files.
 *
 * Shapes verified against claude 2.1.233 with
 * `claude -p … --output-format stream-json --verbose`:
 *   every line          → {"session_id":"<uuid>", …}
 *   a tool call         → {"type":"assistant","message":{"content":
 *                          [{"type":"tool_use","name":"Bash"}]}, …}
 *   the answer          → {"type":"result","subtype":"success","is_error":false,
 *                          "result":"<text>", …}
 *   a refused resume    → {"type":"result","subtype":"error_during_execution",
 *                          "is_error":true,"errors":["No conversation found
 *                          with session ID: …"], …}
 * Everything else — hook records, thinking-token deltas, rate-limit events — is
 * liveness only, which the caller has already counted. Note that lines keep
 * arriving after the result event (a `hook_response` follows it), so a reader
 * must not stop at the answer.
 *
 * Null is not "nothing happened": it only means this line does not rename what
 * the agent is doing.
 */
export function readClaudeLine(line: string, into: ClaudeTurnOutcome): string | null {
  const event = parse(line) as {
    type?: unknown;
    subtype?: unknown;
    session_id?: unknown;
    is_error?: unknown;
    result?: unknown;
    errors?: unknown;
    message?: { content?: unknown };
  } | null;
  if (!event) return null;
  if (typeof event.session_id === "string" && event.session_id) {
    into.sessionId = event.session_id;
  }
  if (event.type === "result") {
    foldResult(event, into);
    return null;
  }
  if (event.type !== "assistant") return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as { type?: string; name?: unknown };
    if (b?.type === "tool_use" && typeof b.name === "string" && b.name) {
      return unprefix(b.name);
    }
  }
  return null;
}

/** The turn's own verdict: the answer, or the CLI's reason for not having one. */
function foldResult(
  event: {
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    errors?: unknown;
  },
  into: ClaudeTurnOutcome,
): void {
  if (event.is_error !== true && typeof event.result === "string") {
    const answer = event.result.trim();
    if (answer) into.text = answer;
    return;
  }
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((e): e is string => typeof e === "string")
    : [];
  into.error =
    errors.join("; ") ||
    (typeof event.subtype === "string" ? `claude: ${event.subtype}` : null) ||
    into.error;
}

/**
 * The reader for one driven `claude -p` turn.
 *
 * `onLine` runs for every line, with the tool it named or null: the caller owns
 * both liveness and the presence label, and this owns the wire format.
 */
export function claudeTurnReader(
  outcome: ClaudeTurnOutcome,
  onLine: (tool: string | null) => void,
): LineFeed {
  return lineSplitter((line) => onLine(readClaudeLine(line, outcome)), {
    maxLine: CLAUDE_RESULT_MAX_LINE,
  });
}

/**
 * Grok: one `tool_call` line per call, and a `tool_call_update` per state
 * change on it. Only the opening line is read — an update carries the tool's
 * output, and re-stamping the same name as it completes says nothing new.
 */
export const readGrokEvent: ReadEvent = (line) => {
  const event = parse(line) as { type?: string; toolName?: unknown } | null;
  if (!event || event.type !== "tool_call") return null;
  return typeof event.toolName === "string" && event.toolName
    ? unprefix(event.toolName)
    : null;
};

/**
 * OpenCode `run --format json`. A tool_use line carries the tool name on
 * `part.tool`. Captured against 1.18.15; other line types are liveness only.
 */
export const readOpenCodeEvent: ReadEvent = (line) => {
  const event = parse(line) as {
    type?: string;
    part?: { tool?: unknown };
  } | null;
  if (!event || event.type !== "tool_use") return null;
  return typeof event.part?.tool === "string" && event.part.tool
    ? unprefix(event.part.tool)
    : null;
};

/**
 * One stream line turned into something a person would want to read, or null
 * when the line says nothing worth a row in the log.
 *
 * Null here means different things than in `ReadEvent`: the line was understood
 * and is deliberately not shown. A line that was *not* understood is returned
 * verbatim instead, because an unparsed line is still information and the log
 * is the only record a human gets of a scheduled run.
 */
export type RenderRunLine = (line: string) => string | null;

/**
 * Claude Code under `--output-format stream-json --verbose`, rendered for the
 * run log of a scheduled automation.
 *
 * The audience is a person reading after the fact, so this keeps what explains
 * the run — session start, what the agent said, which tools it reached for, how
 * it ended — and drops what only a machine would want: tool results, token
 * deltas, hook records. Nothing here throws; a malformed event renders as
 * nothing rather than losing the whole log to one bad line.
 */
export const renderClaudeRunLine: RenderRunLine = (line) => {
  const event = parse(line) as
    | {
        type?: string;
        subtype?: string;
        model?: unknown;
        result?: unknown;
        errors?: unknown;
        message?: { content?: unknown };
      }
    | null;
  // Not JSON we can read — hand it back as it arrived rather than swallow it.
  if (!event || typeof event !== "object") return line;

  if (event.type === "system") {
    if (event.subtype !== "init") return null;
    const model = typeof event.model === "string" && event.model ? event.model : null;
    return model ? `[claude] session started (model ${model})` : "[claude] session started";
  }

  if (event.type === "assistant") {
    const content = event.message?.content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: unknown; name?: unknown };
      if (b?.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      } else if (b?.type === "tool_use" && typeof b.name === "string" && b.name) {
        parts.push(`[tool] ${unprefix(b.name)}`);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }

  if (event.type === "result") {
    if (event.subtype === "success" && typeof event.result === "string") {
      return `[claude] result: ${event.result}`;
    }
    // A failed run carries its explanation on `errors` (and, rarely, `result`).
    // Dropping it would leave the log saying only that something went wrong.
    const label = `[claude] ${event.subtype ?? "result"}`;
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "")
      : [];
    if (errors.length) return `${label}: ${errors.join("; ")}`;
    if (typeof event.result === "string" && event.result) return `${label}: ${event.result}`;
    return label;
  }

  // `user` lines are tool results, and everything else is bookkeeping.
  return null;
};

/**
 * Longest line either CLI may produce before we cut it short.
 *
 * Grok restates its whole command and tool registry periodically, which runs
 * to about 10KB. The cap is well past that and exists only so a child that
 * never emits a newline cannot grow this buffer without bound.
 */
const MAX_LINE = 256 * 1024;

/**
 * The same cap for a reader whose lines carry the turn's answer.
 *
 * Presence can afford to lose a line: it costs one label. A driven turn cannot —
 * dropping the `result` event scores a finished, paid-for turn as "no answer",
 * re-runs it, and dead-letters the message. Claude's own output ceiling is
 * ~32k tokens, so this is orders of magnitude past any real result line and
 * exists only to bound the buffer.
 */
const CLAUDE_RESULT_MAX_LINE = 8 * 1024 * 1024;

/** A chunk sink with an end: `flush` reads whatever arrived without a newline. */
export type LineFeed = ((chunk: string) => void) & { flush: () => void };

/**
 * Turns a stdout chunk stream into whole lines.
 *
 * A pipe splits wherever it likes, so a JSON object routinely arrives across
 * two chunks. A line past the cap is emitted as its first `maxLine` characters
 * and the rest is dropped up to the next newline: the run log keeps the head,
 * which is the part a person can read, and the readers that JSON.parse a line
 * simply return null on the truncated one, as they already do for any line
 * they cannot read.
 *
 * `flush()` emits whatever partial line is still buffered — a child killed
 * mid-line has already said something, and the run log is the only record of
 * it. It is safe to call more than once, and callers that never call it behave
 * exactly as before.
 */
export function lineSplitter(
  onLine: (line: string) => void,
  options: { maxLine?: number } = {},
): LineFeed {
  const maxLine = options.maxLine ?? MAX_LINE;
  let buffer = "";
  let dropping = false;
  const feed = (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (dropping) dropping = false;
      else if (line.trim()) onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > maxLine) {
      const head = buffer.slice(0, maxLine);
      buffer = "";
      dropping = true;
      if (head.trim()) onLine(head);
    }
  };
  feed.flush = () => {
    const line = buffer;
    buffer = "";
    // While dropping, what is buffered is the tail of a line whose head has
    // already been emitted. Emitting it now would be the discard arriving late.
    if (dropping) return;
    if (line.trim()) onLine(line);
  };
  return feed;
}

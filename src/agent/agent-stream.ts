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
const MCP_PREFIXES = ["mcp__boxaide__", "boxaide__"];

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

/** Claude Code: tool calls arrive as content blocks on an assistant message. */
export const readClaudeEvent: ReadEvent = (line) => {
  const event = parse(line) as
    | { type?: string; message?: { content?: unknown } }
    | null;
  if (!event || event.type !== "assistant") return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as { type?: string; name?: unknown };
    if (b?.type === "tool_use" && typeof b.name === "string" && b.name) {
      return unprefix(b.name);
    }
  }
  return null;
};

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
 * Longest line either CLI may produce before we give up on it.
 *
 * Grok restates its whole command and tool registry periodically, which runs
 * to about 10KB. The cap is well past that and exists only so a child that
 * never emits a newline cannot grow this buffer without bound.
 */
const MAX_LINE = 256 * 1024;

/**
 * Turns a stdout chunk stream into whole lines.
 *
 * A pipe splits wherever it likes, so a JSON object routinely arrives across
 * two chunks. Anything past the cap is dropped up to the next newline rather
 * than buffered — losing one oversized line costs a label, and the line that
 * arrived is still counted as liveness by the caller.
 */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  let dropping = false;
  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (dropping) dropping = false;
      else if (line.trim()) onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE) {
      buffer = "";
      dropping = true;
    }
  };
}

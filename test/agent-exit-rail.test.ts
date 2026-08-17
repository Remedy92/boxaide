/**
 * What the rail says about the last launch.
 *
 * The rail used to read `lastExit.code !== 0`, which is not knowable from a
 * code: a driven agent (Claude Code) has no process exit at all, and a child
 * asked to stop dies on a signal with no code. One Stop click therefore painted
 * "exited" on Grok and OpenCode and nothing on Claude Code.
 */
import { describe, expect, it } from "vitest";
import { agentExitedBadly } from "../apps/web/src/components/rail/agent-exit.ts";
import type {
  LocalAgentExit,
  LocalAgentExitReason,
} from "../apps/web/src/lib/api/endpoints.ts";

function exit(
  reason: LocalAgentExitReason,
  over: Partial<LocalAgentExit> = {},
): LocalAgentExit {
  return {
    id: "claude-code",
    code: null,
    reason,
    at: "2026-08-17T00:00:00.000Z",
    stderrTail: "",
    ...over,
  };
}

describe("agentExitedBadly", () => {
  it("says nothing about a stop, whichever CLI it was", () => {
    // A driven agent reports no code; a child-backed one dies on a signal and
    // reports none either. Same click, same answer.
    expect(agentExitedBadly("claude-code", { running: null, lastExit: exit("stopped") })).toBe(
      false,
    );
    expect(
      agentExitedBadly("grok", {
        running: null,
        lastExit: exit("stopped", { id: "grok", code: null }),
      }),
    ).toBe(false);
  });

  it("calls out a crash and a driver that gave up", () => {
    expect(
      agentExitedBadly("grok", {
        running: null,
        lastExit: exit("exited", { id: "grok", code: 3 }),
      }),
    ).toBe(true);
    expect(
      agentExitedBadly("claude-code", {
        running: null,
        lastExit: exit("error", { stderrTail: "Invalid API key" }),
      }),
    ).toBe(true);
  });

  it("shows nothing while an agent runs, or on the wrong row", () => {
    const running = {
      id: "grok",
      pid: 42,
      startedAt: "2026-08-17T00:00:00.000Z",
      model: null,
    };
    expect(agentExitedBadly("claude-code", { running, lastExit: exit("error") })).toBe(
      false,
    );
    // A crash belongs to the agent it happened to.
    expect(agentExitedBadly("opencode", { running: null, lastExit: exit("error") })).toBe(
      false,
    );
    expect(agentExitedBadly("claude-code", { running: null, lastExit: null })).toBe(false);
  });
});

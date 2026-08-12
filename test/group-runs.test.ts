import { describe, expect, it } from "vitest";
import {
  groupRuns,
  type Run,
} from "../apps/web/src/components/agent/group-runs.ts";
import type { AgentTurn } from "../apps/web/src/lib/types.ts";

function turn(
  partial: Partial<AgentTurn> & Pick<AgentTurn, "seq" | "role">,
): AgentTurn {
  return {
    at: "2026-01-01T00:00:00.000Z",
    text: `${partial.role}-${partial.seq}`,
    agent: null,
    ...partial,
  };
}

const seqs = (turns: AgentTurn[]) => turns.map((t) => t.seq);
const shape = (runs: Run[]) =>
  runs.map((run) => ({
    question: run.question?.seq ?? null,
    steps: seqs(run.steps),
    answers: seqs(run.answers),
    seq: run.seq,
  }));

describe("groupRuns", () => {
  it("keeps sequential Q1 then Q2 in two runs, each with its own answer", () => {
    const q1 = turn({ seq: 1, role: "user" });
    const step = turn({ seq: 2, role: "activity", replyTo: 1 });
    const a1 = turn({ seq: 3, role: "agent", replyTo: 1 });
    const q2 = turn({ seq: 4, role: "user" });
    const a2 = turn({ seq: 5, role: "agent", replyTo: 4 });

    expect(shape(groupRuns([q1, step, a1, q2, a2]))).toEqual([
      { question: 1, steps: [2], answers: [3], seq: 1 },
      { question: 4, steps: [], answers: [5], seq: 4 },
    ]);
  });

  it("attaches a mid-work answer to Q1 when Q2 arrived first", () => {
    const q1 = turn({ seq: 1, role: "user" });
    const q2 = turn({ seq: 2, role: "user" });
    const step = turn({ seq: 3, role: "activity", replyTo: 1 });
    const a1 = turn({ seq: 4, role: "agent", replyTo: 1 });

    const runs = groupRuns([q1, q2, step, a1]);
    expect(shape(runs)).toEqual([
      { question: 1, steps: [3], answers: [4], seq: 1 },
      { question: 2, steps: [], answers: [], seq: 2 },
    ]);
  });

  it("falls back to adjacency when replyTo is missing", () => {
    const q1 = turn({ seq: 1, role: "user" });
    const step = turn({ seq: 2, role: "activity" });
    const a1 = turn({ seq: 3, role: "agent" });
    const q2 = turn({ seq: 4, role: "user" });
    const a2 = turn({ seq: 5, role: "agent" });

    expect(shape(groupRuns([q1, step, a1, q2, a2]))).toEqual([
      { question: 1, steps: [2], answers: [3], seq: 1 },
      { question: 4, steps: [], answers: [5], seq: 4 },
    ]);
  });

  it("opens a run with no question for an unprompted agent turn", () => {
    const said = turn({ seq: 1, role: "agent" });
    expect(shape(groupRuns([said]))).toEqual([
      { question: null, steps: [], answers: [1], seq: 1 },
    ]);
  });

  it("falls back to adjacency when the stamped question is not in the list", () => {
    const q2 = turn({ seq: 2, role: "user" });
    const said = turn({ seq: 3, role: "agent", replyTo: 1 });

    expect(shape(groupRuns([q2, said]))).toEqual([
      { question: 2, steps: [], answers: [3], seq: 2 },
    ]);
  });
});

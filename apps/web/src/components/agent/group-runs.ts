import type { AgentTurn } from "../../lib/types";

/**
 * One exchange: the question, the steps taken, the answer.
 *
 * A run is assembled from the flat turn log rather than stored — the server
 * appends turns and nothing else, so the grouping lives here. It is the shape
 * the conversation actually has: a user turn, any number of activity lines the
 * agent posted while it worked, then the answer.
 *
 * What is NOT here is a token stream. Boxaide runs no model; an answer arrives
 * as one finished `chat_say`. The live part of a run is real all the same — the
 * activity lines and the mail tools being called are events this server
 * handled, so "working" is a fact about a claimed message, not a guess about a
 * model that nobody here can see.
 */
export type Run = {
  /** The user turn that opened it. Null when an agent spoke unprompted. */
  question: AgentTurn | null;
  /** `activity` turns posted since the question. */
  steps: AgentTurn[];
  /** `agent` turns since the question. More than one is allowed. */
  answers: AgentTurn[];
  /** Sort key — the earliest turn in the run. */
  seq: number;
};

export function groupRuns(turns: AgentTurn[]): Run[] {
  const runs: Run[] = [];
  const byQuestion = new Map<number, Run>();
  let current: Run | null = null;

  const open = (question: AgentTurn | null, seq: number): Run => {
    const run: Run = { question, steps: [], answers: [], seq };
    runs.push(run);
    if (question) byQuestion.set(question.seq, run);
    return run;
  };

  const attach = (run: Run, turn: AgentTurn): void => {
    if (turn.role === "activity") run.steps.push(turn);
    else if (turn.role === "agent") run.answers.push(turn);
  };

  for (const turn of turns) {
    if (turn.role === "user") {
      current = open(turn, turn.seq);
      continue;
    }

    const replyTo = turn.replyTo;
    if (typeof replyTo === "number") {
      const owned = byQuestion.get(replyTo);
      if (owned) {
        attach(owned, turn);
        continue;
      }
    }

    if (!current) current = open(null, turn.seq);
    attach(current, turn);
  }
  return runs;
}

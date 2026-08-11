"use client";

import * as React from "react";
import { Markdown } from "@/lib/format/markdown";
import { isoAttr, isoTitle } from "@/lib/format/date";
import type { AgentTurn as Turn } from "@/lib/types";

/**
 * One turn.
 *
 * Three shapes, and the difference between them is structural rather than
 * decorative:
 *
 *   user      a contained block, right-aligned — it is the one thing on screen
 *             the person wrote, and it should be findable by shape alone.
 *   agent     full measure, plain prose, no container. The answer is the
 *             content of the pane; wrapping it in a card would make it look
 *             like an aside.
 *   activity  a quiet line. Not a message, and never styled like one, or a
 *             progress note reads as an answer.
 */
export const AgentTurnView = React.memo(function AgentTurnView({
  turn,
}: {
  turn: Turn;
}) {
  if (turn.role === "activity") {
    return (
      <p className="flex items-center gap-2 py-0.5 text-[12px] leading-4 text-fg-tertiary">
        <span
          aria-hidden="true"
          className="block size-1 shrink-0 rounded-[var(--radius-full)] bg-[var(--dot-muted)]"
        />
        <span className="min-w-0 truncate">{turn.text}</span>
      </p>
    );
  }

  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] min-w-0 rounded-[var(--radius-lg)] bg-surface-selected px-3 py-2 text-[13px] leading-[20px] text-fg">
          <Markdown text={turn.text} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="mb-1 flex items-baseline gap-2 text-[11px] leading-4 text-fg-tertiary">
        <span className="font-medium text-fg-secondary">
          {turn.agent ?? "Agent"}
        </span>
        <time dateTime={isoAttr(turn.at)} title={isoTitle(turn.at)} className="tnum">
          {new Date(turn.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </p>
      <div className="text-[13px] leading-[20px] text-fg">
        <Markdown text={turn.text} />
      </div>
    </div>
  );
});

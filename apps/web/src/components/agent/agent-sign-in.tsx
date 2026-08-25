"use client";

import { Button } from "@/components/ui/button";
import { useAgentSignIn } from "@/lib/hooks/use-local-agents";
import { cn } from "@/lib/utils";

/**
 * The one control that fixes a signed-out CLI, wherever the user meets it.
 *
 * Both places that offer it — the rail row that says "signed out" and the
 * unanswered message in the chat — are the same act, so they are the same
 * component and the same request. `compact` is only the rail's line-height:
 * it has 28px to work in, so the server's refusal is truncated there and read
 * in full on hover, while the pane can give it a line of its own.
 */
export function AgentSignIn({
  agentId,
  relaunch = true,
  compact = false,
  className,
}: {
  agentId?: string;
  relaunch?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { signIn, waiting, opened, error } = useAgentSignIn(agentId, relaunch);

  if (opened && !relaunch) {
    return (
      <span className={cn("text-[12px] leading-4 text-fg-tertiary", className)}>
        Finish signing in in Terminal, then run this automation again.
      </span>
    );
  }

  if (waiting) {
    return (
      <span
        className={cn(
          "shrink-0 text-[11px] text-fg-tertiary",
          !compact && "text-[12px]",
          className,
        )}
      >
        waiting for sign-in…
      </span>
    );
  }

  if (compact) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
        {error && (
          <span className="min-w-0 truncate text-[11px] text-fg-tertiary" title={error}>
            {error}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 px-1.5 text-fg-secondary"
          onClick={signIn}
        >
          Sign in
        </Button>
      </span>
    );
  }

  return (
    <span className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button type="button" variant="outline" size="sm" onClick={signIn}>
        Sign in
      </Button>
      {error && (
        <span className="min-w-0 text-[12px] leading-4 text-fg-tertiary">
          {error}
        </span>
      )}
    </span>
  );
}

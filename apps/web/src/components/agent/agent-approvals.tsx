"use client";

import * as React from "react";
import { toast } from "sonner";
import { CalendarPlus, CalendarX, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/atoms";
import { useAgent } from "@/lib/hooks/use-agent";
import { friendlyError } from "@/lib/api/errors";
import type { AgentApproval } from "@/lib/api/endpoints";

/**
 * What an agent asked to do, and the two buttons that answer it.
 *
 * An agent reads mail that strangers wrote and then decides what to do next,
 * so anything another person would see — a sent message, an invitation, a
 * cancellation — is proposed here rather than done. Boxaide carries it out
 * when this is approved.
 *
 * Pinned above the composer instead of scrolling away in the transcript. A
 * request the user has to scroll back to find is a request that sits unanswered
 * while an agent waits, and a scheduled run's request belongs to no
 * conversation at all — there is nowhere in the log for it to be.
 *
 * The whole message is shown, not a preview. The card exists so somebody reads
 * what is about to be sent in their name, and a truncated body defeats it.
 */
export function AgentApprovals() {
  const agent = useAgent();
  if (agent.approvals.length === 0) return null;
  return (
    <div className="mb-2 space-y-2">
      {agent.approvals.map((row) => (
        <ApprovalCard key={row.id} approval={row} />
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: AgentApproval }) {
  const agent = useAgent();
  const [busy, setBusy] = React.useState<"approve" | "deny" | null>(null);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      await agent.decideApproval(approval.id, decision);
      if (decision === "approve") toast.success("Done.");
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-border-control bg-surface-1 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <ToolIcon tool={approval.tool} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-[18px] font-medium text-fg">
            {approval.title}
          </p>
          {/* Named, because these two are not the same thing to a reader: one
              is the agent they are talking to, the other is an automation that
              ran while nobody was here. */}
          <p className="mt-0.5 text-[11px] leading-4 text-fg-tertiary">
            {approval.profile === "run"
              ? "A scheduled automation asked for this. Nothing has been sent."
              : "Your agent asked for this. Nothing has been sent."}
          </p>
        </div>
      </div>

      {approval.fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {approval.fields.map((field) => (
            <React.Fragment key={field.label}>
              <dt className="text-[11px] leading-4 text-fg-tertiary">
                {field.label}
              </dt>
              <dd className="min-w-0 truncate text-[11px] leading-4 text-fg-secondary">
                {field.value}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      {approval.body && (
        <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-surface-hover px-2.5 py-2 text-[12px] leading-[18px] text-fg-secondary">
          {approval.body}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 text-[12px]"
          disabled={busy !== null}
          onClick={() => void decide("approve")}
        >
          {busy === "approve" && <Spinner />}
          {approval.tool === "message_send" ? "Send it" : "Do it"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[12px]"
          disabled={busy !== null}
          onClick={() => void decide("deny")}
        >
          {busy === "deny" && <Spinner />}
          Don&apos;t
        </Button>
      </div>
    </div>
  );
}

function ToolIcon({ tool }: { tool: string }) {
  const Icon =
    tool === "meeting_create"
      ? CalendarPlus
      : tool === "meeting_cancel"
        ? CalendarX
        : Send;
  return (
    <Icon
      className="mt-0.5 size-4 shrink-0 text-fg-tertiary"
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}

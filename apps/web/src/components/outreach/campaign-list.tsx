"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/api/errors";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useCampaigns } from "@/lib/hooks/use-outreach";
import { useUpdateCampaignStatus } from "@/lib/hooks/use-outreach-mutations";
import type { CampaignStatus, OutreachCampaign } from "@/lib/types";

const STATUSES: CampaignStatus[] = ["draft", "active", "paused", "done"];

/** The states a campaign contact can be in, in the order they happen. */
const STATES: Array<{ key: string; label: string }> = [
  { key: "active", label: "active" },
  { key: "replied", label: "replied" },
  { key: "opted_out", label: "opted out" },
  { key: "done", label: "done" },
  { key: "suppressed", label: "suppressed" },
];

/**
 * Campaigns, with the per-state counts the list endpoint returns.
 *
 * The only control is status. Steps — the actual emails — are authored by the
 * agent and no endpoint hands them back, so this view does not pretend to show
 * or edit them. Activating a campaign queues its first step as PENDING outbox
 * rows: it puts mail in the queue on the left, never in someone's inbox.
 */
export function CampaignList() {
  const accounts = useAccounts();
  const campaigns = useCampaigns();
  const rows = campaigns.data ?? [];

  const aliases = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts.data ?? []) map.set(account.id, account.alias);
    return map;
  }, [accounts.data]);

  if (campaigns.isPending) {
    return (
      <div className="space-y-2 px-3 py-3">
        <Skeleton className="h-4 w-[45%]" />
        <Skeleton className="h-4 w-[60%]" />
      </div>
    );
  }

  if (rows.length === 0) return <CampaignsEmpty />;

  return (
    <ul className="list-none">
      {rows.map((campaign) => (
        <CampaignRow
          key={campaign.id}
          campaign={campaign}
          alias={aliases.get(campaign.accountId) ?? campaign.accountId}
        />
      ))}
    </ul>
  );
}

function CampaignRow({
  campaign,
  alias,
}: {
  campaign: OutreachCampaign;
  alias: string;
}) {
  const update = useUpdateCampaignStatus();
  const selectId = `campaign-${campaign.id}-status`;

  const setStatus = (next: string) => {
    update.mutate(
      { campaignId: campaign.id, status: next as CampaignStatus },
      {
        onSuccess: () =>
          toast.success(
            next === "active"
              ? `${campaign.name} is active`
              : `${campaign.name} is ${next}`,
            next === "active"
              ? {
                  description:
                    "The first step is queued for your approval, not sent.",
                }
              : undefined,
          ),
        onError: (error) =>
          toast.error("Could not change that campaign", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  const counts = STATES.filter(
    (state) => (campaign.counts[state.key] ?? 0) > 0,
  );

  return (
    <li className="border-b border-border-subtle px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[18px] font-medium text-fg">
            {campaign.name}
          </p>
          <p className="truncate text-[12px] leading-[18px] text-fg-tertiary">
            Sends as {alias}
          </p>
        </div>

        <label htmlFor={selectId} className="sr-only">
          Status of {campaign.name}
        </label>
        <Select
          value={campaign.status}
          disabled={update.isPending}
          onValueChange={setStatus}
        >
          <SelectTrigger id={selectId} size="sm" className="w-[104px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {counts.length > 0 && (
        // Plain text, not badges: five chips on one row at 320px is a wall,
        // and these are counts, not states of this row.
        <p className="mt-1 text-[11px] leading-4 text-fg-tertiary">
          {counts
            .map((state) => `${campaign.counts[state.key]} ${state.label}`)
            .join(" · ")}
        </p>
      )}
    </li>
  );
}

function CampaignsEmpty() {
  const app = useApp();
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-[13px] leading-[18px] text-fg-tertiary">
        No campaigns yet. Ask the agent to write one — it drafts the steps, and
        every email still waits here for you.
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="mt-3"
        onClick={() => app.setView("agent")}
      >
        Open the agent
      </Button>
    </div>
  );
}

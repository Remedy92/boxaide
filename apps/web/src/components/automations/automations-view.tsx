"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Menu, RefreshCw, Sparkle } from "lucide-react";
import { TechnicalDetails } from "@/components/atoms";
import { AutomationCard } from "@/components/automations/automation-card";
import { ConnectionStateBlock } from "@/components/list/list-empty";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { useAutomations } from "@/lib/hooks/use-automations";
import { useConnection, useMeta } from "@/lib/hooks/use-connection";
import { useSettings } from "@/lib/hooks/use-settings";

/**
 * The Automations view.
 *
 * One column, not a list-and-pane: an automation is a paragraph of instructions
 * and a schedule, and its runs belong under it rather than in a second column
 * that would be empty until something is picked.
 *
 * There is no create form anywhere in this view. Automations are written by
 * talking to the agent — it holds the context that makes a good prompt — so the
 * empty state says that and opens the conversation instead of a dialog.
 */
export function AutomationsView({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const queryClient = useQueryClient();
  const connection = useConnection();
  const meta = useMeta();
  const settings = useSettings();
  const automations = useAutomations();

  const rows = automations.data ?? [];

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["automations"] });
    void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
  }, [queryClient]);

  let body: React.ReactNode;
  if (connection.kind !== "ok") {
    /* A disabled TanStack query sits at "pending" forever, so without this the
       pane would show a skeleton that never resolves. Same rule as the list. */
    body = (
      <ConnectionStateBlock
        connection={connection}
        tokenHint={meta.data?.tokenHint}
        baseUrl={settings.baseUrl}
        handlers={{
          openSettings: (focus) => app.openSettings(focus ?? null),
          retry: refresh,
        }}
      />
    );
  } else if (automations.isError) {
    body = (
      <div
        role="alert"
        className="mx-auto mt-6 max-w-[560px] rounded-[var(--radius-md)] bg-danger-bg p-3"
      >
        <p className="flex items-center gap-2 text-[13px] text-danger">
          <CircleAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />
          {friendlyError(
            automations.error instanceof Error
              ? automations.error.message
              : automations.error,
          )}
        </p>
        <TechnicalDetails
          raw={
            automations.error instanceof Error
              ? automations.error.message
              : automations.error
          }
        />
        <Button type="button" variant="secondary" className="mt-2" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  } else if (automations.isPending) {
    body = (
      <div className="mx-auto max-w-[560px] space-y-3 pt-5">
        {[0, 1].map((card) => (
          <div
            key={card}
            className="space-y-2 rounded-[var(--radius-md)] border border-border-subtle p-3"
          >
            <Skeleton className="h-4 w-[40%]" />
            <Skeleton className="h-3 w-[65%]" />
            <Skeleton className="h-3 w-[30%]" />
          </div>
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center px-6 py-10">
        <div className="max-w-[320px] text-center">
          <p className="text-[13px] leading-[18px] text-fg-secondary">
            Automations are created by talking to the agent.
          </p>
          <p className="mt-1.5 text-[13px] leading-[18px] text-fg-tertiary">
            Tell it what should happen and when — “every weekday at 8, summarise
            what came in overnight” — and it writes the schedule. They show up
            here, where you can pause one or run it now.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => app.setView("agent")}
          >
            <Sparkle className="size-3.5" strokeWidth={1.5} />
            Open the agent
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="mx-auto max-w-[560px] space-y-3 pt-5 pb-10">
        {rows.map((automation) => (
          <AutomationCard key={automation.id} automation={automation} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
        {showRailButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open mailboxes and folders"
            onClick={onOpenRail}
          >
            <Menu className="size-4" strokeWidth={1.5} />
          </Button>
        )}

        <h2 className="mr-1 text-[13px] font-medium text-fg">Automations</h2>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh automations"
              aria-busy={automations.isFetching || undefined}
              className="ml-auto"
              onClick={refresh}
            >
              <RefreshCw
                className={`size-4 ${automations.isFetching ? "mailmux-spin" : ""}`}
                strokeWidth={1.5}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto px-4">{body}</div>
    </div>
  );
}

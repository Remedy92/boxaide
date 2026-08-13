"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Menu, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Spinner, TechnicalDetails } from "@/components/atoms";
import { ConnectionStateBlock } from "@/components/list/list-empty";
import { DealCard } from "@/components/pipeline/deal-card";
import { DealDialog, type DealSeed } from "@/components/pipeline/deal-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { useConnection, useMeta } from "@/lib/hooks/use-connection";
import { useCrmContacts } from "@/lib/hooks/use-crm-contacts";
import { useDeleteCrmDeal, useMoveCrmDeal } from "@/lib/hooks/use-crm-mutations";
import { useCrmPipeline } from "@/lib/hooks/use-crm-pipeline";
import { useSettings } from "@/lib/hooks/use-settings";
import { formatDealValue } from "@/lib/format/deal";
import type { CrmDeal } from "@/lib/types";

/**
 * The pipeline board.
 *
 * One horizontal scroller of fixed-width columns rather than a grid that
 * divides the viewport: stages are seeded (lead, contacted, replied, won, lost)
 * and a five-way split at 900px gives 180px columns that cannot hold a deal
 * title. The board scrolls sideways; the page never does.
 *
 * Moves go through `POST /api/crm/deals/:id/move`, which renumbers `position`
 * across both the old and the new column server-side. That is why nothing here
 * is optimistic — a locally patched board would be wrong for every card but the
 * one that moved.
 */
export function PipelineBoard({
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
  const board = useCrmPipeline();
  // Names for the cards. The deal row carries only `contactId`, and the list
  // endpoint caps at 200, so a card whose contact is outside that page shows no
  // name rather than a wrong one.
  const contacts = useCrmContacts({});
  const move = useMoveCrmDeal();
  const remove = useDeleteCrmDeal();

  const [seed, setSeed] = React.useState<DealSeed | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<CrmDeal | null>(null);
  const [movingId, setMovingId] = React.useState<string | null>(null);

  const stages = React.useMemo(() => board.data ?? [], [board.data]);
  const stageList = React.useMemo(
    () => stages.map((stage) => ({ id: stage.id, name: stage.name, position: stage.position })),
    [stages],
  );

  const contactLabels = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const contact of contacts.data ?? []) {
      map.set(contact.id, contact.name?.trim() || contact.email);
    }
    return map;
  }, [contacts.data]);

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["crm-pipeline"] });
  }, [queryClient]);

  const onMove = React.useCallback(
    (dealId: string, stageId: string) => {
      setMovingId(dealId);
      move.mutate(
        { dealId, stageId },
        {
          onSettled: () => setMovingId(null),
          onError: (error) =>
            toast.error("Could not move that deal", {
              description: friendlyError(
                error instanceof Error ? error.message : error,
              ),
            }),
        },
      );
    },
    [move],
  );

  const onEdit = React.useCallback(
    (deal: CrmDeal) =>
      setSeed({ nonce: Date.now(), deal, stageId: deal.stageId }),
    [],
  );
  const onDelete = React.useCallback((deal: CrmDeal) => setPendingDelete(deal), []);

  const confirmDelete = () => {
    const deal = pendingDelete;
    if (!deal) return;
    remove.mutate(deal.id, {
      onSuccess: (result) => {
        setPendingDelete(null);
        if (result.deleted) toast.success(`Deleted ${deal.title}`);
        else toast.warning("That deal was already gone");
      },
      onError: (error) =>
        toast.error("Could not delete that deal", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        }),
    });
  };

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

        <h2 className="mr-1 text-[13px] font-medium text-fg">Pipeline</h2>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="New deal"
              className="ml-auto"
              disabled={stageList.length === 0}
              onClick={() =>
                setSeed({
                  nonce: Date.now(),
                  stageId: stageList[0]?.id ?? "lead",
                })
              }
            >
              <Plus className="size-4" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New deal</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh the board"
              aria-busy={board.isFetching || undefined}
              onClick={refresh}
            >
              <RefreshCw
                className={`size-4 ${board.isFetching ? "mailmux-spin" : ""}`}
                strokeWidth={1.5}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      {/* A disabled TanStack query sits at status "pending" forever, so with no
          server URL or no token this pane would otherwise show a skeleton that
          never resolves. `connection.kind` decides, as in the message list. */}
      {connection.kind !== "ok" ? (
        <ConnectionStateBlock
          connection={connection}
          tokenHint={meta.data?.tokenHint}
          baseUrl={settings.baseUrl}
          handlers={{
            openSettings: (focus) => app.openSettings(focus ?? null),
            retry: refresh,
          }}
        />
      ) : board.isError ? (
        <div role="alert" className="m-5 rounded-[var(--radius-md)] bg-danger-bg p-3">
          <p className="flex items-center gap-2 text-[13px] text-danger">
            <CircleAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />
            {friendlyError(
              board.error instanceof Error ? board.error.message : board.error,
            )}
          </p>
          <TechnicalDetails
            raw={board.error instanceof Error ? board.error.message : board.error}
          />
          <Button type="button" variant="secondary" className="mt-2" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : board.isPending ? (
        <div className="flex gap-3 p-4">
          {[0, 1, 2, 3].map((column) => (
            <div key={column} className="w-[260px] shrink-0 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      ) : (
        // The board scrolls sideways inside its own box, so the shell's grid
        // never grows a horizontal scrollbar of its own.
        <div className="pane-scroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
          <div className="flex h-full min-h-0 items-start gap-3">
            {stages.map((stage, index) => {
              const previousStage = index > 0 ? stageList[index - 1] : null;
              const nextStage =
                index < stageList.length - 1 ? stageList[index + 1] : null;
              const total = stage.deals.reduce(
                (sum, deal) => sum + (deal.value ?? 0),
                0,
              );
              const currency =
                stage.deals.find((deal) => deal.currency)?.currency ?? null;
              return (
                <section
                  key={stage.id}
                  aria-label={stage.name}
                  className="flex h-full min-h-0 w-[260px] shrink-0 flex-col rounded-[var(--radius-md)] bg-surface-1"
                >
                  <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
                    <h3 className="text-[11px] leading-4 font-medium tracking-[var(--tracking-label)] text-fg-tertiary uppercase">
                      {stage.name}
                    </h3>
                    <span className="tnum text-[11px] text-fg-tertiary">
                      {stage.deals.length}
                    </span>
                    {total > 0 && (
                      <span className="tnum ml-auto text-[11px] text-fg-tertiary">
                        {formatDealValue({ value: total, currency })}
                      </span>
                    )}
                  </div>

                  <ul className="pane-scroll min-h-0 flex-1 list-none space-y-2 overflow-y-auto px-2.5 pb-2.5">
                    {stage.deals.length === 0 ? (
                      <li className="px-0.5 py-1 text-[12px] leading-[18px] text-fg-tertiary">
                        Nothing here.
                      </li>
                    ) : (
                      stage.deals.map((deal) => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          contactLabel={
                            deal.contactId
                              ? contactLabels.get(deal.contactId)
                              : undefined
                          }
                          previousStage={previousStage}
                          nextStage={nextStage}
                          moving={movingId === deal.id}
                          onMove={onMove}
                          onEdit={onEdit}
                          onDelete={onDelete}
                        />
                      ))
                    )}
                  </ul>

                  <div className="shrink-0 px-2.5 pb-2.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() =>
                        setSeed({ nonce: Date.now(), stageId: stage.id })
                      }
                    >
                      <Plus className="size-3.5" strokeWidth={1.5} />
                      New deal in {stage.name}
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <DealDialog
        seed={seed}
        stages={stageList}
        onOpenChange={() => setSeed(null)}
      />

      {pendingDelete && (
        <AlertDialog
          open
          onOpenChange={(next) => (next ? undefined : setPendingDelete(null))}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {pendingDelete.title}?</AlertDialogTitle>
              <AlertDialogDescription>
                The deal goes. The contact and their mail history stay.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  confirmDelete();
                }}
              >
                {remove.isPending && <Spinner />}
                {remove.isPending ? "Deleting…" : "Delete deal"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

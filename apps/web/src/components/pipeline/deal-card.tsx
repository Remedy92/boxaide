"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDealValue } from "@/lib/format/deal";
import type { CrmDeal } from "@/lib/types";

/**
 * One deal on the board.
 *
 * The move controls are buttons, not only a drag handle: a kanban whose single
 * affordance is dragging is unusable from a keyboard, and the spec makes drag
 * the optional half of the pair. Each button names the stage it would move the
 * card to, so the action is legible without the column headers.
 */
export const DealCard = React.memo(function DealCard({
  deal,
  contactLabel,
  previousStage,
  nextStage,
  moving,
  onMove,
  onEdit,
  onDelete,
}: {
  deal: CrmDeal;
  /** The contact's name, resolved by the board. Undefined when unassigned. */
  contactLabel?: string;
  previousStage: { id: string; name: string } | null;
  nextStage: { id: string; name: string } | null;
  /** True while THIS card's move is in flight. */
  moving: boolean;
  onMove: (dealId: string, stageId: string) => void;
  onEdit: (deal: CrmDeal) => void;
  onDelete: (deal: CrmDeal) => void;
}) {
  const value = formatDealValue(deal);

  return (
    <li
      className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-2 p-2.5"
      aria-busy={moving || undefined}
    >
      <p className="text-[13px] leading-[18px] font-medium text-fg">
        {deal.title}
      </p>
      {(contactLabel || value) && (
        <p className="mt-0.5 truncate text-[12px] leading-[18px] text-fg-tertiary">
          {[contactLabel, value].filter(Boolean).join(" · ")}
        </p>
      )}

      <div className="mt-2 flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={
                previousStage
                  ? `Move ${deal.title} to ${previousStage.name}`
                  : `${deal.title} is in the first stage`
              }
              disabled={!previousStage || moving}
              onClick={() =>
                previousStage ? onMove(deal.id, previousStage.id) : undefined
              }
            >
              <ChevronLeft className="size-3" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {previousStage ? `Move to ${previousStage.name}` : "First stage"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={
                nextStage
                  ? `Move ${deal.title} to ${nextStage.name}`
                  : `${deal.title} is in the last stage`
              }
              disabled={!nextStage || moving}
              onClick={() => (nextStage ? onMove(deal.id, nextStage.id) : undefined)}
            >
              <ChevronRight className="size-3" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {nextStage ? `Move to ${nextStage.name}` : "Last stage"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Edit ${deal.title}`}
              className="ml-auto"
              onClick={() => onEdit(deal)}
            >
              <Pencil className="size-3" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${deal.title}`}
              onClick={() => onDelete(deal)}
            >
              <Trash2 className="size-3" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </li>
  );
});

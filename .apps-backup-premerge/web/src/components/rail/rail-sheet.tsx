"use client";

import { LeftRail } from "@/components/rail/left-rail";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * §5.3, below 760px. The rail becomes a slide-over from the leading edge,
 * opened by the hamburger in the list header. Same content, same controls — it
 * is the identical <LeftRail>, not a reduced copy that could drift.
 */
export function RailSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[280px] gap-0 p-0 sm:max-w-[280px]"
        showCloseButton={false}
      >
        <SheetTitle className="sr-only">Mailboxes and folders</SheetTitle>
        <SheetDescription className="sr-only">
          Switch mailbox, filter by folder, and reach settings.
        </SheetDescription>
        <nav aria-label="Mailboxes and folders" className="h-full min-h-0">
          <LeftRail />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

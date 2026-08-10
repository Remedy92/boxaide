"use client";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * §6.3, tiered on the 300ms floor. The caller decides whether to render this at
 * all: 0–300ms shows nothing, because a skeleton that flashes for 200ms is
 * worse than no feedback. No shimmer — the blocks are static at full opacity.
 */
export function ListSkeleton({ rows }: { rows: number }) {
  return (
    <ul aria-hidden="true" className="list-none">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="grid grid-cols-[3px_28px_minmax(0,1fr)_auto] items-center gap-2.5 px-3"
          style={{
            height: "var(--row-h)",
            paddingTop: "var(--row-pad-y)",
            paddingBottom: "var(--row-pad-y)",
          }}
        >
          <Skeleton className="h-full w-[3px] rounded-[var(--radius-full)]" />
          <Skeleton className="size-6 rounded-[var(--radius-sm)]" />
          <span className="min-w-0 space-y-1.5">
            <Skeleton className="h-2.5 w-[40%]" />
            <Skeleton className="h-2.5 w-[85%]" />
          </span>
          <Skeleton className="h-2.5 w-8" />
        </li>
      ))}
    </ul>
  );
}

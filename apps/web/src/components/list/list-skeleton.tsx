"use client";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * Tiered on the 300ms floor: the caller decides whether to render this at all,
 * because a skeleton that flashes for 200ms is worse than no feedback.
 *
 * Skeletons, not a spinner — the shape of what is coming is more informative
 * than a rotating circle, and it holds the scroll position steady when the rows
 * arrive. The blocks pulse; nothing travels across them.
 */
export function ListSkeleton({ rows }: { rows: number }) {
  return (
    <ul aria-hidden="true" className="mailmux-pulse list-none">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-2.5 px-3"
          style={{
            height: "var(--row-h)",
            paddingTop: "calc(var(--row-pad-y) + 2px)",
            paddingBottom: "var(--row-pad-y)",
          }}
        >
          <Skeleton className="size-1.5 justify-self-center rounded-[var(--radius-full)]" />
          <span className="min-w-0 space-y-2">
            <Skeleton className="h-2 w-[34%]" />
            <Skeleton className="h-2 w-[78%]" />
          </span>
          <Skeleton className="h-2 w-7" />
        </li>
      ))}
    </ul>
  );
}

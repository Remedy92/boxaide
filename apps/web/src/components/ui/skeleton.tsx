import { cn } from "@/lib/utils"

/**
 * A flat block. It carries no animation of its own — a travelling shimmer on
 * eight rows reads as a loading screen pretending to be busy. Where a group of
 * these should breathe, the container adds `mailmux-pulse`, so the whole
 * skeleton fades as one shape rather than each block on its own timeline.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-[var(--radius-xs)] bg-border-strong", className)}
      {...props}
    />
  )
}

export { Skeleton }

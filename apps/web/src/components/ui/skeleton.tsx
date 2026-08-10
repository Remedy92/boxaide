import { cn } from "@/lib/utils"

/**
 * §6.3 / §10: no shimmer, no pulse. Static blocks at 100% opacity. A skeleton
 * that animates under 300ms reads as noise, and the animation tokens exist for
 * one deliberately unused.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-[var(--radius-xs)] bg-border-subtle", className)}
      {...props}
    />
  )
}

export { Skeleton }

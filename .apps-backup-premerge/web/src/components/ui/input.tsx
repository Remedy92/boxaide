"use client";

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * §6.9. 32px, token surfaces, 13px. Focus draws the accent border here and the
 * global :focus-visible outline does the rest — no local outline-none, which
 * would beat the base-layer rule.
 *
 * The resting border is --border-control, not --border-subtle: it is the only
 * thing that identifies this as an input, so WCAG 1.4.11 wants 3:1 against the
 * surface behind it. --border-subtle measures 1.18:1 and is decoration only.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-[var(--radius-md)] border border-border-control bg-surface-1 px-2 text-[13px] text-fg",
        "transition-[border-color] duration-[var(--dur-fast)]",
        "placeholder:text-fg-tertiary",
        "hover:border-[var(--text-secondary)] focus-visible:border-accent",
        "disabled:cursor-not-allowed disabled:bg-surface-0 disabled:text-fg-disabled",
        "aria-invalid:border-[var(--danger)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }

"use client";

import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full rounded-[var(--radius-md)] border border-border-control bg-surface-2 px-2 py-1.5 text-[14px] leading-[20px] text-fg",
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

export { Textarea }

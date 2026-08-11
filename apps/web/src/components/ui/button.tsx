"use client";

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * §6.9. Variants are remapped onto the mailmux tokens; nothing here carries a
 * hard-coded colour. Focus is deliberately NOT styled here — globals.css draws
 * a 2px accent outline on :focus-visible for everything, and a local
 * `outline-none` would silently win over it because utilities outrank the base
 * layer.
 *
 * `outline` is kept as an alias of `secondary` because AlertDialogCancel and
 * DialogFooter's generated markup ask for it by name.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded-[var(--radius-md)] font-medium",
    "transition-[background-color,color,transform] duration-[var(--dur-fast)]",
    "hover:duration-0",
    "aria-disabled:cursor-not-allowed aria-disabled:text-fg-disabled",
    "disabled:pointer-events-none disabled:text-fg-disabled",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    "[&_svg:not([class*='size-'])]:size-[15px]",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-accent-fill text-accent-fill-fg hover:bg-[var(--accent-fill-hover)] active:translate-y-[0.5px] disabled:bg-[var(--border-subtle)] aria-disabled:bg-[var(--border-subtle)]",
        secondary:
          "bg-surface-1 text-fg border border-border-control hover:bg-surface-hover active:bg-surface-selected disabled:border-border-subtle aria-disabled:border-border-subtle",
        outline:
          "bg-surface-1 text-fg border border-border-control hover:bg-surface-hover active:bg-surface-selected disabled:border-border-subtle aria-disabled:border-border-subtle",
        ghost:
          "bg-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg active:bg-surface-selected",
        destructive:
          "bg-[var(--danger-fill)] text-[var(--danger-fill-fg)] hover:brightness-110 active:translate-y-[0.5px] disabled:bg-[var(--border-subtle)] aria-disabled:bg-[var(--border-subtle)]",
        link: "bg-transparent text-accent underline decoration-1 underline-offset-2 hover:text-[var(--accent-hover)]",
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        sm: "h-7 px-2.5 text-[13px]",
        xs: "h-6 rounded-[var(--radius-sm)] px-2 text-[11px] [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 px-4 text-[13px]",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-9",
        /** Bare sizing for a control that owns its own box (list rows, nav). */
        none: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

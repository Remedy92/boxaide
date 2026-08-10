"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * §6.9. Bottom-right, 360px max, --surface-2 on 1px --border-subtle, radius-md,
 * --shadow-overlay.
 *
 * The generated component pointed sonner at `var(--popover)`, `var(--border)`
 * and `var(--radius)` — shadcn names that this token set never defines, and
 * that Tailwind v4 does not emit, so every one of them resolved to nothing and
 * toasts fell back to sonner's own palette in both themes. These are the real
 * tokens from §3.3.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          title: "text-[13px] leading-5 text-[var(--text-primary)]",
          description: "text-[12px] leading-4 text-[var(--text-secondary)]",
          actionButton:
            "bg-[var(--accent-fill)] text-[var(--accent-fill-fg)] rounded-[var(--radius-sm)]",
          cancelButton:
            "bg-[var(--surface-1)] text-[var(--text-secondary)] rounded-[var(--radius-sm)]",
          success: "[&_[data-icon]]:text-[var(--success)]",
          warning: "[&_[data-icon]]:text-[var(--warning)]",
          error: "[&_[data-icon]]:text-[var(--danger)]",
          info: "[&_[data-icon]]:text-[var(--accent)]",
        },
      }}
      style={
        {
          "--normal-bg": "var(--surface-2)",
          "--normal-text": "var(--text-primary)",
          "--normal-border": "var(--border-subtle)",
          "--border-radius": "var(--radius-md)",
          "--width": "360px",
          boxShadow: "var(--shadow-overlay)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };

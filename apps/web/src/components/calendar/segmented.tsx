"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The chip row the connect-mailbox dialog uses for provider presets, extracted
 * because the Calendar view needs the same control three times: the agenda
 * range, the provider choice, and a meeting's duration.
 *
 * One tab stop, arrows move the selection. `role="radio"` without a roving
 * tabindex would leave one tab stop per chip and dead arrow keys.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  size = "md",
  onChange,
}: {
  /** The accessible name of the group. Never rendered. */
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  size?: "sm" | "md";
  onChange: (value: T) => void;
}) {
  const refs = React.useRef(new Map<string, HTMLButtonElement>());

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-1.5"
      onKeyDown={(event) => {
        const delta =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (delta === 0 || options.length === 0) return;
        event.preventDefault();
        const at = options.findIndex((entry) => entry.value === value);
        const next =
          options[
            (Math.max(at, 0) + delta + options.length) % options.length
          ];
        onChange(next.value);
        refs.current.get(next.value)?.focus();
      }}
    >
      {options.map((entry) => (
        <button
          key={entry.value}
          ref={(node) => {
            if (node) refs.current.set(entry.value, node);
            else refs.current.delete(entry.value);
          }}
          type="button"
          role="radio"
          aria-checked={value === entry.value}
          tabIndex={value === entry.value ? 0 : -1}
          onClick={() => onChange(entry.value)}
          className={cn(
            "rounded-[var(--radius-md)] border transition-colors duration-[var(--dur-fast)]",
            size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
            value === entry.value
              ? "border-accent bg-accent-subtle text-accent"
              : "border-border-control bg-surface-2 text-fg-secondary hover:bg-surface-hover hover:text-fg",
          )}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

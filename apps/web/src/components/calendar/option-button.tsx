"use client";

import * as React from "react";
import { Spinner } from "@/components/atoms";

/**
 * One way in, as a row: what it is on the left, why it is the easy one under
 * it. A row rather than a button per provider logo, because the sentence is
 * the part that decides — "nothing to type" is the whole offer.
 *
 * It lives in its own file because the add-calendar dialog and the first-run
 * wizard offer the same ways in, and a person who meets the row twice should
 * meet the same row.
 */
export function OptionButton({
  icon,
  title,
  detail,
  caution,
  pending,
  pendingLabel,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  /**
   * A reason to hesitate, shown under the detail in the warning colour. Used
   * for the calendar this Mac probably already holds: the row still works, and
   * pressing it asks for confirmation rather than connecting.
   */
  caution?: string;
  pending: boolean;
  pendingLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={pending || undefined}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-[var(--radius-md)] border border-border-control bg-surface-2 p-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover disabled:opacity-60"
    >
      <span className="mt-px shrink-0 text-fg-secondary">
        {pending ? <Spinner /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-[18px] font-medium text-fg">
          {title}
        </span>
        <span className="block text-[12px] leading-4 text-fg-tertiary">
          {pending ? pendingLabel : detail}
        </span>
        {caution && !pending && (
          <span className="mt-1 block text-[12px] leading-4 text-warning">
            {caution}
          </span>
        )}
      </span>
    </button>
  );
}

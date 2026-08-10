"use client";

import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccountHue } from "@/lib/hooks/use-account-hue";
import { friendlyError } from "@/lib/api/errors";

/**
 * The handful of shapes that appear in more than one pane. Keeping them here
 * rather than duplicating them is what stops the account rail drifting between
 * the sidebar, the list and the reader.
 */

/** §6.9. 18px min-height, mono, token surfaces. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-h-[18px] items-center rounded-[var(--radius-xs)] border border-border-subtle bg-surface-0 px-[5px] py-[2px] font-mono text-[11px] leading-none text-fg-tertiary">
      {children}
    </kbd>
  );
}

/** The 14px inline spinner that enters a loading button's leading slot. */
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn("size-[14px] animate-spin", className)}
      strokeWidth={2}
    />
  );
}

export type DotTone = "success" | "warning" | "danger" | "muted" | "accent";

const DOT_BG: Record<DotTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  // --dot-muted, not --text-disabled. In the collapsed rail footer and beside a
  // sidebar account the words live only in the accessible name, so the dot is
  // the sole visual carrier and 1.4.11's 3:1 applies. --text-disabled measures
  // 1.79–2.22 : 1 and is for inactive controls, which SC 1.4.3 exempts.
  muted: "bg-[var(--dot-muted)]",
  accent: "bg-accent",
};

/**
 * A 6px status dot. It is never the only carrier of its meaning — every caller
 * also states the state in words, in the accessible name or beside it.
 */
export function StatusDot({
  tone,
  className,
}: {
  tone: DotTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-[var(--radius-full)]",
        DOT_BG[tone],
        className,
      )}
    />
  );
}

/**
 * The 3px full-height account rail — the signature element. Seeded on the
 * account id everywhere except the reader's identity monogram, so the same
 * mailbox is the same hue in the sidebar, the list and the reader.
 */
export function AccountRail({
  seed,
  dim = false,
  className,
}: {
  seed: string;
  dim?: boolean;
  className?: string;
}) {
  const hueFor = useAccountHue();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block w-[3px] shrink-0 self-stretch rounded-[var(--radius-full)]",
        className,
      )}
      style={{ background: hueFor(seed), opacity: dim ? 0.45 : 1 }}
    />
  );
}

/**
 * The raw server text stays reachable wherever an error is shown — that is the
 * showError contract from web/app.js, preserved. Rendered only when
 * friendlyError actually replaced the text.
 */
export function TechnicalDetails({ raw }: { raw: unknown }) {
  const text = String(raw ?? "").trim();
  if (!text || friendlyError(text) === text) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[12px] text-fg-tertiary">
        Technical details
      </summary>
      <pre className="mt-1.5 max-h-40 overflow-auto rounded-[var(--radius-md)] bg-surface-0 p-2 font-mono text-[12px] whitespace-pre-wrap text-fg-secondary">
        {text}
      </pre>
    </details>
  );
}

/** The 11px uppercase mono section label used down the left rail. */
export function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-6 items-center justify-between">
      <span className="font-mono text-[11px] leading-4 font-medium tracking-[0.06em] text-fg-tertiary uppercase">
        {children}
      </span>
      {action}
    </div>
  );
}

/**
 * The 14×14 brand mark, §6.2: three 2px rails of heights 14 / 10 / 6, in
 * --acct-4, --acct-2 and --acct-6, converging. Both themes define all three.
 */
export function BrandGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="1" y="0" width="2" height="14" rx="1" fill="var(--acct-4)" />
      <rect x="6" y="2" width="2" height="10" rx="1" fill="var(--acct-2)" />
      <rect x="11" y="4" width="2" height="6" rx="1" fill="var(--acct-6)" />
    </svg>
  );
}

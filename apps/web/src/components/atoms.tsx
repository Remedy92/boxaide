"use client";

import * as React from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { cn, copyToClipboard } from "@/lib/utils";
import { friendlyError } from "@/lib/api/errors";

/**
 * The handful of shapes that appear in more than one pane.
 *
 * Icons: lucide, always `size-4` (16px) and always `strokeWidth={1.5}`. One
 * size and one stroke weight across the whole product; a 20px icon or a 2px
 * stroke anywhere is a bug, not a variant.
 */

/** 11px, mono, one hairline. Sits inline in a button or a shortcut sheet. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-h-[17px] min-w-[17px] items-center justify-center rounded-[var(--radius-xs)] border border-border-subtle bg-surface-0 px-[4px] font-mono text-[11px] leading-none text-fg-tertiary">
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
      strokeWidth={1.5}
    />
  );
}

export type DotTone = "success" | "warning" | "danger" | "muted" | "accent";

const DOT_BG: Record<DotTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  // --dot-muted, not --text-disabled. In the collapsed rail footer and beside a
  // sidebar mailbox the words live only in the accessible name, so the dot is
  // the sole visual carrier and 1.4.11's 3:1 applies. --text-disabled measures
  // under 2.4 : 1 and is for inactive controls, which SC 1.4.3 exempts.
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
 * The raw server text stays reachable wherever an error is shown. Rendered only
 * when friendlyError() actually replaced the text.
 */
export function TechnicalDetails({ raw }: { raw: unknown }) {
  const text = String(raw ?? "").trim();
  if (!text || friendlyError(text) === text) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[12px] text-fg-tertiary hover:text-fg-secondary">
        Technical details
      </summary>
      <pre className="mt-1.5 max-h-40 overflow-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface-0 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-fg-secondary">
        {text}
      </pre>
    </details>
  );
}

/** The 11px uppercase section label used down the left rail and in panels. */
export function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-6 items-center justify-between">
      <span className="text-[11px] leading-4 font-medium tracking-[var(--tracking-label)] text-fg-tertiary uppercase">
        {children}
      </span>
      {action}
    </div>
  );
}

/**
 * The brand mark: braces with one line of mail inside them.
 *
 * The mark alone, with no plate. Everywhere else it is engraved into a machined
 * tile, but this one sits inline at text size and takes the ink colour of what
 * surrounds it — a plate here would be a coloured chip mid-sentence, and its
 * chamfer would be mud at 14px.
 *
 * The path data is generated from apps/desktop/scripts/lib/mark.mjs, which is
 * the one definition of the mark. Do not nudge these numbers by hand; change
 * the geometry there and re-emit.
 */
export function BrandGlyph({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M10.55 7.78L8.7 7.78L8.7 11.34L7.12 12L8.7 12.66L8.7 16.22L10.55 16.22"
        strokeWidth={1.24}
      />
      <path
        d="M13.45 7.78L15.3 7.78L15.3 11.34L16.88 12L15.3 12.66L15.3 16.22L13.45 16.22"
        strokeWidth={1.24}
      />
      <path d="M10.81 12L13.19 12" strokeWidth={1.27} />
    </svg>
  );
}

/**
 * Copy-to-clipboard, in the one shape the whole product uses: the icon flips to
 * a check for 1200ms and a toast states the outcome.
 *
 * navigator.clipboard does not exist in a non-secure context, which is exactly
 * where a self-hosted http:// page lives — so a failure says "press ⌘C"
 * instead of doing nothing silently.
 */
export function CopyButton({
  value,
  label,
  className,
  onFallback,
}: {
  value: string;
  /** Used in the accessible name and the toast: "Copy {label}". */
  label: string;
  className?: string;
  /** Called when the clipboard is unavailable, so the caller can select text. */
  onFallback?: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const run = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      onFallback?.();
      toast.warning("Press ⌘C to copy", {
        description: "This browser blocked clipboard access.",
      });
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
    toast.success(`Copied ${label}`);
  };

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => void run()}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-[var(--radius-sm)]",
        "text-fg-tertiary transition-colors duration-[var(--dur-fast)]",
        "hover:bg-surface-hover hover:text-fg",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-success" strokeWidth={1.5} />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.5} />
      )}
    </button>
  );
}

/**
 * A monospace block with a copy affordance in its top-right corner. Used for
 * every agent-configuration snippet and every shell line the product asks a
 * person to paste somewhere.
 */
export function CopyBlock({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLPreElement | null>(null);

  const selectAll = () => {
    const node = ref.current;
    if (!node || typeof window === "undefined") return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      <pre
        ref={ref}
        className="pane-scroll min-w-0 overflow-x-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface-0 py-2.5 pr-9 pl-3 font-mono text-[11px] leading-[18px] whitespace-pre text-fg-secondary"
      >
        {value}
      </pre>
      <CopyButton
        value={value}
        label={label}
        onFallback={selectAll}
        className="absolute top-1.5 right-1.5 bg-surface-0"
      />
    </div>
  );
}

/** A label + control + optional helper, at the one spacing the product uses. */
export function Field({
  id,
  label,
  helper,
  error,
  children,
}: {
  id: string;
  label: string;
  helper?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="block text-[12px] leading-4 font-medium text-fg-secondary"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[12px] leading-4 text-danger">
          {error}
        </p>
      ) : helper ? (
        <p className="text-[12px] leading-4 text-fg-tertiary">{helper}</p>
      ) : null}
    </div>
  );
}

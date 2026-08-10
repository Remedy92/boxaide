"use client";

import { useAccountHue } from "@/lib/hooks/use-account-hue";
import { initials } from "@/lib/format/address";
import { cn } from "@/lib/utils";

/**
 * §6.3 / §6.4. Monograms in the list are never coloured — chromatic colour in
 * that pane is reserved for the account rail alone. Only the reader's 36px
 * identity monogram takes a hue, and it is seeded on the parsed sender address
 * so it is stable across "J. Doe" and "Jane Doe".
 *
 * There is no avatar image and no Gravatar: the API has no avatar source, and
 * hashing a correspondent's address to a third party would leak it and break
 * the browser-talks-only-to-your-own-box rule.
 */
export function Monogram({
  from,
  size = 24,
  hueSeed,
  className,
}: {
  /** The raw RFC-5322 string, e.g. `Jane Doe <jane@x.com>`. */
  from: string;
  size?: number;
  /** Present ⇒ hued (reader only). Absent ⇒ neutral (list, rail). */
  hueSeed?: string;
  className?: string;
}) {
  const hueFor = useAccountHue();
  const hued = hueSeed !== undefined;
  const hue = hued ? hueFor(hueSeed) : undefined;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center font-mono font-semibold",
        hued
          ? "rounded-[var(--radius-md)] text-[13px]"
          : "rounded-[var(--radius-sm)] border border-border-subtle bg-surface-2 text-[11px] text-fg-secondary",
        className,
      )}
      style={
        hued
          ? {
              width: size,
              height: size,
              // Mixed in sRGB, not oklab, so the measured ratios below are the
              // ones the browser actually paints. --acct-ink darkens the ink to
              // 87% in light mode, which lifts all eight hues from 3.70–3.99
              // to 4.63–4.98 against this tint; dark mixes 100% and already
              // measures 4.51–4.80.
              color: `color-mix(in srgb, ${hue} var(--acct-ink), black)`,
              background: `color-mix(in srgb, ${hue} 16%, var(--surface-2))`,
            }
          : { width: size, height: size }
      }
    >
      {initials(from)}
    </span>
  );
}

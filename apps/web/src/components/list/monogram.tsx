"use client";

import { initials } from "@/lib/format/address";
import { cn } from "@/lib/utils";

/**
 * A correspondent's initials, in one neutral shape everywhere.
 *
 * It used to take a hue seeded on the sender's address. That hue is gone, along
 * with the rest of the eight-colour account palette: a tinted circle of
 * initials is the most over-used shape in software, it made a calm reader look
 * like a contacts app, and the colour never carried information anybody could
 * decode — two senders were the same colour because a hash said so.
 *
 * There is no avatar image and no Gravatar: the API has no avatar source, and
 * hashing a correspondent's address to a third party would leak it and break
 * the browser-talks-only-to-your-own-box rule.
 */
export function Monogram({
  from,
  size = 24,
  className,
}: {
  /** The raw RFC-5322 string, e.g. `Jane Doe <jane@x.com>`. */
  from: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[var(--radius-md)]",
        "border border-border-subtle bg-surface-1 font-mono text-[11px] font-semibold",
        "text-fg-secondary",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initials(from)}
    </span>
  );
}

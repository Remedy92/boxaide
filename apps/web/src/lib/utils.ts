import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * navigator.clipboard is unavailable in a non-secure context, which is exactly
 * where a self-hosted http:// page lives. Resolving `false` lets the caller say
 * "Press ⌘C to copy" instead of silently doing nothing.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

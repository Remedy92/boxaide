"use client";

import * as React from "react";
import { linkifyToElements } from "@/lib/format/linkify";

/**
 * §6.4.7. The trailing quote run, collapsed behind a pill. Expanding pushes
 * content — one of only two places in this app that animates height, because
 * no transform produces a push-content reveal.
 */
export function QuotedBlock({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-full)] border border-border-subtle bg-surface-0 px-2.5 text-[12px] text-fg-tertiary hover:text-fg-secondary"
      >
        <span aria-hidden="true">⋯</span>
        {open ? "Hide" : "Show"} {lines} quoted {lines === 1 ? "line" : "lines"}
      </button>

      {open && (
        <div className="mailmux-expand mt-3 border-l-2 border-border-strong pl-3">
          <div
            className="text-fg-secondary"
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: "var(--text-read)",
              lineHeight: "var(--leading-read)",
            }}
          >
            {linkifyToElements(text)}
          </div>
        </div>
      )}
    </div>
  );
}

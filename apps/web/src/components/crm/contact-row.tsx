"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { CrmContact } from "@/lib/types";

/**
 * One contact in the People list. Same anatomy as MessageRow — a two-line row
 * in a listbox, exactly one ellipsizing element per line, no avatar, no hover
 * transform — because it sits in the same column at the same width and a second
 * row language there would read as a second product.
 *
 * Line one is the name (or the address when mail never gave one); line two is
 * the address and the organization. `source` is not drawn: whether a row came
 * from mail, an agent or a person is provenance for the detail pane, not a
 * per-row badge.
 */
export const ContactRow = React.memo(function ContactRow({
  contact,
  selected,
  active,
  onSelect,
  registerRow,
}: {
  contact: CrmContact;
  selected: boolean;
  /** Holds the roving tabindex. */
  active: boolean;
  /* Stable across parent renders, so React.memo above can actually bail out. */
  onSelect: (contactId: string) => void;
  registerRow: (id: string, node: HTMLLIElement | null) => void;
}) {
  const { id } = contact;

  const ref = React.useCallback(
    (node: HTMLLIElement | null) => registerRow(id, node),
    [id, registerRow],
  );
  const select = React.useCallback(() => onSelect(id), [id, onSelect]);

  const title = contact.name?.trim() || contact.email;
  const showEmail = title !== contact.email;
  const label = `${title}. ${contact.email}${
    contact.orgName ? `. ${contact.orgName}` : ""
  }`;

  return (
    // Enter and Space are handled here rather than by the global map, for the
    // same reason MessageRow does it: the row that holds the roving tabindex is
    // not necessarily the selected one, and the global map is suspended while
    // any dialog is open.
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={active ? 0 : -1}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        select();
      }}
      className={cn(
        "cursor-pointer px-3 outline-offset-[-2px]",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
        selected
          ? "bg-surface-selected"
          : "hover:bg-surface-hover active:bg-surface-selected",
      )}
      style={{
        minHeight: "var(--row-h)",
        paddingTop: "var(--row-pad-y)",
        paddingBottom: "var(--row-pad-y)",
      }}
    >
      <span className="block truncate text-[13px] leading-[18px] font-medium text-fg">
        {title}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className="min-w-0 truncate leading-[18px] text-fg-secondary"
          style={{ fontSize: "var(--font-list)" }}
        >
          {showEmail ? contact.email : (contact.title ?? "")}
        </span>
        {contact.orgName && (
          <span className="shrink-0 text-[11px] leading-4 text-fg-tertiary">
            {contact.orgName}
          </span>
        )}
      </span>
    </li>
  );
});

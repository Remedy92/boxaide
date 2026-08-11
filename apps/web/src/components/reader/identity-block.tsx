"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { StatusDot } from "@/components/atoms";
import { AttachmentNote } from "@/components/reader/attachment-note";
import { Monogram } from "@/components/list/monogram";
import { Badge } from "@/components/ui/badge";
import { displayName, parseAddress, parseAddressList } from "@/lib/format/address";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import type { MailMessage, MailMessageSummary } from "@/lib/types";

/**
 * §6.4.3–5. Who sent it, who else got it, which mailbox received it and from
 * which folder. The provenance chip is mandatory on every message — that pair
 * is the product's whole premise.
 */
export function IdentityBlock({
  message,
  alias,
}: {
  message: MailMessage | MailMessageSummary;
  /** The receiving mailbox's alias, when the account list has loaded. */
  alias: string | null;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const sender = parseAddress(message.from);
  const recipients = parseAddressList(message.to);
  const cc = "cc" in message ? parseAddressList(message.cc ?? "") : [];
  const bcc = "bcc" in message ? parseAddressList(message.bcc ?? "") : [];
  const first = recipients[0];
  const rest = Math.max(recipients.length - 1, 0);

  return (
    <div>
      <div className="flex items-start gap-3">
        <Monogram from={message.from} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[18px] font-semibold text-fg">
            {displayName(message.from)}
          </p>
          {sender.address && (
            <address
              className="truncate font-mono text-[12px] leading-4 text-fg-secondary not-italic"
              style={{ fontStyle: "normal" }}
            >
              {sender.address}
            </address>
          )}
        </div>
        <time
          dateTime={isoAttr(message.date)}
          title={isoTitle(message.date)}
          className="tnum shrink-0 font-mono text-[12px] leading-4 text-fg-tertiary"
        >
          {formatReaderDate(message.date)}
        </time>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[calc(36px+0.75rem)]">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex items-center gap-1 text-[12px] leading-4 text-fg-secondary hover:text-fg"
        >
          <span className="truncate">
            To: {first ? first.name || first.address || "—" : "—"}
          </span>
          {rest > 0 && (
            <Badge variant="neutral" className="px-1.5 py-0">
              +{rest}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            strokeWidth={1.5}
          />
        </button>

        {/* Provenance: which mailbox received this, and from which folder. */}
        <span className="flex items-center gap-1.5" title={`${alias ?? message.accountId} · ${message.folder}`}>
          <span className="font-mono text-[11px] leading-4 text-fg-secondary">
            {alias ?? message.accountId}
          </span>
          <span className="text-fg-tertiary">·</span>
          <span className="font-mono text-[11px] leading-4 text-fg-tertiary">
            {message.folder}
          </span>
        </span>

        {!message.seen && (
          <span className="flex items-center gap-1.5 text-[11px] text-accent">
            <StatusDot tone="accent" />
            Unread
          </span>
        )}
      </div>

      {expanded && (
        <dl className="mt-2 space-y-1 pl-[calc(3px+0.75rem+36px+0.75rem)] text-[12px] leading-4">
          <AddressLine label="To" entries={recipients} />
          {cc.length > 0 && <AddressLine label="Cc" entries={cc} />}
          {/* bcc is declared on MailMessage but never populated on the read
              path, so this branch effectively never renders. It is kept so an
              empty "Bcc:" label can never appear. */}
          {bcc.length > 0 && <AddressLine label="Bcc" entries={bcc} />}
        </dl>
      )}

      {message.hasAttachments && <AttachmentNote />}
    </div>
  );
}

function AddressLine({
  label,
  entries,
}: {
  label: string;
  entries: ReturnType<typeof parseAddressList>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-fg-tertiary">{label}:</dt>
      <dd className="min-w-0 font-mono break-words text-fg-secondary">
        {entries
          .map((entry) => entry.address || entry.name)
          .filter(Boolean)
          .join(", ")}
      </dd>
    </div>
  );
}

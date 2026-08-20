/**
 * Reply / reply-all / forward prefill, §6.4.
 *
 * `inReplyTo` and `references` are the only threading this client ships, and
 * they are real: SendMessageInput carries both and the provider writes them
 * into the composed headers. When the source message has no Message-ID, both
 * are omitted — exactly as web/app.js already does by setting replyTo to null —
 * and the caller tells the user the reply will start a new thread.
 */

import { dedupeAddresses, parseAddress } from "@/lib/format/address";
import { forwardDate } from "@/lib/format/date";
import {
  MAX_RENDERED_MARKUP_CHARS,
  markupLength,
  sanitizeMailHtml,
} from "@/lib/mail/sanitize";
import type { ComposeMode, ComposeSeed } from "@/lib/hooks/use-app-state";
import type { MailMessage } from "@/lib/types";

function prefixed(subject: string, prefix: "Re: " | "Fwd: "): string {
  const guard = prefix === "Re: " ? /^re:/i : /^fwd:/i;
  return guard.test(subject.trim()) ? subject : `${prefix}${subject}`;
}

/** `<` `&` `"` only: this builds an attribute-free text node inside a table. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The HTML twin of the forwarded-message block, wrapping the source message's
 * own markup.
 *
 * Sanitised with the reader's config before it goes anywhere: forwarding is
 * the one path where sender markup leaves this machine, and the recipient's
 * client has no sandbox of ours to land in. What the reader refuses to run, it
 * refuses to relay. Returns null when there is no HTML part, when the DOM is
 * unavailable, when the markup is large enough to be the sanitiser DoS the
 * reader also refuses (§6.4.6), or when sanitising empties it. The caller then
 * forwards plain text exactly as before.
 */
function buildForwardHtml(
  message: MailMessage,
  header: readonly string[],
): string | null {
  if (!message.bodyHtml) return null;
  if (markupLength(message.bodyHtml) > MAX_RENDERED_MARKUP_CHARS) return null;
  const sanitized = sanitizeMailHtml(message.bodyHtml);
  if (!sanitized || !sanitized.trim()) return null;
  const lines = header
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join("");
  /* A blockquote, the shape every mail client already styles, rather than a
     bare div that inherits whatever the recipient's reader does to the page. */
  return `<div>${lines}</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #cccccc;padding-left:1ex">${sanitized}</blockquote>`;
}

/** The `nonce` is stamped by openCompose, so it is absent here by design. */
export function buildReplySeed(
  message: MailMessage,
  mode: Exclude<ComposeMode, "new">,
  account: { alias: string; email: string } | null,
): Omit<ComposeSeed, "nonce"> {
  const self = account ? [account.email] : [];
  const threading = message.messageId
    ? {
        inReplyTo: message.messageId,
        references: [message.references, message.messageId]
          .filter(Boolean)
          .join(" "),
      }
    : {};

  if (mode === "forward") {
    const sender = parseAddress(message.from);
    const header = [
      "---------- Forwarded message ----------",
      `From: ${sender.name ? `${sender.name} <${sender.address}>` : message.from}`,
      `Date: ${forwardDate(message.date)}`,
      `Subject: ${message.subject}`,
      `To: ${message.to}`,
    ];
    const quoted = ["", ...header, "", message.bodyText].join("\n");
    /* The HTML part is an addition, never a replacement: the text body is
       still built and still sent, so a recipient reading plain text sees the
       same forward they saw before this existed. */
    const html = buildForwardHtml(message, header);

    return {
      mode,
      account: account?.alias,
      to: "",
      cc: "",
      bcc: "",
      subject: prefixed(message.subject, "Fwd: "),
      text: quoted,
      ...(html ? { html } : {}),
      threadingUnavailable: !message.messageId,
      ...threading,
    };
  }

  const sources =
    mode === "reply" ? [message.from] : [message.from, message.to];
  /* Excluding the sending account is right for reply-all, but it empties the
     To line whenever the message was sent BY that account — everything in the
     Sent folder, and self-addressed mail. Fall back to the unfiltered list
     rather than handing back a reply with no recipient. */
  const filtered = dedupeAddresses(sources, self);
  const to = filtered.length > 0 ? filtered : dedupeAddresses(sources);
  const cc =
    mode === "replyAll" ? dedupeAddresses([message.cc ?? ""], [...self, ...to]) : [];

  return {
    mode,
    account: account?.alias,
    to: to.join(", "),
    cc: cc.join(", "),
    bcc: "",
    subject: prefixed(message.subject, "Re: "),
    text: "",
    threadingUnavailable: !message.messageId,
    ...threading,
  };
}

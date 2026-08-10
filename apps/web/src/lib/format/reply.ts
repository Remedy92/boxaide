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
import type { ComposeMode, ComposeSeed } from "@/lib/hooks/use-app-state";
import type { MailMessage } from "@/lib/types";

function prefixed(subject: string, prefix: "Re: " | "Fwd: "): string {
  const guard = prefix === "Re: " ? /^re:/i : /^fwd:/i;
  return guard.test(subject.trim()) ? subject : `${prefix}${subject}`;
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
    const quoted = [
      "",
      "---------- Forwarded message ----------",
      `From: ${sender.name ? `${sender.name} <${sender.address}>` : message.from}`,
      `Date: ${forwardDate(message.date)}`,
      `Subject: ${message.subject}`,
      `To: ${message.to}`,
      "",
      message.bodyText,
    ].join("\n");

    return {
      mode,
      account: account?.alias,
      to: "",
      cc: "",
      bcc: "",
      subject: prefixed(message.subject, "Fwd: "),
      text: quoted,
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

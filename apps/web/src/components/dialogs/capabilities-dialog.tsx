"use client";

import { SectionLabel } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The capability disclosure, and its content is fixed. Disclosing the boundary
 * is what separates a tool from a demo — every line below was checked against
 * src/api/routes.ts, src/mcp/server.ts and src/provider/types.ts.
 */
const CAN = [
  "Hold a conversation with your own MCP agent, in the Agent view",
  "Read mail from every connected mailbox",
  "Search mailboxes (Inbox only)",
  "Mark messages read and unread",
  "Archive messages, and move them between folders",
  "Write, edit, list and discard drafts",
  "Send mail, including replies that thread correctly",
  "List folders",
  "Connect and remove mailboxes",
];

const CANNOT = [
  "Answer you by itself — Boxaide runs no model and never calls one",
  "Delete messages — archiving moves them, it never removes them",
  "Star, flag, label, or tag",
  "Snooze or remind",
  "Group messages into conversations",
  "Download attachments",
  "Show unread counts per folder",
  "Push new mail — this page fetches when you ask it to",
];

/**
 * The mail and chat tools of src/mcp/server.ts — TOOLS + CHAT_TOOLS — in the
 * order they are declared. NOT the whole surface: with the agent platform
 * wired, which is every served endpoint, server.ts also appends PLATFORM_TOOLS
 * (CRM, automations, outreach, calendar). Those are named in their own section
 * of the README; this list is the mail one.
 */
const TOOLS = [
  "accounts_list",
  "messages_list",
  "messages_search",
  "message_get",
  "message_send",
  "message_mark_read",
  "message_archive",
  "message_move",
  "draft_create",
  "draft_update",
  "drafts_list",
  "draft_delete",
  "folders_list",
  "chat_await_message",
  "chat_say",
  "chat_activity",
  "chat_history",
];

export function CapabilitiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="title-15">What this client can do</DialogTitle>
          <DialogDescription>
            Everything below is checked against the endpoints the server
            actually exposes.
          </DialogDescription>
        </DialogHeader>
      <DialogBody>

          <section className="space-y-2">
            <SectionLabel>Boxaide can</SectionLabel>
            <ul className="space-y-1">
              {CAN.map((line) => (
                <li key={line} className="text-[13px] leading-[18px] text-fg-secondary">
                  {line}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <SectionLabel>Boxaide can&rsquo;t</SectionLabel>
            <ul className="space-y-1">
              {CANNOT.map((line) => (
                <li key={line} className="text-[13px] leading-[18px] text-fg-tertiary">
                  {line}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <SectionLabel>Agents</SectionLabel>
            <p className="text-[13px] leading-[18px] text-fg-secondary">
              Anything you point at the MCP endpoint gets the same access to your
              mail that this page has, through these {TOOLS.length} tools.
              Connecting and removing a mailbox is not among them. Drafting is the
              default the tools steer towards; sending is a separate tool. The
              agent work platform adds its own tools beside these; what reaches
              your mail is this list.
            </p>
            <p className="font-mono text-[11px] leading-4 text-fg-tertiary">
              {TOOLS.join(", ")}
            </p>
          </section>

          <div className="flex justify-end">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
      </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

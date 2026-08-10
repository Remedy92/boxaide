"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSettings } from "@/lib/hooks/use-settings";
import { copyToClipboard } from "@/lib/utils";

/**
 * §8 row 3. The capability-disclosure panel, and its content is fixed.
 * Disclosing the boundary is what separates a tool from a demo — every line
 * below was checked against src/api/routes.ts and src/provider/types.ts.
 */
const CAN = [
  "Read mail from every connected mailbox",
  "Search mailboxes (Inbox only)",
  "Mark messages read and unread",
  "Send mail, including replies that thread correctly",
  "List folders",
  "Connect and remove mailboxes",
];

const CANNOT = [
  "Archive, delete, or move messages",
  "Star, flag, label, or tag",
  "Snooze or remind",
  "Group messages into conversations",
  "Save drafts",
  "Download attachments",
  "Show unread counts per folder",
  "Push new mail — this page fetches when you ask it to",
];

const TOOLS = [
  "accounts_list",
  "messages_list",
  "messages_search",
  "message_get",
  "message_send",
  "message_mark_read",
  "folders_list",
];

export function CapabilitiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useSettings();
  const endpoint = `${settings.baseUrl}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        mailmux: {
          url: endpoint,
          headers: {
            Authorization: `Bearer ${settings.token || "<your token>"}`,
          },
        },
      },
    },
    null,
    2,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[560px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle style={{ fontSize: "var(--text-display)" }}>
            What this client can do
          </DialogTitle>
          <DialogDescription>
            Everything below is checked against the endpoints the server
            actually exposes.
          </DialogDescription>
        </DialogHeader>

        <section>
          <h3 className="text-[13px] font-medium text-fg">mailmux can</h3>
          <ul className="mt-1.5 space-y-1">
            {CAN.map((line) => (
              <li key={line} className="text-[13px] leading-[18px] text-fg-secondary">
                {line}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-[13px] font-medium text-fg">mailmux can&rsquo;t</h3>
          <ul className="mt-1.5 space-y-1">
            {CANNOT.map((line) => (
              <li key={line} className="text-[13px] leading-[18px] text-fg-tertiary">
                {line}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-[13px] font-medium text-fg">Agents</h3>
          <p className="mt-1.5 text-[13px] leading-[18px] text-fg-secondary">
            Anything you point at the MCP endpoint gets the same access to your
            mail that this page has, through these seven tools — and no others.
            Connecting and removing a mailbox is not among them:
          </p>
          <p className="mt-1 font-mono text-[12px] leading-4 text-fg-tertiary">
            {TOOLS.join(", ")}
          </p>
          <p className="mt-2 font-mono text-[12px] text-fg-secondary">{endpoint}</p>
          <Button
            type="button"
            variant="secondary"
            className="mt-2"
            onClick={async () => {
              const ok = await copyToClipboard(snippet);
              toast[ok ? "success" : "warning"](
                ok ? "Copied MCP configuration" : "Press ⌘C to copy",
              );
            }}
          >
            Copy configuration
          </Button>
        </section>
      </DialogContent>
    </Dialog>
  );
}

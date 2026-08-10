"use client";

import { Kbd } from "@/components/atoms";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * §9. The footer line is the cheapest honesty this interface can buy: it
 * pre-empts the most common false expectation before the user presses a key
 * that does nothing.
 */
const GROUPS: Array<[string, Array<[string, string[]]>]> = [
  [
    "Moving around",
    [
      ["Next message", ["j"]],
      ["Previous message", ["k"]],
      ["Open selected", ["Enter"]],
      // Esc means "leave what you are in": it clears the search box first, then
      // dismisses an open rail, then moves focus back to the selected row. Only
      // the one-pane layout below 760px actually returns to the list.
      ["Leave the reader or the search box", ["Esc"]],
      ["Scroll the reader", ["Space"]],
      ["Inbox — all mailboxes", ["g", "i"]],
      ["Unread only", ["g", "u"]],
      ["Switch mailbox", ["g", "1–9"]],
      ["Folder picker", ["g", "f"]],
      ["Toggle the sidebar", ["["]],
    ],
  ],
  [
    "Message",
    [
      ["Toggle read / unread", ["u"]],
      ["Reply", ["r"]],
      ["Reply all", ["a"]],
      ["Forward", ["f"]],
      ["Compose", ["c"]],
      ["Send from the composer", ["⌘", "↵"]],
    ],
  ],
  [
    "Finding things",
    [
      ["Search mail", ["/"]],
      ["Command palette", ["⌘", "K"]],
      ["This sheet", ["?"]],
    ],
  ],
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[640px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle style={{ fontSize: "var(--text-display)" }}>
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Single-letter keys are ignored while you are typing in a field.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map(([heading, rows]) => (
            <section key={heading}>
              <h3 className="mb-2 font-mono text-[11px] font-medium tracking-[0.06em] text-fg-tertiary uppercase">
                {heading}
              </h3>
              <dl className="space-y-1.5">
                {rows.map(([action, keys]) => (
                  <div key={action} className="flex items-center gap-2">
                    <dt className="min-w-0 flex-1 text-[13px] leading-[18px] text-fg-secondary">
                      {action}
                    </dt>
                    <dd className="flex shrink-0 gap-1">
                      {keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="text-[12px] leading-4 text-fg-tertiary">
          mailmux can&rsquo;t archive, delete, star, or snooze — so those keys do
          nothing here.
        </p>
      </DialogContent>
    </Dialog>
  );
}

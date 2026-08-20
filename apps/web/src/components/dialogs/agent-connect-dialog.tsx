"use client";

import * as React from "react";
import { toast } from "sonner";
import { CopyBlock, SectionLabel, Spinner, StatusDot } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { friendlyError } from "@/lib/api/errors";
import {
  buildAgentTargets,
  mcpEndpoint,
  type AgentTargetId,
} from "@/lib/agent-config";
import { useMcpTools } from "@/lib/hooks/use-mcp-tools";
import { useSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";

/**
 * "Connect your agent" — the one place that hands out configuration.
 *
 * Every snippet is assembled in this browser from the server URL and token in
 * localStorage. `GET /api/agent-connect` embeds the token in a response body
 * and is deliberately never called.
 *
 * The panel states the capability boundary in plain words because the boundary
 * is the point: drafting is the default an agent should reach for, and sending
 * is a separate tool it has to choose on purpose.
 */
/**
 * The prompt that puts an agent into the chat loop.
 *
 * Worded for a model, not for a person: it names the three tools, says the loop
 * is a loop, and pre-empts the two ways it reliably goes wrong — answering in
 * its own terminal where the user cannot see it, and treating an empty
 * chat_await_message as a reason to stop.
 */
const KICKOFF = `You are my Boxaide inbox agent. Use the Boxaide MCP tools.

Loop: call chat_await_message, do the work, post the answer with chat_say, then
call chat_await_message again. Keep going until I tell you to stop.

Everything I read appears in the Boxaide window, so every answer must go through
chat_say — do not answer here. A chat_await_message that returns no message is
normal; call it again. Use chat_activity for anything slow. Draft rather than
send unless I ask you to send.`;

export function AgentConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) return null;
  return <Body onOpenChange={onOpenChange} />;
}

function Body({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const settings = useSettings();
  const test = useMcpTools();
  const [active, setActive] = React.useState<AgentTargetId>("claude-code");

  const targets = React.useMemo(
    () => buildAgentTargets({ baseUrl: settings.baseUrl, token: settings.token }),
    [settings.baseUrl, settings.token],
  );
  const target = targets.find((entry) => entry.id === active) ?? targets[0];
  const endpoint = mcpEndpoint(settings.baseUrl);
  const tabRefs = React.useRef(new Map<AgentTargetId, HTMLButtonElement>());

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <div className="flex shrink-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="title-15">Connect your agent</DialogTitle>
            <DialogDescription>
              Point any MCP client at Boxaide. It can then read, draft and send
              from all your mailboxes — and hold a conversation with you in the
              Agent view. Drafting is the default; sending needs the send tool.
            </DialogDescription>
          </DialogHeader>

          {/* A real tablist: one tab stop, arrows move between tabs. */}
          <div
            role="tablist"
            aria-label="Agent client"
            className="-mx-(--dialog-px) flex flex-wrap gap-1 border-b border-border-subtle px-(--dialog-px) pb-2"
            onKeyDown={(event) => {
              const delta =
                event.key === "ArrowRight"
                  ? 1
                  : event.key === "ArrowLeft"
                    ? -1
                    : 0;
              if (delta === 0) return;
              event.preventDefault();
              const at = targets.findIndex((entry) => entry.id === active);
              const next =
                targets[
                  (Math.max(at, 0) + delta + targets.length) % targets.length
                ];
              setActive(next.id);
              tabRefs.current.get(next.id)?.focus();
            }}
          >
            {targets.map((entry) => {
              const selected = entry.id === active;
              return (
                <button
                  key={entry.id}
                  ref={(node) => {
                    if (node) tabRefs.current.set(entry.id, node);
                    else tabRefs.current.delete(entry.id);
                  }}
                  type="button"
                  role="tab"
                  id={`agent-tab-${entry.id}`}
                  aria-selected={selected}
                  aria-controls={`agent-panel-${entry.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(entry.id)}
                  className={cn(
                    "h-7 rounded-[var(--radius-md)] px-2.5 text-[13px]",
                    "transition-colors duration-[var(--dur-fast)]",
                    selected
                      ? "bg-surface-selected font-medium text-fg"
                      : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
                  )}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        </div>

        <DialogBody>
          <div
            role="tabpanel"
            id={`agent-panel-${target.id}`}
            aria-labelledby={`agent-tab-${target.id}`}
            className="space-y-3"
          >
            <p className="text-[13px] leading-[18px] text-fg-secondary">
              {target.where}
            </p>

            {target.download ? (
              <>
                <Button asChild size="sm">
                  <a
                    href={target.download.href}
                    download={target.download.filename}
                  >
                    {target.download.action}
                  </a>
                </Button>
                <details className="group">
                  <summary className="cursor-pointer list-none text-[12px] leading-4 text-fg-tertiary hover:text-fg-secondary">
                    Manual alternative
                  </summary>
                  <div className="mt-2">
                    <CopyBlock
                      value={target.snippet}
                      label={`${target.label} configuration`}
                    />
                  </div>
                </details>
              </>
            ) : (
              <CopyBlock
                value={target.snippet}
                label={`${target.label} configuration`}
              />
            )}

            <p className="text-[12px] leading-4 text-fg-tertiary">
              {target.note}
            </p>

            {target.carriesToken && (
              <p className="flex items-start gap-1.5 text-[12px] leading-4 text-warning">
                <StatusDot tone="warning" className="mt-1.5" />
                This snippet contains your access token. Don&rsquo;t paste it
                into anything public.
              </p>
            )}
          </div>

          {/* Without this step the Agent view stays silent, and the reason is
              invisible: MCP is client-driven, so Boxaide cannot make an agent
              start listening. Something has to tell it to enter the loop, and
              that something is the person, once, in their own client. */}
          <div className="space-y-2">
            <SectionLabel>Then start the conversation</SectionLabel>
            <p className="text-[13px] leading-[18px] text-fg-secondary">
              Configuration alone does not make your agent appear in the Agent
              view. Say this to it once, in its own window:
            </p>
            <CopyBlock value={KICKOFF} label="starting prompt" />
            <p className="text-[12px] leading-4 text-fg-tertiary">
              It then waits for whatever you type here. Anything you send before
              it starts is queued, not lost.
            </p>
          </div>

          <div className="space-y-2">
            <SectionLabel>What it gets</SectionLabel>
            <ul className="space-y-1 text-[13px] leading-[18px] text-fg-secondary">
              <li>Read and search mail in every connected mailbox.</li>
              <li>Write, update, list and discard drafts.</li>
              <li>Mark messages read or unread.</li>
              <li>Archive mail into your own Archive mailbox.</li>
              <li>Send mail, and move mail between folders. Both ask you first.</li>
            </ul>
            <p className="text-[12px] leading-4 text-fg-tertiary">
              It cannot connect or remove a mailbox, and it cannot delete, label
              or star mail. Archiving is a move, so nothing it does removes a
              message. A move to any other folder waits for you to approve it.
            </p>
          </div>

          <div className="space-y-2">
            <SectionLabel>Endpoint</SectionLabel>
            <p className="font-mono text-[12px] break-all text-fg-secondary">
              {endpoint}
            </p>
            {/* User-triggered, never on load. A response proves this endpoint
                answers with this token — it never means an agent is attached,
                and this panel must not say so. */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={test.isPending}
              aria-busy={test.isPending || undefined}
              onClick={() => test.mutate()}
            >
              {test.isPending && <Spinner />}
              {test.isPending ? "Testing…" : "Test the endpoint"}
            </Button>

            <div role="status" aria-live="polite">
              {test.isSuccess && (
                <p className="flex items-center gap-1.5 text-[12px] text-success">
                  <StatusDot tone="success" />
                  Responded — {test.data.length} tools available
                </p>
              )}
              {test.isError && (
                <p className="flex items-center gap-1.5 text-[12px] text-danger">
                  <StatusDot tone="danger" />
                  {friendlyError(
                    test.error instanceof Error
                      ? test.error.message
                      : test.error,
                  )}
                </p>
              )}
            </div>
          </div>
        </DialogBody>

        {/* Never disabled: whatever else fails, the dialog can be dismissed. */}
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              toast.dismiss();
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

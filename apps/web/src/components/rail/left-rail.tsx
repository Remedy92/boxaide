"use client";

import * as React from "react";
import {
  Columns3,
  FilePen,
  Inbox,
  MailOpen,
  Plus,
  Send,
  Sparkle,
  Timer,
  Users,
} from "lucide-react";
import { WorkingMark } from "@/components/agent/agent-run";
import { AccountRow, type AccountHealth } from "@/components/rail/account-row";
import { AgentsSection } from "@/components/rail/agents-section";
import { BrandMark } from "@/components/rail/brand-mark";
import { ChatsSection, NewChatButton } from "@/components/rail/chats-section";
import { ComposeButton } from "@/components/rail/compose-button";
import { FolderList } from "@/components/rail/folder-list";
import { NavItem } from "@/components/rail/nav-item";
import { RailFooter } from "@/components/rail/rail-footer";
import { RailSection } from "@/components/rail/rail-section";
import { UpdateCard } from "@/components/rail/update-card";
import { StatusDot } from "@/components/atoms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";
import { useConnection } from "@/lib/hooks/use-connection";
import { useHealth } from "@/lib/hooks/use-health";
import { useMessages } from "@/lib/hooks/use-messages";
import { useOutreachBadge } from "@/lib/hooks/use-outreach";
import { useRailSections } from "@/lib/hooks/use-rail-sections";
import type { MailAccountMeta } from "@/lib/types";

/**
 * The rail carries provenance and configuration. It carries no counts — the
 * backend returns none, and counting the page we happened to fetch is a
 * different number from the one the mailbox holds.
 */
export function LeftRail({
  collapsed = false,
  gPending = false,
}: {
  collapsed?: boolean;
  gPending?: boolean;
}) {
  const app = useApp();
  const accounts = useAccounts();
  const health = useHealth();
  const connection = useConnection();
  const agent = useAgent();
  /* The one polled endpoint in this rail. With the CRM off there is no
     Outreach row to put the number on, so the poll stops rather than running
     every 30s for a view that does not exist. */
  const badge = useOutreachBadge(app.crm);
  const messages = useMessages({
    account: app.account,
    folder: app.folder,
    unreadOnly: app.unreadOnly,
    q: app.query,
  });

  const list = React.useMemo(() => accounts.data ?? [], [accounts.data]);
  const errors = React.useMemo(() => messages.data?.errors ?? [], [messages.data]);
  const hasResponse = messages.data !== undefined;

  const healthFor = React.useCallback(
    (account: MailAccountMeta): AccountHealth => {
      if (!hasResponse) return { state: "unchecked" };
      const failure = errors.find((entry) => entry.account === account.alias);
      if (failure) return { state: "failing", error: failure.error };
      // A per-account listing only reports on the account it asked for.
      if (app.account !== "all" && app.account !== account.alias) {
        return { state: "unchecked" };
      }
      return { state: "ok" };
    },
    [app.account, errors, hasResponse],
  );

  const partial = React.useMemo(() => {
    if (!hasResponse) return null;
    const total = app.account === "all" ? list.length : 1;
    const loaded = Math.max(total - errors.length, 0);
    return { loaded, total };
  }, [app.account, errors.length, hasResponse, list.length]);

  const inMail = app.view === "mail";
  const pending = badge.data?.pending ?? 0;
  const sections = useRailSections();
  const chatCount = agent.storage.chats + agent.storage.archived;

  /* Which sections start open.
     Chats and Mail, because those are the two things somebody opens this app
     to do. Mailboxes and Agents start folded: they are set up once and then
     read as provenance, and they are also the two that grow — an install with
     six mailboxes and four agent CLIs used to push everything else off the
     bottom of the rail. Folding is what buys the room the chat list needs, and
     it is why this is one sidebar and not two. */
  const OPEN_BY_DEFAULT: Record<string, boolean> = {
    chats: true,
    mail: true,
    crm: true,
    mailboxes: false,
    agents: false,
  };
  const isOpen = (id: string) => sections.isOpen(id, OPEN_BY_DEFAULT[id] ?? true);
  const toggle = (id: string) => sections.toggle(id, OPEN_BY_DEFAULT[id] ?? true);

  /** The count a folded header keeps showing. Folding never hides a signal. */
  const foldedCount = (n: number) =>
    n > 0 ? (
      <span className="pr-1 text-[11px] leading-4 text-fg-tertiary tabular-nums">
        {n}
      </span>
    ) : undefined;

  /* Three groups, not one stack of eight rows. Nothing in a flat list said
     that Inbox and Unread are the same kind of thing and Pipeline is not, and
     the labels are what make the workspace setting legible: turn the CRM off
     and a whole named section leaves, rather than three rows going missing
     from the middle of a list. */
  const viewsAndFolders = (
    <>
      <div className="space-y-px">
        {/* First, and first for a reason: the conversation is the product's
            front door. It belongs to neither section — an agent reads mail and
            works the pipeline — so it sits above both, unlabelled.

            The trailing mark says one thing and only while it is true: an
            agent has taken a message and has not answered it. That is the fact
            worth pulling somebody out of their inbox for. Merely having an
            agent parked and idle is not — it was a permanent green dot here,
            and the Agent pane states it in words, with a name, at the top of
            the conversation it belongs to. */}
        <NavItem
          icon={Sparkle}
          label="Agent"
          active={app.view === "agent"}
          onClick={() => app.setView("agent")}
          trailing={
            agent.presence.working ? (
              <span className="flex items-center pr-0.5">
                <WorkingMark />
                <span className="sr-only">Your agent is working on a message</span>
              </span>
            ) : undefined
          }
        />
      </div>

      {/* The conversation list, directly under the row that opens it. Five
          rows and a fixed footer, whatever the history holds — see
          ChatsSection. */}
      <RailSection
        id="chats"
        label="Chats"
        open={isOpen("chats")}
        onToggle={() => toggle("chats")}
        summary={foldedCount(chatCount)}
        action={<NewChatButton />}
      >
        <ChatsSection onOpenAll={() => app.openDialog("chats")} />
      </RailSection>

      {/* Not gated on `collapsed`: this block only ever renders at full
          width — inline in the expanded rail, or inside the popover the
          collapsed rail opens, which is 224px wide. */}
      <RailSection
        id="mail"
        label="Mail"
        open={isOpen("mail")}
        onToggle={() => toggle("mail")}
      >
        <NavItem
          icon={Inbox}
          label="Inbox"
          active={inMail && app.account === "all" && !app.unreadOnly && !app.folder}
          onClick={() => {
            app.setView("mail");
            app.setAccount("all");
            app.setUnreadOnly(false);
          }}
        />
        <NavItem
          icon={MailOpen}
          label="Unread"
          active={inMail && app.unreadOnly}
          onClick={() => {
            app.setView("mail");
            app.setUnreadOnly(!app.unreadOnly);
          }}
        />
        {/* Drafts is a view, not a folder: it comes from GET /api/drafts, which
            takes one mailbox at a time and is unified here rather than by the
            server. Putting it in the folder list would imply otherwise. */}
        <NavItem
          icon={FilePen}
          label="Drafts"
          active={app.view === "drafts"}
          onClick={() => app.setView("drafts")}
        />
        {/* Under Mail, and it stays in a mail-only install: an automation is a
            rule that runs over messages, which is exactly what somebody who
            turned the CRM off still has. */}
        <NavItem
          icon={Timer}
          label="Automations"
          active={app.view === "automations"}
          onClick={() => app.setView("automations")}
        />

        {/* Mail and Drafts only. Folders scope the MESSAGE list; in a
            conversation, in People and on the Pipeline there is no such list to
            scope — the section would sit there explaining that it needs a
            mailbox picked, about a pane that is not on screen. Drafts still
            shows it, disabled, because Drafts IS a list of mail. */}
        {(inMail || app.view === "drafts") && (
          <FolderList
            accountRef={app.account}
            activeFolder={app.folder}
            disabled={app.view === "drafts"}
            onSelect={(path) => {
              app.setView("mail");
              app.setFolder(path);
            }}
          />
        )}
      </RailSection>

      {/* The CRM, and only for somebody who asked for one. Off, these three
          rows are not rendered — not greyed, not behind a switch — because the
          setting is a claim about what this app is, not a filter over a list.
          The server keeps its contacts and deals either way. */}
      {app.crm && (
        <RailSection
          id="crm"
          label="CRM"
          open={isOpen("crm")}
          onToggle={() => toggle("crm")}
          /* Folded, the approval queue still has to be visible. A count that
             disappears when a section closes is a count nobody can trust. */
          summary={
            pending > 0 ? (
              <Badge variant="accent" className="tnum mr-1 px-1.5">
                {pending}
              </Badge>
            ) : undefined
          }
        >
          {/* People is a list and a detail pane, the same shape as mail;
              Pipeline is a board and takes the whole width. Neither carries a
              count: the endpoints return rows, not totals, and counting the
              page we happened to fetch is a different number. */}
          <NavItem
            icon={Users}
            label="People"
            active={app.view === "people"}
            onClick={() => app.setView("people")}
          />
          <NavItem
            icon={Columns3}
            label="Pipeline"
            active={app.view === "pipeline"}
            onClick={() => app.setView("pipeline")}
          />
          {/* The one count in this rail, and the one the spec asks for: emails
              an agent wrote that nobody has decided on. It is a number the
              server returns — GET /api/outreach/badge, polled every 30s — not a
              count of the page we happened to fetch, and it is a person's
              queue, not a notification. Silent when there is nothing to
              decide. */}
          <NavItem
            icon={Send}
            label="Outreach"
            active={app.view === "outreach"}
            onClick={() => app.setView("outreach")}
            ariaLabel={
              pending > 0
                ? `Outreach, ${pending} waiting for approval`
                : undefined
            }
            trailing={
              pending > 0 ? (
                <Badge variant="accent" className="tnum px-1.5">
                  {pending}
                </Badge>
              ) : undefined
            }
          />
        </RailSection>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The macOS window's traffic lights land here, and the rest of the strip
          is the window's drag handle. Zero-height in a browser tab — see
          `.titlebar-strip` in globals.css. */}
      <div className="titlebar-strip" aria-hidden />
      <div className={collapsed ? "px-2" : "px-3"}>
        <BrandMark
          fixture={health.data?.fixture ?? false}
          collapsed={collapsed}
        />
        <div className="pb-3">
          <ComposeButton
            disabled={list.length === 0}
            collapsed={collapsed}
            onClick={() => app.openCompose({ account: list[0]?.alias })}
          />
        </div>
      </div>

      <div
        className={`pane-scroll min-h-0 flex-1 space-y-5 overflow-y-auto pb-4 ${
          collapsed ? "px-2" : "px-3"
        }`}
      >
        {collapsed ? (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={
                      pending > 0
                        ? `Views and folders, ${pending} waiting for approval`
                        : "Views and folders"
                    }
                    className="relative w-full"
                  >
                    <Inbox className="size-4" strokeWidth={1.5} />
                    {/* The collapsed rail has no room for the Outreach row, so
                        the count it carries becomes a dot on the control that
                        opens it. The number itself is one click away, and the
                        accessible name above already says it. */}
                    {pending > 0 && (
                      <StatusDot
                        tone="accent"
                        className="absolute top-1.5 right-1.5"
                      />
                    )}
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">Views and folders</TooltipContent>
            </Tooltip>
            <PopoverContent side="right" align="start" className="w-56 p-1.5">
              <div className="space-y-3">{viewsAndFolders}</div>
            </PopoverContent>
          </Popover>
        ) : (
          viewsAndFolders
        )}

        {/* Folded by default at full width: mailboxes are set up once and then
            read as provenance. The icon rail has no headers to fold, so there
            the rows are simply the section. */}
        {collapsed ? (
          <div className="space-y-px">
            {list.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                health={healthFor(account)}
                selected={app.account === account.alias}
                compact={app.density === "compact"}
                collapsed
                onSelect={(alias) =>
                  app.setAccount(app.account === alias ? "all" : alias)
                }
              />
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Connect a mailbox"
                  className="w-full"
                  onClick={() => app.openDialog("connect")}
                >
                  <Plus className="size-4" strokeWidth={1.5} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Connect a mailbox</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <RailSection
            id="mailboxes"
            label="Mailboxes"
            open={isOpen("mailboxes")}
            onToggle={() => toggle("mailboxes")}
            summary={foldedCount(list.length)}
            action={
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Connect a mailbox"
                    onClick={() => app.openDialog("connect")}
                  >
                    <Plus className="size-3.5" strokeWidth={1.5} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Connect a mailbox</TooltipContent>
              </Tooltip>
            }
          >
            {accounts.isPending && (
              <p className="px-2 py-1 text-[12px] text-fg-tertiary">Loading…</p>
            )}

            {!accounts.isPending && list.length === 0 && (
              <p className="px-2 py-1 text-[12px] leading-4 text-fg-tertiary">
                No mailboxes yet.
              </p>
            )}

            {list.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                health={healthFor(account)}
                selected={app.account === account.alias}
                compact={app.density === "compact"}
                onSelect={(alias) =>
                  app.setAccount(app.account === alias ? "all" : alias)
                }
              />
            ))}
          </RailSection>
        )}

        {collapsed ? (
          <AgentsSection
            collapsed
            onOpenAgentConnect={() => app.openDialog("agent")}
            onOpenCapabilities={() => app.openDialog("capabilities")}
          />
        ) : (
          <RailSection
            id="agents"
            label="Agents"
            open={isOpen("agents")}
            onToggle={() => toggle("agents")}
            summary={
              agent.presence.launchedAgent ? (
                <StatusDot tone="accent" className="mr-1.5" />
              ) : undefined
            }
          >
            <AgentsSection
              hideLabel
              onOpenAgentConnect={() => app.openDialog("agent")}
              onOpenCapabilities={() => app.openDialog("capabilities")}
            />
          </RailSection>
        )}
      </div>

      {/* Outside the scroll area, above the footer: an update is worth seeing
          without scrolling to it, and it must not push the mailbox list
          around when it arrives mid-session. */}
      <UpdateCard collapsed={collapsed} />

      <RailFooter
        connection={connection}
        partial={partial}
        density={app.density}
        collapsed={collapsed}
        gPending={gPending}
        onOpenSettings={() => app.openSettings()}
        onToggleDensity={app.toggleDensity}
      />
    </div>
  );
}

"use client";

import * as React from "react";
import { FilePen, Inbox, MailOpen, Plus } from "lucide-react";
import { AccountRow, type AccountHealth } from "@/components/rail/account-row";
import { AgentsSection } from "@/components/rail/agents-section";
import { BrandMark } from "@/components/rail/brand-mark";
import { ComposeButton } from "@/components/rail/compose-button";
import { FolderList } from "@/components/rail/folder-list";
import { NavItem } from "@/components/rail/nav-item";
import { RailFooter } from "@/components/rail/rail-footer";
import { SectionLabel } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useConnection } from "@/lib/hooks/use-connection";
import { useHealth } from "@/lib/hooks/use-health";
import { useMessages } from "@/lib/hooks/use-messages";
import { useSettings } from "@/lib/hooks/use-settings";
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
  const settings = useSettings();
  const accounts = useAccounts();
  const health = useHealth();
  const connection = useConnection();
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

  const viewsAndFolders = (
    <>
      <div className="space-y-px">
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
      </div>

      <FolderList
        accountRef={app.account}
        activeFolder={app.folder}
        disabled={app.view === "drafts"}
        onSelect={(path) => {
          app.setView("mail");
          app.setFolder(path);
        }}
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
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
                    aria-label="Views and folders"
                    className="w-full"
                  >
                    <Inbox className="size-4" strokeWidth={1.5} />
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

        <div className="space-y-px">
          {!collapsed && (
            <SectionLabel
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
              Mailboxes
            </SectionLabel>
          )}

          {accounts.isPending && !collapsed && (
            <p className="px-2 py-1 text-[12px] text-fg-tertiary">Loading…</p>
          )}

          {!accounts.isPending && list.length === 0 && !collapsed && (
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
              collapsed={collapsed}
              onSelect={(alias) =>
                app.setAccount(app.account === alias ? "all" : alias)
              }
            />
          ))}

          {collapsed && (
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
          )}
        </div>

        <AgentsSection
          collapsed={collapsed}
          onOpenAgentConnect={() => app.openDialog("agent")}
          onOpenCapabilities={() => app.openDialog("capabilities")}
        />
      </div>

      <RailFooter
        connection={connection}
        partial={partial}
        baseUrl={settings.baseUrl}
        density={app.density}
        collapsed={collapsed}
        gPending={gPending}
        onOpenSettings={() => app.openSettings()}
        onToggleDensity={app.toggleDensity}
      />
    </div>
  );
}

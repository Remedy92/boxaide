"use client";

import * as React from "react";
import { CapabilitiesDialog } from "@/components/dialogs/capabilities-dialog";
import { CommandPalette } from "@/components/dialogs/command-palette";
import { ComposeDialog } from "@/components/dialogs/compose-dialog";
import { ConnectMailboxDialog } from "@/components/dialogs/connect-mailbox-dialog";
import { RemoveAccountDialog } from "@/components/dialogs/remove-account-dialog";
import { SettingsDialog } from "@/components/dialogs/settings-dialog";
import { ShortcutsDialog } from "@/components/dialogs/shortcuts-dialog";
import { MessageList } from "@/components/list/message-list";
import { LeftRail } from "@/components/rail/left-rail";
import { RailSheet } from "@/components/rail/rail-sheet";
import { Reader } from "@/components/reader/reader";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { AppStateProvider, useApp } from "@/lib/hooks/use-app-state";
import { useKeyboard } from "@/lib/hooks/use-keyboard";
import { useMarkRead } from "@/lib/hooks/use-mark-read";
import {
  useMessageNavigation,
  useSelectionEffects,
} from "@/lib/hooks/use-selection";

export function AppShell() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}

/**
 * §5.1 / §6.1. One CSS grid, never nested flex, so a width change is a single
 * custom-property write with no layout thrash. Tab moves between panes — one
 * stop each — and arrow keys move within.
 */
function Shell() {
  const app = useApp();
  const accounts = useAccounts();
  const nav = useMessageNavigation();
  const markRead = useMarkRead();

  // Mounted here and nowhere else: prefetch-below and the debounced mark-read.
  useSelectionEffects();

  const list = accounts.data ?? [];
  const overlayOpen = app.dialog !== null || app.removalTarget !== null;

  const { gPending } = useKeyboard(
    {
      next: nav.next,
      previous: nav.previous,
      open: () => {
        if (nav.index < 0) nav.selectAt(0);
        document.getElementById("mailmux-reader")?.focus();
      },
      escape: () => {
        if (app.clearSearch()) return;
        // The expanded rail overlay is hand-rolled, not a Radix layer, so
        // nothing else would dismiss it on Escape.
        if (app.railOverlay) {
          app.setRailOverlay(false);
          return;
        }
        if (app.railSheetOpen) {
          app.setRailSheetOpen(false);
          return;
        }
        if (!app.selected) return;
        // §9: on desktop Esc moves focus from the reader back to the list and
        // leaves the selection alone. Only the one-pane layout, where the
        // reader replaced the list, actually goes back.
        if (app.narrow) {
          app.clearSelection();
          return;
        }
        const row = document.querySelector<HTMLElement>(
          '[role="option"][aria-selected="true"]',
        );
        row?.focus();
      },
      toggleRead: () => {
        const current = nav.current;
        if (!current) return;
        markRead.mutate({
          accountId: current.accountId,
          messageId: current.id,
          seen: !current.seen,
        });
      },
      reply: () => app.requestReply("reply"),
      replyAll: () => app.requestReply("replyAll"),
      forward: () => app.requestReply("forward"),
      compose: () => {
        if (list.length === 0) return;
        app.openCompose({ account: list[0]?.alias });
      },
      focusSearch: app.focusSearch,
      commandPalette: () => app.openPalette(),
      shortcuts: () => app.openDialog("shortcuts"),
      goInbox: () => {
        app.setAccount("all");
        app.setUnreadOnly(false);
      },
      goUnread: () => app.setUnreadOnly(true),
      goAccount: (index) => {
        const account = list[index];
        if (account) app.setAccount(account.alias);
      },
      goFolder: () => {
        if (app.account === "all") return;
        app.openPalette("folders");
      },
      toggleRail: app.toggleRail,
      scrollReader: (direction) => {
        const pane = document.getElementById("mailmux-reader");
        if (!pane) return;
        pane.scrollBy({
          top: direction * (pane.clientHeight * 0.85),
          behavior: app.reducedMotion ? "auto" : "smooth",
        });
      },
    },
    { suspended: overlayOpen },
  );

  const collapsedRail = app.medium || app.railCollapsed;
  const showReaderOnly = app.narrow && app.selected !== null;
  /** Narrow with nothing open: the reader is not rendered, so the list is the page. */
  const listIsMain = app.narrow && !showReaderOnly;

  return (
    <div
      className="shell"
      data-density={app.density}
      data-rail={collapsedRail ? "collapsed" : "expanded"}
      data-narrow={app.narrow ? "true" : "false"}
      style={
        app.narrow
          ? ({ gridTemplateColumns: "minmax(0, 1fr)" } as React.CSSProperties)
          : undefined
      }
    >
      {/* The reader's subject is the only <h1> in the app and it exists only
          while a message is open, so without this the first-run page would
          start its heading outline at <h2>. */}
      <h1 className="sr-only">mailmux</h1>

      {!app.narrow && (
        <nav
          aria-label="Mailboxes and folders"
          className="relative h-full min-h-0 border-r border-border-subtle bg-surface-0"
        >
          {/* At the medium breakpoint `[` expands the rail as an overlay above
              the list rather than pushing it. The collapsed copy is NOT left
              mounted underneath: every one of its controls would stay in the
              tab order behind an opaque scrim (2.4.11). */}
          {app.railOverlay ? (
            <>
              <button
                type="button"
                aria-label="Close the expanded sidebar"
                className="fixed inset-0 z-30 cursor-default"
                onClick={() => app.setRailOverlay(false)}
              />
              <div className="absolute top-0 left-0 z-40 h-full w-[240px] border-r border-border-subtle bg-surface-0 shadow-[var(--shadow-overlay)]">
                <LeftRail gPending={gPending} />
              </div>
            </>
          ) : (
            <LeftRail collapsed={collapsedRail} gPending={gPending} />
          )}
        </nav>
      )}

      {/* There is a <main> at every width. The landmark moves rather than
          disappearing: below 760px with nothing open the list IS the page, so
          it carries it. Gating <main> on a selection left the default narrow
          layout with no main landmark at all. */}
      {(!app.narrow || !showReaderOnly) &&
        (listIsMain ? (
          <main
            aria-label="Messages"
            tabIndex={-1}
            className="h-full min-h-0 border-r border-border-subtle bg-surface-1"
          >
            <MessageList
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          </main>
        ) : (
          <div
            role="region"
            aria-label="Message list"
            className="h-full min-h-0 border-r border-border-subtle bg-surface-1"
          >
            <MessageList
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          </div>
        ))}

      {(!app.narrow || showReaderOnly) && (
        <main
          aria-label="Message"
          tabIndex={-1}
          className={`h-full min-h-0 bg-surface-2 ${
            showReaderOnly && !app.reducedMotion ? "mailmux-slide-in" : ""
          }`}
        >
          <Reader />
        </main>
      )}

      {app.narrow && (
        <RailSheet
          open={app.railSheetOpen}
          onOpenChange={app.setRailSheetOpen}
        />
      )}

      <ConnectMailboxDialog
        open={app.dialog === "connect"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <ComposeDialog
        open={app.dialog === "compose"}
        seed={app.composeSeed}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <SettingsDialog
        open={app.dialog === "settings"}
        focus={app.settingsFocus}
        autoTest={app.settingsAutoTest}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <ShortcutsDialog
        open={app.dialog === "shortcuts"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <CapabilitiesDialog
        open={app.dialog === "capabilities"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <CommandPalette
        open={app.dialog === "palette"}
        initialPage={app.palettePage}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <RemoveAccountDialog />
    </div>
  );
}

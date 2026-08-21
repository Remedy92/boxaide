"use client";

import * as React from "react";
import { AgentView } from "@/components/agent/agent-view";
import { AutomationsView } from "@/components/automations/automations-view";
import { CalendarView } from "@/components/calendar/calendar-view";
import { AgentConnectDialog } from "@/components/dialogs/agent-connect-dialog";
import { CapabilitiesDialog } from "@/components/dialogs/capabilities-dialog";
import { ChatsDialog } from "@/components/dialogs/chats-dialog";
import { CommandPalette } from "@/components/dialogs/command-palette";
import { ComposeDialog } from "@/components/dialogs/compose-dialog";
import { ConnectMailboxDialog } from "@/components/dialogs/connect-mailbox-dialog";
import { ContactPane } from "@/components/crm/contact-pane";
import { PeopleList } from "@/components/crm/people-list";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { RemoveAccountDialog } from "@/components/dialogs/remove-account-dialog";
import { ShortcutsDialog } from "@/components/dialogs/shortcuts-dialog";
import { DraftEditor } from "@/components/drafts/draft-editor";
import { DraftsList } from "@/components/drafts/drafts-list";
import { MessageList } from "@/components/list/message-list";
import { OutboxPane } from "@/components/outreach/outbox-pane";
import { OutreachList } from "@/components/outreach/outreach-list";
import { SetupWizard } from "@/components/onboarding/setup-wizard";
import { LeftRail } from "@/components/rail/left-rail";
import { SettingsView } from "@/components/settings/settings-view";
import { RailSheet } from "@/components/rail/rail-sheet";
import { Reader } from "@/components/reader/reader";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { AgentProvider } from "@/lib/hooks/use-agent";
import { AppStateProvider, useApp } from "@/lib/hooks/use-app-state";
import { useArchive } from "@/lib/hooks/use-archive";
import { useCrmContacts } from "@/lib/hooks/use-crm-contacts";
import { useDrafts } from "@/lib/hooks/use-drafts";
import { useKeyboard } from "@/lib/hooks/use-keyboard";
import { useMarkRead } from "@/lib/hooks/use-mark-read";
import { useOutbox } from "@/lib/hooks/use-outreach";
import {
  useMessageNavigation,
  useSelectionEffects,
} from "@/lib/hooks/use-selection";

export function AppShell() {
  return (
    <AppStateProvider>
      {/* Above the shell, so the conversation stream stays open across view
          changes: an answer that lands while the user is reading mail has to be
          there when they switch back, and the sidebar dot has to stay honest. */}
      <AgentProvider>
        <Shell />
      </AgentProvider>
    </AppStateProvider>
  );
}

/**
 * One CSS grid, never nested flex, so a width change is a single custom
 * property write with no layout thrash. Tab moves between panes — one stop
 * each — and arrow keys move within.
 *
 * The middle column carries the message list, the Drafts list or the People
 * list, and the right column the matching pane. They are siblings rather than
 * modes: each comes from its own endpoint and has its own id space.
 */
function Shell() {
  const app = useApp();
  const accounts = useAccounts();
  const nav = useMessageNavigation();
  const markRead = useMarkRead();
  const archive = useArchive();
  const inMail = app.view === "mail";
  const drafting = app.view === "drafts";
  const peopling = app.view === "people";
  const outreaching = app.view === "outreach";
  /** No list column at all — one pane is the whole workspace at every width. */
  const conversing = app.view === "agent";
  const boarding = app.view === "pipeline";
  const automating = app.view === "automations";
  /** One column too: an agenda is a single list, not a list and a pane. */
  const calendaring = app.view === "calendar";
  /* Settings is a page like the others, with its own sidebar inside the pane —
     so it takes the whole workspace and the shell drops to two tracks. */
  const settingsOpen = app.view === "settings";
  const singlePane =
    conversing || boarding || automating || calendaring || settingsOpen;
  const drafts = useDrafts(app.account, drafting);
  /* The same query the People list issues, so j / k walk exactly the rows on
     screen. React Query dedupes it — one request, two readers. */
  const people = useCrmContacts({
    query: app.peopleQuery,
    tag: app.peopleTag ?? undefined,
    enabled: peopling,
  });
  /* Same arrangement for the approval queue: the list column issues this query
     and React Query dedupes it, so j / k walk exactly the rows on screen. Only
     while the Queue tab is up — suppression is not a selection. */
  const outboxQueue = useOutbox(
    "pending",
    outreaching && app.outreachTab === "queue",
  );

  // Mounted here and nowhere else: prefetch-below and the debounced mark-read.
  useSelectionEffects();

  const list = accounts.data ?? [];
  const overlayOpen =
    app.dialog !== null || app.removalTarget !== null || app.wizardOpen;

  /* j / k in the Drafts view walk drafts, not messages. Same keys, same
     ordering, different collection — the alternative is a dead keyboard on
     half the product. */
  const draftRows = drafts.drafts;
  const draftIndex = app.selectedDraft
    ? draftRows.findIndex((row) => row.id === app.selectedDraft?.draftId)
    : -1;
  const selectDraftAt = React.useCallback(
    (index: number) => {
      const row = draftRows[index];
      if (!row) return;
      app.selectDraft({ accountId: row.accountId, draftId: row.id });
    },
    [app, draftRows],
  );

  /* And in People they walk contacts. Same keys, same ordering, third
     collection — see the note above. */
  const contactRows = React.useMemo(() => people.data ?? [], [people.data]);
  const contactIndex = app.selectedContact
    ? contactRows.findIndex((row) => row.id === app.selectedContact)
    : -1;
  const selectContactAt = React.useCallback(
    (index: number) => {
      const row = contactRows[index];
      if (!row) return;
      app.selectContact(row.id);
    },
    [app, contactRows],
  );

  /* And in Outreach they walk the queue. Fourth collection, same keys — see the
     note above the drafts rows. */
  const queueRows = React.useMemo(
    () => outboxQueue.data ?? [],
    [outboxQueue.data],
  );
  const queueIndex = app.selectedOutbox
    ? queueRows.findIndex((row) => row.id === app.selectedOutbox)
    : -1;
  const selectOutboxAt = React.useCallback(
    (index: number) => {
      const row = queueRows[index];
      if (!row) return;
      app.selectOutbox(row.id);
    },
    [app, queueRows],
  );

  const { gPending } = useKeyboard(
    {
      next: () => {
        if (singlePane) return;
        if (drafting) {
          if (draftRows.length === 0) return;
          selectDraftAt(
            draftIndex < 0 ? 0 : Math.min(draftIndex + 1, draftRows.length - 1),
          );
          return;
        }
        if (peopling) {
          if (contactRows.length === 0) return;
          selectContactAt(
            contactIndex < 0
              ? 0
              : Math.min(contactIndex + 1, contactRows.length - 1),
          );
          return;
        }
        if (outreaching) {
          if (queueRows.length === 0) return;
          selectOutboxAt(
            queueIndex < 0 ? 0 : Math.min(queueIndex + 1, queueRows.length - 1),
          );
          return;
        }
        nav.next();
      },
      previous: () => {
        if (singlePane) return;
        if (drafting) {
          if (draftRows.length === 0) return;
          selectDraftAt(draftIndex <= 0 ? 0 : draftIndex - 1);
          return;
        }
        if (peopling) {
          if (contactRows.length === 0) return;
          selectContactAt(contactIndex <= 0 ? 0 : contactIndex - 1);
          return;
        }
        if (outreaching) {
          if (queueRows.length === 0) return;
          selectOutboxAt(queueIndex <= 0 ? 0 : queueIndex - 1);
          return;
        }
        nav.previous();
      },
      open: () => {
        if (singlePane) return;
        if (drafting) {
          if (draftIndex < 0) selectDraftAt(0);
          return;
        }
        if (peopling) {
          if (contactIndex < 0) selectContactAt(0);
          return;
        }
        if (outreaching) {
          if (queueIndex < 0) selectOutboxAt(0);
          return;
        }
        if (nav.index < 0) nav.selectAt(0);
        document.getElementById("mailmux-reader")?.focus();
      },
      escape: () => {
        if (app.clearSearch()) return;
        // Settings is a page, so Escape leaves it the way the close button
        // does — back to the view it was opened over.
        if (settingsOpen) {
          app.closeSettings();
          return;
        }
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
        /* Same rule as mail, over the contact pane: narrow goes back to the
           list, wide moves focus to the selected row and keeps the pane. */
        if (peopling) {
          if (!app.selectedContact) return;
          if (app.narrow) {
            app.selectContact(null);
            return;
          }
          document
            .querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
            ?.focus();
          return;
        }
        /* Same rule over the approval pane. */
        if (outreaching) {
          if (!app.selectedOutbox) return;
          if (app.narrow) {
            app.selectOutbox(null);
            return;
          }
          document
            .querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
            ?.focus();
          return;
        }
        if (!app.selected && !app.selectedDraft) return;
        // On desktop Esc moves focus from the reading pane back to the list and
        // leaves the selection alone. Only the one-pane layout, where the pane
        // replaced the list, actually goes back.
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
        if (!inMail) return;
        const current = nav.current;
        if (!current) return;
        markRead.mutate({
          accountId: current.accountId,
          messageId: current.id,
          seen: !current.seen,
        });
      },
      archive: () => {
        if (!inMail) return;
        // The selection, not nav.current. They differ whenever the open
        // message has dropped out of the visible list — the unread filter
        // refetching after the message was auto-marked read is the everyday
        // way that happens — and the reader still shows it, with a working
        // Archive button. `e` has to archive the message on screen, or it is
        // a dead key with nothing to explain itself.
        const current = nav.current ?? app.selected;
        if (!current) return;
        archive.mutate({
          accountId: current.accountId,
          messageId: "id" in current ? current.id : current.messageId,
        });
      },
      reply: () => (inMail ? app.requestReply("reply") : undefined),
      replyAll: () => (inMail ? app.requestReply("replyAll") : undefined),
      forward: () => (inMail ? app.requestReply("forward") : undefined),
      compose: () => {
        if (list.length === 0) return;
        app.openCompose({ account: list[0]?.alias });
      },
      focusSearch: app.focusSearch,
      commandPalette: () => app.openPalette(),
      shortcuts: () => app.openDialog("shortcuts"),
      settings: () => app.openSettings(),
      goAgent: () => app.setView("agent"),
      goInbox: () => {
        app.setView("mail");
        app.setAccount("all");
        app.setUnreadOnly(false);
      },
      goUnread: () => {
        app.setView("mail");
        app.setUnreadOnly(true);
      },
      goDrafts: () => app.setView("drafts"),
      goAccount: (index) => {
        const account = list[index];
        if (account) app.setAccount(account.alias);
      },
      goFolder: () => {
        if (app.account === "all" || !inMail) return;
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
  const openItem = drafting
    ? app.selectedDraft !== null
    : peopling
      ? app.selectedContact !== null
      : outreaching
        ? app.selectedOutbox !== null
        : app.selected !== null;
  const showPaneOnly = !singlePane && app.narrow && openItem;
  /** Narrow with nothing open: the reading pane is not rendered, so the list is the page. */
  const listIsMain = app.narrow && !showPaneOnly;

  /** The label the list column and its pane carry, per collection. */
  const listLabel = drafting
    ? "Drafts"
    : peopling
      ? "People"
      : outreaching
        ? "Outreach"
        : "Messages";
  const paneLabel = drafting
    ? "Draft"
    : peopling
      ? "Contact"
      : outreaching
        ? "Queued email"
        : "Message";

  const listPane = drafting ? (
    <DraftsList
      onOpenRail={() => app.setRailSheetOpen(true)}
      showRailButton={app.narrow}
    />
  ) : peopling ? (
    <PeopleList
      onOpenRail={() => app.setRailSheetOpen(true)}
      showRailButton={app.narrow}
    />
  ) : outreaching ? (
    <OutreachList
      onOpenRail={() => app.setRailSheetOpen(true)}
      showRailButton={app.narrow}
    />
  ) : (
    <MessageList
      onOpenRail={() => app.setRailSheetOpen(true)}
      showRailButton={app.narrow}
    />
  );

  return (
    <div
      className="shell"
      data-density={app.density}
      data-rail={collapsedRail ? "collapsed" : "expanded"}
      data-narrow={app.narrow ? "true" : "false"}
      /* The Agent and Pipeline views have no list column, so the grid drops to
         two tracks. Driven by a data attribute rather than an inline style so
         the media queries in globals.css can still override it at the
         breakpoints; every other view falls through to the three-track rule. */
      data-view={app.view}
      style={
        app.narrow
          ? ({ gridTemplateColumns: "minmax(0, 1fr)" } as React.CSSProperties)
          : undefined
      }
    >
      {/* The reader's subject is the only <h1> in the mail view and it exists
          only while a message is open, so without this the first-run page would
          start its heading outline at <h2>. */}
      <h1 className="sr-only">Boxaide</h1>

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
              <div className="absolute top-0 left-0 z-40 h-full w-[228px] border-r border-border-subtle bg-surface-0 shadow-[var(--shadow-overlay)]">
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
          it carries it. In the Agent view the conversation is the only pane and
          carries it at every width. */}
      {singlePane ? (
        <main
          aria-label={
            conversing
              ? "Agent conversation"
              : automating
                ? "Automations"
                : calendaring
                  ? "Calendar"
                  : settingsOpen
                    ? "Settings"
                    : "Pipeline"
          }
          tabIndex={-1}
          className="h-full min-h-0 bg-surface-2"
        >
          {settingsOpen ? (
            <SettingsView
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          ) : conversing ? (
            <AgentView
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          ) : automating ? (
            <AutomationsView
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          ) : calendaring ? (
            <CalendarView
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          ) : (
            <PipelineBoard
              onOpenRail={() => app.setRailSheetOpen(true)}
              showRailButton={app.narrow}
            />
          )}
        </main>
      ) : (
        <>
          {(!app.narrow || !showPaneOnly) &&
            (listIsMain ? (
              <main
                aria-label={listLabel}
                tabIndex={-1}
                className="h-full min-h-0 border-r border-border-subtle bg-surface-1"
              >
                {listPane}
              </main>
            ) : (
              <div
                role="region"
                aria-label={`${paneLabel} list`}
                className="h-full min-h-0 border-r border-border-subtle bg-surface-1"
              >
                {listPane}
              </div>
            ))}

          {(!app.narrow || showPaneOnly) && (
            <main
              aria-label={paneLabel}
              tabIndex={-1}
              className={`h-full min-h-0 bg-surface-2 ${
                showPaneOnly && !app.reducedMotion ? "mailmux-slide-in" : ""
              }`}
            >
              {drafting ? (
                <DraftEditor />
              ) : peopling ? (
                <ContactPane />
              ) : outreaching ? (
                <OutboxPane />
              ) : (
                <Reader />
              )}
            </main>
          )}
        </>
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
      <ShortcutsDialog
        open={app.dialog === "shortcuts"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <CapabilitiesDialog
        open={app.dialog === "capabilities"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <ChatsDialog
        open={app.dialog === "chats"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <AgentConnectDialog
        open={app.dialog === "agent"}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <CommandPalette
        open={app.dialog === "palette"}
        initialPage={app.palettePage}
        onOpenChange={(open) => (open ? undefined : app.closeDialog())}
      />
      <RemoveAccountDialog />

      {/* Last, and above everything: with no token there is no mail behind it. */}
      {app.wizardOpen && <SetupWizard />}
    </div>
  );
}

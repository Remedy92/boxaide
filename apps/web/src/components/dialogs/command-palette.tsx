"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  CalendarDays,
  ChevronRight,
  Columns3,
  Copy,
  Folder,
  Inbox,
  Mail,
  MailOpen,
  PenLine,
  Plug,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Rows3,
  Search,
  Send,
  Server,
  Settings2,
  Sparkle,
  SunMoon,
  Timer,
  Trash2,
  Users,
  FilePen,
  Forward as ForwardIcon,
  Keyboard,
  PanelLeft,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Kbd } from "@/components/atoms";
import { friendlyError } from "@/lib/api/errors";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DialogBody } from "@/components/ui/dialog";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApp } from "@/lib/hooks/use-app-state";
import { useFolders } from "@/lib/hooks/use-folders";
import { useMarkRead } from "@/lib/hooks/use-mark-read";
import { useMcpTools } from "@/lib/hooks/use-mcp-tools";
import { useMessageNavigation } from "@/lib/hooks/use-selection";
import { useSettings } from "@/lib/hooks/use-settings";
import { genericMcpSnippet } from "@/lib/agent-config";
import { rememberCommand } from "@/lib/settings";
import { copyToClipboard } from "@/lib/utils";

type Page = "root" | "folders" | "remove";

/**
 * §6.8. Every command is backed by a real call. There is no Archive, Delete,
 * Snooze, Label, Move, Star or Undo row, because there is no endpoint behind
 * any of them.
 */
export function CommandPalette({
  open,
  initialPage = "root",
  onOpenChange,
}: {
  open: boolean;
  /** `g f` opens straight on the folder page rather than the root list. */
  initialPage?: "root" | "folders";
  onOpenChange: (open: boolean) => void;
}) {
  // cmdk's CommandDialog renders its sr-only title and description outside the
  // Dialog, so a closed palette would otherwise leave a stray heading in the
  // accessibility tree on every screen.
  if (!open) return null;
  return <Palette initialPage={initialPage} onOpenChange={onOpenChange} />;
}

function Palette({
  initialPage,
  onOpenChange,
}: {
  initialPage: "root" | "folders";
  onOpenChange: (open: boolean) => void;
}) {
  const app = useApp();
  const settings = useSettings();
  const accounts = useAccounts();
  const folders = useFolders(app.account);
  const nav = useMessageNavigation();
  const markRead = useMarkRead();
  const mcp = useMcpTools();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [page, setPage] = React.useState<Page>(initialPage);
  const [search, setSearch] = React.useState("");

  /* A sub-page swaps the whole list in place. Only the input's placeholder
     changes, and a placeholder is not announced on an already-focused input,
     so the move is otherwise silent (4.1.3). */
  const pageTitle =
    page === "folders"
      ? `Folders in ${app.account}`
      : page === "remove"
        ? "Pick a mailbox to remove"
        : "All commands";

  const goToPage = (next: Page) => {
    setSearch("");
    setPage(next);
  };

  const list = accounts.data ?? [];
  const selected = nav.current ?? null;

  /** Closing always resets the page and the query — no effect needed. */
  const close = (next: boolean) => {
    if (!next) {
      setPage("root");
      setSearch("");
    }
    onOpenChange(next);
  };

  const run = (id: string, action: () => void) => {
    rememberCommand(id, settings.recentCommands);
    close(false);
    action();
  };

  const snippet = genericMcpSnippet({
    baseUrl: settings.baseUrl,
    token: settings.token,
  });

  const commands: Array<{
    id: string;
    group: string;
    label: string;
    icon: React.ReactNode;
    hint?: string;
    disabled?: boolean;
    reason?: string;
    action: () => void;
  }> = [
    {
      id: "compose",
      group: "Mail",
      label: "Compose",
      icon: <PenLine />,
      hint: "c",
      disabled: list.length === 0,
      reason: "Connect a mailbox first",
      action: () => app.openCompose({ account: list[0]?.alias }),
    },
    {
      id: "reply",
      group: "Mail",
      label: "Reply",
      icon: <Reply />,
      hint: "r",
      disabled: !selected,
      reason: "Open a message first",
      action: () => app.requestReply("reply"),
    },
    {
      id: "reply-all",
      group: "Mail",
      label: "Reply all",
      icon: <ReplyAll />,
      hint: "a",
      disabled: !selected,
      reason: "Open a message first",
      action: () => app.requestReply("replyAll"),
    },
    {
      id: "forward",
      group: "Mail",
      label: "Forward",
      icon: <ForwardIcon />,
      hint: "f",
      disabled: !selected,
      reason: "Open a message first",
      action: () => app.requestReply("forward"),
    },
    {
      id: "toggle-read",
      group: "Mail",
      label: selected?.seen ? "Mark unread" : "Mark read",
      icon: selected?.seen ? <Mail /> : <MailOpen />,
      hint: "u",
      disabled: !selected,
      reason: "Open a message first",
      action: () => {
        if (!selected) return;
        markRead.mutate({
          accountId: selected.accountId,
          messageId: selected.id,
          seen: !selected.seen,
        });
      },
    },
    {
      id: "refresh",
      group: "Mail",
      label: "Refresh list",
      icon: <RefreshCw />,
      action: () => void queryClient.invalidateQueries({ queryKey: ["messages"] }),
    },

    {
      id: "go-agent",
      group: "Go to",
      label: "Agent conversation",
      icon: <Sparkle />,
      hint: "g a",
      action: () => app.setView("agent"),
    },
    {
      id: "go-inbox",
      group: "Go to",
      label: "Inbox (all mailboxes)",
      icon: <Inbox />,
      hint: "g i",
      action: () => {
        app.setView("mail");
        app.setAccount("all");
        app.setUnreadOnly(false);
      },
    },
    {
      id: "go-unread",
      group: "Go to",
      label: "Unread only",
      icon: <MailOpen />,
      hint: "g u",
      action: () => {
        app.setView("mail");
        app.setUnreadOnly(true);
      },
    },
    {
      id: "go-drafts",
      group: "Go to",
      label: "Drafts",
      icon: <FilePen />,
      hint: "g d",
      action: () => app.setView("drafts"),
    },
    /* No `hint`: Calendar has no `g` chord, and inventing one here would put a
       key in the palette that does nothing when pressed. Same rule as People
       and Pipeline below. */
    {
      id: "go-calendar",
      group: "Go to",
      label: "Calendar",
      icon: <CalendarDays />,
      action: () => app.setView("calendar"),
    },
    {
      id: "go-automations",
      group: "Go to",
      label: "Automations",
      icon: <Timer />,
      action: () => app.setView("automations"),
    },
    /* The CRM rows, and only where there is a CRM. Listing them disabled would
       advertise the thing the workspace setting was chosen to remove, and
       listing them enabled would offer a view setView now refuses.

       No `hint`: People and Pipeline have no `g` chord. The shortcuts sheet is
       the one list of those, and inventing a binding here would put a key in
       the palette that does nothing when pressed. */
    ...(app.crm
      ? [
          {
            id: "go-people",
            group: "Go to",
            label: "People",
            icon: <Users />,
            action: () => app.setView("people"),
          },
          {
            id: "go-pipeline",
            group: "Go to",
            label: "Pipeline",
            icon: <Columns3 />,
            action: () => app.setView("pipeline"),
          },
          {
            id: "go-outreach",
            group: "Go to",
            label: "Outreach",
            icon: <Send />,
            action: () => app.setView("outreach"),
          },
        ]
      : []),
    ...list.map((account, index) => ({
      id: `go-account-${account.id}`,
      group: "Go to",
      label: `Go to ${account.alias}`,
      icon: <Inbox />,
      hint: index < 9 ? `g ${index + 1}` : undefined,
      action: () => app.setAccount(account.alias),
    })),

    {
      id: "connect",
      group: "Mailboxes",
      label: "Connect a mailbox…",
      icon: <Plus />,
      action: () => app.openDialog("connect"),
    },

    {
      id: "settings",
      group: "Server",
      label: "Open settings",
      icon: <Settings2 />,
      hint: "⌘ ,",
      action: () => app.openSettings(),
    },
    {
      id: "updates",
      group: "Server",
      label: "Check for updates",
      icon: <ArrowUpCircle />,
      // The page runs the check as it mounts, so the row does what it says.
      action: () => app.openSettingsSection("updates"),
    },
    {
      id: "set-base-url",
      group: "Server",
      label: "Set server URL",
      icon: <Server />,
      action: () => app.openSettings("baseUrl"),
    },
    {
      id: "set-token",
      group: "Server",
      label: "Set access token",
      icon: <Server />,
      action: () => app.openSettings("token"),
    },
    {
      id: "test-connection",
      group: "Server",
      label: "Test connection",
      icon: <Server />,
      // Opens settings AND runs the /health → /api/health → /api/meta probe, so
      // the row does what it says instead of only navigating to the button.
      action: () => app.openSettings(null, true),
    },
    {
      id: "connect-agent",
      group: "Server",
      label: "Connect your agent…",
      icon: <Plug />,
      action: () => app.openDialog("agent"),
    },
    {
      id: "run-setup",
      group: "Server",
      label: "Run setup again",
      icon: <Server />,
      action: app.openWizard,
    },
    {
      id: "copy-mcp",
      group: "Server",
      label: "Copy MCP configuration",
      icon: <Copy />,
      action: () => {
        void copyToClipboard(snippet).then((ok) =>
          toast[ok ? "success" : "warning"](
            ok ? "Copied MCP configuration" : "Press ⌘C to copy",
          ),
        );
      },
    },
    {
      id: "test-mcp",
      group: "Server",
      label: "Test MCP endpoint",
      icon: <Plug />,
      // The palette closes on select, so the inline result in the rail would
      // never be seen from here. The toast carries it — and says "Responded",
      // never "Connected": POST /mcp is stateless and proves nothing about an
      // agent being attached.
      action: () =>
        mcp.mutate(undefined, {
          onSuccess: (tools) =>
            toast.success(`Responded — ${tools.length} tools available`, {
              description: tools.map((tool) => tool.name).join(", "),
            }),
          onError: (error) =>
            toast.error("Did not respond", {
              description: friendlyError(
                error instanceof Error ? error.message : error,
              ),
            }),
        }),
    },

    {
      id: "toggle-theme",
      group: "View",
      label: "Toggle theme",
      icon: <SunMoon />,
      action: () => setTheme(theme === "dark" ? "light" : "dark"),
    },
    {
      id: "toggle-density",
      group: "View",
      label: "Toggle density",
      icon: <Rows3 />,
      action: app.toggleDensity,
    },
    {
      id: "toggle-rail",
      group: "View",
      label: "Toggle sidebar",
      icon: <PanelLeft />,
      hint: "[",
      action: app.toggleRail,
    },
    {
      id: "shortcuts",
      group: "View",
      label: "Keyboard shortcuts",
      icon: <Keyboard />,
      hint: "?",
      action: () => app.openDialog("shortcuts"),
    },
  ];

  const byId = new Map(commands.map((entry) => [entry.id, entry]));
  const recent = settings.recentCommands
    .map((id) => byId.get(id))
    .filter((entry): entry is (typeof commands)[number] => !!entry);

  const groups = ["Mail", "Go to", "Mailboxes", "Server", "View"];

  return (
    <CommandDialog
      open
      onOpenChange={close}
      title="Command palette"
      description="Search commands, mailboxes and folders."
      // Anchored near the top, not centred, so it owns the height cap that
      // <DialogContent> would otherwise derive from being centred: from 18vh
      // down to a margin above the window's bottom edge.
      className="top-[18vh] max-h-[calc(82dvh-1.5rem)] max-w-[600px] translate-y-0"
      showCloseButton={false}
      onKeyDown={(event) => {
        // Backspace on an empty query leaves a sub-page. Without it the only
        // way out is Escape, which closes the whole palette.
        if (event.key === "Backspace" && page !== "root" && search === "") {
          event.preventDefault();
          goToPage("root");
        }
      }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={
          page === "folders"
            ? "Search folders"
            : page === "remove"
              ? "Pick a mailbox to remove"
              : "Search commands, mailboxes, folders"
        }
      />
      <p role="status" className="sr-only">
        {pageTitle}
        {page !== "root" && ". Press Backspace to go back."}
      </p>
      {/* The list IS the dialog's scroll region: one scroller, capped by the
          dialog on a short window and by 420px on a tall one. */}
      <DialogBody asChild>
        <CommandList className="max-h-[420px] gap-0">
          <CommandEmpty>No matching command.</CommandEmpty>

          {page === "root" && (
            <>
              {search.trim().length === 0 && recent.length > 0 && (
                <CommandGroup heading="Recent">
                  {recent.map((entry) => (
                    <Row
                      key={`recent-${entry.id}`}
                      icon={entry.icon}
                      label={entry.label}
                      hint={entry.hint}
                      disabled={entry.disabled}
                      reason={entry.reason}
                      onSelect={() => run(entry.id, entry.action)}
                    />
                  ))}
                </CommandGroup>
              )}

              {search.trim().length >= 2 && (
                <CommandGroup heading="Search">
                  <Row
                    icon={<Search />}
                    label={`Search mail for “${search.trim()}”`}
                    onSelect={() =>
                      run("search-query", () => app.setRawQuery(search.trim()))
                    }
                  />
                </CommandGroup>
              )}

              {groups.map((group) => {
                const entries = commands.filter((entry) => entry.group === group);
                if (entries.length === 0) return null;
                return (
                  <CommandGroup key={group} heading={group}>
                    {entries.map((entry) => (
                      <Row
                        key={entry.id}
                        icon={entry.icon}
                        label={entry.label}
                        hint={entry.hint}
                        disabled={entry.disabled}
                        reason={entry.reason}
                        onSelect={() => run(entry.id, entry.action)}
                      />
                    ))}

                    {group === "Go to" && (
                      <Row
                        icon={<Folder />}
                        label="Go to folder"
                        trailing={<ChevronRight className="size-3.5" />}
                        disabled={app.account === "all"}
                        reason="Pick one mailbox first — folders are per mailbox."
                        onSelect={() => goToPage("folders")}
                      />
                    )}

                    {group === "Mailboxes" && list.length > 0 && (
                      <Row
                        icon={<Trash2 />}
                        label="Remove mailbox"
                        trailing={<ChevronRight className="size-3.5" />}
                        onSelect={() => goToPage("remove")}
                      />
                    )}

                    {group === "Mail" && (
                      <Row
                        icon={<Search />}
                        label="Search mail…"
                        hint="/"
                        onSelect={() => run("focus-search", app.focusSearch)}
                      />
                    )}
                  </CommandGroup>
                );
              })}
            </>
          )}

          {page === "folders" && (
            <CommandGroup heading={`Folders in ${app.account}`}>
              {(folders.data ?? []).map((folder) => (
                <Row
                  key={folder.path}
                  icon={<Folder />}
                  label={folder.name}
                  onSelect={() =>
                    run(`folder-${folder.path}`, () => app.setFolder(folder.path))
                  }
                />
              ))}
            </CommandGroup>
          )}

          {page === "remove" && (
            <CommandGroup heading="Remove a mailbox">
              {list.map((account) => (
                <Row
                  key={account.id}
                  icon={<Trash2 />}
                  label={`Remove ${account.alias}…`}
                  onSelect={() =>
                    // Opens the same confirmation the sidebar × opens — a fuzzy
                    // match never deletes a mailbox on its own.
                    run(`remove-${account.id}`, () =>
                      app.requestRemoveAccount(account),
                    )
                  }
                />
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </DialogBody>
    </CommandDialog>
  );
}

function Row({
  icon,
  label,
  hint,
  trailing,
  disabled,
  reason,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
  disabled?: boolean;
  reason?: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`${label} ${reason ?? ""}`}
      disabled={disabled}
      onSelect={onSelect}
      className="h-8 text-[13px]"
    >
      <span className="text-fg-tertiary [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {disabled && reason && (
        <span className="shrink-0 text-[12px] text-fg-tertiary">{reason}</span>
      )}
      {hint && <Kbd>{hint}</Kbd>}
      {trailing}
    </CommandItem>
  );
}

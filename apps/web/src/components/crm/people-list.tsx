"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Menu, RefreshCw, Search, Tag, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { ContactDialog, type ContactSeed } from "@/components/crm/contact-dialog";
import { ContactRow } from "@/components/crm/contact-row";
import { ConnectionStateBlock } from "@/components/list/list-empty";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useApp, usePeopleSearchQuery } from "@/lib/hooks/use-app-state";
import { useConnection, useMeta } from "@/lib/hooks/use-connection";
import { useCrmContacts } from "@/lib/hooks/use-crm-contacts";
import { useCrmSync } from "@/lib/hooks/use-crm-mutations";
import { useSettings } from "@/lib/hooks/use-settings";

/**
 * The People list.
 *
 * Search and the tag filter go to the server — `GET /api/crm/contacts` does the
 * LIKE in SQL and caps at 200 — so this pane never holds a full CRM in memory
 * to grep. Both filters live in app state because the shell's keyboard map
 * walks the rows they produce.
 *
 * The tag filter is a text field rather than a picker: no endpoint returns the
 * set of tags in use, and inventing one from the rows on screen would offer a
 * list that changes with the search.
 */
export function PeopleList({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const rawQuery = usePeopleSearchQuery();
  const queryClient = useQueryClient();
  const connection = useConnection();
  const meta = useMeta();
  const settings = useSettings();
  const sync = useCrmSync();
  const [seed, setSeed] = React.useState<ContactSeed | null>(null);

  const contacts = useCrmContacts({
    query: app.peopleQuery,
    tag: app.peopleTag ?? undefined,
  });

  const rows = React.useMemo(() => contacts.data ?? [], [contacts.data]);
  const selectedId = app.selectedContact;
  const activeId = selectedId ?? rows[0]?.id ?? null;
  const filtering = app.peopleQuery.trim().length > 0 || app.peopleTag !== null;

  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  const registerRow = React.useCallback(
    (id: string, node: HTMLLIElement | null) => {
      if (node) rowRefs.current.set(id, node);
      else rowRefs.current.delete(id);
    },
    [],
  );

  React.useEffect(() => {
    if (!selectedId) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({
      block: "nearest",
      behavior: app.reducedMotion ? "auto" : "smooth",
    });
  }, [app.reducedMotion, selectedId]);

  const selectContact = app.selectContact;

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["crm-contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
  }, [queryClient]);

  const runSync = () => {
    sync.mutate(undefined, {
      onSuccess: (result) =>
        toast.success(
          `Synced ${result.contacts} ${
            result.contacts === 1 ? "contact" : "contacts"
          } and ${result.interactions} ${
            result.interactions === 1 ? "interaction" : "interactions"
          }`,
        ),
      onError: (error) =>
        toast.error("Could not sync from mail", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        }),
    });
  };

  /* With no server URL or no token the query is disabled, and a disabled
     TanStack query sits at status "pending" forever — so without this the pane
     would show a skeleton that never resolves. `connection.kind` decides, the
     same way the message list does it. */
  const blocked = connection.kind !== "ok";

  let body: React.ReactNode;
  if (blocked) {
    body = (
      <ConnectionStateBlock
        connection={connection}
        tokenHint={meta.data?.tokenHint}
        baseUrl={settings.baseUrl}
        handlers={{
          openSettings: (focus) => app.openSettings(focus ?? null),
          retry: refresh,
        }}
      />
    );
  } else if (contacts.isError) {
    body = (
      <Empty
        action={
          <Button type="button" size="sm" onClick={refresh}>
            Try again
          </Button>
        }
      >
        {friendlyError(
          contacts.error instanceof Error
            ? contacts.error.message
            : contacts.error,
        )}
      </Empty>
    );
  } else if (rows.length === 0 && contacts.isPending) {
    body = <ListSkeleton rows={6} />;
  } else if (rows.length === 0 && filtering) {
    body = (
      <Empty
        action={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              app.setPeopleRawQuery("");
              app.setPeopleTag(null);
            }}
          >
            Clear filters
          </Button>
        }
      >
        No contact matches that.
      </Empty>
    );
  } else if (rows.length === 0) {
    body = (
      <Empty
        action={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={sync.isPending}
            onClick={runSync}
          >
            {sync.isPending ? "Syncing…" : "Sync from mail"}
          </Button>
        }
      >
        No contacts yet. Boxaide builds them from who you actually write to.
      </Empty>
    );
  } else {
    body = (
      <ul
        role="listbox"
        aria-label="Contacts"
        aria-busy={contacts.isFetching || undefined}
        className="list-none"
      >
        {rows.map((contact) => (
          <ContactRow
            key={contact.id}
            contact={contact}
            selected={selectedId === contact.id}
            active={activeId === contact.id}
            onSelect={selectContact}
            registerRow={registerRow}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 bg-surface-1">
        {/* Two rows, the same split the message list uses: search owns the
            first, filters and actions the second. */}
        <div className="flex h-11 items-center gap-2 px-3">
          {showRailButton && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open mailboxes and folders"
              onClick={onOpenRail}
            >
              <Menu className="size-4" strokeWidth={1.5} />
            </Button>
          )}

          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-tertiary"
              strokeWidth={1.5}
            />
            <Input
              type="search"
              value={rawQuery}
              onChange={(event) => app.setPeopleRawQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  app.setPeopleRawQuery("");
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search people"
              aria-label="Search people by name, email or organization"
              className="bg-surface-2 pr-7 pl-7 [&::-webkit-search-cancel-button]:hidden"
            />
            {rawQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => app.setPeopleRawQuery("")}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-tertiary hover:bg-surface-hover hover:text-fg"
              >
                <X className="size-3.5" strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>

        <div className="flex h-9 items-center gap-1.5 border-b border-border-subtle px-3 pb-1.5">
          <div className="relative min-w-0 flex-1">
            <Tag
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-tertiary"
              strokeWidth={1.5}
            />
            <Input
              value={app.peopleTag ?? ""}
              onChange={(event) =>
                app.setPeopleTag(event.target.value.trim() || null)
              }
              placeholder="Tag"
              aria-label="Filter by tag"
              className="h-7 bg-surface-2 pl-7"
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="New contact"
                className="ml-auto shrink-0"
                onClick={() => setSeed({ nonce: Date.now() })}
              >
                <UserPlus className="size-4" strokeWidth={1.5} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New contact</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Sync contacts from mail"
                aria-busy={sync.isPending || undefined}
                disabled={sync.isPending}
                onClick={runSync}
              >
                <Download className="size-4" strokeWidth={1.5} />
              </Button>
            </TooltipTrigger>
            {/* Named, not "Refresh": this one walks IMAP and can take seconds. */}
            <TooltipContent>Sync from mail</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh the contact list"
                aria-busy={contacts.isFetching || undefined}
                onClick={refresh}
              >
                <RefreshCw
                  className={`size-4 ${contacts.isFetching ? "mailmux-spin" : ""}`}
                  strokeWidth={1.5}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {(contacts.isFetching || sync.isPending) && rows.length > 0 && (
        <div aria-hidden="true" className="h-0.5 shrink-0 overflow-hidden">
          <div className="mailmux-progress h-full bg-accent" />
        </div>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {contacts.isFetching
          ? "Loading contacts…"
          : rows.length > 0
            ? `${rows.length} ${rows.length === 1 ? "contact" : "contacts"}`
            : ""}
      </p>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">{body}</div>

      <ContactDialog seed={seed} onOpenChange={() => setSeed(null)} />
    </div>
  );
}

/** One quiet sentence, centred, with at most one action. */
function Empty({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-[240px] text-center">
        <p className="text-[13px] leading-[18px] text-fg-tertiary">{children}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

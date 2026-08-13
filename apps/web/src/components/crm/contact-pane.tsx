"use client";

import * as React from "react";
import { ArrowLeft, CircleAlert, Mail, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BrandGlyph,
  SectionLabel,
  Spinner,
  TechnicalDetails,
} from "@/components/atoms";
import { ContactDialog, type ContactSeed } from "@/components/crm/contact-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import { formatDealValue } from "@/lib/format/deal";
import { useApp } from "@/lib/hooks/use-app-state";
import { useCrmContact } from "@/lib/hooks/use-crm-contacts";
import {
  useAddCrmNote,
  useDeleteCrmContact,
} from "@/lib/hooks/use-crm-mutations";
import type { CrmDeal, CrmInteraction, CrmNote } from "@/lib/types";

/**
 * The contact pane: everything the CRM holds about one person, in the reading
 * pane's column and at the reading pane's measure.
 *
 * Interaction subjects and snippets arrive decrypted from the server and are
 * mail content — they are rendered as text and never stored by this client. As
 * everywhere else in this app, no HTML from a message is rendered.
 *
 * There is no link from an interaction to the message it came from: the stored
 * id is `accountId:folder:uid` for whatever folder the sync walked, and the
 * reader keys on a selection the message list produced. A dead link that looks
 * live is worse than no link.
 */
export function ContactPane() {
  const app = useApp();
  const contactId = app.selectedContact;
  const detail = useCrmContact(contactId);
  const remove = useDeleteCrmContact();
  const [editSeed, setEditSeed] = React.useState<ContactSeed | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  if (!contactId) {
    return (
      <div className="flex h-full items-center justify-center px-5">
        <div className="text-center">
          <BrandGlyph size={20} className="mx-auto text-fg-disabled" />
          <p className="mt-3 text-[13px] leading-[18px] text-fg-tertiary">
            Pick someone to see what you know about them.
          </p>
        </div>
      </div>
    );
  }

  const data = detail.data ?? null;
  const contact = data?.contact ?? null;

  const confirmDelete = () => {
    if (!contact) return;
    remove.mutate(contact.id, {
      onSuccess: (result) => {
        setConfirmingDelete(false);
        app.selectContact(null);
        if (result.deleted) toast.success(`Removed ${contact.email}`);
        else toast.warning("That contact was already gone");
      },
      onError: (error) => {
        toast.error("Could not remove that contact", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        });
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Same 44px action bar as the reader, so the two panes line up when the
          view changes under a fixed viewport. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        {app.narrow && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to the contact list"
            onClick={() => app.selectContact(null)}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Write to this contact"
              disabled={!contact}
              onClick={() =>
                contact ? app.openCompose({ to: contact.email }) : undefined
              }
            >
              <Mail className="size-4" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Write an email</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Edit this contact"
              disabled={!contact}
              onClick={() =>
                contact
                  ? setEditSeed({
                      nonce: Date.now(),
                      contact,
                      tags: data?.tags ?? [],
                    })
                  : undefined
              }
            >
              <Pencil className="size-4" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove this contact"
              disabled={!contact}
              className="ml-auto"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="size-4" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </div>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        {detail.isError ? (
          <div role="alert" className="mt-6 rounded-[var(--radius-md)] bg-danger-bg p-3">
            <p className="flex items-center gap-2 text-[13px] text-danger">
              <CircleAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />
              {friendlyError(
                detail.error instanceof Error ? detail.error.message : detail.error,
              )}
            </p>
            <TechnicalDetails
              raw={detail.error instanceof Error ? detail.error.message : detail.error}
            />
            <Button
              type="button"
              variant="secondary"
              className="mt-2"
              onClick={() => void detail.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : !data || !contact ? (
          <div className="mt-6 space-y-2">
            <Skeleton className="h-4 w-[50%]" />
            <Skeleton className="h-3 w-[35%]" />
            <Skeleton className="h-3 w-[60%]" />
          </div>
        ) : (
          <article className="mx-auto max-w-[calc(var(--reader-measure)+2rem)] pt-5">
            {/* h2 for the same reason the reader's subject is one: the page's
                h1 is the app name in AppShell. */}
            <h2 className="title-15 text-fg">
              {contact.name?.trim() || contact.email}
            </h2>
            <p className="mt-1 text-[13px] leading-[18px] text-fg-secondary">
              <a
                href={`mailto:${contact.email}`}
                className="text-accent underline decoration-1 underline-offset-2"
              >
                {contact.email}
              </a>
            </p>
            {(contact.title || contact.orgName) && (
              <p className="mt-1 text-[13px] leading-[18px] text-fg-tertiary">
                {[contact.title, contact.orgName].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {/* Where the row came from. 'mail' rows are derived and a sync
                  can revise them; 'manual' and 'agent' rows were asserted. */}
              <Badge variant="neutral">{contact.source}</Badge>
              {data.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="accent"
                  asChild
                >
                  <button
                    type="button"
                    onClick={() => app.setPeopleTag(tag)}
                    title={`Filter the list by ${tag}`}
                  >
                    {tag}
                  </button>
                </Badge>
              ))}
            </div>

            <Notes contactId={contact.id} notes={data.notes} />
            <Deals deals={data.deals} />
            <Timeline interactions={data.interactions} />
          </article>
        )}
      </div>

      <ContactDialog seed={editSeed} onOpenChange={() => setEditSeed(null)} />

      {contact && (
        <AlertDialog
          open={confirmingDelete}
          onOpenChange={(next) => (next ? undefined : setConfirmingDelete(false))}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {contact.email}?</AlertDialogTitle>
              <AlertDialogDescription>
                Their notes and interaction history go with them. Mail on the
                server is untouched, and the next sync may re-derive the contact
                from it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  confirmDelete();
                }}
              >
                {remove.isPending && <Spinner />}
                {remove.isPending ? "Removing…" : "Remove contact"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/** Notes: newest first, plus the one control that adds one. */
function Notes({
  contactId,
  notes,
}: {
  contactId: string;
  notes: CrmNote[];
}) {
  const add = useAddCrmNote();
  const [text, setText] = React.useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    add.mutate(
      { contactId, text: body },
      {
        onSuccess: () => setText(""),
        onError: (error) =>
          toast.error("Could not save that note", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  return (
    <section className="mt-6">
      <SectionLabel>Notes</SectionLabel>
      <form onSubmit={submit} className="mt-1.5">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What should you remember about them?"
          aria-label="New note"
          rows={2}
        />
        <div className="mt-1.5 flex justify-end">
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={add.isPending || text.trim().length === 0}
          >
            {add.isPending && <Spinner />}
            {add.isPending ? "Saving…" : "Add note"}
          </Button>
        </div>
      </form>

      {notes.length === 0 ? (
        <p className="text-[13px] leading-[18px] text-fg-tertiary">
          No notes yet.
        </p>
      ) : (
        <ul className="mt-1 list-none space-y-2.5">
          {notes.map((note) => (
            <li key={note.id}>
              <time
                dateTime={isoAttr(note.at)}
                title={isoTitle(note.at)}
                className="text-[11px] leading-4 text-fg-tertiary"
              >
                {formatReaderDate(note.at)}
              </time>
              <p className="text-[13px] leading-[18px] whitespace-pre-wrap text-fg">
                {note.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Deals this contact is on. Editing them is the Pipeline view's job. */
function Deals({ deals }: { deals: CrmDeal[] }) {
  if (deals.length === 0) return null;
  return (
    <section className="mt-6">
      <SectionLabel>Deals</SectionLabel>
      <ul className="mt-1 list-none space-y-1">
        {deals.map((deal) => (
          <li
            key={deal.id}
            className="flex items-baseline justify-between gap-2 text-[13px] leading-[18px]"
          >
            <span className="min-w-0 truncate text-fg">{deal.title}</span>
            <span className="shrink-0 text-[11px] text-fg-tertiary">
              {deal.stageId}
              {deal.value !== null ? ` · ${formatDealValue(deal)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Mail with this contact, newest first, as the sync recorded it. */
function Timeline({ interactions }: { interactions: CrmInteraction[] }) {
  return (
    <section className="mt-6">
      <SectionLabel>Mail</SectionLabel>
      {interactions.length === 0 ? (
        <p className="mt-1 text-[13px] leading-[18px] text-fg-tertiary">
          Nothing yet. Sync from mail builds this from your Inbox and Sent
          folders.
        </p>
      ) : (
        <ul className="mt-1 list-none">
          {interactions.map((entry) => (
            <li
              key={entry.id}
              className="border-l border-border-subtle py-1.5 pl-3"
            >
              <span className="flex items-baseline gap-1.5">
                <span className="shrink-0 text-[11px] leading-4 text-fg-tertiary">
                  {entry.direction === "in" ? "Received" : "Sent"}
                </span>
                <time
                  dateTime={isoAttr(entry.at)}
                  title={isoTitle(entry.at)}
                  className="shrink-0 text-[11px] leading-4 text-fg-tertiary"
                >
                  {formatReaderDate(entry.at)}
                </time>
              </span>
              <span className="block truncate text-[13px] leading-[18px] text-fg">
                {entry.subject ?? "(no subject)"}
              </span>
              {entry.snippet && entry.snippet !== entry.subject && (
                <span className="block truncate text-[12px] leading-[18px] text-fg-tertiary">
                  {entry.snippet}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

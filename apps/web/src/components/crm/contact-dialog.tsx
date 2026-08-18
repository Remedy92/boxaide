"use client";

import * as React from "react";
import { toast } from "sonner";
import { Field, Spinner, TechnicalDetails } from "@/components/atoms";
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
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/api/errors";
import { useUpsertCrmContact } from "@/lib/hooks/use-crm-mutations";
import type { CrmContact } from "@/lib/types";

export type ContactSeed = {
  /** Fresh on every open, so the form can be keyed on it and needs no effect. */
  nonce: number;
  /** Absent ⇒ create. Present ⇒ edit that row. */
  contact?: CrmContact;
  /** Tags already on the contact, so the field starts full rather than empty. */
  tags?: string[];
};

/**
 * Create and edit are one form because the route is one upsert on lowercase
 * email. That is also why the address is read-only while editing: typing a
 * different one there would not rename this contact, it would silently create
 * or edit a second.
 */
export function ContactDialog({
  seed,
  onOpenChange,
}: {
  seed: ContactSeed | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!seed) return null;
  return <ContactForm key={seed.nonce} seed={seed} onOpenChange={onOpenChange} />;
}

function ContactForm({
  seed,
  onOpenChange,
}: {
  seed: ContactSeed;
  onOpenChange: (open: boolean) => void;
}) {
  const editing = seed.contact ?? null;
  const upsert = useUpsertCrmContact();

  const [email, setEmail] = React.useState(editing?.email ?? "");
  const [name, setName] = React.useState(editing?.name ?? "");
  const [title, setTitle] = React.useState(editing?.title ?? "");
  const [org, setOrg] = React.useState(editing?.orgName ?? "");
  const [tags, setTags] = React.useState((seed.tags ?? []).join(", "));
  const [emailError, setEmailError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    // The same shape the route checks. Anything richer here would reject
    // addresses the server accepts.
    if (!address.includes("@")) {
      setEmailError("An email address is required.");
      return;
    }
    setEmailError(null);
    upsert.mutate(
      {
        email: address,
        name: name.trim() || undefined,
        title: title.trim() || undefined,
        org: org.trim() || undefined,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        source: editing ? editing.source : "manual",
      },
      {
        onSuccess: (contact) => {
          onOpenChange(false);
          toast.success(editing ? "Contact saved" : `Added ${contact.email}`);
        },
        onError: (error) => {
          toast.error("Could not save that contact", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit contact" : "New contact"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Stored on this machine. Mail on the server is untouched."
                : "Added by hand. A mail sync will not overwrite the name you type."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>

            <div className="space-y-3">
              <Field
                id="crm-contact-email"
                label="Email"
                error={emailError}
                helper={
                  editing
                    ? "The address identifies the contact and cannot be changed here."
                    : undefined
                }
              >
                <Input
                  id="crm-contact-email"
                  type="email"
                  value={email}
                  readOnly={editing !== null}
                  aria-invalid={emailError ? true : undefined}
                  aria-describedby={emailError ? "crm-contact-email-error" : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="jane@acme.com"
                />
              </Field>

              <Field id="crm-contact-name" label="Name">
                <Input
                  id="crm-contact-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Jane Smith"
                />
              </Field>

              <Field id="crm-contact-title" label="Title">
                <Input
                  id="crm-contact-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Head of operations"
                />
              </Field>

              {/* An org NAME, not a picker: the route resolves an existing
                  organization or creates one. Emptying it does not unset the
                  current organization — upsertContact COALESCEs org_id, so
                  there is no REST path that clears it. */}
              <Field
                id="crm-contact-org"
                label="Organization"
                helper={
                  editing?.orgName
                    ? "Leave empty to keep the current organization."
                    : "Matched by name, or created."
                }
              >
                <Input
                  id="crm-contact-org"
                  value={org}
                  onChange={(event) => setOrg(event.target.value)}
                  placeholder="Acme"
                />
              </Field>

              {/* Tags only ever accumulate: the server's addTags is INSERT OR
                  IGNORE and nothing in the REST surface removes one, so this
                  field does not pretend that deleting a word untags anybody. */}
              <Field
                id="crm-contact-tags"
                label="Tags"
                helper="Comma separated. Adding only — removing a tag here does not delete it."
              >
                <Input
                  id="crm-contact-tags"
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="lead, belgium"
                />
              </Field>

              {upsert.isError && (
                <div role="alert" className="rounded-[var(--radius-md)] bg-danger-bg p-3">
                  <p className="text-[13px] text-danger">
                    {friendlyError(
                      upsert.error instanceof Error
                        ? upsert.error.message
                        : upsert.error,
                    )}
                  </p>
                  <TechnicalDetails
                    raw={
                      upsert.error instanceof Error
                        ? upsert.error.message
                        : upsert.error
                    }
                  />
                </div>
              )}
            </div>

          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending && <Spinner />}
              {upsert.isPending ? "Saving…" : editing ? "Save contact" : "Add contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

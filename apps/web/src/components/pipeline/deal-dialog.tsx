"use client";

import * as React from "react";
import { toast } from "sonner";
import { Field, Spinner, TechnicalDetails } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { friendlyError } from "@/lib/api/errors";
import { useCrmContacts, useCrmOrgs } from "@/lib/hooks/use-crm-contacts";
import { useUpsertCrmDeal } from "@/lib/hooks/use-crm-mutations";
import type { CrmDeal, CrmPipelineStage } from "@/lib/types";

/** The sentinel for "no contact" / "no organization" — Radix rejects a "" value. */
const NONE = "__none__";

export type DealSeed = {
  /** Fresh on every open, so the form can be keyed on it and needs no effect. */
  nonce: number;
  /** Absent ⇒ create. Present ⇒ patch that deal. */
  deal?: CrmDeal;
  /** Which column the New button was pressed in. */
  stageId: string;
};

/**
 * Create and edit are one form because `POST /api/crm/deals` is one upsert:
 * with `dealId` it patches, without it creates. An unknown id is a 404 from the
 * server rather than a silent second deal, so a stale card cannot fork one.
 */
export function DealDialog({
  seed,
  stages,
  onOpenChange,
}: {
  seed: DealSeed | null;
  stages: CrmPipelineStage[];
  onOpenChange: (open: boolean) => void;
}) {
  if (!seed) return null;
  return (
    <DealForm
      key={seed.nonce}
      seed={seed}
      stages={stages}
      onOpenChange={onOpenChange}
    />
  );
}

function DealForm({
  seed,
  stages,
  onOpenChange,
}: {
  seed: DealSeed;
  stages: CrmPipelineStage[];
  onOpenChange: (open: boolean) => void;
}) {
  const editing = seed.deal ?? null;
  const upsert = useUpsertCrmDeal();
  // Unfiltered, capped at 200 by the endpoint. A CRM larger than that needs a
  // searchable picker; this dialog does not pretend to be one.
  const contacts = useCrmContacts({});
  const orgs = useCrmOrgs();

  const [title, setTitle] = React.useState(editing?.title ?? "");
  const [stageId, setStageId] = React.useState(editing?.stageId ?? seed.stageId);
  const [contactId, setContactId] = React.useState(editing?.contactId ?? NONE);
  const [orgId, setOrgId] = React.useState(editing?.orgId ?? NONE);
  const [value, setValue] = React.useState(
    editing?.value === null || editing?.value === undefined
      ? ""
      : String(editing.value),
  );
  const [currency, setCurrency] = React.useState(editing?.currency ?? "");
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const [valueError, setValueError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) {
      setTitleError("A deal needs a title.");
      return;
    }
    setTitleError(null);

    const raw = value.trim();
    const amount = raw === "" ? null : Number(raw);
    if (amount !== null && !Number.isFinite(amount)) {
      setValueError("Value must be a number, or empty.");
      return;
    }
    setValueError(null);

    upsert.mutate(
      {
        dealId: editing?.id,
        title: name,
        stageId,
        contactId: contactId === NONE ? null : contactId,
        orgId: orgId === NONE ? null : orgId,
        value: amount,
        currency: currency.trim() || null,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(editing ? "Deal saved" : `Added ${name}`);
        },
        onError: (error) =>
          toast.error("Could not save that deal", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit deal" : "New deal"}</DialogTitle>
            <DialogDescription>
              Deals live on this machine. Nothing here is sent anywhere.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-4">
            <Field id="crm-deal-title" label="Title" error={titleError}>
              <Input
                id="crm-deal-title"
                value={title}
                aria-invalid={titleError ? true : undefined}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Pilot with Acme"
              />
            </Field>

            <Field id="crm-deal-stage" label="Stage">
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger id="crm-deal-stage" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((stage) => (
                    <SelectItem key={stage.id} value={stage.id}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field id="crm-deal-contact" label="Contact">
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger id="crm-deal-contact" className="w-full">
                  <SelectValue placeholder="Nobody" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Nobody</SelectItem>
                  {(contacts.data ?? []).map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.name?.trim() || contact.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field id="crm-deal-org" label="Organization">
              <Select value={orgId} onValueChange={setOrgId}>
                <SelectTrigger id="crm-deal-org" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {(orgs.data ?? []).map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-2">
              <Field id="crm-deal-value" label="Value" error={valueError}>
                <Input
                  id="crm-deal-value"
                  inputMode="decimal"
                  value={value}
                  aria-invalid={valueError ? true : undefined}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="12000"
                />
              </Field>
              {/* Free text, not a currency picker: the column is a plain TEXT
                  and nothing server-side validates it against ISO 4217. */}
              <Field id="crm-deal-currency" label="Currency">
                <Input
                  id="crm-deal-currency"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value)}
                  placeholder="EUR"
                />
              </Field>
            </div>

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

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending && <Spinner />}
              {upsert.isPending ? "Saving…" : editing ? "Save deal" : "Add deal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

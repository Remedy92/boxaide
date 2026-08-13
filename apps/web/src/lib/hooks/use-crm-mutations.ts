"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addCrmNote,
  deleteCrmContact,
  deleteCrmDeal,
  moveCrmDeal,
  syncCrm,
  upsertCrmContact,
  upsertCrmDeal,
  type CrmContactBody,
  type CrmDealBody,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * Every CRM write, in one file, because they all invalidate the same two or
 * three caches and scattering that rule is how a board goes stale after a move.
 *
 * Nothing here is optimistic. A deal move renumbers `position` across the whole
 * target stage server-side (`reindexStage`), so a locally patched board would
 * be wrong for every card but the one that moved; refetching is both correct
 * and, against a loopback SQLite server, imperceptible.
 */

/** Invalidate the reads a contact write can change. */
function useInvalidateContacts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["crm-contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-orgs"] });
  };
}

/**
 * Create AND edit: the route upserts on lowercase email. Tags are additive —
 * there is no REST path that removes one — so the form never pretends a
 * dropped tag was deleted.
 */
export function useUpsertCrmContact() {
  const ctx = useApiCtx();
  const invalidate = useInvalidateContacts();
  return useMutation({
    mutationFn: (body: CrmContactBody) => upsertCrmContact(body, ctx),
    onSuccess: invalidate,
  });
}

export function useDeleteCrmContact() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => deleteCrmContact(contactId, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
      // Deals hold ON DELETE SET NULL on contact_id, so the board's cards lose
      // their name the moment a contact goes.
      void queryClient.invalidateQueries({ queryKey: ["crm-pipeline"] });
    },
  });
}

export function useAddCrmNote() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contactId: string; text: string }) =>
      addCrmNote(input.contactId, input.text, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
    },
  });
}

export function useUpsertCrmDeal() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CrmDealBody) => upsertCrmDeal(body, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-pipeline"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
    },
  });
}

export function useMoveCrmDeal() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      dealId: string;
      stageId: string;
      position?: number;
    }) => moveCrmDeal(input.dealId, input.stageId, ctx, input.position),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-pipeline"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
    },
  });
}

export function useDeleteCrmDeal() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dealId: string) => deleteCrmDeal(dealId, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-pipeline"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-contact"] });
    },
  });
}

/**
 * Re-derive contacts and interactions from mail. The server serialises
 * concurrent calls onto one walk, so a double click costs one sync.
 */
export function useCrmSync() {
  const ctx = useApiCtx();
  const invalidate = useInvalidateContacts();
  return useMutation({
    mutationFn: () => syncCrm(ctx),
    onSuccess: invalidate,
  });
}

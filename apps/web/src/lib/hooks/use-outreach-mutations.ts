"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addSuppression,
  decideOutbox,
  removeSuppression,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * Every outreach write, in one file, because they all invalidate the same
 * queries — and because the approval decision is the single most consequential
 * button in this product: it is the only thing in mailmux that puts agent-
 * written mail on a path to a real recipient.
 *
 * Nothing here is optimistic. A decision that only looked applied, over a queue
 * of mail waiting to go out, is not a trade this view makes.
 */

/** Approve or reject one queued row. Only a `pending` row can be decided. */
export function useDecideOutbox() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { outboxId: string; decision: "approve" | "reject" }) =>
      decideOutbox(input.outboxId, input.decision, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["outreach-outbox"] });
      // The rail badge counts pending rows, so a decision moves it.
      void queryClient.invalidateQueries({ queryKey: ["outreach-badge"] });
    },
  });
}

export function useAddSuppression() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; reason?: string }) =>
      addSuppression(input.email, input.reason ?? "manual", ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["outreach-suppression"] });
    },
  });
}

export function useRemoveSuppression() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => removeSuppression(email, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["outreach-suppression"] });
    },
  });
}

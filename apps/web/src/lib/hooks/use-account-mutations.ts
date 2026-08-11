"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createAccount,
  deleteAccount,
  type CreateAccountBody,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * POST /api/accounts performs a live IMAP login server-side and can take
 * several seconds. Re-POSTing an existing alias updates that mailbox instead of
 * creating a second one, so the caller relabels its button accordingly.
 */
export function useCreateAccount() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAccountBody) => createAccount(body, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

export function useDeleteAccount() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (idOrAlias: string) => deleteAccount(idOrAlias, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

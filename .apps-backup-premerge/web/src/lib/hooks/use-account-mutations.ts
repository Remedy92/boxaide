"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createAccount,
  deleteAccount,
  testCredentials,
  type CreateAccountBody,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { AccountCredentials } from "@/lib/types";

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

/** A failed test is a 400 whose body still carries `ok:false` — not a throw. */
export function useTestCredentials() {
  const ctx = useApiCtx();
  return useMutation({
    mutationFn: (creds: AccountCredentials) => testCredentials(creds, ctx),
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

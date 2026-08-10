"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendMessage, type SendMessageBody } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The sent message is NOT inserted into the list. The server appends it to the
 * Sent folder and the current listing will not return it; rendering a fake row
 * would be a lie about state. The list is invalidated instead, so a Sent-folder
 * view refreshes truthfully.
 */
export function useSend() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SendMessageBody) => sendMessage(body, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

/**
 * Which recipients the server did not confirm. `accepted` comes straight from
 * nodemailer; anything the user typed that is missing from it is worth saying
 * out loud rather than swallowing behind a green toast.
 */
export function missingRecipients(
  typed: readonly string[],
  accepted: readonly string[],
): string[] {
  const got = new Set(accepted.map((value) => value.trim().toLowerCase()));
  return typed.filter((value) => value && !got.has(value.trim().toLowerCase()));
}

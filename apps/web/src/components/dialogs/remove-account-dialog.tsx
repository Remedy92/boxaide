"use client";

import { toast } from "sonner";
import { Spinner } from "@/components/atoms";
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
import { friendlyError } from "@/lib/api/errors";
import { useDeleteAccount } from "@/lib/hooks/use-account-mutations";
import { useApp } from "@/lib/hooks/use-app-state";

/**
 * The one confirmation behind DELETE /api/accounts/:id. Mounted once by
 * AppShell and driven by `app.removalTarget`, so the sidebar row's × and the
 * command palette's `Remove {alias}` reach the same dialog rather than one of
 * them merely pointing at the other.
 */
export function RemoveAccountDialog() {
  const app = useApp();
  const account = app.removalTarget;
  const remove = useDeleteAccount();

  if (!account) return null;

  const confirm = () => {
    remove.mutate(account.id, {
      onSuccess: (result) => {
        app.clearRemovalTarget();
        if (result.deleted) toast.success(`Removed ${account.alias}`);
        else toast.warning(`${account.alias} was already gone`);
      },
      onError: (error) => {
        toast.error("Could not remove that mailbox", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        });
      },
    });
  };

  return (
    <AlertDialog
      open
      onOpenChange={(next) => (next ? undefined : app.clearRemovalTarget())}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {account.alias}?</AlertDialogTitle>
          <AlertDialogDescription>
            mailmux stops fetching this mailbox and forgets its credentials.
            Mail on the server is untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {remove.isPending && <Spinner />}
            {remove.isPending ? "Removing…" : "Remove mailbox"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

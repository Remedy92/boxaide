"use client";

import * as React from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Spinner } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import { useSuppression } from "@/lib/hooks/use-outreach";
import {
  useAddSuppression,
  useRemoveSuppression,
} from "@/lib/hooks/use-outreach-mutations";

/**
 * The suppression list: addresses mailmux refuses to send to.
 *
 * It is not a preference this UI enforces — the send guard inside
 * MailService.sendMessage does, for every send including an agent's — so what
 * this panel does is show the list and let a person add to or take from it.
 *
 * Rows added by a reply of "stop" carry reason `reply-stop`. Removing one is
 * deliberately as easy as adding one, and deliberately says what it means.
 */
export function SuppressionPanel() {
  const suppression = useSuppression();
  const add = useAddSuppression();
  const remove = useRemoveSuppression();
  const [email, setEmail] = React.useState("");

  const rows = suppression.data ?? [];

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!value) return;
    add.mutate(
      { email: value, reason: "manual" },
      {
        onSuccess: (row) => {
          setEmail("");
          toast.success(`${row.email} will not be written to`);
        },
        onError: (error) =>
          toast.error("Could not suppress that address", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  return (
    <div className="min-h-0">
      <form onSubmit={submit} className="flex items-center gap-1.5 px-3 py-2.5">
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          aria-label="Address to suppress"
          className="bg-surface-2"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          className="shrink-0"
          disabled={add.isPending || email.trim().length === 0}
        >
          {add.isPending && <Spinner />}
          {add.isPending ? "Adding…" : "Suppress"}
        </Button>
      </form>

      {suppression.isPending ? (
        <div className="space-y-2 px-3 py-2">
          <Skeleton className="h-3 w-[55%]" />
          <Skeleton className="h-3 w-[40%]" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-6 py-8 text-center text-[13px] leading-[18px] text-fg-tertiary">
          Nobody is suppressed. Anyone who replies “stop” lands here
          automatically.
        </p>
      ) : (
        <ul className="list-none">
          {rows.map((row) => (
            <li
              key={row.email}
              className="flex items-center gap-2 border-b border-border-subtle px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-[18px] text-fg">
                  {row.email}
                </p>
                <p className="text-[11px] leading-4 text-fg-tertiary">
                  {row.reason}
                  {" · "}
                  <time dateTime={isoAttr(row.at)} title={isoTitle(row.at)}>
                    {formatReaderDate(row.at)}
                  </time>
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Allow mail to ${row.email} again`}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(row.email, {
                        onSuccess: (result) =>
                          result.deleted
                            ? toast.success(`${row.email} can be written to again`)
                            : toast.warning("That address was already off the list"),
                        onError: (error) =>
                          toast.error("Could not remove that address", {
                            description: friendlyError(
                              error instanceof Error ? error.message : error,
                            ),
                          }),
                      })
                    }
                  >
                    <X className="size-4" strokeWidth={1.5} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Allow again</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

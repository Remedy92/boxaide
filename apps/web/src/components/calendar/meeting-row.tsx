"use client";

import * as React from "react";
import { MapPin, Users, Video } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/api/errors";
import { formatMeetingWhen } from "@/lib/format/calendar";
import { isoAttr, isoTitle } from "@/lib/format/date";
import { useCancelMeeting } from "@/lib/hooks/use-calendar";
import type { Meeting } from "@/lib/types";

/**
 * One meeting Boxaide created.
 *
 * Cancelling is the only write here, and it goes through the same confirmation
 * shape as removing a mailbox: it emails everyone on the invitation, which is
 * not something to do on a mis-click.
 */
export function MeetingRow({ meeting }: { meeting: Meeting }) {
  const cancel = useCancelMeeting();
  const [confirming, setConfirming] = React.useState(false);
  const cancelled = meeting.status === "cancelled";

  const confirm = () => {
    cancel.mutate(meeting.id, {
      onSuccess: (result) => {
        setConfirming(false);
        // The warnings ARE the outcome for the part that failed — an attendee
        // whose notice bounced is not a cancelled meeting for them.
        if (result.warnings.length > 0) {
          toast.warning(`Cancelled “${meeting.title}”, with problems`, {
            description: result.warnings.join(" "),
          });
        } else {
          toast.success(`Cancelled “${meeting.title}”`);
        }
      },
      onError: (error) =>
        toast.error("Could not cancel that meeting", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        }),
    });
  };

  return (
    <li className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[13px] leading-[18px] font-medium text-fg">
            {meeting.title}
          </h4>
          <p className="mt-0.5 text-[12px] leading-[18px] text-fg-secondary">
            <time
              dateTime={isoAttr(meeting.start)}
              title={isoTitle(meeting.start)}
            >
              {formatMeetingWhen(meeting)}
            </time>
          </p>
        </div>
        <Badge variant={cancelled ? "danger" : "success"}>
          {cancelled ? "Cancelled" : "Scheduled"}
        </Badge>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-[18px] text-fg-tertiary">
        {meeting.attendees.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5">
            <Users aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="truncate">{meeting.attendees.join(", ")}</span>
          </span>
        )}
        {/* The server writes the call link into `location` as well. Printing
            it twice — once as a URL, once as the Join button below — is one
            fact wearing two coats. */}
        {meeting.location && meeting.location !== meeting.meetingUrl && (
          <span className="flex min-w-0 items-center gap-1.5">
            <MapPin aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="truncate">{meeting.location}</span>
          </span>
        )}
      </div>

      {(meeting.meetingUrl || !cancelled) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {/* First, and a real button: on the day, joining is the only thing
              anybody wants from this row. Kept on a cancelled meeting too —
              the link is dead either way, and hiding it mid-call would be
              worse than showing it beside a Cancelled badge. */}
          {meeting.meetingUrl && (
            <Button asChild variant={cancelled ? "secondary" : "default"} size="sm">
              <a
                href={meeting.meetingUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Video className="size-3.5" strokeWidth={1.5} />
                Join call
              </a>
            </Button>
          )}

          {!cancelled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => setConfirming(true)}
            >
              {cancel.isPending && <Spinner />}
              {cancel.isPending ? "Cancelling…" : "Cancel meeting"}
            </Button>
          )}
        </div>
      )}

      <AlertDialog
        open={confirming}
        onOpenChange={(next) => (next ? undefined : setConfirming(false))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel “{meeting.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The event is removed from your calendar and everyone on the
              invitation is told it is off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                confirm();
              }}
            >
              {cancel.isPending && <Spinner />}
              {cancel.isPending ? "Cancelling…" : "Cancel meeting"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

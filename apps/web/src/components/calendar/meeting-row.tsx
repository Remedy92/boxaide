"use client";

import * as React from "react";
import { Check, CircleDashed, CircleDot, MapPin, Video, X } from "lucide-react";
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
import {
  useCancelMeeting,
  useRefreshMeetingResponses,
} from "@/lib/hooks/use-calendar";
import type { AttendeeResponse, Meeting } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * How each response reads, and how it looks.
 *
 * An icon as well as a colour, because colour alone is not a difference
 * everybody can see, and a word as well as the icon, because a green tick is
 * only obvious once you have been told what it means.
 *
 * "No reply yet" is where every guest starts, so it is drawn in the same
 * quiet grey as the rest of the row's small print — an unanswered invitation
 * an hour after it went out is not a problem to be flagged.
 */
const RESPONSES = {
  accepted: { label: "accepted", Icon: Check, tone: "text-success" },
  declined: { label: "declined", Icon: X, tone: "text-danger" },
  tentative: { label: "maybe", Icon: CircleDot, tone: "text-warning" },
  "needs-action": {
    label: "no reply yet",
    Icon: CircleDashed,
    tone: "text-fg-tertiary",
  },
} as const;

/* Widened to `string` on purpose: the server normalises to the four values
   above, and anything it ever adds must land on the resting state rather than
   render nothing at all. */
function responseFor(status: string) {
  return RESPONSES[status as keyof typeof RESPONSES] ?? RESPONSES["needs-action"];
}

/**
 * One meeting Boxaide created.
 *
 * Cancelling is the only write here, and it goes through the same confirmation
 * shape as removing a mailbox: it emails everyone on the invitation, which is
 * not something to do on a mis-click.
 */
export function MeetingRow({ meeting }: { meeting: Meeting }) {
  const cancel = useCancelMeeting();
  const refresh = useRefreshMeetingResponses();
  const [confirming, setConfirming] = React.useState(false);
  const cancelled = meeting.status === "cancelled";
  /* `attendeeStatus` carries one entry per invited guest and is never partial,
     so it is the guest list. `attendees` is the fallback for a meeting stored
     before responses were tracked. */
  const guests: AttendeeResponse[] =
    meeting.attendeeStatus.length > 0
      ? meeting.attendeeStatus
      : meeting.attendees.map((email) => ({
          email,
          status: "needs-action",
          respondedAt: null,
          source: "none",
        }));

  const checkReplies = () => {
    refresh.mutate(undefined, {
      onSuccess: (result) => {
        // The scan reads every mailbox, so a mailbox it could not open is a
        // partial answer, not a failure — saying "no new replies" over the top
        // of it would be a claim the server did not make.
        if (result.errors.length > 0) {
          toast.warning("Checked for replies, with problems", {
            description: result.errors.join(" "),
          });
        } else if (result.updated > 0) {
          toast.success(
            result.updated === 1
              ? "One new reply"
              : `${result.updated} new replies`,
          );
        } else {
          toast.success("No new replies");
        }
      },
      onError: (error) =>
        toast.error("Could not check for replies", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        }),
    });
  };

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

      {/* The guest list IS the response list — one line each, address and
          answer together. A name without an answer beside it is the question
          this row exists to settle. */}
      {guests.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {guests.map((guest) => {
            const { label, Icon, tone } = responseFor(guest.status);
            return (
              <li
                key={guest.email}
                className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[18px] text-fg-tertiary"
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-3.5 shrink-0", tone)}
                  strokeWidth={1.5}
                />
                <span className="truncate">{guest.email}</span>
                <span className={cn("shrink-0", tone)}>{label}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-[18px] text-fg-tertiary">
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

          {/* Quiet, and only where the question can be asked: a meeting with
              nobody on it has no replies to wait for, and a cancelled one has
              nothing left to answer. The scan itself covers every meeting —
              the button sits here because this is where a person wonders. */}
          {!cancelled && guests.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refresh.isPending}
              aria-busy={refresh.isPending || undefined}
              onClick={checkReplies}
            >
              {refresh.isPending && <Spinner />}
              {refresh.isPending ? "Checking…" : "Check for replies"}
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

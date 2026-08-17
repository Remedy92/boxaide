"use client";

import * as React from "react";
import { toast } from "sonner";
import { Field, Spinner, TechnicalDetails } from "@/components/atoms";
import { Segmented } from "@/components/calendar/segmented";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/api/errors";
import { parseAddress, splitAddressList } from "@/lib/format/address";
import { dayKey, formatDayHeadingShort, formatTime } from "@/lib/format/calendar";
import { useCreateMeeting, useFreeSlots } from "@/lib/hooks/use-calendar";
import type { FreeSlot } from "@/lib/types";
import { cn } from "@/lib/utils";

const DURATIONS = [
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "45", label: "45m" },
  { value: "60", label: "1h" },
  { value: "90", label: "1h 30m" },
] as const;

/** A date input wants `YYYY-MM-DD` in LOCAL time — toISOString() would not do. */
function localDateValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The next whole quarter hour, as a Date.
 *
 * A Date rather than a "HH:MM" string because rounding up can cross midnight —
 * setMinutes(60) rolls the day — and the caller has to take the DATE from the
 * rolled value too. Reading the time from the rolled clock and the date from
 * the original booked a meeting a day in the past between 23:45 and midnight.
 */
function nextQuarterHour(now: Date): Date {
  const date = new Date(now);
  date.setMinutes(Math.ceil((date.getMinutes() + 1) / 15) * 15, 0, 0);
  return date;
}

/**
 * Whether a start time has already gone by. A module function, not an inline
 * `Date.now()`: reading the clock inside a component body is impure, and this
 * is only ever asked on submit.
 */
function isPast(start: Date): boolean {
  return start.getTime() < new Date().getTime();
}

/** A time input wants `HH:MM` in local time. */
function localTimeValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

/**
 * Create a meeting.
 *
 * A date, a start and a duration rather than two datetimes: nobody thinks in
 * end times, and two datetime pickers is the shape that lets a person book a
 * meeting that ends before it starts.
 *
 * A success here is not automatically an invitation delivered — POST returns
 * `warnings` for the parts that did not happen, and they are shown rather than
 * swallowed.
 */
export function NewMeetingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateMeeting();
  const [form, setForm] = React.useState(() => blankForm());
  const [validation, setValidation] = React.useState<string | null>(null);

  /* Only while the dialog is up, and re-run per duration: a window that fits
     half an hour need not fit ninety minutes. A failure hides the strip and
     says nothing — a suggestion nobody knew was coming is not an error, and
     the form works without it. */
  const slots = useFreeSlots(Number(form.duration), open);
  const suggestions = React.useMemo(
    () => groupSlots(slots.data?.slots ?? []),
    [slots.data],
  );

  const reset = () => {
    setForm(blankForm());
    setValidation(null);
    create.reset();
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const parsed = parseAttendees(form.attendees);
  /* Bare addresses, never the display-name form: the server puts these
     straight into the invitation's attendee list. */
  const attendees = parsed.map((entry) => entry.address).filter(Boolean);
  const invalid = parsed.filter((entry) => !entry.valid);

  /** Fill the date and the time from a suggestion. Nothing else moves. */
  const applySlot = (slot: FreeSlot) => {
    const start = new Date(slot.start);
    if (Number.isNaN(start.getTime())) return;
    setValidation(null);
    setForm((v) => ({
      ...v,
      date: localDateValue(start),
      time: `${String(start.getHours()).padStart(2, "0")}:${String(
        start.getMinutes(),
      ).padStart(2, "0")}`,
    }));
  };

  const submit = () => {
    if (!form.title.trim()) {
      setValidation("Give the meeting a title.");
      return;
    }
    if (!form.date || !form.time) {
      setValidation("Pick a date and a start time.");
      return;
    }
    const start = new Date(`${form.date}T${form.time}`);
    if (Number.isNaN(start.getTime())) {
      setValidation("That date and time could not be read.");
      return;
    }
    /* Inline, not a toast: it is about the two fields directly above the
       button, and the fix is to change one of them. A meeting in the past
       invites people to something that has already not happened. */
    if (isPast(start)) {
      setValidation("That start time has already passed. Pick a later one.");
      return;
    }
    if (invalid.length > 0) {
      setValidation(
        invalid.length === 1
          ? `“${invalid[0].label}” is not an email address.`
          : `${invalid.length} attendees are not email addresses.`,
      );
      return;
    }
    setValidation(null);

    const end = new Date(start.getTime() + Number(form.duration) * 60_000);
    create.mutate(
      {
        title: form.title.trim(),
        start: start.toISOString(),
        end: end.toISOString(),
        attendees,
        description: form.description.trim() || undefined,
        includeMeetingLink: form.includeMeetingLink,
      },
      {
        onSuccess: (result) => {
          // "Warnings" here means part of this did not happen — an invitation
          // that bounced, a calendar that refused the write. Saying only
          // "Meeting created" would be a claim the server did not make.
          if (result.warnings.length > 0) {
            toast.warning(`Created “${result.meeting.title}”, with problems`, {
              description: result.warnings.join(" "),
            });
          } else {
            const sent = result.meeting.attendees;
            toast.success(`Created “${result.meeting.title}”`, {
              description:
                sent.length > 0
                  ? `Invitations emailed to ${sent.join(", ")}.`
                  : "Nobody was invited — it is on the calendar only.",
            });
          }
          close();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="pane-scroll max-h-[86vh] max-w-[480px] overflow-y-auto"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
          if (!(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          if (!create.isPending) submit();
        }}
      >
        <DialogHeader>
          <DialogTitle className="title-15">New meeting</DialogTitle>
          <DialogDescription>
            Boxaide writes the event to your calendar and emails everyone you
            list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field id="meeting-title" label="Title">
            <Input
              id="meeting-title"
              value={form.title}
              autoComplete="off"
              placeholder="Weekly sync"
              onChange={(event) => {
                setValidation(null);
                setForm((v) => ({ ...v, title: event.target.value }));
              }}
            />
          </Field>

          {/* Above the pickers, because tapping one is the fast path and the
              pickers are the fallback. Silent when the server has nothing to
              offer, or could not say. */}
          {suggestions.length > 0 && (
            <div className="space-y-1.5">
              <span className="block text-[12px] leading-4 font-medium text-fg-secondary">
                Suggested times
              </span>
              <div className="space-y-1.5">
                {suggestions.map((day) => (
                  <div key={day.key} className="flex items-center gap-2">
                    <span className="w-[68px] shrink-0 text-[12px] leading-4 text-fg-tertiary">
                      {formatDayHeadingShort(day.slots[0].start)}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {day.slots.map((slot) => {
                        const chosen = isChosen(slot, form.date, form.time);
                        return (
                          <button
                            key={slot.start}
                            type="button"
                            aria-pressed={chosen}
                            onClick={() => applySlot(slot)}
                            className={cn(
                              "h-7 rounded-[var(--radius-md)] border px-2.5 text-[12px] tabular-nums",
                              "transition-colors duration-[var(--dur-fast)]",
                              chosen
                                ? "border-accent bg-accent-subtle text-accent"
                                : "border-border-control bg-surface-2 text-fg-secondary hover:bg-surface-hover hover:text-fg",
                            )}
                          >
                            {formatTime(slot.start)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[12px] leading-4 text-fg-tertiary">
                Free on your calendars. Nothing is held until you create the
                meeting.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field id="meeting-date" label="Date">
              <Input
                id="meeting-date"
                type="date"
                value={form.date}
                onChange={(event) => {
                  setValidation(null);
                  setForm((v) => ({ ...v, date: event.target.value }));
                }}
              />
            </Field>
            <Field id="meeting-time" label="Start">
              <Input
                id="meeting-time"
                type="time"
                value={form.time}
                onChange={(event) => {
                  setValidation(null);
                  setForm((v) => ({ ...v, time: event.target.value }));
                }}
              />
            </Field>
          </div>

          <div className="space-y-1.5">
            <span className="block text-[12px] leading-4 font-medium text-fg-secondary">
              Duration
            </span>
            <Segmented
              label="Duration"
              size="sm"
              options={DURATIONS}
              value={form.duration}
              onChange={(duration) => setForm((v) => ({ ...v, duration }))}
            />
          </div>

          <Field
            id="meeting-attendees"
            label={
              parsed.length > 0
                ? `Attendees (${parsed.length})`
                : "Attendees"
            }
            helper="Email addresses, separated by commas. Everyone listed gets an invitation."
          >
            <Input
              id="meeting-attendees"
              value={form.attendees}
              autoComplete="off"
              spellCheck={false}
              placeholder="ada@example.com, grace@example.com"
              onChange={(event) => {
                setValidation(null);
                setForm((v) => ({ ...v, attendees: event.target.value }));
              }}
            />
            {/* The addresses as parsed, so a missed comma or a typo shows up
                while it is still being typed rather than on submit. */}
            {parsed.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {parsed.map((entry) => (
                  <li
                    key={entry.label}
                    className={cn(
                      "rounded-[var(--radius-full)] px-2 py-0.5 font-mono text-[11px] leading-4",
                      entry.valid
                        ? "bg-surface-1 text-fg-secondary"
                        : "bg-danger-bg text-danger",
                    )}
                  >
                    {entry.label}
                    {!entry.valid && (
                      <span className="sr-only"> — not an email address</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <Field id="meeting-description" label="Description">
            <Textarea
              id="meeting-description"
              rows={3}
              value={form.description}
              onChange={(event) =>
                setForm((v) => ({ ...v, description: event.target.value }))
              }
            />
          </Field>

          <label
            htmlFor="meeting-link"
            className="flex items-center justify-between gap-3 text-[13px] leading-[18px] text-fg-secondary"
          >
            Include a video link
            <Switch
              id="meeting-link"
              checked={form.includeMeetingLink}
              onCheckedChange={(includeMeetingLink) =>
                setForm((v) => ({ ...v, includeMeetingLink }))
              }
            />
          </label>
        </div>

        <div role="status" aria-live="polite">
          {validation && (
            <p className="text-[12px] leading-4 text-danger">{validation}</p>
          )}
          {create.isError && (
            <div>
              <p className="text-[12px] leading-4 text-danger">
                {friendlyError(
                  create.error instanceof Error
                    ? create.error.message
                    : create.error,
                )}
              </p>
              <TechnicalDetails
                raw={
                  create.error instanceof Error
                    ? create.error.message
                    : create.error
                }
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={create.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={create.isPending}
            aria-busy={create.isPending || undefined}
            onClick={submit}
          >
            {create.isPending && <Spinner />}
            {create.isPending ? "Creating…" : "Create meeting"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Attendee = {
  /** What the chip shows: the display name when there was one. */
  label: string;
  /** The bare address that goes to the server. `""` when unparsable. */
  address: string;
  valid: boolean;
};

/**
 * The typed text, as addresses — through the same parser the composer uses.
 *
 * `Ada Lovelace <ada@example.com>` is what a paste out of any mail client
 * looks like, and splitting on whitespace shredded it into three fragments,
 * none of them an address. splitAddressList honours quotes and angle brackets,
 * so commas and semicolons separate and spaces inside a name do not.
 */
function parseAttendees(text: string): Attendee[] {
  const seen = new Set<string>();
  const out: Attendee[] = [];
  for (const entry of splitAddressList(text.replace(/;/g, ","))) {
    const { name, address } = parseAddress(entry);
    const key = (address || entry).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      /* A parsed pair reads back as it was typed; anything with no address at
         all shows the raw text, because "nope <?>" is a worse answer than
         "nope" about what has to be corrected. */
      label: address ? (name ? `${name} <${address}>` : address) : entry,
      address,
      // The one check the server would fail on anyway, reported while the
      // address is still being typed.
      valid: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address),
    });
  }
  return out;
}

/** Suggestions, split into local calendar days in the order they arrived. */
function groupSlots(
  slots: FreeSlot[],
): Array<{ key: string; slots: FreeSlot[] }> {
  const groups: Array<{ key: string; slots: FreeSlot[] }> = [];
  for (const slot of slots) {
    const key = dayKey(slot.start);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.slots.push(slot);
    else groups.push({ key, slots: [slot] });
  }
  return groups;
}

/** Whether the form is currently sitting on this suggestion. */
function isChosen(slot: FreeSlot, date: string, time: string): boolean {
  if (!date || !time) return false;
  const start = new Date(slot.start);
  if (Number.isNaN(start.getTime())) return false;
  const chosen = new Date(`${date}T${time}`);
  return !Number.isNaN(chosen.getTime()) && chosen.getTime() === start.getTime();
}

type MeetingForm = {
  title: string;
  date: string;
  time: string;
  duration: (typeof DURATIONS)[number]["value"];
  attendees: string;
  description: string;
  includeMeetingLink: boolean;
};

function blankForm(): MeetingForm {
  // ONE Date for both fields. See nextQuarterHour: the rounded value can be
  // tomorrow, and the two must never come from different clocks.
  const start = nextQuarterHour(new Date());
  return {
    title: "",
    date: localDateValue(start),
    time: localTimeValue(start),
    duration: "30",
    attendees: "",
    description: "",
    // On by default: a meeting with attendees and no way to join it is the
    // thing people forget, not the thing they choose.
    includeMeetingLink: true,
  };
}

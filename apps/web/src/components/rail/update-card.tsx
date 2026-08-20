"use client";

import * as React from "react";
import { ArrowUpCircle, ExternalLink, RotateCw } from "lucide-react";
import { Spinner, StatusDot } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/lib/hooks/use-app-state";
import { hasUpdateNews, useUpdate } from "@/lib/hooks/use-update";
import type { UpdateState } from "@/lib/types";

/**
 * The one row in the rail that is about the app itself.
 *
 * It appears only when there is something to do about a version — available,
 * downloading, or downloaded and waiting for a restart. "Up to date" is not
 * news, a failed check is not news, and neither draws anything. That is the
 * same rule the footer alert follows: the rail speaks when it has something
 * to say.
 *
 * Nothing here decides what state the app is in. `useUpdate` polls
 * `GET /api/update` and this renders the `status` it finds, so the card and
 * the server can never disagree about whether an update exists.
 */
export function UpdateCard({ collapsed = false }: { collapsed?: boolean }) {
  const app = useApp();
  const update = useUpdate();
  const state = update.state;
  if (!hasUpdateNews(state)) return null;

  if (collapsed) {
    /* One click to the Updates page, not a popover. The collapsed rail is
       where this used to be an unlabelled arrow-in-a-circle that opened a
       second surface before it opened anything the user could act on. */
    return (
      <div className="px-2 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${headline(state)}. Open update settings.`}
              className="relative w-full text-accent hover:text-accent"
              onClick={() => app.openSettingsSection("updates")}
            >
              <ArrowUpCircle className="size-4" strokeWidth={1.5} />
              {/* Same grammar as the Outreach dot above it: the collapsed
                  rail has no room for the words, so the dot carries the
                  fact and the accessible name carries the sentence. */}
              <StatusDot tone="accent" className="absolute top-1.5 right-1.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{headline(state)}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="px-3 pt-2">
      <div
        // `mailmux-step-in` is the same 240ms rise a new agent step uses. The
        // card arrives out of a poll, with no click behind it, so it eases in
        // rather than appearing between two frames.
        className="mailmux-step-in rounded-[var(--radius-lg)] border border-[var(--accent-line)] bg-accent-subtle p-2"
      >
        <Body state={state} update={update} />
      </div>
    </div>
  );
}

/** The card's contents, shared by the expanded rail and the collapsed popover. */
function Body({
  state,
  update,
}: {
  state: UpdateState;
  update: ReturnType<typeof useUpdate>;
}) {
  return (
    // Polite, not assertive: an update is worth announcing once the screen
    // reader finishes what it is saying, never worth interrupting for.
    <div role="status" aria-live="polite" className="space-y-1.5">
      <div className="flex items-start gap-2">
        <ArrowUpCircle
          aria-hidden="true"
          className="mt-px size-4 shrink-0 text-accent"
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[18px] font-medium text-fg">
            {headline(state)}
          </p>
          <p className="truncate text-[11px] leading-4 text-fg-tertiary">
            {subline(state)}
          </p>
        </div>
      </div>

      {state.status === "downloading" && <Progress value={state.progress} />}

      <Actions state={state} update={update} />

      {/* An error under an offer, never instead of one. The update the user
          was told about is still there; this line says the last attempt at it
          did not work. */}
      {state.error && state.status !== "downloading" && (
        <p className="text-[11px] leading-4 text-warning">{state.error}</p>
      )}

      {/* Why the last press did nothing. A button that refuses silently is the
          one thing worse than a button that is missing. */}
      {update.commandError && (
        <p className="text-[11px] leading-4 text-warning">
          {update.commandError}
        </p>
      )}

      {/* The card is a summary; the page is where the version, the channel and
          the last check time are. Its own line: "What is new" is an inline
          button, and the two would otherwise read as one word. */}
      <div>
        <SettingsLink />
      </div>
    </div>
  );
}

function Actions({
  state,
  update,
}: {
  state: UpdateState;
  update: ReturnType<typeof useUpdate>;
}) {
  const notes = state.notes ? <Notes state={state} /> : null;

  // A self-hosted server has nothing to install into — it is updated with npm
  // or git, by the person who started it. Offering a button would be a lie;
  // the release is a link.
  if (!state.canInstall) {
    return (
      <div className="flex items-center gap-2">
        {state.releaseUrl && (
          <a
            href={state.releaseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[11px] leading-4 text-accent hover:text-[var(--accent-hover)]"
          >
            Release notes
            <ExternalLink aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </a>
        )}
        {notes}
      </div>
    );
  }

  if (state.status === "ready") {
    return (
      <div className="space-y-1.5">
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={update.busy}
          onClick={update.install}
        >
          {update.busy ? <Spinner /> : <RotateCw className="size-3.5" strokeWidth={1.5} />}
          Restart now
        </Button>
        {notes}
      </div>
    );
  }

  if (state.status === "downloading") {
    // No button at all while bytes are moving. A disabled "Download" reads as
    // a control the user broke; the progress bar above already says what is
    // happening.
    return notes;
  }

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={update.busy}
        onClick={update.download}
      >
        {update.busy && <Spinner />}
        Download update
      </Button>
      {notes}
    </div>
  );
}

/**
 * A determinate bar. Determinate on purpose: electron-updater reports real
 * bytes, and an indeterminate stripe over a known percentage would be throwing
 * away the one number that tells somebody whether to wait.
 */
function Progress({ value }: { value: number | null }) {
  const percent = Math.round(Math.min(Math.max(value ?? 0, 0), 1) * 100);
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label="Downloading the update"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 w-full overflow-hidden rounded-[var(--radius-full)] bg-[var(--accent-line)]"
      >
        <div
          className="h-full rounded-[var(--radius-full)] bg-accent-fill transition-[width] duration-[var(--dur-enter)] ease-linear"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="tnum text-[11px] leading-4 text-fg-tertiary">{percent}%</p>
    </div>
  );
}

function SettingsLink() {
  const app = useApp();
  return (
    <button
      type="button"
      onClick={() => app.openSettingsSection("updates")}
      className="text-[11px] leading-4 text-fg-tertiary underline decoration-dotted underline-offset-2 hover:text-fg-secondary"
    >
      Update settings
    </button>
  );
}

/** The changelog, one click away and never in the rail itself. */
function Notes({ state }: { state: UpdateState }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-[11px] leading-4 text-fg-tertiary underline decoration-dotted underline-offset-2 hover:text-fg-secondary"
        >
          What is new
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-3">
        <p className="mb-1.5 text-[12px] leading-4 font-medium text-fg">
          Boxaide {state.latestVersion}
        </p>
        {/* Plain text by the time it arrives: src/update/notes.ts flattens
            the release body, so this only has to wrap and scroll it. */}
        <div className="pane-scroll max-h-64 overflow-y-auto">
          <p className="text-[12px] leading-4 whitespace-pre-wrap text-fg-secondary">
            {state.notes}
          </p>
        </div>
        {state.releaseUrl && (
          <a
            href={state.releaseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-flex items-center gap-1 text-[11px] leading-4 text-accent hover:text-[var(--accent-hover)]"
          >
            Open the release
            <ExternalLink aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One sentence, the same one in the tooltip, the dot's label and the card. */
export function headline(state: UpdateState): string {
  const version = state.latestVersion ?? "a new version";
  switch (state.status) {
    case "downloading":
      return `Downloading ${version}`;
    case "ready":
      return `Boxaide ${version} is ready`;
    default:
      return `Boxaide ${version} is available`;
  }
}

function subline(state: UpdateState): string {
  // Short enough for a 204px rail. The line truncates, and a truncated
  // sentence is a sentence nobody can read.
  if (state.status === "ready") return "Restart to install.";
  return `You are on ${state.currentVersion}`;
}

"use client";

import * as React from "react";
import { toast } from "sonner";
import { Spinner, StatusDot, TechnicalDetails } from "@/components/atoms";
import { PanelHeader } from "@/components/settings/settings-panels";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/api/errors";
import { MAX_MEMORY_FILE_BYTES } from "@/lib/constants";
import { formatListDate, isoAttr, isoTitle } from "@/lib/format/date";
import { useApp } from "@/lib/hooks/use-app-state";
import {
  useMemoryFile,
  useMemoryFiles,
  useSaveMemoryFile,
} from "@/lib/hooks/use-memory";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MemoryFile } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * What I remember: the notes the agent writes into its own workspace as it
 * learns about this install — who the company is, how the user sounds, who
 * matters. The panel is the "what I remember" view, not a configuration
 * screen: read what the agent wrote, correct a line, save.
 *
 * Deliberately read-and-correct only. The agent owns the file set — which
 * topics exist and when one is retired — so there is no create and no delete
 * here; a form for inventing notes would be a second place holding that
 * opinion. What a person gets is exactly one power: their correction wins on
 * the next conversation.
 */
export function MemoryPanel() {
  const app = useApp();
  const ctx = useApiCtx();
  const connected = ctx.baseUrl.length > 0 && ctx.token.length > 0;
  const files = useMemoryFiles();

  const rows = files.data ?? [];
  const loaded = files.isSuccess;

  return (
    <div className="space-y-5">
      <PanelHeader title="What I remember">
        Notes your agent keeps about your work, in its own words. Correct a
        line and save — the next conversation reads your version.
      </PanelHeader>

      {/* The query is switched off without a token, so it never resolves and a
          spinner would sit there for ever. Say what is missing, and go there. */}
      {!connected && (
        <div className="space-y-2">
          <p className="text-[12px] leading-4 text-fg-secondary">
            Connect this page to your Boxaide server to read its notes.
          </p>
          <Button
            type="button"
            onClick={() => app.openSettingsSection("connection")}
          >
            Open Connection settings
          </Button>
        </div>
      )}

      {connected && files.isPending && (
        <p className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
          <Spinner />
          Loading notes…
        </p>
      )}

      {files.isError && (
        <div role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
            <StatusDot tone="danger" />
            Could not read the notes from the server.
          </p>
          <p className="text-[12px] leading-4 text-fg-secondary">
            {friendlyError(
              files.error instanceof Error ? files.error.message : files.error,
            )}
          </p>
          <TechnicalDetails
            raw={
              files.error instanceof Error ? files.error.message : files.error
            }
          />
        </div>
      )}

      {loaded && rows.length === 0 && (
        <p className="max-w-[46ch] text-[13px] leading-[18px] text-fg-secondary">
          Your agent hasn&rsquo;t written any notes yet. On your first
          conversation it will offer to read your mailbox and calendar and save
          what it learns here.
        </p>
      )}

      {loaded && rows.length > 0 && <MemoryEditor files={rows} />}
    </div>
  );
}

/**
 * The list of notes beside — above, at this width — the editor for the
 * selected one.
 *
 * Selection is held by name, not index, and derived through `active` rather
 * than kept in step by an effect: if the agent retires the open note while
 * this page is up, the next render simply falls back to the first row instead
 * of pointing the editor at a name that no longer resolves.
 *
 * Unsaved edits are deliberately NOT kept across a note switch, like the
 * half-pasted keys in Connectors: a draft that silently survives being sent
 * away and back is a draft nobody remembers writing.
 */
function MemoryEditor({ files }: { files: MemoryFile[] }) {
  const [selectedName, setSelectedName] = React.useState(
    () => files[0]?.name ?? "",
  );
  const active = files.find((file) => file.name === selectedName) ?? files[0];

  const detail = useMemoryFile(active?.name ?? null);
  const save = useSaveMemoryFile();

  /** Null means "no edits yet" — the textarea shows what the server returned. */
  const [draft, setDraft] = React.useState<string | null>(null);

  const content = draft ?? detail.data?.content ?? "";
  const dirty =
    detail.data !== undefined && draft !== null && draft !== detail.data.content;

  /* Bytes, not characters — the cap the server enforces is UTF-8 bytes. */
  const bytes = React.useMemo(
    () => new TextEncoder().encode(content).length,
    [content],
  );
  const tooBig = bytes > MAX_MEMORY_FILE_BYTES;

  const select = (name: string) => {
    if (name === selectedName) return;
    setSelectedName(name);
    setDraft(null);
  };

  const submit = () => {
    if (!active || !dirty || tooBig || save.isPending) return;
    save.mutate(
      { name: active.name, content },
      { onSuccess: () => toast.success(`${active.name} saved`) },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-4 text-fg-tertiary">
        The agent keeps this list itself, starting and retiring notes as it
        learns. Anything below, you can correct.
      </p>

      <ul aria-label="Notes" className="space-y-1">
        {files.map((file) => {
          const selected = active !== undefined && file.name === active.name;
          return (
            <li key={file.name}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => select(file.name)}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 text-left text-[13px]",
                  selected
                    ? "bg-surface-selected font-medium text-fg"
                    : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.name}
                </span>
                <time
                  dateTime={isoAttr(file.updatedAt)}
                  title={isoTitle(file.updatedAt)}
                  className="tnum shrink-0 text-[11px] leading-4 text-fg-tertiary"
                >
                  {formatListDate(file.updatedAt)}
                </time>
              </button>
            </li>
          );
        })}
      </ul>

      <section className="space-y-2">
        <Label
          htmlFor="memory-content"
          className="block font-mono text-[12px] font-medium text-fg-secondary"
        >
          {active?.name}
        </Label>

        {/* Stays mounted while a note loads — a textarea that vanishes and
            returns makes the page jump — but will not take keystrokes meant
            for text about to be replaced. */}
        <Textarea
          id="memory-content"
          value={content}
          disabled={!active || detail.isPending}
          spellCheck={false}
          aria-busy={detail.isPending || undefined}
          onChange={(event) => setDraft(event.target.value)}
          className="h-[420px] resize-y font-mono"
        />

        {detail.isPending && (
          <p className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
            <Spinner />
            Reading {active?.name}…
          </p>
        )}

        {tooBig && (
          <p className="text-[12px] leading-4 text-warning">
            That is more than the server accepts in one note (64&nbsp;KiB).
            Trim it, then save.
          </p>
        )}

        <Button
          type="button"
          variant="secondary"
          disabled={!dirty || tooBig || save.isPending}
          aria-busy={save.isPending || undefined}
          onClick={submit}
        >
          {save.isPending && <Spinner />}
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </section>

      {/* Mounted whether or not there is anything to report: a live region
          created in the same commit as its content is not announced. */}
      <div role="status" aria-live="polite">
        {detail.isError && (
          <>
            <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
              <StatusDot tone="danger" />
              Could not read {active?.name}.
            </p>
            <p className="text-[12px] leading-4 text-fg-secondary">
              {friendlyError(
                detail.error instanceof Error
                  ? detail.error.message
                  : detail.error,
              )}
            </p>
            <TechnicalDetails
              raw={
                detail.error instanceof Error
                  ? detail.error.message
                  : detail.error
              }
            />
          </>
        )}
        {save.isError && (
          <>
            <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
              <StatusDot tone="danger" />
              Could not save {active?.name}.
            </p>
            <p className="text-[12px] leading-4 text-fg-secondary">
              {friendlyError(
                save.error instanceof Error ? save.error.message : save.error,
              )}
            </p>
            <TechnicalDetails
              raw={
                save.error instanceof Error ? save.error.message : save.error
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { ChevronDown, ExternalLink, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Spinner, StatusDot, TechnicalDetails } from "@/components/atoms";
import { PanelHeader } from "@/components/settings/settings-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import {
  useCheckConnector,
  useConnectors,
  useSetConnectorKey,
} from "@/lib/hooks/use-connectors";
import { capabilityStatus, connectorStatus } from "@/lib/connector-check";
import { byRank, factsFor, CHECKED_ON, type ConnectorFacts } from "@/lib/connector-catalog";
import { cleanPastedKey } from "@/lib/connector-key";
import { useApiCtx } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";
import type { Connector, ConnectorCheck, ConnectorKind } from "@/lib/types";

/**
 * Connectors: the provider API keys Boxaide uses to find prospects, to look up
 * an email address, and to search the web.
 *
 * The screen is three capabilities, not five API keys. Nobody wants a Hunter
 * key; they want agents that can find an email address, and Hunter is one of
 * two ways to get that. So each capability opens with the provider worth
 * reaching for first — the one with a free tier and the lower price, argued out
 * in lib/connector-catalog.ts — and folds the alternative away behind a line
 * that says how many there are. A capability is done when one key works, and
 * the screen says so rather than leaving four empty fields looking unfinished.
 *
 * Every key is optional and outreach already works with none of them.
 *
 * ---------------------------------------------------------------------------
 * Getting a key in as few moves as possible
 * ---------------------------------------------------------------------------
 *
 * None of these five providers offers OAuth to a self-hosted app, so there is
 * no honest one-click button; connector-catalog.ts sets out why per provider.
 * Two clicks is the floor, and this panel is built to hit it:
 *
 *   1. "Get a key" opens the page that issues one — not the vendor's home page,
 *      the API key page itself.
 *   2. Pasting into the field saves and checks. No Save button to find, no
 *      Check button to remember afterwards.
 *
 * A paste is cleaned first (see lib/connector-key.ts), so a whole `.env` line,
 * a quoted string or an `Authorization: Bearer …` header all resolve to the key
 * inside them. What was stripped is said out loud in the toast, because
 * silently editing somebody's secret and then reporting failure is the worst of
 * both. Typing still works, and Enter still saves.
 *
 * ---------------------------------------------------------------------------
 * What the screen is allowed to claim
 * ---------------------------------------------------------------------------
 *
 * Only that a provider answered a real call. Saving is not evidence: PUT
 * /api/connectors/:id stores the string it is given, so a typo saves exactly as
 * happily as a real key. So a save is followed by a check, and the row reports
 * what came back. A refusal is shown in the provider's own words; a provider
 * nobody could reach is its own state and is never red, because a vendor having
 * a bad minute says nothing about the key.
 *
 * Two more rules shape the rows. The server never returns a full key, so a
 * field cannot be pre-filled: every one starts empty, the saved key is shown
 * masked, and typing replaces it. And a key set where the server was started
 * stays underneath a saved one, so Remove says what it falls back to rather
 * than promising the connector is off.
 *
 * Half-typed keys are deliberately NOT kept across a section switch: a key is
 * pasted in one motion, so the module-scope draft the Connection panel needs
 * would only keep a secret alive in memory for no gain.
 */

/** The heading for each group, in the order the groups are shown. */
const KIND_TITLE: Record<ConnectorKind, string> = {
  prospecting: "Find prospects",
  enrichment: "Find email addresses",
  search: "Web search",
};

/** The short label the summary strip uses for the same three capabilities. */
const KIND_SUMMARY: Record<ConnectorKind, string> = {
  prospecting: "Prospects",
  enrichment: "Email addresses",
  search: "Web search",
};

const KIND_ORDER: ConnectorKind[] = ["prospecting", "enrichment", "search"];

/** One plain line per group: what a key unlocks, and what happens without one. */
function kindNote(kind: ConnectorKind, working: boolean): string {
  if (kind === "prospecting") {
    return working
      ? "Agents can search for companies and for the people who work at them, then save what they find to the CRM."
      : "Without a key here, agents can only work with contacts you already have.";
  }
  if (kind === "enrichment") {
    return working
      ? "Agents can find and check a work email address from a name and a company domain."
      : "Without a key here, agents cannot look up an address you do not already hold.";
  }
  return working
    ? "Agents search through Boxaide, so every lookup uses a key below."
    : "Without a key here, agents use whatever web search their own tool already has, which may be none.";
}

/**
 * What a group with no rows means. The web app and the Boxaide server are
 * updated separately, so a page newer than its server asks for a connector the
 * server has never heard of. Dropping the whole group leaves nothing to search
 * for and no reason why, which is the worst answer available.
 */
const KIND_MISSING: Record<ConnectorKind, string> = {
  prospecting:
    "Your Boxaide server is older than this page and does not offer prospecting yet. Update the server to turn it on.",
  enrichment:
    "Your Boxaide server is older than this page and does not offer email lookups yet. Update the server to turn it on.",
  search:
    "Your Boxaide server is older than this page and does not offer web search yet. Update the server to turn it on.",
};

export function ConnectorsPanel() {
  const app = useApp();
  const ctx = useApiCtx();
  const connected = ctx.baseUrl.length > 0 && ctx.token.length > 0;
  const connectors = useConnectors();

  const rows = connectors.data?.connectors ?? [];
  const checks = connectors.data?.checks ?? {};
  const groups = KIND_ORDER.map((kind) => {
    const members = byRank(rows.filter((row) => row.kind === kind));
    return {
      kind,
      members,
      // "Working" is a stronger claim than "configured", and it is the one the
      // group note and the strip are allowed to make.
      working: members.some((row) => checks[row.id]?.verdict === "works"),
      summary: capabilityStatus(members, checks),
    };
  });
  const loaded = connectors.isSuccess;

  return (
    <div className="space-y-5">
      <PanelHeader title="Connectors">
        Outreach already works with no keys at all. Each key below switches on
        one more thing your agents can do. One working key finishes a section:
        the second provider is an alternative, not a second step.
      </PanelHeader>

      {/* The query is switched off without a token, so it never resolves and a
          spinner would sit there for ever. Say what is missing, and go there. */}
      {!connected && (
        <div className="space-y-2">
          <p className="text-[12px] leading-4 text-fg-secondary">
            Connect this page to your Boxaide server before you add any keys.
          </p>
          <Button
            type="button"
            onClick={() => app.openSettingsSection("connection")}
          >
            Open Connection settings
          </Button>
        </div>
      )}

      {connected && connectors.isPending && (
        <p className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
          <Spinner />
          Loading connectors…
        </p>
      )}

      {connectors.isError && (
        <div role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
            <StatusDot tone="danger" />
            Could not read connectors from the server.
          </p>
          <p className="text-[12px] leading-4 text-fg-secondary">
            {friendlyError(
              connectors.error instanceof Error
                ? connectors.error.message
                : connectors.error,
            )}
          </p>
          <TechnicalDetails
            raw={
              connectors.error instanceof Error
                ? connectors.error.message
                : connectors.error
            }
          />
        </div>
      )}

      {loaded && (
        <>
          <ul className="flex flex-wrap gap-2" aria-label="Which keys are working">
            {groups.map((group) => (
              <li
                key={group.kind}
                className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle px-2 py-1 text-[12px] leading-4 text-fg-secondary"
              >
                <StatusDot tone={group.summary.tone} />
                {KIND_SUMMARY[group.kind]}
                <span className="text-fg-tertiary">{group.summary.words}</span>
              </li>
            ))}
          </ul>

          {groups.map((group) => (
            <CapabilitySection
              key={group.kind}
              kind={group.kind}
              connectors={group.members}
              checks={checks}
              note={
                group.members.length === 0
                  ? KIND_MISSING[group.kind]
                  : kindNote(group.kind, group.working)
              }
            />
          ))}

          <p className="text-[12px] leading-4 text-fg-tertiary">
            Prices and free allowances here were read off each provider&apos;s own
            pricing page on {CHECKED_ON}. Every card links to that page, which is
            the one that is current.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * One capability: what it unlocks, then the provider worth reaching for first,
 * then the alternatives folded away.
 *
 * A provider that already holds a key is never folded away, whatever its rank.
 * Hiding a key somebody has to change or remove behind a disclosure would make
 * the screen lie about what is set.
 */
function CapabilitySection({
  kind,
  connectors,
  checks,
  note,
}: {
  kind: ConnectorKind;
  connectors: Connector[];
  checks: Record<string, ConnectorCheck>;
  note: string;
}) {
  const [first, ...rest] = connectors;
  const pinned = rest.filter((row) => row.configured);
  const folded = rest.filter((row) => !row.configured);
  const [open, setOpen] = React.useState(false);
  const rowId = (id: string) => `connector-alternative-${kind}-${id}`;

  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-medium text-fg">{KIND_TITLE[kind]}</h3>
      <p className="text-[12px] leading-4 text-fg-tertiary">{note}</p>

      {first && (
        <ConnectorCard
          connector={first}
          check={checks[first.id]}
          recommended={connectors.length > 1}
        />
      )}

      {/* Every alternative is a keyed child of this one element, and a folded
          one is hidden rather than left unrendered. Saving a key moves a row
          from folded to pinned, and a row that changed parent on the way would
          be torn down and rebuilt while its check was still running: the
          spinner would vanish, the caret would be dropped, and a check that
          never reached the server would report nothing at all. Same parent,
          same key, same component. */}
      {rest.length > 0 && (
        /* Gaps rather than margins: a hidden row is not a flex item at all, so
           a collapsed fold leaves no space behind it. */
        <div className="flex flex-col gap-2">
          {[
            ...pinned.map((row) => (
              <div key={row.id}>
                <ConnectorCard connector={row} check={checks[row.id]} recommended={false} />
              </div>
            )),
            folded.length === 0 ? null : (
              <button
                key="toggle"
                type="button"
                aria-expanded={open}
                aria-controls={folded.map((row) => rowId(row.id)).join(" ")}
                onClick={() => setOpen((shown) => !shown)}
                className="flex items-center gap-1 rounded-[var(--radius-sm)] text-[12px] leading-4 text-fg-secondary hover:text-fg"
              >
                <ChevronDown
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className={cn(
                    "size-3.5 transition-transform duration-[var(--dur-fast)]",
                    open && "rotate-180",
                  )}
                />
                {open
                  ? "Hide the other option"
                  : folded.length === 1
                    ? `Other option: ${folded[0].label}`
                    : `${folded.length} other options`}
              </button>
            ),
            ...folded.map((row) => (
              <div key={row.id} id={rowId(row.id)} hidden={!open}>
                <ConnectorCard connector={row} check={checks[row.id]} recommended={false} />
              </div>
            )),
          ]}
        </div>
      )}
    </section>
  );
}

/**
 * The vendor's own mark, on a tile the size of two lines of text.
 *
 * The file is served by Boxaide itself out of public/connectors, never fetched
 * from the vendor: a settings screen that phones five companies to draw five
 * rows would tell each of them that this install exists, and would draw nothing
 * at all on a laptop that is offline. See public/connectors/README.md for where
 * each file came from.
 *
 * The label is spelled out beside the mark, so the mark carries no meaning on
 * its own and is hidden from assistive tech. A provider the catalogue has never
 * heard of falls back to its initial, which is honest about being a placeholder
 * rather than pretending to be a logo.
 */
function ConnectorLogo({
  facts,
  label,
}: {
  facts: ConnectorFacts | undefined;
  label: string;
}) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-border-subtle bg-surface-2">
      {facts ? (
        /* eslint-disable-next-line @next/next/no-img-element --
           next/image exists to resize and re-encode, and next.config.ts sets
           images.unoptimized for the static export, so it would emit this same
           tag around a 24px mark that is already the size it is drawn at. */
        <img
          src={facts.logo}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
          className={cn("size-6 object-contain", facts.invertOnDark && "dark:invert")}
        />
      ) : (
        <span aria-hidden="true" className="text-[13px] font-medium text-fg-tertiary">
          {label.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

/** One fact about a provider: a label nobody has to guess at, and the figure. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-[var(--radius-sm)] bg-surface-hover px-1.5 py-0.5">
      <span className="text-[11px] leading-4 tracking-[var(--tracking-label)] text-fg-tertiary uppercase">
        {label}
      </span>
      <span className="text-[12px] leading-4 text-fg-secondary">{value}</span>
    </span>
  );
}

function ConnectorCard({
  connector,
  check,
  recommended,
}: {
  connector: Connector;
  check: ConnectorCheck | undefined;
  recommended: boolean;
}) {
  const save = useSetConnectorKey();
  const probe = useCheckConnector();
  const [value, setValue] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const facts = factsFor(connector.id);
  const inputId = `connector-${connector.id}`;

  /* Remove destroys a key the operator may have to go back to the vendor for,
     so it asks once, inline. It is not a dialog: a dialog for a key you can
     paste again is heavier than the mistake. It gives up after a few seconds so
     a half-pressed Remove is never left armed. */
  React.useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  const write = (apiKey: string, message: string) => {
    save.mutate(
      { id: connector.id, apiKey },
      {
        onSuccess: () => {
          // Only what this save wrote is cleared. A paste that arrived while
          // it was in flight is sitting in the field waiting for Save, and
          // wiping it would lose a key nobody copied twice.
          setValue((current) => (current === apiKey ? "" : current));
          setReveal(false);
          setConfirmRemove(false);
          // Clearing the value disables Save, and a focused element that turns
          // disabled hands focus back to the document, which puts the next Tab
          // at the top of the app. The field is where they will be next anyway.
          inputRef.current?.focus();
          toast.success(message);
          // The check the operator would otherwise have to ask for. A saved key
          // nobody tested is the thing this panel used to get wrong, so the save
          // and the check are one action: paste, answer.
          if (apiKey !== "") probe.mutate(connector.id);
        },
      },
    );
  };

  /**
   * Save whatever was just handed to the field, once the packaging is off.
   * Shared by the paste and by Enter, so both behave the same.
   */
  const commit = (raw: string) => {
    const cleaned = cleanPastedKey(raw);
    // The field keeps the key, packaging off, whatever happens next. A save
    // that fails has to leave something to press Save on again: an empty field
    // sends somebody back to the vendor for a key they already have.
    setValue(cleaned.key);
    if (cleaned.problem) {
      toast.error(cleaned.problem);
      return;
    }
    if (save.isPending) {
      toast.error(
        `Still saving the last ${connector.label} key. Press Save when that finishes.`,
      );
      return;
    }
    write(
      cleaned.key,
      cleaned.removed
        ? `${connector.label} key saved, without ${cleaned.removed}`
        : `${connector.label} key saved`,
    );
  };

  /**
   * A paste is the whole interaction: it saves and it checks. Everything an
   * operator does with an API key between the vendor's page and this field is
   * one ⌘V, and asking them to then find a Save button and afterwards a Check
   * button is two steps that only ever have one answer.
   *
   * Read off the event rather than the field, because React has not written
   * the pasted text into state yet when this fires, and dropped into whatever
   * the field already holds at the caret: a paste that completes a half-typed
   * key has to save the whole of it, not the half that arrived last.
   */
  const paste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (text.trim() === "") return;
    const field = event.currentTarget;
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? value.length;
    event.preventDefault();
    commit(value.slice(0, start) + text + value.slice(end));
  };

  /** Enter in the field is the same save, for a key somebody typed out. */
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (value.trim().length === 0) return;
    commit(value);
  };

  const status = connectorStatus(connector, check, probe.isPending);

  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-border-subtle p-3">
      <div className="flex items-start gap-2.5">
        <ConnectorLogo facts={facts} label={connector.label} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] leading-[18px] font-medium text-fg">
              {connector.label}
            </span>
            {recommended && (
              <span className="rounded-[var(--radius-sm)] bg-accent-subtle px-1.5 py-0.5 text-[11px] leading-4 font-medium text-accent">
                Start here
              </span>
            )}
            <span className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-secondary">
              {status.busy ? <Spinner /> : <StatusDot tone={status.tone} />}
              {status.headline}
              {connector.maskedKey && (
                <span className="font-mono text-fg-tertiary">{connector.maskedKey}</span>
              )}
            </span>
          </div>

          {facts && (
            <p className="text-[12px] leading-4 text-fg-tertiary">{facts.blurb}</p>
          )}

          {facts && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Fact label="Free" value={facts.free} />
              <Fact label="Then" value={facts.paid} />
              <a
                href={facts.pricingHref}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[12px] leading-4 text-accent hover:text-[var(--accent-hover)]"
              >
                Pricing
                <ExternalLink aria-hidden="true" className="size-3" strokeWidth={1.5} />
              </a>
            </div>
          )}

          {facts?.caveat && (
            <p className="text-[12px] leading-4 text-fg-tertiary">{facts.caveat}</p>
          )}
        </div>
      </div>

      <form className="space-y-1" onSubmit={submit}>
        <Label
          htmlFor={inputId}
          className="text-[12px] font-medium text-fg-secondary"
        >
          {connector.configured ? "Replace the API key" : "API key"}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          {/* Not the vendor's home page: the page that issues the key. It is
              first because it is the first thing to do, and it is a link so
              that middle-click and ⌘-click work like every other link. It stays
              once a key is saved, quieter: the row that needs the key page
              most is the one holding a key the provider just refused. */}
          {facts && (
            <Button asChild variant={connector.configured ? "secondary" : "default"}>
              <a href={facts.keysHref} target="_blank" rel="noreferrer noopener">
                Get a key
                <ExternalLink aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
              </a>
            </Button>
          )}
          <div className="relative w-full max-w-[300px]">
            <Input
              id={inputId}
              ref={inputRef}
              type={reveal ? "text" : "password"}
              value={value}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              placeholder="Paste it here"
              className="pr-8 font-mono"
              onPaste={paste}
              onChange={(event) => setValue(event.target.value)}
            />
            <button
              type="button"
              aria-label={reveal ? "Hide key" : "Show key"}
              onClick={() => setReveal((shown) => !shown)}
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-tertiary hover:bg-surface-hover hover:text-fg"
            >
              {reveal ? (
                <EyeOff className="size-3.5" strokeWidth={1.5} />
              ) : (
                <Eye className="size-3.5" strokeWidth={1.5} />
              )}
            </button>
          </div>
          {/* Only for a key somebody typed instead of pasting. A paste has
              already saved by the time this could be pressed. */}
          <Button
            type="submit"
            variant="secondary"
            disabled={value.trim().length === 0 || save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending && <Spinner />}
            Save
          </Button>
          {/* One button for the key nobody can paste here: the one set where
              the server was started. It is also the way back after a provider
              could not be reached, which is nobody's fault and passes. */}
          {connector.configured && (
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending || probe.isPending}
              aria-busy={probe.isPending || undefined}
              onClick={() => probe.mutate(connector.id)}
            >
              {probe.isPending && <Spinner />}
              {check ? "Check again" : "Check"}
            </Button>
          )}
          {connector.source === "settings" && (
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending || probe.isPending}
              onClick={() => {
                if (!confirmRemove) {
                  setConfirmRemove(true);
                  return;
                }
                write("", `${connector.label} key removed`);
              }}
            >
              {confirmRemove ? "Remove?" : "Remove"}
            </Button>
          )}
        </div>
        {!connector.configured && (
          <p className="text-[12px] leading-4 text-fg-tertiary">
            Pasting saves the key and asks {connector.label} whether it works.
            A whole line out of a .env file works too. Boxaide takes the
            variable name and the quotes off first.
          </p>
        )}
      </form>

      {connector.source === "settings" ? (
        <p className="text-[12px] leading-4 text-fg-tertiary">
          Remove deletes the saved key. If a key was also set where the Boxaide
          server was started, that key takes over.
        </p>
      ) : connector.source === "env" ? (
        <p className="text-[12px] leading-4 text-fg-tertiary">
          This key was set when the Boxaide server was started, so it cannot be
          changed here. Saving a key on this row wins over it.
        </p>
      ) : null}

      <div role="status" aria-live="polite">
        {status.reason && (
          <p className="text-[12px] leading-4 text-fg-secondary">
            {connector.label} said: {status.reason}
          </p>
        )}
        {status.hint && (
          <p className="text-[12px] leading-4 text-fg-tertiary">{status.hint}</p>
        )}
        {facts?.checkCost && !status.busy && (
          <p className="text-[12px] leading-4 text-fg-tertiary">{facts.checkCost}</p>
        )}
        {probe.isError && (
          <>
            <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
              <StatusDot tone="danger" />
              Could not ask your Boxaide server to check the key.
            </p>
            <p className="text-[12px] leading-4 text-fg-secondary">
              {friendlyError(
                probe.error instanceof Error ? probe.error.message : probe.error,
              )}
            </p>
            <TechnicalDetails
              raw={probe.error instanceof Error ? probe.error.message : probe.error}
            />
          </>
        )}
        {save.isError && (
          <>
            <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
              <StatusDot tone="danger" />
              Could not save the key.
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

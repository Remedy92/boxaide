"use client";

import * as React from "react";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
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
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { Connector, ConnectorCheck, ConnectorKind } from "@/lib/types";

/**
 * Connectors: the provider API keys Boxaide uses to find prospects, to look up
 * an email address, and to search the web.
 *
 * Every key is optional. Outreach already works with none of them, so the panel
 * reads as three capabilities that are off until a key turns them on, not as a
 * setup checklist. The summary at the top says which three have a key so nobody
 * has to read every row to find out.
 *
 * The summary only ever says a capability is on when a provider has answered a
 * real call with the key behind it. Saving is not evidence: PUT
 * /api/connectors/:id stores the string it is given, so a typo saves exactly as
 * happily as a real key. So saving is followed by a check: the server makes the
 * smallest authenticated call that provider offers and the row reports what came
 * back. A refusal is shown in the provider's own words with the next thing to
 * try, and a provider nobody could reach is its own state, because a vendor
 * having a bad minute says nothing about the key.
 *
 * The check costs the operator no extra step. It runs itself the moment a save
 * succeeds, and the Check button exists for the one key that cannot be saved
 * here: the one set where the server was started.
 *
 * Two more rules shape the rows. The server never returns a full key, so an
 * input cannot be pre-filled with the saved value: every field starts empty, the
 * saved key is shown masked underneath, and typing replaces it. And a key set
 * where the server was started stays underneath a saved one, so Remove says what
 * it falls back to rather than promising the connector is off.
 *
 * Each row is its own form, so a pasted key saves on Enter with no button hunt
 * and no confirmation step. Half-typed keys are deliberately NOT kept across a
 * section switch: a key is pasted in one motion, so the module-scope draft the
 * Connection panel needs would only keep a secret alive in memory for no gain.
 */

type Meta = {
  blurb: string;
  keysHref: string;
  keysLabel: string;
  /**
   * What checking this key costs, when it costs anything. Two of the five
   * providers have no free way to test a key, and an operator is owed that
   * before Boxaide spends their money on their behalf.
   */
  checkCost?: string;
};

/** Copy and key-page links, keyed by connector id. The server sends the rest. */
const META: Record<string, Meta> = {
  apollo: {
    blurb:
      "Searches for companies and for the people who work at them, so an agent can find prospects you do not have yet.",
    keysHref: "https://app.apollo.io/#/settings/integrations/api",
    keysLabel: "app.apollo.io API settings",
  },
  hunter: {
    blurb: "Finds and verifies work email addresses from a name and a domain.",
    keysHref: "https://hunter.io/api-keys",
    keysLabel: "hunter.io API keys",
  },
  prospeo: {
    blurb: "A second source for the same lookup, tried when Hunter finds nothing.",
    keysHref: "https://prospeo.io/api",
    keysLabel: "prospeo.io API",
  },
  exa: {
    blurb: "Searches the web and reads pages, for research on a person or a company.",
    keysHref: "https://dashboard.exa.ai/api-keys",
    keysLabel: "dashboard.exa.ai",
    checkCost:
      "Exa has no free way to test a key, so a check runs one small search. That costs a fraction of a penny.",
  },
  parallel: {
    blurb: "A second web search source, used when Exa has no key.",
    keysHref: "https://platform.parallel.ai/settings/api-keys",
    keysLabel: "platform.parallel.ai",
    checkCost:
      "Parallel has no free way to test a key, so a check runs one small search. That costs a fraction of a penny.",
  },
};

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
function kindNote(kind: ConnectorKind, configured: boolean): string {
  if (kind === "prospecting") {
    return configured
      ? "With a working key, agents can search for companies and for the people who work at them, then save what they find to the CRM."
      : "Without a key here, agents can only work with contacts you already have.";
  }
  if (kind === "enrichment") {
    return configured
      ? "With a working key, agents can find and check a work email address from a name and a company domain."
      : "Without a key here, agents cannot look up an address you do not already hold.";
  }
  return configured
    ? "Agents search through Boxaide, so every lookup uses the key below."
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
    const members = rows.filter((row) => row.kind === kind);
    return {
      kind,
      members,
      configured: members.some((row) => row.configured),
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
        one more thing your agents can do: find new prospects, look up an email
        address, or search the web. Paste a key and press Enter. Boxaide then
        asks the provider whether the key works, and the row says what it said.
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
            <ConnectorSection
              key={group.kind}
              kind={group.kind}
              connectors={group.members}
              checks={checks}
              autoFocusId={firstEmptyId(groups)}
            >
              {group.members.length === 0
                ? KIND_MISSING[group.kind]
                : kindNote(group.kind, group.working)}
            </ConnectorSection>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The row whose field opens with the caret in it: the first one with no key.
 * When every connector already has one, nothing is focused, because returning
 * to this panel must not drop the caret into a password field on its own.
 */
function firstEmptyId(
  groups: { members: Connector[] }[],
): string | null {
  for (const group of groups) {
    for (const member of group.members) {
      if (!member.configured) return member.id;
    }
  }
  return null;
}

function ConnectorSection({
  kind,
  connectors,
  checks,
  autoFocusId,
  children,
}: {
  kind: ConnectorKind;
  connectors: Connector[];
  checks: Record<string, ConnectorCheck>;
  autoFocusId: string | null;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-medium text-fg">{KIND_TITLE[kind]}</h3>
      {children && (
        <p className="text-[12px] leading-4 text-fg-tertiary">{children}</p>
      )}
      <div className="space-y-3">
        {connectors.map((connector) => (
          <ConnectorRow
            key={connector.id}
            connector={connector}
            check={checks[connector.id]}
            autoFocus={connector.id === autoFocusId}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectorRow({
  connector,
  check,
  autoFocus,
}: {
  connector: Connector;
  check: ConnectorCheck | undefined;
  autoFocus: boolean;
}) {
  const save = useSetConnectorKey();
  const probe = useCheckConnector();
  const [value, setValue] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const meta = META[connector.id];
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
          setValue("");
          setReveal(false);
          setConfirmRemove(false);
          // Clearing the value disables Save, and a focused element that turns
          // disabled hands focus back to the document, which puts the next Tab
          // at the top of the app. The field is where they will be next anyway.
          inputRef.current?.focus();
          toast.success(message);
          // The check the operator would otherwise have to ask for. A saved key
          // nobody tested is the thing this panel used to get wrong, so the save
          // and the check are one action: paste, Enter, answer.
          if (apiKey !== "") probe.mutate(connector.id);
        },
      },
    );
  };

  /** Enter in the field is a save: one paste, one keystroke, no dialog. */
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (key.length === 0 || save.isPending) return;
    write(key, `${connector.label} key saved`);
  };

  const status = connectorStatus(connector, check, probe.isPending);

  return (
    <div className="space-y-1.5 rounded-[var(--radius-md)] border border-border-subtle p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] leading-[18px] font-medium text-fg">
          {connector.label}
        </span>
        <span className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-secondary">
          {status.busy ? <Spinner /> : <StatusDot tone={status.tone} />}
          {status.headline}
          {connector.maskedKey && (
            <span className="font-mono text-fg-tertiary">{connector.maskedKey}</span>
          )}
        </span>
      </div>

      {meta && (
        <p className="text-[12px] leading-4 text-fg-tertiary">
          {meta.blurb}{" "}
          <a
            href={meta.keysHref}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-accent hover:text-[var(--accent-hover)]"
          >
            {meta.keysLabel}
            <ExternalLink aria-hidden="true" className="size-3" strokeWidth={1.5} />
          </a>
        </p>
      )}

      <form className="space-y-1" onSubmit={submit}>
        <Label
          htmlFor={inputId}
          className="text-[12px] font-medium text-fg-secondary"
        >
          API key
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-[320px]">
            <Input
              id={inputId}
              ref={inputRef}
              autoFocus={autoFocus}
              type={reveal ? "text" : "password"}
              value={value}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              placeholder={
                connector.configured ? "Enter a new key" : "Paste the API key"
              }
              className="pr-8 font-mono"
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
          <Button
            type="submit"
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
              Check
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
        {meta?.checkCost && !status.busy && (
          <p className="text-[12px] leading-4 text-fg-tertiary">{meta.checkCost}</p>
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

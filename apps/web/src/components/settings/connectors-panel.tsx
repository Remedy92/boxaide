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
import { useConnectors, useSetConnectorKey } from "@/lib/hooks/use-connectors";
import type { Connector, ConnectorKind } from "@/lib/types";

/**
 * Connectors: the provider API keys Boxaide uses for prospect data and for web
 * search.
 *
 * Two rules shape this panel. The server never returns a full key, so an input
 * cannot be pre-filled with the saved value: every field starts empty, the
 * saved key is shown masked underneath, and typing replaces it. And a key in
 * the server's environment stays underneath a saved one, so Remove says what it
 * falls back to rather than promising the connector is off.
 *
 * Half-typed keys are deliberately NOT kept across a section switch. Each row
 * has its own Save and a key is pasted in one motion, so the module-scope draft
 * the Connection panel needs would only keep a secret alive in memory for no
 * gain. Leaving the section loses what was typed, like any unsaved form.
 */

type Meta = { blurb: string; keysHref: string; keysLabel: string };

/** Copy and key-page links, keyed by connector id. The server sends the rest. */
const META: Record<string, Meta> = {
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
    blurb: "Neural web search, for research on a person or a company.",
    keysHref: "https://dashboard.exa.ai/api-keys",
    keysLabel: "dashboard.exa.ai",
  },
  parallel: {
    blurb: "An alternative web index, used when Exa is not configured.",
    keysHref: "https://platform.parallel.ai/settings/api-keys",
    keysLabel: "platform.parallel.ai",
  },
};

const KIND_TITLE: Record<ConnectorKind, string> = {
  enrichment: "Enrichment",
  search: "Web search",
};

export function ConnectorsPanel() {
  const connectors = useConnectors();

  const rows = connectors.data ?? [];
  const enrichment = rows.filter((row) => row.kind === "enrichment");
  const search = rows.filter((row) => row.kind === "search");
  const searchConfigured = search.some((row) => row.configured);

  return (
    <div className="space-y-5">
      <PanelHeader title="Connectors">
        Enrichment connectors find and verify a prospect&rsquo;s email address.
        Search connectors give your agents web search. Without a search
        connector, a launched agent falls back to its own CLI&rsquo;s web search.
      </PanelHeader>

      {connectors.isPending && (
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

      {enrichment.length > 0 && (
        <ConnectorSection kind="enrichment" connectors={enrichment} />
      )}

      {search.length > 0 && (
        <ConnectorSection kind="search" connectors={search}>
          {searchConfigured
            ? "Agents search through Boxaide, so every lookup uses the key above."
            : "No search connector, so a launched agent keeps its own CLI's web search and fetch."}
        </ConnectorSection>
      )}
    </div>
  );
}

function ConnectorSection({
  kind,
  connectors,
  children,
}: {
  kind: ConnectorKind;
  connectors: Connector[];
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
          <ConnectorRow key={connector.id} connector={connector} />
        ))}
      </div>
    </section>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const save = useSetConnectorKey();
  const [value, setValue] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const meta = META[connector.id];
  const inputId = `connector-${connector.id}`;

  const write = (apiKey: string, message: string) => {
    save.mutate(
      { id: connector.id, apiKey },
      {
        onSuccess: () => {
          setValue("");
          setReveal(false);
          toast.success(message);
        },
      },
    );
  };

  return (
    <div className="space-y-1.5 rounded-[var(--radius-md)] border border-border-subtle p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] leading-[18px] font-medium text-fg">
          {connector.label}
        </span>
        <ConnectorStatus connector={connector} />
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

      <div className="space-y-1">
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
            type="button"
            disabled={value.trim().length === 0 || save.isPending}
            aria-busy={save.isPending || undefined}
            onClick={() => write(value.trim(), `${connector.label} key saved`)}
          >
            {save.isPending && <Spinner />}
            Save
          </Button>
          {connector.source === "settings" && (
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending}
              onClick={() => write("", `${connector.label} key removed`)}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      {connector.source === "settings" ? (
        <p className="text-[12px] leading-4 text-fg-tertiary">
          Remove deletes the saved key. If the server also has one in its
          environment, that key takes over.
        </p>
      ) : connector.source === "env" ? (
        <p className="text-[12px] leading-4 text-fg-tertiary">
          Read from the server&rsquo;s environment. Saving a key here overrides
          it.
        </p>
      ) : null}

      <div role="status" aria-live="polite">
        {save.isError && (
          <>
            <p className="flex items-center gap-1.5 text-[12px] leading-4 text-danger">
              <StatusDot tone="danger" />
              The server did not accept that change.
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

/**
 * One line saying where the key came from. An environment key is read-only
 * here, but it is not fixed: saving a key on this row takes precedence over it.
 */
function ConnectorStatus({ connector }: { connector: Connector }) {
  if (connector.source === "settings") {
    return (
      <span className="flex items-center gap-1.5 text-[12px] leading-4 text-success">
        <StatusDot tone="success" />
        Configured in settings
        {connector.maskedKey && (
          <span className="font-mono text-fg-tertiary">{connector.maskedKey}</span>
        )}
      </span>
    );
  }
  if (connector.source === "env") {
    return (
      <span className="flex items-center gap-1.5 text-[12px] leading-4 text-success">
        <StatusDot tone="success" />
        Configured via environment variable
        {connector.maskedKey && (
          <span className="font-mono text-fg-tertiary">{connector.maskedKey}</span>
        )}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-tertiary">
      <StatusDot tone="muted" />
      Not configured
    </span>
  );
}

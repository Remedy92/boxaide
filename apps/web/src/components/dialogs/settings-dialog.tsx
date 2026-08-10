"use client";

import * as React from "react";
import { Check, Copy, Eye, EyeOff, Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Spinner, StatusDot, TechnicalDetails, type DotTone } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ApiError, friendlyError } from "@/lib/api/errors";
import { getApiHealth, getHealth, getMeta } from "@/lib/api/endpoints";
import { useApp } from "@/lib/hooks/use-app-state";
import { useMeta } from "@/lib/hooks/use-connection";
import { useMcpTools } from "@/lib/hooks/use-mcp-tools";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";
import { hostLabel, isValidBaseUrl, normalizeBaseUrl } from "@/lib/settings";
import { cn, copyToClipboard } from "@/lib/utils";

type TestResult = { tone: DotTone; message: string; note?: string; raw?: string };

/**
 * §6.7. The MCP snippet is built client-side from localStorage — never from
 * GET /api/agent-connect, whose response embeds the full bearer token and would
 * put it into a document served from a third-party origin.
 */
export function SettingsDialog({
  open,
  focus,
  autoTest,
  onOpenChange,
}: {
  open: boolean;
  focus: "baseUrl" | "token" | null;
  /** A nonce from the command palette's `Test connection` row, or null. */
  autoTest?: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Mounting only while open means the fields initialise from localStorage
  // during render instead of being synced by an effect.
  if (!open) return null;
  return (
    <SettingsBody focus={focus} autoTest={autoTest ?? null} onOpenChange={onOpenChange} />
  );
}

function SettingsBody({
  focus,
  autoTest,
  onOpenChange,
}: {
  focus: "baseUrl" | "token" | null;
  autoTest: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const app = useApp();
  const settings = useSettings();
  const update = useUpdateSettings();
  const meta = useMeta();
  const mcp = useMcpTools();
  const { theme, setTheme } = useTheme();

  const [baseUrl, setBaseUrl] = React.useState(() => settings.baseUrl);
  const [token, setToken] = React.useState(() => settings.token);
  const [reveal, setReveal] = React.useState(false);
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [copied, setCopied] = React.useState(false);
  const baseUrlRef = React.useRef<HTMLInputElement | null>(null);
  const tokenRef = React.useRef<HTMLInputElement | null>(null);
  const snippetRef = React.useRef<HTMLPreElement | null>(null);
  // This dialog unmounts on close (`if (!open) return null` above), which is
  // well inside the 1200ms confirm window, so the timer has to be cancellable.
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  /* Focus only — no state is written here, so no cascading render. */
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (focus === "baseUrl") baseUrlRef.current?.focus();
      if (focus === "token") {
        tokenRef.current?.focus();
        tokenRef.current?.select();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [focus]);

  const dirty =
    normalizeBaseUrl(baseUrl) !== settings.baseUrl || token !== settings.token;

  const save = () => {
    if (!isValidBaseUrl(baseUrl)) {
      setUrlError("Enter a full URL, like http://127.0.0.1:8787");
      baseUrlRef.current?.focus();
      return;
    }
    update({ baseUrl: normalizeBaseUrl(baseUrl), token });
    toast.success("Settings saved");
  };

  /** §6.7: /health → /api/health → /api/meta, in that order, first failure wins. */
  const runTest = async () => {
    if (!isValidBaseUrl(baseUrl)) {
      setUrlError("Enter a full URL, like http://127.0.0.1:8787");
      return;
    }
    const ctx = { baseUrl: normalizeBaseUrl(baseUrl), token };
    setTesting(true);
    setResult(null);
    try {
      const health = await getHealth(ctx);
      const api = await getApiHealth(ctx);
      await getMeta(ctx);
      setResult({
        tone: "success",
        message: `Connected — mailmux ${api.version}`,
        note: health.fixture
          ? "Fixture mode — the mail you see is demo data."
          : undefined,
      });
    } catch (error) {
      setResult(describeFailure(error, hostLabel(ctx.baseUrl)));
    } finally {
      setTesting(false);
    }
  };

  /* The palette's `Test connection` row opens this dialog and runs the test,
     so the command does what its label says rather than only navigating. */
  const runTestRef = React.useRef(runTest);
  React.useEffect(() => {
    runTestRef.current = runTest;
  });
  React.useEffect(() => {
    if (autoTest === null) return;
    void runTestRef.current();
  }, [autoTest]);

  const endpoint = `${normalizeBaseUrl(baseUrl)}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        mailmux: {
          url: endpoint,
          headers: { Authorization: `Bearer ${token || "<your token>"}` },
        },
      },
    },
    null,
    2,
  );

  const copySnippet = async () => {
    const ok = await copyToClipboard(snippet);
    if (!ok) {
      const node = snippetRef.current;
      if (node && typeof window !== "undefined") {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      toast.warning("Press ⌘C to copy");
      return;
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
    toast.success("Copied MCP configuration");
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[560px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle style={{ fontSize: "var(--text-display)" }}>
            Settings
          </DialogTitle>
          <DialogDescription>
            The server URL and the token live in this browser&rsquo;s
            localStorage and are sent only to the server you name here.
          </DialogDescription>
        </DialogHeader>

        {/* ---- Server ---------------------------------------------------- */}
        <section className="space-y-3">
          <h3 className="text-[13px] font-medium text-fg">Server</h3>

          <div className="space-y-1">
            <Label
              htmlFor="settings-base-url"
              className="text-[12px] font-medium text-fg-secondary"
            >
              Server URL
            </Label>
            <Input
              id="settings-base-url"
              ref={baseUrlRef}
              value={baseUrl}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="http://127.0.0.1:8787"
              aria-invalid={urlError ? "true" : undefined}
              aria-describedby={urlError ? "settings-base-url-error" : undefined}
              className="font-mono"
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setUrlError(null);
              }}
              onBlur={() => {
                if (baseUrl && !isValidBaseUrl(baseUrl)) {
                  setUrlError("Enter a full URL, like http://127.0.0.1:8787");
                }
              }}
            />
            {urlError ? (
              <p
                id="settings-base-url-error"
                className="text-[12px] leading-4 text-danger"
              >
                {urlError}
              </p>
            ) : (
              <p className="text-[12px] leading-4 text-fg-tertiary">
                The address your mailmux server listens on. It never leaves this
                browser.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label
              htmlFor="settings-token"
              className="text-[12px] font-medium text-fg-secondary"
            >
              Access token
            </Label>
            <div className="relative">
              <Input
                id="settings-token"
                ref={tokenRef}
                type={reveal ? "text" : "password"}
                value={token}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                className="pr-8 font-mono"
                onChange={(event) => setToken(event.target.value)}
              />
              <button
                type="button"
                aria-label={reveal ? "Hide token" : "Show token"}
                onClick={() => setReveal((value) => !value)}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-tertiary hover:bg-surface-hover hover:text-fg"
              >
                {reveal ? (
                  <EyeOff className="size-3.5" strokeWidth={1.5} />
                ) : (
                  <Eye className="size-3.5" strokeWidth={1.5} />
                )}
              </button>
            </div>
            <p className="text-[12px] leading-4 text-fg-tertiary">
              Run <code className="font-mono">mailmux serve</code> and copy the
              token it prints. It&rsquo;s also in{" "}
              <code className="font-mono">bearer.token</code> inside your data
              directory.
            </p>
            {meta.data?.tokenHint && (
              <p className="font-mono text-[11px] text-fg-tertiary">
                Server expects a token starting {meta.data.tokenHint}
              </p>
            )}
          </div>

          {dirty && (
            <p className="text-[12px] leading-4 text-warning">
              Saving clears everything mailmux has cached from the current
              server.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={testing}
              aria-busy={testing || undefined}
              onClick={() => void runTest()}
            >
              {testing && <Spinner />}
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button type="button" disabled={!dirty} onClick={save}>
              Save
            </Button>
          </div>

          {/* Mounted whether or not there is a result: a live region created in
              the same commit as its content is not announced. Focus stays on
              the Test button, so nothing else would report the outcome. */}
          <div role="status" aria-live="polite">
            {result && (
              <>
              <p className="flex items-center gap-1.5 text-[12px] leading-4">
                <StatusDot tone={result.tone} />
                <span
                  className={
                    result.tone === "success"
                      ? "text-success"
                      : result.tone === "warning"
                        ? "text-warning"
                        : "text-danger"
                  }
                >
                  {result.message}
                </span>
              </p>
              {result.note && (
                <p className="mt-1 text-[12px] leading-4 text-warning">
                  {result.note}
                </p>
              )}
              {result.tone === "danger" && result.message.includes("token") && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-5 px-0"
                  onClick={() => tokenRef.current?.focus()}
                >
                  Check the token
                </Button>
              )}
              <TechnicalDetails raw={result.raw} />
              </>
            )}
          </div>
        </section>

        <Separator className="bg-border-subtle" />

        {/* ---- Appearance ------------------------------------------------- */}
        <section className="space-y-3">
          <h3 className="text-[13px] font-medium text-fg">Appearance</h3>

          <div className="space-y-1">
            <span className="text-[12px] font-medium text-fg-secondary">Theme</span>
            <SegmentGroup
              label="Theme"
              value={theme ?? "system"}
              options={[
                { value: "system", label: "System", icon: Monitor },
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
              ]}
              onSelect={setTheme}
            />
          </div>

          <div className="space-y-1">
            <span className="text-[12px] font-medium text-fg-secondary">
              Density
            </span>
            <SegmentGroup
              label="Density"
              value={app.density}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
              onSelect={(value) => {
                if (app.density !== value) app.toggleDensity();
              }}
            />
          </div>
        </section>

        <Separator className="bg-border-subtle" />

        {/* ---- Agents (MCP) ----------------------------------------------- */}
        <section className="space-y-3">
          <h3 className="text-[13px] font-medium text-fg">Agents (MCP)</h3>
          {/* Not "the same access this page has" unqualified: this page can
              also connect and remove mailboxes, and no MCP tool does either
              (mcp/server.ts exposes seven read/send/mark tools). The
              capabilities dialog carries the same qualifier. */}
          <p className="text-[13px] leading-[18px] text-fg-secondary">
            Point an MCP client at your mailmux server to give it the same
            access to your mail that this page has, through seven tools. It
            cannot connect or remove a mailbox.
          </p>

          <p className="font-mono text-[13px] text-fg-secondary">{endpoint}</p>

          {token && (
            <p className="text-[12px] leading-4 text-warning">
              This snippet contains your token. Don&rsquo;t paste it anywhere
              public.
            </p>
          )}

          <div className="relative">
            <pre
              ref={snippetRef}
              className="overflow-x-auto rounded-[var(--radius-md)] bg-surface-0 p-3 font-mono text-[12px] text-fg-secondary"
            >
              {snippet}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy MCP configuration"
              className="absolute top-1.5 right-1.5"
              onClick={() => void copySnippet()}
            >
              {copied ? (
                <Check className="size-4 text-success" strokeWidth={1.5} />
              ) : (
                <Copy className="size-4" strokeWidth={1.5} />
              )}
            </Button>
          </div>

          <Button
            type="button"
            variant="secondary"
            disabled={mcp.isPending}
            aria-busy={mcp.isPending || undefined}
            onClick={() => mcp.mutate()}
          >
            {mcp.isPending && <Spinner />}
            {mcp.isPending ? "Testing…" : "Test MCP endpoint"}
          </Button>

          <div role="status" aria-live="polite">
            {mcp.isSuccess && (
              <p className="flex items-center gap-1.5 text-[12px] text-success">
                <StatusDot tone="success" />
                Responded — {mcp.data.length} tools available
              </p>
            )}
            {mcp.isError && (
              <>
                <p className="flex items-center gap-1.5 text-[12px] text-danger">
                  <StatusDot tone="danger" />
                  Did not respond
                </p>
                <p className="text-[12px] leading-4 text-fg-secondary">
                  {friendlyError(
                    mcp.error instanceof Error ? mcp.error.message : mcp.error,
                  )}
                </p>
                <TechnicalDetails
                  raw={mcp.error instanceof Error ? mcp.error.message : mcp.error}
                />
              </>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A real APG radio group: one tab stop, arrows move the selection.
 *
 * role="radio" without a roving tabindex and arrow handling makes every option
 * its own tab stop and leaves Arrow keys dead — a screen reader announces
 * "radio, 1 of 3" and then nothing responds (4.1.2).
 */
function SegmentGroup<T extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: LucideIcon }>;
  onSelect: (value: T) => void;
}) {
  const refs = React.useRef(new Map<string, HTMLButtonElement>());
  const index = Math.max(
    options.findIndex((option) => option.value === value),
    0,
  );

  const move = (delta: number) => {
    const next = options[(index + delta + options.length) % options.length];
    onSelect(next.value);
    refs.current.get(next.value)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-1"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) refs.current.set(option.value, node);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(option.value)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-[13px]",
              active
                ? "border-accent bg-accent-subtle text-accent"
                : "border-border-control bg-surface-1 text-fg-secondary hover:border-[var(--text-secondary)]",
            )}
          >
            {Icon && <Icon className="size-3.5" strokeWidth={1.5} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function describeFailure(error: unknown, host: string): TestResult {
  const raw = error instanceof ApiError ? error.raw : String(error ?? "");
  if (error instanceof ApiError) {
    if (error.kind === "unauthorized") {
      return { tone: "danger", message: "Server reached, token rejected.", raw };
    }
    if (error.kind === "forbidden-origin" || error.kind === "cors") {
      return {
        tone: "danger",
        message: "Server reached, but it refused this origin.",
        note: "Set MAILMUX_ALLOWED_ORIGINS on the machine running mailmux, then restart it.",
        raw,
      };
    }
    if (error.kind === "lna-denied") {
      return {
        tone: "warning",
        message: "Your browser blocked the request to your local network.",
        note: "Allow it when Chrome prompts, then reload.",
        raw,
      };
    }
    if (error.kind === "mixed-content") {
      return {
        tone: "danger",
        message: "Your browser blocked this connection.",
        note: "Open the local build at your server's own address instead.",
        raw,
      };
    }
  }
  return { tone: "danger", message: `Can't reach ${host}.`, raw };
}

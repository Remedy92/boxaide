import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { Store } from "./db/store.js";
import { FixtureProvider } from "./provider/fixture.js";
import { ImapSmtpProvider, closeAll } from "./provider/imap-smtp.js";
import { MailService } from "./mail/service.js";
import {
  createApi,
  applyCors,
  authFailure,
  corsGate,
  corsPreflightOrDeny,
  isAllowedOrigin,
  isLocalHostHeader,
  isApiOriginAllowed,
  isLoopbackBindAddress,
  tokensMatch,
} from "./api/routes.js";
import { securityHeaders } from "./api/security-headers.js";
import { handleMcpJsonRpc } from "./mcp/server.js";
import { ScopedTokens, secretsMatch } from "./mcp/scoped-tokens.js";
import type { ScopeProfile } from "./mcp/scope.js";
import { AgentChannel } from "./agent/channel.js";
import { ApprovalQueue } from "./agent/approvals.js";
import { AgentLauncher } from "./agent/launcher.js";
import { createPlatform, type Platform } from "./platform.js";
import {
  consumeGoogleOAuthState,
  googleRedirectUri,
  peekGoogleOAuthState,
} from "./calendar/routes.js";
import { exchangeGoogleCode } from "./calendar/google.js";
import { UpdateService, type UpdateDriver } from "./update/service.js";
import type { MailProvider } from "./provider/types.js";

export {
  isLocalHostHeader,
  isLoopbackBindAddress,
  isAllowedOrigin,
  isApiOriginAllowed,
  tokensMatch,
} from "./api/routes.js";
export { parseAllowedOrigins } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

/** Large enough for normal drafts and settings, small enough to bound JSON parsing. */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
/** Prevent one authenticated request from multiplying work without bound. */
export const MAX_MCP_BATCH_MESSAGES = 50;

export type Runtime = {
  config: AppConfig;
  store: Store;
  mail: MailService;
  provider: MailProvider;
  channel: AgentChannel;
  launcher: AgentLauncher;
  approvals: ApprovalQueue;
  platform: Platform;
  update: UpdateService;
  /**
   * The credentials handed to launched agents. Exposed so a shutdown can
   * revoke them and so tests can assert what a launch was actually given.
   */
  scopedTokens: ScopedTokens;
  app: Hono;
};

/**
 * Everything an embedder may hand in that is not configuration.
 *
 * `updateDriver` is how the Electron shell puts electron-updater behind
 * `/api/update` without this module importing Electron. Absent, the service
 * runs on its manual channel: it states the newest release and links to it.
 */
export type RuntimeOverrides = Partial<AppConfig> & {
  provider?: MailProvider;
  store?: Store;
  updateDriver?: UpdateDriver;
  /** The shell's own version, which beats reading package.json when packaged. */
  appVersion?: string;
};

export function createRuntime(overrides: RuntimeOverrides = {}): Runtime {
  const config = loadConfig(overrides);
  const store =
    overrides.store ??
    (config.dataDir === ":memory:"
      ? new Store(config.masterKey, ":memory:")
      : Store.open(config.dataDir, config.masterKey));

  let provider = overrides.provider;
  if (!provider) {
    if (config.fixtureMode) {
      const fixture = new FixtureProvider();
      provider = fixture;
    } else {
      provider = new ImapSmtpProvider();
    }
  }

  const mail = new MailService(store, provider);
  const channel = new AgentChannel(store);
  // A launched agent connects back over HTTP MCP. The bind host is always
  // loopback in the desktop app and CLI default; a 0.0.0.0 bind still wants
  // the agent talking to the loopback interface, not the wildcard address.
  const launcherHost = isLoopbackBindAddress(config.host) ? config.host : "127.0.0.1";
  // Every launch takes its credential from here instead of the master bearer,
  // and this server is what enforces the scope that credential carries. See
  // src/mcp/scope.ts for why the boundary moved to the server.
  const scopedTokens = new ScopedTokens();
  // The launcher is built before the platform, and a connector saved in
  // Settings must reach the next launch without a restart, so the search check
  // reads through this rather than taking a value now.
  let platformRef: Platform | null = null;
  const launcher = new AgentLauncher({
    mcpUrl: `http://${launcherHost}:${config.port}/mcp`,
    bearerToken: config.bearerToken,
    mintToken: (profile, label) => scopedTokens.mint(profile, label),
    // The operating system's half of the boundary: what a launch may read off
    // the disk, as against what it may call on this server.
    access: config.agentAccess,
    dataDir: config.dataDir,
    // OpenCode is launched as a server and driven from here, so the launcher
    // needs the channel itself, not just its callbacks.
    channel,
    onRunningChange: (id) => channel.setLaunchedAgent(id),
    onActivity: (tool) => channel.noteAgentActivity(tool),
    // False here lets a launched CLI use its own web search and fetch. See
    // LaunchContext.searchConfigured.
    searchConfigured: () => platformRef?.hasSearchConnector() ?? true,
  });
  // The agent platform (CRM, automations, outreach) shares the Store's SQLite
  // handle. Constructed here so every entry point has the tools; its timers
  // start only in startServer — a stdio `boxaide mcp` process must never run
  // a second scheduler against the same database.
  const platform = createPlatform({
    db: store.db,
    masterKey: config.masterKey,
    mail,
    launcher,
    store,
    calendarHelperPath: config.calendarHelperPath,
  });
  platformRef = platform;

  // Sending mail and booking a meeting are the two things a launched agent
  // does that another person sees at once. It may ask for either; this is what
  // holds the request until a human answers, and what carries it out when they
  // do. See src/agent/approvals.ts.
  const approvals = new ApprovalQueue(store, { mail, platform, channel });

  // No timers yet — `startServer` starts them. A stdio `boxaide mcp` process
  // has no UI to show an update in and must not poll GitHub on a timer.
  const update = new UpdateService({
    driver: overrides.updateDriver,
    currentVersion: overrides.appVersion,
  });

  const app = new Hono();
  let bootstrapCapability = config.bootstrapCapability ?? null;

  // First middleware registered, so every route below — UI, API, MCP and any
  // error response — carries the headers. It runs after the handler and only
  // sets headers, so it cannot short-circuit a request.
  app.use("*", securityHeaders());
  const boundedBody = bodyLimit({
    maxSize: MAX_HTTP_BODY_BYTES,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  });
  app.use("/api/*", boundedBody);
  app.use("/mcp", boundedBody);

  // Public health (no auth) for smoke checks. It carries CORS headers so an
  // allowlisted browser origin can tell "server unreachable" apart from
  // "token rejected"; the origin allowlist still gates it.
  app.options("/health", (c) => corsPreflightOrDeny(c, config.allowedOrigins));
  app.get("/health", (c) => {
    const denied = corsGate(c, config.allowedOrigins);
    if (denied) return denied;
    return c.json({ ok: true, service: "boxaide", fixture: config.fixtureMode });
  });

  // Desktop-only bootstrap. Loopback is a network location, not an identity:
  // any process under the local account can call this endpoint. The Electron
  // shell therefore gives its renderer a random capability in the URL
  // fragment (which HTTP never receives), and the page presents it once in a
  // header. Plain browsers use the manual token path.
  app.get("/api/local-bootstrap", (c) => {
    // This handler is registered before the /api/* auth middleware, so it
    // carries its own Origin guard.
    //
    // The bind address is checked first, and it is the only check that is not
    // a browser guard. Host and Origin are attacker-supplied: a remote client
    // on a non-loopback bind sends `Host: localhost` with no Origin and passes
    // both. On such a bind the endpoint does not exist at all, and the token
    // must be pasted in by a human.
    if (!isLoopbackBindAddress(config.host)) {
      return c.json({ error: "not found" }, 404);
    }
    if (!isAllowedOrigin(c.req.header("origin"))) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (!isLocalHostHeader(c.req.header("host"))) {
      return c.json({ error: "localhost only" }, 403);
    }
    const provided = c.req.header("x-boxaide-bootstrap") ?? "";
    if (!bootstrapCapability || !tokensMatch(provided, bootstrapCapability)) {
      return c.json({ error: "desktop capability required" }, 401);
    }
    // Consume before constructing the response. A retry, local race, or page
    // reload cannot turn the short-lived capability into a second credential.
    bootstrapCapability = null;
    // This body is the plaintext bearer token. It carries no CORS headers, so
    // no cross-origin page can read it — but without these it stays
    // heuristically cacheable by the browser and by any local proxy, and the
    // answer varies by Origin.
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return c.json({
      token: config.bearerToken,
      fixture: config.fixtureMode,
      mcpUrl: `http://${config.host}:${config.port}/mcp`,
    });
  });

  // Mount API
  const api = createApi(
    mail,
    config.bearerToken,
    config.allowedOrigins,
    channel,
    launcher,
    platform,
    update,
    approvals,
    {
      host: config.host,
      port: config.port,
      googleClientId: config.googleClientId,
      googleClientSecret: config.googleClientSecret,
    },
  );

  // Google Calendar OAuth callback. Registered on the OUTER app, BEFORE the
  // api mount and so outside the /api/* auth middleware, for the same reason
  // /api/local-bootstrap above is: the browser lands here by a top-level
  // redirect from accounts.google.com and carries no bearer token. Its
  // authentication is the single-use random `state` minted by
  // POST /api/calendar/google/start, which that token-gated route issued.
  app.get("/api/calendar/google/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    // Peek, do not spend: pressing Cancel on Google's consent screen lands
    // here with no code, and burning the state there would make the user
    // retype their client id and secret to try again. The entry stays alive
    // for its TTL so the same authorization link still works.
    const pending = state ? peekGoogleOAuthState(state) : null;
    if (!pending) {
      return c.text("This authorization link is unknown or has expired. Start again from Boxaide.", 400);
    }
    const code = c.req.query("code");
    if (!code) {
      const denied = c.req.query("error");
      return c.text(
        denied
          ? `Google refused the authorization: ${denied}`
          : "Google returned no authorization code.",
        400,
      );
    }
    // A code is in hand: spend the state now, before the exchange, so a leaked
    // callback URL cannot be replayed even if the exchange fails.
    consumeGoogleOAuthState(state);
    try {
      const { refreshToken, email } = await exchangeGoogleCode({
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        code,
        redirectUri: googleRedirectUri({ host: config.host, port: config.port }),
      });
      platform.calendarStore.addAccount({
        alias: pending.alias || email,
        email,
        config: {
          kind: "google",
          clientId: pending.clientId,
          clientSecret: pending.clientSecret,
          refreshToken,
          email,
        },
      });
      return c.html(oauthResultPage("Google Calendar connected — you can close this tab."));
    } catch (err) {
      return c.html(
        oauthResultPage(err instanceof Error ? err.message : String(err)),
        400,
      );
    }
  });

  app.route("/", api);

  // MCP over HTTP (JSON-RPC POST) — same auth as API
  app.options("/mcp", (c) => corsPreflightOrDeny(c, config.allowedOrigins));
  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    const auth = mcpAuth(c, config, scopedTokens);
    if ("failure" in auth) return auth.failure;
    applyCors(c, origin);
    let body: JsonRpcMessage | JsonRpcMessage[];
    try {
      body = await c.req.json<JsonRpcMessage | JsonRpcMessage[]>();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400,
      );
    }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length > MAX_MCP_BATCH_MESSAGES) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "JSON-RPC batch is too large" },
        },
        400,
      );
    }
    const results = [];
    for (const msg of messages) {
      const res = await handleMcpJsonRpc(
        mail,
        msg,
        channel,
        platform,
        c.req.raw.signal,
        auth.scope,
        approvals,
      );
      if (c.req.raw.signal.aborted) return c.body(null);
      if (res != null) results.push(res);
    }
    // A JSON-RPC notification has no id and takes no reply. The streamable-HTTP
    // transport says so explicitly: a body of nothing but notifications and
    // responses MUST be answered with 202 and an empty body.
    //
    // Answering `{}` with a 200 instead is well-formed JSON and is not a
    // JSON-RPC message, which is fatal to a strict client — Codex drops the
    // whole transport on `notifications/initialized` and then reports that the
    // tools do not exist. Claude Code happens to ignore the body. Getting this
    // right is the difference between "works with the client I tested" and
    // "works with any MCP client".
    if (results.length === 0) return c.body(null, 202);
    if (Array.isArray(body)) return c.json(results);
    return c.json(results[0]);
  });

  // Session termination. This server is stateless — there is no session to end
  // — and the spec's answer for that is 405, not the 404 an unrouted DELETE
  // would produce. Clients log the 404 as a transport error on every shutdown.
  app.delete("/mcp", (c) => {
    const auth = mcpAuth(c, config, scopedTokens);
    if ("failure" in auth) return auth.failure;
    applyCors(c, c.req.header("origin"));
    return c.body(null, 405);
  });

  // Agent connect snippet
  app.get("/api/agent-connect", (c) => {
    const failure = authFailure(c, config.bearerToken, config.allowedOrigins);
    if (failure) return failure;
    const base = `http://${config.host}:${config.port}`;
    return c.json({
      mcpHttp: {
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${config.bearerToken}` },
      },
      mcpStdio: {
        command: "npx",
        args: ["tsx", "src/cli.ts", "mcp"],
        env: {
          BOXAIDE_DATA_DIR: config.dataDir,
          BOXAIDE_TOKEN: config.bearerToken,
        },
      },
      claudeDesktop: {
        mcpServers: {
          boxaide: {
            command: "npx",
            args: ["tsx", join(process.cwd(), "src/cli.ts"), "mcp"],
            env: {
              BOXAIDE_DATA_DIR: config.dataDir,
            },
          },
        },
      },
    });
  });

  // Static web UI
  const webRoot = resolveWebRoot(config.webRoot);
  app.get("/", async (c) => {
    const index = join(webRoot, "index.html");
    if (!existsSync(index)) {
      return c.text(
        "Boxaide UI missing. Build it with: npm run build",
        500,
      );
    }
    return c.html(readFileSync(index, "utf8"));
  });

  app.use(
    "/*",
    serveStatic({
      root: webRoot,
    }),
  );

  return {
    config,
    store,
    mail,
    provider,
    channel,
    launcher,
    platform,
    update,
    scopedTokens,
    approvals,
    app,
  };
}

/**
 * Who is calling /mcp, and with what.
 *
 * Two credentials are accepted here and nowhere else in the app: the master
 * bearer, which is unrestricted, and a scoped token minted for one launch.
 * The rest of the API stays master-only on purpose — a launched agent has no
 * business reading settings, minting more credentials, or starting a second
 * agent, and before this it could do all three.
 *
 * The origin guard runs first and is unchanged: a browser page is subject to
 * the same allowlist whichever credential it presents.
 */
function mcpAuth(
  c: Context,
  config: AppConfig,
  tokens: ScopedTokens,
): { scope: ScopeProfile | null } | { failure: Response } {
  const origin = c.req.header("origin");
  if (!isApiOriginAllowed(origin, config.allowedOrigins)) {
    return { failure: authFailure(c, config.bearerToken, config.allowedOrigins)! };
  }
  const header = c.req.header("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (secretsMatch(bearer, config.bearerToken)) return { scope: null };
  const scope = tokens.resolve(bearer);
  if (scope) return { scope };
  applyCors(c, origin);
  return { failure: c.json({ error: "unauthorized" }, 401) };
}

/**
 * The one page a browser sees at the end of the OAuth redirect.
 *
 * No stylesheet, no script, no image: the security headers deny external
 * origins, and this tab is closed a second after it renders.
 */
function oauthResultPage(message: string): string {
  const safe = message.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Boxaide</title></head><body style="font:16px system-ui,sans-serif;padding:3rem;max-width:34rem"><p>${safe}</p></body></html>`;
}

/**
 * Where the UI is served from.
 *
 * `npm run build` exports `apps/web` and copies the result to `web-next`.
 * There is no second UI to fall back to: when the export is absent, `/` says
 * so rather than serving a stale page.
 */
function resolveWebRoot(configured?: string): string {
  if (configured) return configured;
  const candidates = [
    join(process.cwd(), "web-next"),
    join(__dirname, "..", "web-next"),
    join(__dirname, "web-next"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return join(process.cwd(), "web-next");
}

/**
 * Start the HTTP server and resolve only once it is listening.
 *
 * Resolving on the `listening` callback rather than synchronously is what lets
 * an embedder — the Electron shell in `apps/desktop` — open a window the moment
 * this returns instead of polling. It also turns a busy port into a rejected
 * promise the caller can report, rather than an unhandled `error` event.
 */
export async function startServer(
  overrides: RuntimeOverrides = {},
): Promise<{ runtime: Runtime; url: string; stop: () => Promise<void> }> {
  const runtime = createRuntime(overrides);
  // The serve process is the one place platform timers run (CRM sync,
  // automation scheduler, outreach engine).
  runtime.platform.start();
  runtime.mail.start();
  // Same rule for the update check: one process asks, and only the one with a
  // UI attached to the answer.
  runtime.update.start();
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve(
      {
        fetch: runtime.app.fetch,
        hostname: runtime.config.host,
        port: runtime.config.port,
      },
      () => {
        s.off("error", reject);
        resolve(s);
      },
    );
    s.once("error", reject);
  });
  return {
    runtime,
    url: `http://${runtime.config.host}:${runtime.config.port}`,
    stop: async () => {
      server.close();
      // Platform timers before the launcher: a scheduler tick that fires
      // mid-shutdown would spawn a child the close below never sees.
      runtime.platform.stop();
      runtime.update.stop();
      runtime.mail.stop();
      // The launched agent first: it holds an open long poll against the
      // channel, and an orphaned child process would outlive the app.
      runtime.launcher.close();
      // Before the store closes: a parked long poll and the SSE drain interval
      // both hold a reference to it, and both would touch a closed handle.
      runtime.channel.close();
      runtime.store.close();
      await closeAll();
    },
  };
}

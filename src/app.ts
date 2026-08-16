import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
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
  isLoopbackBindAddress,
} from "./api/routes.js";
import { securityHeaders } from "./api/security-headers.js";
import { handleMcpJsonRpc } from "./mcp/server.js";
import { AgentChannel } from "./agent/channel.js";
import { AgentLauncher } from "./agent/launcher.js";
import { createPlatform, type Platform } from "./platform.js";
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

export type Runtime = {
  config: AppConfig;
  store: Store;
  mail: MailService;
  provider: MailProvider;
  channel: AgentChannel;
  launcher: AgentLauncher;
  platform: Platform;
  update: UpdateService;
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
  const launcher = new AgentLauncher({
    mcpUrl: `http://${launcherHost}:${config.port}/mcp`,
    bearerToken: config.bearerToken,
    dataDir: config.dataDir,
    // OpenCode is launched as a server and driven from here, so the launcher
    // needs the channel itself, not just its callbacks.
    channel,
    onRunningChange: (id) => channel.setLaunchedAgent(id),
    onActivity: (tool) => channel.noteAgentActivity(tool),
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
  });

  // No timers yet — `startServer` starts them. A stdio `boxaide mcp` process
  // has no UI to show an update in and must not poll GitHub every six hours.
  const update = new UpdateService({
    driver: overrides.updateDriver,
    currentVersion: overrides.appVersion,
  });

  const app = new Hono();

  // First middleware registered, so every route below — UI, API, MCP and any
  // error response — carries the headers. It runs after the handler and only
  // sets headers, so it cannot short-circuit a request.
  app.use("*", securityHeaders());

  // Public health (no auth) for smoke checks. It carries CORS headers so an
  // allowlisted browser origin can tell "server unreachable" apart from
  // "token rejected"; the origin allowlist still gates it.
  app.options("/health", (c) => corsPreflightOrDeny(c, config.allowedOrigins));
  app.get("/health", (c) => {
    const denied = corsGate(c, config.allowedOrigins);
    if (denied) return denied;
    return c.json({ ok: true, service: "boxaide", fixture: config.fixtureMode });
  });

  // Localhost-only bootstrap so the web UI can pick up the token without copy-paste
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
  );
  app.route("/", api);

  // MCP over HTTP (JSON-RPC POST) — same auth as API
  app.options("/mcp", (c) => corsPreflightOrDeny(c, config.allowedOrigins));
  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    const failure = authFailure(c, config.bearerToken, config.allowedOrigins);
    if (failure) return failure;
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
    const results = [];
    for (const msg of messages) {
      const res = await handleMcpJsonRpc(
        mail,
        msg,
        channel,
        platform,
        c.req.raw.signal,
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
    const failure = authFailure(c, config.bearerToken, config.allowedOrigins);
    if (failure) return failure;
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

  return { config, store, mail, provider, channel, launcher, platform, update, app };
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

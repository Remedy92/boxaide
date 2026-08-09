import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { Store } from "./db/store.js";
import { FixtureProvider } from "./provider/fixture.js";
import { ImapSmtpProvider, closeAll } from "./provider/imap-smtp.js";
import { MailService } from "./mail/service.js";
import {
  createApi,
  authFailure,
  isAllowedOrigin,
  isLocalHostHeader,
} from "./api/routes.js";
import { handleMcpJsonRpc } from "./mcp/server.js";
import type { MailProvider } from "./provider/types.js";

export {
  isLocalHostHeader,
  isAllowedOrigin,
  tokensMatch,
} from "./api/routes.js";

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
  app: Hono;
};

export function createRuntime(
  overrides: Partial<AppConfig> & {
    provider?: MailProvider;
    store?: Store;
  } = {},
): Runtime {
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
  const app = new Hono();

  // Public health (no auth) for smoke checks
  app.get("/health", (c) =>
    c.json({ ok: true, service: "mailmux", fixture: config.fixtureMode }),
  );

  // Localhost-only bootstrap so the web UI can pick up the token without copy-paste
  app.get("/api/local-bootstrap", (c) => {
    // This handler is registered before the /api/* auth middleware, so it
    // carries its own Origin guard.
    if (!isAllowedOrigin(c.req.header("origin"))) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (!isLocalHostHeader(c.req.header("host"))) {
      return c.json({ error: "localhost only" }, 403);
    }
    return c.json({
      token: config.bearerToken,
      fixture: config.fixtureMode,
      mcpUrl: `http://${config.host}:${config.port}/mcp`,
    });
  });

  // Mount API
  const api = createApi(mail, config.bearerToken);
  app.route("/", api);

  // MCP over HTTP (JSON-RPC POST) — same auth as API
  app.post("/mcp", async (c) => {
    const failure = authFailure(c, config.bearerToken);
    if (failure) return failure;
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
      const res = await handleMcpJsonRpc(mail, msg);
      if (res != null) results.push(res);
    }
    if (Array.isArray(body)) return c.json(results);
    return c.json(results[0] ?? {});
  });

  // Agent connect snippet
  app.get("/api/agent-connect", (c) => {
    const failure = authFailure(c, config.bearerToken);
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
          MAILMUX_DATA_DIR: config.dataDir,
          MAILMUX_TOKEN: config.bearerToken,
        },
      },
      claudeDesktop: {
        mcpServers: {
          mailmux: {
            command: "npx",
            args: ["tsx", join(process.cwd(), "src/cli.ts"), "mcp"],
            env: {
              MAILMUX_DATA_DIR: config.dataDir,
            },
          },
        },
      },
    });
  });

  // Static web UI
  const webRoot = resolveWebRoot();
  app.get("/", async (c) => {
    const index = join(webRoot, "index.html");
    if (!existsSync(index)) {
      return c.text("mailmux UI missing", 500);
    }
    const html = readFileSync(index, "utf8").replace(
      "__MAILMUX_PORT__",
      String(config.port),
    );
    return c.html(html);
  });

  app.use(
    "/*",
    serveStatic({
      root: webRoot,
    }),
  );

  return { config, store, mail, provider, app };
}

function resolveWebRoot(): string {
  const candidates = [
    join(process.cwd(), "web"),
    join(__dirname, "..", "web"),
    join(__dirname, "web"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return join(process.cwd(), "web");
}

export async function startServer(
  overrides: Partial<AppConfig> = {},
): Promise<{ runtime: Runtime; stop: () => Promise<void> }> {
  const runtime = createRuntime(overrides);
  const server = serve({
    fetch: runtime.app.fetch,
    hostname: runtime.config.host,
    port: runtime.config.port,
  });
  return {
    runtime,
    stop: async () => {
      server.close();
      runtime.store.close();
      await closeAll();
    },
  };
}

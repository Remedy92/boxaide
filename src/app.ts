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
import { ImapSmtpProvider } from "./provider/imap-smtp.js";
import { MailService } from "./mail/service.js";
import { createApi } from "./api/routes.js";
import { handleMcpJsonRpc } from "./mcp/server.js";
import type { MailProvider } from "./provider/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const host = c.req.header("host") ?? "";
    const isLocal =
      host.startsWith("127.0.0.1") ||
      host.startsWith("localhost") ||
      host.startsWith("[::1]");
    if (!isLocal) return c.json({ error: "localhost only" }, 403);
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
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const q = c.req.query("token") ?? "";
    if (bearer !== config.bearerToken && q !== config.bearerToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json();
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
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const q = c.req.query("token") ?? "";
    if (bearer !== config.bearerToken && q !== config.bearerToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
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
): Promise<{ runtime: Runtime; stop: () => void }> {
  const runtime = createRuntime(overrides);
  const server = serve({
    fetch: runtime.app.fetch,
    hostname: runtime.config.host,
    port: runtime.config.port,
  });
  return {
    runtime,
    stop: () => {
      server.close();
      runtime.store.close();
    },
  };
}

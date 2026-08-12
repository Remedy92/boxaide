#!/usr/bin/env node
/**
 * The mailmux connector for Claude Desktop — a stdio→HTTP proxy.
 *
 * Claude Desktop speaks MCP over stdio to this process; this process forwards
 * every JSON-RPC message to the mailmux server's stateless `POST /mcp` and
 * writes the answer back. It is a proxy and nothing more: no tool logic, no
 * database, no dependencies beyond Node itself.
 *
 * Why a proxy instead of bundling the real server: mailmux keeps mail state in
 * SQLite behind one process (the app or `mailmux serve`). A second in-process
 * copy here would race it over the same database file — and better-sqlite3 is
 * a native module that Claude Desktop's own Node runtime cannot be assumed to
 * load. Forwarding to the one running server sidesteps both, and it means an
 * agent and the mailmux window always see the same live state.
 *
 * Zero configuration is the point. The token comes from, in order:
 *   1. MAILMUX_TOKEN (the extension's optional "Access token" setting),
 *   2. <data dir>/bearer.token — the file the mailmux server itself writes,
 *      because this proxy runs on the same machine as that server.
 * On a 401 the file is re-read once and the call retried, so a token that was
 * created or rotated after Claude Desktop spawned this process still works.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));

const INSTALL_HINT =
  "mailmux is not running. Open the mailmux app (or run `mailmux serve`), then try again. Get it at https://github.com/Remedy92/mailmux";

const baseUrl = normalizeBaseUrl(process.env.MAILMUX_URL || "http://127.0.0.1:8787");
const dataDir = expandHome(process.env.MAILMUX_DATA_DIR || "~/.mailmux");

/** The extension setting, when the user filled it in. Never re-read. */
const configuredToken = (process.env.MAILMUX_TOKEN || "").trim() || null;
/** Last token read from bearer.token; refreshed on 401. */
let fileToken = readTokenFile();

function token() {
  return configuredToken ?? fileToken;
}

function readTokenFile() {
  try {
    const value = readFileSync(join(dataDir, "bearer.token"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** `http://127.0.0.1:8787/` and `127.0.0.1:8787` both become a clean origin. */
function normalizeBaseUrl(raw) {
  let value = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Forward one JSON-RPC message. Returns the reply object, or null when there
 * is nothing to write back (notifications — the server answers those 202).
 */
async function forward(message) {
  const isRequest = message !== null && typeof message === "object" && "id" in message;

  const send = async () => {
    const bearer = token();
    const headers = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
  };

  let response;
  try {
    response = await send();
    if (response.status === 401 && !configuredToken) {
      const fresh = readTokenFile();
      if (fresh && fresh !== fileToken) {
        fileToken = fresh;
        response = await send();
      }
    }
  } catch {
    return isRequest ? offlineAnswer(message) : null;
  }

  if (response.status === 202) return null;
  if (response.status === 401) {
    return isRequest
      ? rpcError(
          message.id,
          -32001,
          `mailmux rejected the access token. The connector reads ${join(dataDir, "bearer.token")}; if your data directory is elsewhere, put the token into the extension's "Access token" setting.`,
        )
      : null;
  }
  if (!response.ok) {
    return isRequest
      ? rpcError(message.id, -32001, `mailmux answered ${response.status}. ${INSTALL_HINT}`)
      : null;
  }

  try {
    return await response.json();
  } catch {
    return isRequest ? rpcError(message.id, -32700, "mailmux sent an unparseable response") : null;
  }
}

function rpcError(id, code, text) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message: text } };
}

/**
 * What the connector says when the mailmux server is not running.
 *
 * The handshake must not fail: Claude Desktop attaches its extensions at its
 * own startup, and "Could not attach" over an app that is merely closed reads
 * as a broken install. So `initialize`, `ping` and `tools/list` are answered
 * here — the tool list from a build-time snapshot of the server's own list
 * (tools.json, written by scripts/export-mcpb-tools.mjs) — and only an actual
 * tool CALL tells the user to open mailmux.
 */
function offlineAnswer(message) {
  const id = message.id ?? null;
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    // Same echo the live server does: mirror the requested version.
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof requested === "string" && requested ? requested : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mailmux", version: "0.1.0" },
      },
    };
  }
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: snapshotTools() } };
  }
  return rpcError(id, -32001, INSTALL_HINT);
}

/** @type {unknown[] | null} */
let toolsSnapshot = null;
function snapshotTools() {
  if (!toolsSnapshot) {
    toolsSnapshot = JSON.parse(readFileSync(join(here, "tools.json"), "utf8"));
  }
  return toolsSnapshot;
}

/** One write call per line: whole lines cannot interleave on the pipe. */
function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/* ---- stdio loop ---------------------------------------------------------- */

let buffer = "";
/** Requests still waiting on the server. Guards shutdown, nothing else. */
let inFlight = 0;
let stdinClosed = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    handleLine(line);
  }
});
// Exit only after in-flight calls finish: their replies are already owed to
// whatever closed stdin, and an immediate exit would drop them.
process.stdin.on("end", () => {
  stdinClosed = true;
  maybeExit();
});

function maybeExit() {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeLine(rpcError(null, -32700, "Parse error"));
    return;
  }
  // Requests run concurrently on purpose: chat_await_message long-polls for up
  // to ~2 minutes, and a ping arriving meanwhile must not queue behind it.
  inFlight += 1;
  forward(message)
    .then((reply) => {
      if (reply != null) writeLine(reply);
    })
    .catch(() => {
      const id = message !== null && typeof message === "object" ? message.id : null;
      if (id !== undefined) writeLine(rpcError(id, -32603, "connector failure"));
    })
    .finally(() => {
      inFlight -= 1;
      maybeExit();
    });
}

process.stderr.write(
  `mailmux connector: forwarding stdio MCP to ${baseUrl}/mcp (token ${token() ? "found" : "not found yet"})\n`,
);

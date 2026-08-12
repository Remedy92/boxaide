/**
 * Snapshots the MCP tool list into the Claude Desktop connector.
 *
 * The connector (apps/mcpb) answers `tools/list` itself while the mailmux
 * server is not running, so Claude Desktop can attach — and show the real
 * tools — before the app is ever opened. That answer must be the server's own
 * list, not a hand-maintained copy, so this script derives it from the
 * compiled server. Run after `npm run build:server`; `npm run mcpb:build`
 * chains it. test/mcpb-proxy.test.ts fails when the committed snapshot drifts.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_TOOLS, TOOLS } from "../dist/mcp/server.js";

// The HTTP server always runs with an agent channel, so the connector's
// offline answer is the full list — mail tools plus chat tools.
const all = [...TOOLS, ...CHAT_TOOLS];
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "apps", "mcpb", "server", "tools.json");
writeFileSync(target, `${JSON.stringify(all, null, 2)}\n`);
console.log(`wrote ${all.length} tools to ${target}`);

/**
 * Copy apps/web/out to web-next and record the source hash.
 * The desktop runner uses that stamp so it does not rebuild a current export.
 */
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markWebExport } from "./lib/stale.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const from = join(root, "apps", "web", "out");
  const to = join(root, "web-next");
  try {
    await stat(join(from, "index.html"));
  } catch {
    throw new Error(`Missing ${join(from, "index.html")}.\nBuild it first:\n  npm --prefix apps/web run build`);
  }
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  await markWebExport(root);
  console.log(`synced ${from} -> ${to}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

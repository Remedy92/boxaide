/**
 * Copy the compiled server and the built UI into `apps/desktop/server/`.
 *
 * The copy is not laziness. The desktop app has its own dependency tree
 * (`apps/desktop/node_modules`), rebuilt against Electron's ABI so
 * `better-sqlite3` loads inside Electron. If the shell imported
 * `../../dist/app.js` directly, Node would resolve that file's bare imports
 * from the *repository* `node_modules` — the tree built for plain Node — and
 * the native module would refuse to load. Importing a copy that sits inside
 * `apps/desktop` puts the resolution walk in the right tree.
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exists, sourceNeedsCopy } from "../../../scripts/lib/stale.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");

const sources = [
  {
    from: join(repoRoot, "dist"),
    to: join(desktopRoot, "server", "dist"),
    probe: "app.js",
    fix: "npm run desktop",
  },
  {
    from: join(repoRoot, "web-next"),
    to: join(desktopRoot, "server", "web-next"),
    probe: "index.html",
    fix: "npm run desktop",
  },
];

/**
 * Dependencies the shell has and the server does not.
 *
 * The check below is an equality check on purpose, so this list is the only
 * way a desktop-only package gets in — and adding one is a deliberate line in
 * a diff rather than drift nobody notices.
 *
 * electron-updater: the auto-updater. It talks to Squirrel and to the GitHub
 * release feed, neither of which exists for `boxaide serve`.
 */
const DESKTOP_ONLY = new Set(["electron-updater"]);

/**
 * The desktop package restates the server's runtime dependencies instead of
 * depending on the repository root, so Electron gets its own installed tree.
 * That restatement is the one thing here that can silently drift, so it is
 * checked on every sync rather than trusted.
 */
export async function assertServerDepsMatch() {
  const [root, desktop] = await Promise.all([
    readFile(join(repoRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(desktopRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  const problems = [];
  for (const [name, range] of Object.entries(root.dependencies ?? {})) {
    const mine = desktop.dependencies?.[name];
    if (!mine) problems.push(`missing "${name}": "${range}"`);
    else if (mine !== range) problems.push(`"${name}" is "${mine}", root has "${range}"`);
  }
  for (const name of Object.keys(desktop.dependencies ?? {})) {
    if (DESKTOP_ONLY.has(name)) continue;
    if (!(name in (root.dependencies ?? {}))) {
      problems.push(`"${name}" is not a dependency of the server any more`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `apps/desktop/package.json dependencies have drifted from the root package.json:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nEdit apps/desktop/package.json to match, then run npm install there.`,
    );
  }
}

export async function syncServer() {
  await assertServerDepsMatch();
  for (const { from, probe, fix } of sources) {
    if (!(await exists(join(from, probe)))) {
      throw new Error(`Missing ${join(from, probe)}.\nBuild it first:\n  ${fix}`);
    }
  }
  await mkdir(join(desktopRoot, "server"), { recursive: true });
  for (const { from, to } of sources) {
    if (!(await sourceNeedsCopy(from, to))) continue;
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
    console.log(`synced ${from} -> ${to}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncServer().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

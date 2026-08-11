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
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");

const sources = [
  {
    from: join(repoRoot, "dist"),
    to: join(desktopRoot, "server", "dist"),
    probe: "app.js",
    fix: "npm run build:server   # in the repository root",
  },
  {
    from: join(repoRoot, "web-next"),
    to: join(desktopRoot, "server", "web-next"),
    probe: "index.html",
    fix: "npm run build          # in the repository root",
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The desktop package restates the server's runtime dependencies instead of
 * depending on the repository root, so Electron gets its own installed tree.
 * That restatement is the one thing here that can silently drift, so it is
 * checked on every sync rather than trusted.
 */
async function assertServerDepsMatch() {
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
    if (!(name in (root.dependencies ?? {}))) {
      problems.push(`"${name}" is not a dependency of the server any more`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `apps/desktop/package.json dependencies have drifted from the root package.json:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nEdit apps/desktop/package.json to match, then run npm install here.`,
    );
  }
}

async function main() {
  await assertServerDepsMatch();
  for (const { from, probe, fix } of sources) {
    if (!(await exists(join(from, probe)))) {
      throw new Error(`Missing ${join(from, probe)}.\nBuild it first:\n  ${fix}`);
    }
  }
  await rm(join(desktopRoot, "server"), { recursive: true, force: true });
  await mkdir(join(desktopRoot, "server"), { recursive: true });
  for (const { from, to } of sources) {
    await cp(from, to, { recursive: true });
    console.log(`synced ${from} -> ${to}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

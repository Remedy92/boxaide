/**
 * One command for the desktop app.
 *
 *   node scripts/desktop.mjs           compile, install if needed, launch
 *   node scripts/desktop.mjs --dist    same, then pack and sign the mac dmg
 *   node scripts/desktop.mjs --smoke   same, then electron --smoke
 *
 * Electron 43 has no install script. The zip is fetched the first time
 * something requires the package. This runner does that during prepare
 * so launch is not the step that downloads the binary.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncServer } from "../apps/desktop/scripts/sync-server.mjs";
import {
  electronBinaryReady,
  exists,
  markNpmInstalled,
  needsNpmInstall,
  webExportStale,
} from "./lib/stale.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function repoRoot(from = here) {
  return join(from, "..");
}

export function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

function log(message) {
  console.log(`desktop: ${message}`);
}

async function ensureNpm(dir, label) {
  if (!(await needsNpmInstall(dir))) {
    await markNpmInstalled(dir);
    return false;
  }
  log(`installing ${label}`);
  await run(npm, ["install"], dir);
  await markNpmInstalled(dir);
  return true;
}

async function compileServer(root) {
  const tsc = join(root, "node_modules", ".bin", "tsc");
  await run(tsc, ["--incremental", "--tsBuildInfoFile", join(root, ".tsbuildinfo")], root);
}

async function buildWeb(root) {
  const web = join(root, "apps", "web");
  await ensureNpm(web, "apps/web");
  log("building web UI");
  await run(npm, ["run", "build"], web);
  await run(npm, ["run", "web:sync"], root);
  await run(npm, ["run", "mcpb:build"], root);
}

async function ensureElectron(desktop) {
  if (await electronBinaryReady(desktop)) return;
  const installJs = join(desktop, "node_modules", "electron", "install.js");
  if (!(await exists(installJs))) {
    throw new Error(`Electron is not installed in ${desktop}. Run npm install there.`);
  }
  log("downloading Electron (once)");
  await run(process.execPath, [installJs], desktop);
}

export async function prepare(root) {
  await ensureNpm(root, "repo");
  await compileServer(root);
  const mcpb = join(root, "web-next", "boxaide.mcpb");
  if (await webExportStale(root)) {
    await buildWeb(root);
  }
  if (!(await exists(mcpb))) {
    log("packing connector");
    await run(npm, ["run", "mcpb:build"], root);
  }
  const desktop = join(root, "apps", "desktop");
  await ensureNpm(desktop, "apps/desktop");
  await ensureElectron(desktop);
  await syncServer();
}

export async function packMac(desktop) {
  const builder = join(desktop, "node_modules", ".bin", "electron-builder");
  log("packing macOS app");
  await run(builder, ["--mac", "dmg", "-c.mac.identity=null"], desktop);
  await run("sh", ["scripts/sign-mac.sh"], desktop);
}

export async function launch(desktop, extra = []) {
  const electronCli = join(desktop, "node_modules", "electron", "cli.js");
  log("launching");
  await run(process.execPath, [electronCli, ".", ...extra], desktop);
}

async function main(argv) {
  const args = new Set(argv);
  const root = repoRoot();
  const desktop = join(root, "apps", "desktop");
  await prepare(root);
  if (args.has("--dist")) {
    await packMac(desktop);
    return;
  }
  await launch(desktop, args.has("--smoke") ? ["--smoke"] : []);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

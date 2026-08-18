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
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncServer } from "../apps/desktop/scripts/sync-server.mjs";
import {
  electronBinaryReady,
  exists,
  markNpmInstalled,
  mtime,
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

/**
 * The EventKit helper the local calendar provider spawns.
 *
 * macOS only, because EventKit is: Windows and Linux packs carry no such
 * binary and the provider reports the local path as unavailable there.
 *
 * Two slices and a lipo rather than one -target: the mac target is arm64
 * today, but a universal pack must not silently ship a binary half the
 * machines cannot exec. `-macos12.0` matches Electron 43's floor.
 */
async function compileCalendarHelper(desktop) {
  if (process.platform !== "darwin") return;
  const src = join(desktop, "native", "calendar", "main.swift");
  const out = join(desktop, "build", "boxaide-calendar");
  // mtime, not the tree hashes the web export uses: one source file and one
  // output, and a checkout that rewrote the mtime should recompile — 1.4s.
  if ((await exists(out)) && (await mtime(src)) <= (await mtime(out))) return;
  if (!hasSwiftc()) {
    throw new Error(
      "swiftc is not on PATH. Install the Xcode command line tools — the macOS calendar helper cannot be built without it.",
    );
  }
  log("compiling the calendar helper");
  await run("swiftc", ["-O", "-target", "arm64-apple-macos12.0", "-o", `${out}.arm64`, src], desktop);
  await run("swiftc", ["-O", "-target", "x86_64-apple-macos12.0", "-o", `${out}.x64`, src], desktop);
  await run("lipo", ["-create", "-output", out, `${out}.arm64`, `${out}.x64`], desktop);
}

function hasSwiftc() {
  return spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;
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
  await compileCalendarHelper(desktop);
  await syncServer();
}

export async function packMac(desktop) {
  const builder = join(desktop, "node_modules", ".bin", "electron-builder");
  log("packing macOS app");
  // dmg only, and thrown away: sign-mac.sh rebuilds both artifacts from the
  // signed app. `--publish never` because the publish block in
  // electron-builder.yml would otherwise upload this unsigned pack whenever a
  // GH_TOKEN happens to be in the environment.
  await run(
    builder,
    ["--mac", "dmg", "-c.mac.identity=null", "--publish", "never"],
    desktop,
  );
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

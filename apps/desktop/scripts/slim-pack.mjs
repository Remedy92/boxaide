/**
 * Drop files the packaged app never loads.
 *
 * electron-builder's `files` filter cannot see into Electron Framework, and it
 * cannot keep only the host better-sqlite3 prebuild. This runs after the app
 * directory is assembled and before the dmg is built.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** app-builder-lib Arch enum, mirrored so this file has no packager import. */
const ARCH = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

/**
 * @param {import("app-builder-lib").AfterPackContext} context
 */
export default async function slimPack(context) {
  const { electronPlatformName: platform } = context;
  const appDir = packagedAppDir(context);
  await Promise.all([
    dropForeignPrebuilds(unpackedRoot(appDir, platform), nativeId(context)),
    dropSwiftshader(appDir, platform),
  ]);
}

/**
 * The directory that holds Contents/ on mac, or the exe on win/linux.
 * @param {import("app-builder-lib").AfterPackContext} context
 */
function packagedAppDir(context) {
  if (context.electronPlatformName === "darwin") {
    return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  }
  return context.appOutDir;
}

/** @param {string} appDir @param {string} platform */
function unpackedRoot(appDir, platform) {
  if (platform === "darwin") {
    return join(appDir, "Contents", "Resources", "app.asar.unpacked");
  }
  return join(appDir, "resources", "app.asar.unpacked");
}

/**
 * better-sqlite3 prebuild stem, e.g. `darwin-arm64`.
 * A universal Mac build keeps every `darwin-*` prebuild.
 * @param {import("app-builder-lib").AfterPackContext} context
 */
function nativeId(context) {
  return {
    platform: context.electronPlatformName,
    arch: ARCH[context.arch] ?? String(context.arch),
  };
}

/**
 * Keep one .node (the host). The package ships eight, plus the SQLite C
 * sources used to compile them. None of that loads at runtime.
 * @param {string} unpacked
 * @param {{ platform: string, arch: string }} native
 */
async function dropForeignPrebuilds(unpacked, native) {
  const dir = join(unpacked, "node_modules", "better-sqlite3", "prebuilds");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => !keepPrebuild(name, native))
      .map((name) => rm(join(dir, name), { force: true })),
  );
}

/**
 * @param {string} name
 * @param {{ platform: string, arch: string }} native
 */
function keepPrebuild(name, native) {
  if (native.arch === "universal" && native.platform === "darwin") {
    return name.startsWith("darwin-");
  }
  return name === `${native.platform}-${native.arch}.node`;
}

/**
 * CPU Vulkan fallback. The mail UI is 2D CSS. macOS always has Metal, so
 * Chromium never needs a software Vulkan device.
 * @param {string} appDir
 * @param {string} platform
 */
async function dropSwiftshader(appDir, platform) {
  const names =
    platform === "darwin"
      ? ["libvk_swiftshader.dylib", "vk_swiftshader_icd.json"]
      : ["libvk_swiftshader.so", "vk_swiftshader.dll", "vk_swiftshader_icd.json"];
  const dir =
    platform === "darwin"
      ? join(
          appDir,
          "Contents",
          "Frameworks",
          "Electron Framework.framework",
          "Versions",
          "A",
          "Libraries",
        )
      : appDir;
  await Promise.all(names.map((name) => rm(join(dir, name), { force: true })));
}

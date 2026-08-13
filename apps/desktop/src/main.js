/**
 * Sley desktop shell.
 *
 * The whole app is the Sley server started in this process plus a window
 * pointed at it. Because the window loads `http://127.0.0.1:<port>`, the page
 * is same-origin with the API: `/api/local-bootstrap` works exactly as it does
 * in a browser, so the token never has to be shown to the user.
 *
 * There is no preload script and no IPC. The renderer is the same static page
 * the browser gets, and it gets no Electron surface at all.
 */
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `npm run smoke` — load the window, report, quit. Never shows a window. */
const smoke = process.argv.includes("--smoke");

/**
 * The generated mark, from `npm run icons`.
 *
 * A packaged build takes its icon from the bundle — the .icns on macOS, the
 * .ico compiled into the .exe — so this is only read when running unpackaged.
 * Without it `npm run dev` shows the stock Electron diamond, which makes the
 * one thing this task is checking impossible to check.
 */
const iconPng = join(here, "..", "build", "icon.png");

/**
 * The same mark, inset to Apple's 824-of-1024 grid.
 *
 * `app.dock.setIcon` paints the bitmap across the whole dock tile, so the
 * edge-to-edge icon.png — correct for Windows and Linux, which draw their own
 * margin — makes the unpackaged app stand about a quarter wider than the icons
 * beside it. The .icns a packaged build uses already carries this inset.
 */
const dockIconPng = join(here, "..", "build", "icon-dock.png");

/**
 * The UI export lives outside the asar in a packaged build (`extraResources`),
 * so `serveStatic` reads it from a real directory instead of through Electron's
 * asar shim. The compiled server stays inside the asar, next to node_modules,
 * where its bare imports resolve.
 */
const webRoot = app.isPackaged
  ? join(process.resourcesPath, "web-next")
  : join(here, "..", "server", "web-next");

/** @type {BrowserWindow | null} */
let win = null;
/** @type {(() => Promise<void>) | null} */
let stopServer = null;
/** @type {string | null} */
let serverUrl = null;
/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let popover = null;

if (!app.requestSingleInstanceLock()) {
  // A second launch hands focus to the running one. Two instances would fight
  // over the port and over the SQLite file in ~/.sley.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (serverUrl && BrowserWindow.getAllWindows().length === 0) {
      createWindow(serverUrl);
    }
  });

  // Quitting is held open once, long enough to close the SQLite handle and log
  // out of any IMAP connection, and then finished with `app.exit`. Calling
  // `app.quit()` a second time here does not end the process — the cancelled
  // quit leaves it running — so the exit has to be explicit. By this point the
  // store and the listener are already closed, so there is nothing left to
  // unwind gracefully.
  app.on("will-quit", (event) => {
    if (!stopServer) return;
    const stop = stopServer;
    stopServer = null;
    event.preventDefault();
    stop()
      .catch((err) => console.error("shutdown failed", err))
      .finally(() => app.exit(0));
  });

  app.whenReady().then(start).catch(fatal);
}

async function start() {
  // macOS takes the dock icon from the bundle once packaged; unpackaged there is
  // no bundle to read, so it has to be set by hand. Windows and Linux get theirs
  // from the BrowserWindow below.
  if (!app.isPackaged && process.platform === "darwin" && existsSync(dockIconPng)) {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPng));
  }
  const { startServer } = await import("../server/dist/app.js");
  // host is pinned rather than read from SLEY_HOST: a desktop app that binds
  // a non-loopback address would put decrypted mail credentials on the LAN.
  // Everything else — port, ~/.sley, the bearer token, the master key — is
  // the server's own configuration, untouched.
  const started = await startServer({ host: "127.0.0.1", webRoot });
  stopServer = started.stop;
  serverUrl = started.url;
  createWindow(started.url);
  // Menu bar presence is macOS-scoped for now: that is where "glance at your
  // mail and your agents without the window" was asked for, and where the
  // template-image rendering below is known-correct.
  if (process.platform === "darwin") createTray(started.url);
}

/** Raise the main window, recreating it after a close. */
function openMainWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  if (serverUrl) createWindow(serverUrl);
}

/* ---- menu bar ------------------------------------------------------------ */

/**
 * Packaged, the icon lives in Resources via extraResources — the `build`
 * directory itself is never packed (same reason webRoot moves, above).
 */
const trayIconPng = app.isPackaged
  ? join(process.resourcesPath, "trayTemplate.png")
  : join(here, "..", "build", "trayTemplate.png");

/** @param {string} url */
function createTray(url) {
  // "Template" is a macOS contract: pure black plus alpha, recoloured by the
  // system for light/dark menu bars and while the icon is highlighted.
  const image = nativeImage.createFromPath(trayIconPng);
  if (image.isEmpty()) {
    // A Tray from an empty image is an invisible, unclickable sliver — worse
    // than no tray, because nothing says why. Shipped this once; never silent.
    console.error(`tray icon missing or unreadable: ${trayIconPng}`);
    return;
  }
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Sley");

  // Left-click toggles the popover; the menu lives on right-click. Wiring the
  // menu with `setContextMenu` instead would make BOTH buttons open it and the
  // popover would become unreachable.
  tray.on("click", () => togglePopover(url));
  tray.on("right-click", () => {
    // Rebuilt per click so the login checkbox always shows the OS's current
    // answer, not the answer from when the tray was created.
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Sley", click: () => openMainWindow() },
        {
          label: "Install Claude connector…",
          click: () => installClaudeConnector(),
        },
        { type: "separator" },
        {
          label: "Start at login",
          type: "checkbox",
          // Unpackaged, the registered login item would be the dev Electron
          // binary, which is a trap — so the toggle only exists in the real app.
          visible: app.isPackaged,
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) =>
            app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: "separator" },
        { label: "Quit Sley", role: "quit" },
      ]),
    );
  });
}

/** @param {string} url */
function togglePopover(url) {
  if (popover?.isVisible()) {
    popover.hide();
    return;
  }
  showPopover(url);
}

/** @param {string} url */
function showPopover(url) {
  if (!popover) {
    const origin = new URL(url).origin;
    popover = new BrowserWindow({
      width: 380,
      height: 520,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    popover.on("blur", () => popover?.hide());
    popover.on("closed", () => {
      popover = null;
    });

    // The page's "Open Sley" button and every mail row navigate to the
    // server's root. That navigation IS the popover's exit: catch it, raise
    // the real window, keep the popover parked on /tray/ for next time.
    popover.webContents.on("will-navigate", (event, target) => {
      event.preventDefault();
      if (originOf(target) === origin) {
        popover?.hide();
        openMainWindow();
        return;
      }
      openExternal(target);
    });
    popover.webContents.setWindowOpenHandler(({ url: target }) => {
      openExternal(target);
      return { action: "deny" };
    });

    void popover.loadURL(`${url}/tray/`);
  }
  // Smoke checks the page load only; showing would steal focus mid-check.
  if (!smoke) {
    positionPopover();
    popover.show();
  }
}

/**
 * The tray leg of `npm run smoke`: the tray exists and the popover page loads
 * with real text in it. macOS only, like the tray itself.
 * @param {string} url
 */
function smokePopover(url) {
  if (process.platform !== "darwin") return Promise.resolve();
  console.log(`smoke: tray ${tray ? "created" : "MISSING"}`);
  return new Promise((resolve) => {
    showPopover(url);
    popover?.webContents.once("did-finish-load", () => {
      popover?.webContents
        .executeJavaScript("({ chars: document.body.innerText.length })")
        .then((page) => {
          console.log(`smoke: popover loaded /tray/ text-chars=${page.chars}`);
        })
        .catch((err) => console.error("smoke: popover read failed", err))
        .finally(() => resolve(undefined));
    });
  });
}

/**
 * Under the tray icon, horizontally centred on it, clamped into the work area
 * so a menu-bar icon near the screen edge does not push the window off-screen.
 */
function positionPopover() {
  if (!popover || !tray) return;
  const icon = tray.getBounds();
  const [width, height] = popover.getSize();
  const area = screen.getDisplayNearestPoint({
    x: icon.x,
    y: icon.y,
  }).workArea;
  const x = Math.round(
    Math.min(
      Math.max(icon.x + icon.width / 2 - width / 2, area.x + 8),
      area.x + area.width - width - 8,
    ),
  );
  const y = Math.round(Math.min(icon.y + icon.height + 6, area.y + area.height - height));
  popover.setPosition(x, y, false);
}

/**
 * One click from the menu bar to a connected Claude Desktop. The bundle is
 * already on disk — the server serves it at /sley.mcpb from the same
 * directory — so this hands the file to the OS, and Claude Desktop (the
 * registered .mcpb handler) opens its install dialog.
 *
 * Copied to a temp path first: webRoot sits inside the .app bundle, and
 * pointing another app into our own Resources directory is fragile across
 * updates.
 */
function installClaudeConnector() {
  const source = join(webRoot, "sley.mcpb");
  if (!existsSync(source)) {
    dialog.showErrorBox(
      "Connector not found",
      "sley.mcpb is missing from this build. Run the root `npm run build` and re-sync the desktop app.",
    );
    return;
  }
  const target = join(app.getPath("temp"), "sley.mcpb");
  try {
    copyFileSync(source, target);
  } catch (err) {
    dialog.showErrorBox(
      "Could not stage the connector",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  void shell.openPath(target).then((problem) => {
    if (problem) {
      dialog.showErrorBox(
        "Could not open the connector",
        `${problem}\n\nInstall Claude Desktop first, then try again — or open ${target} yourself.`,
      );
    }
  });
}

/** @param {string} url */
function createWindow(url) {
  const origin = new URL(url).origin;

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: "Sley",
    // Ignored on macOS, which reads the bundle. Set unconditionally rather than
    // behind a platform check so a Windows or Linux dev run is not the stock
    // Electron diamond.
    ...(existsSync(iconPng) ? { icon: iconPng } : {}),
    // A standard frame: the traffic lights stay in the title bar, where they
    // cannot land on top of the web UI's own header. The page ships no drag
    // region and no top inset, so `hiddenInset` would cover its top-left
    // controls.
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Showing on `ready-to-show` avoids a blank flash, and keeping the window
  // hidden in smoke mode keeps the check from stealing focus.
  win.once("ready-to-show", () => {
    if (!smoke) win?.show();
  });
  win.on("closed", () => {
    win = null;
  });

  // Mail contains links. Anything that is not this server opens in the user's
  // real browser; nothing else gets an Electron window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (originOf(target) === origin) return;
    event.preventDefault();
    openExternal(target);
  });

  win.webContents.on("did-fail-load", (_event, code, description, failedUrl) => {
    if (code === -3) return; // aborted, e.g. a superseded navigation
    console.error(`load failed ${failedUrl}: ${description} (${code})`);
  });

  if (smoke) {
    win.webContents.once("did-finish-load", () => {
      win?.webContents
        .executeJavaScript(
          "({ title: document.title, chars: document.body.innerText.length })",
        )
        .then((page) => {
          console.log(
            `smoke: loaded ${url} title=${JSON.stringify(page.title)} text-chars=${page.chars}`,
          );
        })
        .then(() => smokePopover(url))
        .catch((err) => console.error("smoke: read title failed", err))
        .finally(() => app.quit());
    });
  }

  void win.loadURL(url);
}

/** @param {string} target */
function openExternal(target) {
  const protocol = protocolOf(target);
  if (protocol !== "http:" && protocol !== "https:") return;
  void shell.openExternal(target);
}

/** @param {string} value */
function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** @param {string} value */
function protocolOf(value) {
  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

/** @param {unknown} err */
function fatal(err) {
  const message = err instanceof Error ? err.message : String(err);
  const busy = /EADDRINUSE/.test(message);
  const detail = busy
    ? `The port is already in use.\n\nSley is probably already running — check for another Sley window, or a "sley serve" in a terminal.\n\n${message}`
    : message;
  console.error(`sley could not start: ${detail}`);
  // `showErrorBox` is modal and waits for a click, which is right in front of a
  // person and a hang in `npm run smoke`.
  if (!smoke) dialog.showErrorBox("Sley could not start", detail);
  app.exit(1);
}

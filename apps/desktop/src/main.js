/**
 * mailmux desktop shell.
 *
 * The whole app is the mailmux server started in this process plus a window
 * pointed at it. Because the window loads `http://127.0.0.1:<port>`, the page
 * is same-origin with the API: `/api/local-bootstrap` works exactly as it does
 * in a browser, so the token never has to be shown to the user.
 *
 * There is no preload script and no IPC. The renderer is the same static page
 * the browser gets, and it gets no Electron surface at all.
 */
import { app, BrowserWindow, dialog, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `npm run smoke` — load the window, report, quit. Never shows a window. */
const smoke = process.argv.includes("--smoke");

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

if (!app.requestSingleInstanceLock()) {
  // A second launch hands focus to the running one. Two instances would fight
  // over the port and over the SQLite file in ~/.mailmux.
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
  const { startServer } = await import("../server/dist/app.js");
  // host is pinned rather than read from MAILMUX_HOST: a desktop app that binds
  // a non-loopback address would put decrypted mail credentials on the LAN.
  // Everything else — port, ~/.mailmux, the bearer token, the master key — is
  // the server's own configuration, untouched.
  const started = await startServer({ host: "127.0.0.1", webRoot });
  stopServer = started.stop;
  serverUrl = started.url;
  createWindow(started.url);
}

/** @param {string} url */
function createWindow(url) {
  const origin = new URL(url).origin;

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: "mailmux",
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
    ? `The port is already in use.\n\nmailmux is probably already running — check for another mailmux window, or a "mailmux serve" in a terminal.\n\n${message}`
    : message;
  console.error(`mailmux could not start: ${detail}`);
  // `showErrorBox` is modal and waits for a click, which is right in front of a
  // person and a hang in `npm run smoke`.
  if (!smoke) dialog.showErrorBox("mailmux could not start", detail);
  app.exit(1);
}

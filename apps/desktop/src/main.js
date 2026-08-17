/**
 * Boxaide desktop shell.
 *
 * The whole app is the Boxaide server started in this process plus a window
 * pointed at it. The window receives a one-time capability in its URL fragment
 * and exchanges that for the server token. HTTP never receives fragments, so
 * another local process cannot impersonate the desktop renderer merely by
 * calling loopback.
 *
 * There is no preload script and no IPC. The renderer is the same static page
 * the browser gets, and it gets no Electron surface at all. That is also why
 * the updater below is handed to the server rather than to the window: the
 * sidebar learns about a new version over HTTP, like everything else it shows.
 */
import electronUpdater from "electron-updater";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
} from "electron";
import { randomBytes } from "node:crypto";
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
/** @type {NodeJS.Timeout | null} */
let badgeTimer = null;
/**
 * Pending count from the previous poll, or null before the first one.
 *
 * Null is not zero: at launch every pending draft is old work the user left
 * behind, not something that arrived while they were looking away. The first
 * poll therefore paints the badge and stays quiet; only a later rise notifies.
 * @type {number | null}
 */
let lastPending = null;
/**
 * Set while `quitAndInstall` is tearing the app down.
 *
 * The quit that installs an update must reach Squirrel, and `will-quit` below
 * ends in `app.exit(0)`, which does not. The install path therefore shuts the
 * server down itself and leaves nothing for `will-quit` to hold the quit open
 * for. This flag is what keeps a second Cmd-Q from racing it.
 */
let installing = false;
/**
 * The version Squirrel has staged and is waiting to swap in, once one is
 * downloaded. Read by `will-quit`, which applies it instead of exiting.
 * @type {string | null}
 */
let stagedUpdate = null;
/**
 * The server's update service, held so the menu bar can ask for a check
 * without going back through HTTP. The window still reads it over
 * `/api/update` — that is the only path the renderer has.
 * @type {{
 *   check: () => Promise<void>,
 *   checkAndDownload: () => Promise<void>,
 *   state: () => { status: string, currentVersion: string, latestVersion: string | null, error: string | null },
 * } | null}
 */
let updateService = null;
/** Set while a menu-driven check is running, so a second click is not a second check. */
let checkingFromMenu = false;

if (!app.requestSingleInstanceLock()) {
  // A second launch hands focus to the running one. Two instances would fight
  // over the port and over the SQLite file in ~/.boxaide.
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
    // Before the early return: the poll must stop even when the server never
    // started, or a tick fires against a half-torn-down process.
    stopBadgePoll();
    // The install path has already closed everything and needs this quit to
    // reach Squirrel. Holding it open here, and ending in `app.exit`, would
    // swallow the update instead of applying it.
    if (installing) return;
    if (!stopServer && !stagedUpdate) return;
    event.preventDefault();
    shutdownServer().finally(() => {
      // A downloaded update the user never restarted into applies here, on the
      // next quit. electron-updater's own `autoInstallOnAppQuit` hangs off the
      // `quit` event, which `app.exit` never emits — so the handoff is made by
      // hand. `quitAndInstall` quits again; `installing` lets that one through.
      if (stagedUpdate) {
        installing = true;
        try {
          autoUpdater.quitAndInstall(false, false);
          return;
        } catch (err) {
          // A staged file that has gone missing must not cost the user their
          // quit. Fall through and exit; the next check re-downloads it.
          console.error("install on quit failed", err);
        }
      }
      app.exit(0);
    });
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
  const bootstrapCapability = randomBytes(32).toString("base64url");
  // host is pinned rather than read from BOXAIDE_HOST: a desktop app that binds
  // a non-loopback address would put decrypted mail credentials on the LAN.
  // Everything else — port, ~/.boxaide, the bearer token, the master key — is
  // the server's own configuration, untouched.
  const started = await startServer({
    host: "127.0.0.1",
    webRoot,
    // Unpackaged there is no bundle to replace and no update feed to read, so
    // the driver is left off and the server falls back to its manual channel:
    // it states the newest release and links to it. Wiring the driver anyway
    // would make every dev run report an updater error it cannot act on.
    updateDriver: app.isPackaged ? createUpdateDriver() : undefined,
    // The bundle's version, not a package.json found by walking up from the
    // compiled server inside the asar. Same number today; this is the one the
    // OS and Squirrel agree on.
    appVersion: app.getVersion(),
    bootstrapCapability,
  });
  stopServer = started.stop;
  serverUrl = started.url;
  updateService = started.runtime.update;
  createAppMenu();
  createWindow(
    started.url,
    `#bootstrap=${encodeURIComponent(bootstrapCapability)}`,
  );
  // Menu bar presence is macOS-scoped for now: that is where "glance at your
  // mail and your agents without the window" was asked for, and where the
  // template-image rendering below is known-correct.
  if (process.platform === "darwin") createTray(started.url);
  // The token is right here in the runtime config — the same file-backed bearer
  // token the page obtains through its one-time bootstrap capability — so the
  // main process reads it directly rather than going through the renderer.
  if (!smoke) startBadgePoll(started.url, started.runtime.config.bearerToken);
}

/**
 * Close the server once, whoever asked. Never throws.
 *
 * Shared by the quit handler and by the update install, which must finish the
 * shutdown itself and then let the quit run all the way through to Squirrel.
 */
async function shutdownServer() {
  stopBadgePoll();
  if (!stopServer) return;
  const stop = stopServer;
  stopServer = null;
  await stop().catch((err) => console.error("shutdown failed", err));
}

/* ---- updates ------------------------------------------------------------- */

const { autoUpdater } = electronUpdater;

/** Told once per version, so a re-check does not re-notify. */
let notifiedReadyFor = null;

/**
 * The adapter the server's UpdateService drives.
 *
 * electron-updater reads `app-update.yml`, packed from the `publish` block in
 * electron-builder.yml, and resolves `latest-mac.yml` from the newest GitHub
 * release. Both files must be on the release for any of this to work —
 * scripts/ship.sh uploads them beside the dmg.
 *
 * Downloading is never automatic. The update is tens of megabytes over
 * somebody's connection, and it lands as a restart; both are the user's call,
 * made in the sidebar.
 */
function createUpdateDriver() {
  autoUpdater.autoDownload = false;
  // A downloaded update that the user never restarts into should still apply
  // the next time they quit — but electron-updater does that from the `quit`
  // event, which the shutdown below never emits. Off here, and done by hand in
  // `will-quit`, which is the only path that gets to run.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  /** @type {(event: unknown) => void} */
  let emit = () => {};

  autoUpdater.on("checking-for-update", () => emit({ kind: "checking" }));
  autoUpdater.on("update-available", (info) =>
    emit({
      kind: "available",
      version: info.version,
      notes: notesOf(info.releaseNotes),
      publishedAt: info.releaseDate ?? null,
    }),
  );
  autoUpdater.on("update-not-available", (info) =>
    emit({ kind: "not-available", version: info?.version ?? null }),
  );
  autoUpdater.on("download-progress", (progress) =>
    emit({ kind: "progress", percent: progress.percent }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    stagedUpdate = info.version;
    emit({ kind: "downloaded", version: info.version });
    announceReady(info.version);
  });
  autoUpdater.on("error", (err) =>
    emit({ kind: "error", message: err?.message ?? String(err) }),
  );

  return {
    canInstall: true,
    subscribe: (sink) => {
      emit = sink;
    },
    check: async () => {
      await autoUpdater.checkForUpdates();
    },
    download: async () => {
      await autoUpdater.downloadUpdate();
    },
    install: () => {
      if (installing) return;
      installing = true;
      // The server owns a SQLite handle and may hold an IMAP connection.
      // Close both before the process is replaced, then quit for real:
      // `quitAndInstall` runs the Squirrel handoff that `app.exit` skips.
      void shutdownServer().finally(() => {
        autoUpdater.quitAndInstall(false, true);
      });
    },
  };
}

/**
 * GitHub release notes arrive as a string, or as a list of per-version blocks
 * when more than one release is being skipped. Both become one text.
 */
function notesOf(raw) {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return null;
  return (
    raw
      .map((entry) =>
        entry && typeof entry === "object"
          ? `## ${entry.version ?? ""}\n${entry.note ?? ""}`.trim()
          : String(entry),
      )
      .join("\n\n")
      .trim() || null
  );
}

/**
 * One notification, when the update is staged and a restart is all that is
 * left. Not when it is merely available: that is a sidebar row, not an
 * interruption.
 */
function announceReady(version) {
  if (notifiedReadyFor === version) return;
  notifiedReadyFor = version;
  if (!Notification.isSupported()) return;
  notify(`Boxaide ${version} is ready`, "Restart to finish updating.");
}

/* ---- approval badge ------------------------------------------------------ */

/** How often the main process asks the local server for the pending count. */
const BADGE_POLL_MS = 60_000;

/**
 * Outreach never sends by itself: a draft sits in the outbox until a human
 * approves it. The badge is what tells that human there is something waiting
 * while the window is closed or behind other apps.
 *
 * @param {string} url
 * @param {string} token
 */
function startBadgePoll(url, token) {
  const endpoint = `${url}/api/outreach/badge`;
  const poll = () => {
    void pollBadge(endpoint, token);
  };
  poll();
  badgeTimer = setInterval(poll, BADGE_POLL_MS);
}

function stopBadgePoll() {
  if (!badgeTimer) return;
  clearInterval(badgeTimer);
  badgeTimer = null;
}

/**
 * @param {string} endpoint
 * @param {string} token
 */
async function pollBadge(endpoint, token) {
  let pending;
  try {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const body = await response.json();
    pending = typeof body?.pending === "number" ? body.pending : null;
  } catch {
    // The server runs in this process, so a failed poll means a shutdown race
    // or a socket that was not listening yet — both transient, both resolved by
    // the next tick. Logging them would fill the console during a normal quit.
    // The last seen count is left untouched so the poll that recovers does not
    // re-notify for drafts the user has already been told about.
    return;
  }
  if (pending === null || !Number.isFinite(pending) || pending < 0) return;
  applyBadge(pending);
}

/** @param {number} pending */
function applyBadge(pending) {
  // Only a rise notifies, and the comparison is against the previous count
  // rather than against zero: working through the queue lowers the count, and a
  // count that merely stays high is work the user has already been told about.
  const rose = lastPending !== null && pending > lastPending;
  lastPending = pending;
  // setBadgeCount(0) is how the dock badge is cleared, so the call is
  // unconditional. It is a no-op on Windows, where Electron has no badge API.
  app.setBadgeCount(pending);
  if (!rose || !Notification.isSupported()) return;
  const notification = new Notification({
    title: "Boxaide",
    body:
      pending === 1
        ? "1 draft awaits your approval"
        : `${pending} drafts await your approval`,
  });
  // The notification is only useful if it leads somewhere: clicking it opens
  // the window the user would otherwise have to find.
  notification.on("click", () => openMainWindow());
  notification.show();
}

/**
 * Raise the main window, recreating it after a close.
 *
 * `hash` names a page inside the app — `#/settings/updates`, say. The page
 * routes on the URL hash, so this is the whole of the main process's ability
 * to send the window somewhere: there is no preload and no IPC, by design.
 * @param {string} [hash]
 */
function openMainWindow(hash) {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (hash) navigateTo(hash);
    return;
  }
  if (serverUrl) createWindow(serverUrl, hash);
}

/**
 * Move the loaded page to a hash route without reloading it.
 *
 * The custom event is not belt-and-braces: assigning the same hash the window
 * is already on fires no `hashchange`, and "Check for updates…" pressed twice
 * from the Updates page is exactly that case.
 * @param {string} hash
 */
function navigateTo(hash) {
  if (!win) return;
  void win.webContents
    .executeJavaScript(
      `window.location.hash = ${JSON.stringify(hash)};` +
        `window.dispatchEvent(new Event("boxaide:hash"));`,
    )
    .catch(() => {
      // A window mid-load has no document to route yet. It is loading the URL
      // it was created with, which already carries the hash.
    });
}

/**
 * The menu item, end to end: show the page that reports updates, run the
 * check, start the download if there is one, and say so when there is not.
 *
 * The old version checked and opened the window, which from the outside is a
 * menu item that does nothing — the sidebar card it was opening the window for
 * only appears when an update exists, and only after the check lands.
 */
async function checkForUpdatesFromMenu() {
  if (!updateService || checkingFromMenu) return;
  checkingFromMenu = true;
  // Before the await: the window comes up on the Updates page, which shows
  // "Checking for updates…" while this runs. That is the feedback.
  openMainWindow("#/settings/updates");
  try {
    await updateService.checkAndDownload();
  } finally {
    checkingFromMenu = false;
  }
  const state = updateService.state();
  // An update that was found is on screen — the page shows the version and a
  // progress bar. Only the two outcomes with nothing to show get a line.
  if (state.status === "up-to-date") {
    notify("Boxaide is up to date", `You are on ${state.currentVersion}.`);
    return;
  }
  if (state.status === "error") {
    notify(
      "Could not check for updates",
      state.error ?? "The release feed did not answer.",
    );
  }
}

/**
 * @param {string} title
 * @param {string} body
 */
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on("click", () => openMainWindow("#/settings/updates"));
  notification.show();
}

/* ---- application menu ---------------------------------------------------- */

/**
 * The default Electron menu has no way to reach settings and no way to ask for
 * an update, so this replaces it. Everything else is a role, which is how the
 * standard Edit and Window behaviour (copy, paste, minimise, the emoji picker)
 * survives the replacement.
 *
 * Built once at start rather than per open: nothing in it reads state that
 * changes. The tray menu, which does, is still rebuilt per click.
 */
function createAppMenu() {
  const mac = process.platform === "darwin";
  /** Shared by the app menu on macOS and the File menu everywhere else. */
  const appItems = [
    {
      label: "Check for Updates…",
      click: () => void checkForUpdatesFromMenu(),
    },
    { type: "separator" },
    {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: () => openMainWindow("#/settings"),
    },
    {
      label: "Install Claude connector…",
      click: () => installClaudeConnector(),
    },
  ];

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" },
                { type: "separator" },
                ...appItems,
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : [
            {
              label: "File",
              submenu: [...appItems, { type: "separator" }, { role: "quit" }],
            },
          ]),
      { role: "editMenu" },
      {
        label: "View",
        // No accelerators on these two. CmdOrCtrl+0 belongs to the resetZoom
        // role three lines down, and CmdOrCtrl+, is already on Settings… in
        // the menu above — a second registration takes the key away from the
        // item that should have it.
        submenu: [
          { label: "Boxaide", click: () => openMainWindow() },
          { label: "Settings", click: () => openMainWindow("#/settings") },
          { type: "separator" },
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Boxaide on GitHub",
            click: () => openExternal("https://github.com/Remedy92/boxaide"),
          },
          {
            label: "Releases",
            click: () =>
              openExternal("https://github.com/Remedy92/boxaide/releases"),
          },
        ],
      },
    ]),
  );
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
  tray.setToolTip("Boxaide");

  // Left-click toggles the popover; the menu lives on right-click. Wiring the
  // menu with `setContextMenu` instead would make BOTH buttons open it and the
  // popover would become unreachable.
  tray.on("click", () => togglePopover(url));
  tray.on("right-click", () => {
    // Rebuilt per click so the login checkbox always shows the OS's current
    // answer, not the answer from when the tray was created.
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Boxaide", click: () => openMainWindow() },
        {
          label: "Install Claude connector…",
          click: () => installClaudeConnector(),
        },
        {
          label: "Settings…",
          click: () => openMainWindow("#/settings"),
        },
        {
          // Opens the Updates page, checks, and downloads what it finds. See
          // checkForUpdatesFromMenu.
          label: checkingFromMenu ? "Checking for updates…" : "Check for updates…",
          enabled: !checkingFromMenu,
          click: () => void checkForUpdatesFromMenu(),
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
        { label: "Quit Boxaide", role: "quit" },
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

    // The page's "Open Boxaide" button and every mail row navigate to the
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
 * already on disk — the server serves it at /boxaide.mcpb from the same
 * directory — so this hands the file to the OS, and Claude Desktop (the
 * registered .mcpb handler) opens its install dialog.
 *
 * Copied to a temp path first: webRoot sits inside the .app bundle, and
 * pointing another app into our own Resources directory is fragile across
 * updates.
 */
function installClaudeConnector() {
  const source = join(webRoot, "boxaide.mcpb");
  if (!existsSync(source)) {
    dialog.showErrorBox(
      "Connector not found",
      "boxaide.mcpb is missing from this build. Run the root `npm run build` and re-sync the desktop app.",
    );
    return;
  }
  const target = join(app.getPath("temp"), "boxaide.mcpb");
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

/**
 * @param {string} url
 * @param {string} [hash] A page inside the app, e.g. `#/settings/updates`.
 */
function createWindow(url, hash) {
  const origin = new URL(url).origin;

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: "Boxaide",
    // Ignored on macOS, which reads the bundle. Set unconditionally rather than
    // behind a platform check so a Windows or Linux dev run is not the stock
    // Electron diamond.
    ...(existsSync(iconPng) ? { icon: iconPng } : {}),
    // macOS: no title bar row. The traffic lights sit inside the sidebar, the
    // way Claude and ChatGPT do it. The page reserves the strip they land on
    // and marks it draggable — see `data-desktop` in apps/web. Windows and
    // Linux keep the standard frame.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          // Centres the 14px button group in the 44px strip the page reserves.
          trafficLightPosition: { x: 16, y: 15 },
        }
      : {}),
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

  // The one signal the page gets about its host, and the reason it reserves a
  // strip for the traffic lights. A marker rather than "is this Electron":
  // any Electron browser pointed at the same URL would answer yes to that, and
  // only this window actually hides its title bar. Set on macOS alone, because
  // only macOS gets `hiddenInset` above.
  if (process.platform === "darwin") {
    win.webContents.setUserAgent(
      `${win.webContents.getUserAgent()} BoxaideDesktop/${app.getVersion()}`,
    );
  }

  void win.loadURL(hash ? `${url}${hash}` : url);
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
    ? `The port is already in use.\n\nBoxaide is probably already running — check for another Boxaide window, or a "boxaide serve" in a terminal.\n\n${message}`
    : message;
  console.error(`boxaide could not start: ${detail}`);
  // `showErrorBox` is modal and waits for a click, which is right in front of a
  // person and a hang in `npm run smoke`.
  if (!smoke) dialog.showErrorBox("Boxaide could not start", detail);
  app.exit(1);
}

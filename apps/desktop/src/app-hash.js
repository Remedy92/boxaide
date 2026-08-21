/**
 * The hash a tray navigation asked for, empty unless it names a page inside
 * the app. Every route the app has starts `#/`, so the test also keeps a
 * fragment that is anything else out of the main window: the only string the
 * main process ever evaluates inside the renderer is this one, and it is
 * decided here rather than trusted from the popover's page.
 *
 * Its own module, with no Electron import, so it can be tested.
 * @param {string} value
 * @returns {string}
 */
export function appHashOf(value) {
  try {
    const { hash } = new URL(value);
    return hash.startsWith("#/") ? hash : "";
  } catch {
    return "";
  }
}

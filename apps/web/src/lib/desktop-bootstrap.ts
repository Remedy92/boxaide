/**
 * Take the desktop shell's one-time bootstrap capability from the fragment.
 * Fragments are not sent in HTTP requests. Strip it immediately so it cannot
 * survive a copy, reload, or later navigation.
 */
let cachedCapability: string | undefined;

export function takeDesktopBootstrapCapability(): string {
  // React Strict Mode may evaluate a state initializer twice in development.
  // Return the same value without leaving the secret in browser history.
  if (cachedCapability !== undefined) return cachedCapability;
  if (typeof window === "undefined") return "";
  const prefix = "#bootstrap=";
  if (!window.location.hash.startsWith(prefix)) {
    cachedCapability = "";
    return cachedCapability;
  }
  let capability = "";
  try {
    capability = decodeURIComponent(window.location.hash.slice(prefix.length));
  } catch {
    // A malformed fragment is not a credential.
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  cachedCapability = capability;
  return cachedCapability;
}

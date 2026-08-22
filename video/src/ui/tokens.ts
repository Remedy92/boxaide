/**
 * The app's dark palette, copied value-for-value out of
 * `apps/web/src/app/globals.css`. Nothing here is invented: if a colour in the
 * video does not appear in that file it is a bug, because the whole point of
 * this video is that the UI on screen is the UI you get.
 */
export const T = {
  surface0: "#08090a",
  surface1: "#0d0e10",
  surface2: "#121316",
  surfaceHover: "#191a1d",
  surfaceSelected: "#212226",
  scrim: "rgb(0 0 0 / 0.62)",

  borderSubtle: "#1c1d20",
  borderStrong: "#2b2d31",
  borderControl: "#70737c",

  fg: "#edeef0",
  fgSecondary: "#9fa1a8",
  fgTertiary: "#83858d",
  fgDisabled: "#54565d",
  dotMuted: "#70737c",

  accent: "#9aa3f5",
  accentHover: "#b3bafa",
  accentFill: "#5c67d8",
  accentFillFg: "#ffffff",
  accentSubtle: "#16182b",
  accentLine: "#2b2f52",

  success: "#4ed08a",
  successBg: "#0f2419",
  warning: "#f0a93c",
  warningBg: "#251d10",
  danger: "#ff6e6a",
  dangerBg: "#2a1514",

  shadowOverlay:
    "0 1px 1px rgb(0 0 0 / 0.50), 0 6px 16px -6px rgb(0 0 0 / 0.60)",
  shadowDialog:
    "0 1px 2px rgb(0 0 0 / 0.50), 0 20px 48px -16px rgb(0 0 0 / 0.70)",

  // Four type sizes, no fifth. Same rule as the app.
  micro: 11,
  meta: 12,
  ui: 13,
  read: 15,

  trackTight: "-0.011em",
  trackNormal: "-0.006em",
  trackLabel: "0.04em",

  radiusXs: 3,
  radiusSm: 4,
  radiusMd: 6,
  radiusLg: 8,

  railW: 228,
  listW: 360,
  rowH: 62,
} as const;

/** The app renders at this logical size; the video scales the whole plane. */
export const APP_W = 1440;
export const APP_H = 900;

/**
 * The app icon, drawn at hero size.
 *
 * Every number here is read off apps/desktop/scripts/make-icons.mjs: the same
 * superellipse plate, the same near-black vertical gradient, the same three
 * rails on a 14-unit grid at 56% of the plate. The page shows the icon the
 * visitor is about to have in their dock — a different-but-similar mark would
 * be a small lie on the one screen that has to be trusted.
 */

/**
 * |x/50|⁵ + |y/50|⁵ = 1, sampled at 72 points on a 100-unit box. n = 5 is the
 * macOS icon shape; a plain rounded rectangle turns its corners too late and
 * reads wrong beside real icons. Straight segments between samples deviate by
 * under 0.1 units — a tenth of a pixel at any size this is drawn.
 */
const SQUIRCLE =
  "M100.00 50.00L99.92 68.84L99.69 74.82L99.31 79.12L98.77 82.55L98.07 85.43L97.20 87.89L96.17 90.03L94.94 91.90L93.53 93.53L91.90 94.94L90.03 96.17L87.89 97.20L85.43 98.07L82.55 98.77L79.12 99.31L74.82 99.69L68.84 99.92L50.00 100.00L31.16 99.92L25.18 99.69L20.88 99.31L17.45 98.77L14.57 98.07L12.11 97.20L9.97 96.17L8.10 94.94L6.47 93.53L5.06 91.90L3.83 90.03L2.80 87.89L1.93 85.43L1.23 82.55L0.69 79.12L0.31 74.82L0.08 68.84L0.00 50.00L0.08 31.16L0.31 25.18L0.69 20.88L1.23 17.45L1.93 14.57L2.80 12.11L3.83 9.97L5.06 8.10L6.47 6.47L8.10 5.06L9.97 3.83L12.11 2.80L14.57 1.93L17.45 1.23L20.88 0.69L25.18 0.31L31.16 0.08L50.00 0.00L68.84 0.08L74.82 0.31L79.12 0.69L82.55 1.23L85.43 1.93L87.89 2.80L90.03 3.83L91.90 5.06L93.53 6.47L94.94 8.10L96.17 9.97L97.20 12.11L98.07 14.57L98.77 17.45L99.31 20.88L99.69 25.18L99.92 31.16Z";

/** The 14-unit grid scaled to 56% of a 100-unit plate and centred. */
const UNIT = (100 * 0.56) / 14;
const ORIGIN = 50 - (14 * UNIT) / 2;

const RAILS = [
  { x: 1.7, y: 0, h: 14, alpha: 1, delay: 90 },
  { x: 6.2, y: 2, h: 10, alpha: 0.72, delay: 160 },
  { x: 10.7, y: 4, h: 6, alpha: 0.5, delay: 230 },
] as const;

export function AppMark({ size = 88 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="The mailmux app icon"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="mailmux-plate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#18191d" />
          <stop offset="1" stopColor="#0b0c0e" />
        </linearGradient>
      </defs>

      <path d={SQUIRCLE} fill="url(#mailmux-plate)" />
      {/* The plate is near-black in both themes, as the real icon is. On the
          dark surface it would otherwise dissolve into the page, so it keeps
          the same hairline the dock gives it. */}
      <path
        d={SQUIRCLE}
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.09"
        strokeWidth="1"
      />

      {RAILS.map((rail) => (
        <rect
          key={rail.x}
          className="mailmux-mark-rail"
          style={{ animationDelay: `${rail.delay}ms` }}
          x={ORIGIN + rail.x * UNIT}
          y={ORIGIN + rail.y * UNIT}
          width={2.6 * UNIT}
          height={rail.h * UNIT}
          rx={1.3 * UNIT}
          fill="#ffffff"
          fillOpacity={rail.alpha}
        />
      ))}
    </svg>
  );
}

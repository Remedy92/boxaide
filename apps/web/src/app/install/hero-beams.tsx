/**
 * The background: many lines arriving at one point.
 *
 * That is the product — every mailbox converging into one inbox — drawn once,
 * at page scale, behind the icon they converge on. It is generated from a
 * formula rather than drawn by hand, so it is exact at any window size, and it
 * is deterministic: a static export prerenders this on a build machine and
 * hydrates it in the browser, and a random number here would make the two
 * disagree.
 *
 * Every beam fades to nothing twice — once before it reaches the meeting point,
 * so the middle of the page stays empty for the words, and once again near the
 * edges. What is left is the middle of each line, which is the part that has a
 * direction.
 */

const VIEW_W = 1600;
const VIEW_H = 900;

/** Where the beams meet: behind the app icon, at 23% of the page height. */
const CX = VIEW_W / 2;
const CY = VIEW_H * 0.23;

const COUNT = 30;
/** Radians of bend. 0 is a sunburst; past ~0.5 the curves start to cross. */
const SWIRL = 0.34;
/** No beam may leave straight up: that is where the wordmark sits. */
const BLIND_SPOT = { from: -1.92, to: -1.22 };

/** The three alphas of the mark, reused so the accent arrives in its rhythm. */
const ACCENTS = new Map([
  [7, 1],
  [14, 0.72],
  [22, 0.5],
]);

/** Distance from C to the edge of the box along `angle`. */
function reach(angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const spans = [
    dx > 0 ? (VIEW_W - CX) / dx : dx < 0 ? -CX / dx : Infinity,
    dy > 0 ? (VIEW_H - CY) / dy : dy < 0 ? -CY / dy : Infinity,
  ];
  return Math.min(...spans);
}

type Beam = { angle: number; d: string; opacity: number; accent?: number };

const BEAMS: Beam[] = Array.from({ length: COUNT }, (_, i) => {
  const angle = -Math.PI + ((i + 0.5) / COUNT) * Math.PI * 2;
  const far = reach(angle) * 1.05;
  const end = { x: CX + Math.cos(angle) * far, y: CY + Math.sin(angle) * far };
  // The control point sits mid-beam, rotated off the straight line. The bend is
  // one direction for every beam, so the whole field turns the same way.
  const mid = angle + SWIRL;
  const control = {
    x: CX + Math.cos(mid) * far * 0.52,
    y: CY + Math.sin(mid) * far * 0.52,
  };

  return {
    angle,
    // Whole units, and two decimals of opacity. Node renders this HTML and the
    // browser re-renders it to compare: Math.sin and Number.toFixed are both
    // allowed to disagree in the last bit between two engines, and one digit of
    // disagreement is a hydration mismatch on an attribute React refuses to
    // patch. A viewBox unit is 1/1600 of the window, so nothing is lost.
    d: `M${Math.round(CX)} ${Math.round(CY)}Q${Math.round(control.x)} ${Math.round(control.y)} ${Math.round(end.x)} ${Math.round(end.y)}`,
    // A little variation along the fan, so the eye reads light rather than a
    // mechanism. Deterministic — see the note at the top.
    opacity:
      Math.round((0.55 + 0.45 * Math.abs(Math.sin(angle * 1.5 + 0.7))) * 100) /
      100,
    accent: ACCENTS.get(i),
  };
  // Beams that would leave straight up are dropped rather than nudged aside:
  // that is where the wordmark sits, and two beams nudged to the same angle
  // draw the same line twice.
}).filter((beam) => beam.angle < BLIND_SPOT.from || beam.angle > BLIND_SPOT.to);

/**
 * Which beams carry an arriving light, spread around the fan rather than
 * bunched, so no two travel side by side. Indices into the filtered list, and
 * fixed for the same reason the field is: this markup is rendered on a build
 * machine and re-rendered in the browser, and the two must agree exactly.
 */
const PULSE_BEAMS = [1, 5, 9, 13, 18, 23];

const PULSES: Beam[] = PULSE_BEAMS.map((i) => BEAMS[i]).filter(Boolean);

export function HeroBeams() {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      // `none`, so the field always fills the window. Slicing would crop the
      // outer beams away on a narrow one, and non-uniform scale only shears the
      // curves — which is what a perspective on them would do anyway.
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className="absolute inset-0 size-full"
    >
      <defs>
        <radialGradient id="mailmux-beam-mask" cx="0.5" cy="0.23" r="0.72">
          {/* The void the icon sits in. */}
          <stop offset="0.05" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.26" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.62" stopColor="#fff" stopOpacity="0.85" />
          {/* …and out again, so nothing ever meets the edge of the window. */}
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="mailmux-beams">
          <rect width={VIEW_W} height={VIEW_H} fill="url(#mailmux-beam-mask)" />
        </mask>
      </defs>

      {/* The rotation lives inside the mask, so the field turns while the void
          the icon sits in stays exactly where the icon is. */}
      <g
        className="mailmux-beams"
        mask="url(#mailmux-beams)"
        fill="none"
        strokeWidth="1.4"
        strokeLinecap="round"
      >
        {BEAMS.map((beam, i) => (
          <path
            key={i}
            d={beam.d}
            // currentColor is set once, by the wrapper, per theme.
            stroke={beam.accent ? "var(--accent)" : "currentColor"}
            opacity={beam.accent ? beam.accent : beam.opacity}
          />
        ))}

        {/* The arrivals: the same beams again, drawn as a short dash that
            travels inward and dies at the meeting point. Six of them, spread
            over the cycle, so the field is never busy and never quite still. */}
        {PULSES.map(({ d }, i) => (
          <path
            key={`pulse-${i}`}
            className="mailmux-beam-pulse"
            d={d}
            stroke="var(--accent)"
            opacity="0"
            style={{ animationDelay: `${i * 1.55}s` }}
          />
        ))}
      </g>
    </svg>
  );
}

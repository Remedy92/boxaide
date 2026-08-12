/**
 * The app icon, drawn at hero size.
 *
 * Every path here is generated from apps/desktop/scripts/lib/mark.mjs and
 * copied out of the emitted apps/desktop/build/icon.svg — the plate, the
 * chamfer inset, the two stroke copies that make the mark read as a groove. The
 * page shows the icon the visitor is about to have in their dock, so a
 * different-but-similar drawing would be a small lie on the one screen that has
 * to be trusted. Re-run `npm run icons` and copy across if the mark moves.
 */

/** |x/512|^5 + |y/512|^5 = 1, sampled at 96 points. n = 5 is the macOS shape. */
const PLATE =
  "M1024 512L1023.56 683.99L1022.24 738.75L1020.04 778.3L1016.95 810.17L1012.95 837.17L1008.04 860.66L1002.19 881.45L995.37 900.02L987.56 916.73L978.72 931.81L968.79 945.43L957.72 957.72L945.43 968.79L931.81 978.72L916.73 987.56L900.02 995.37L881.45 1002.19L860.66 1008.04L837.17 1012.95L810.17 1016.95L778.3 1020.04L738.75 1022.24L683.99 1023.56L512 1024L340.01 1023.56L285.25 1022.24L245.7 1020.04L213.83 1016.95L186.83 1012.95L163.34 1008.04L142.55 1002.19L123.98 995.37L107.27 987.56L92.19 978.72L78.57 968.79L66.28 957.72L55.21 945.43L45.28 931.81L36.44 916.73L28.63 900.02L21.81 881.45L15.96 860.66L11.05 837.17L7.05 810.17L3.96 778.3L1.76 738.75L0.44 683.99L0 512L0.44 340.01L1.76 285.25L3.96 245.7L7.05 213.83L11.05 186.83L15.96 163.34L21.81 142.55L28.63 123.98L36.44 107.27L45.28 92.19L55.21 78.57L66.28 66.28L78.57 55.21L92.19 45.28L107.27 36.44L123.98 28.63L142.55 21.81L163.34 15.96L186.83 11.05L213.83 7.05L245.7 3.96L285.25 1.76L340.01 0.44L512 0L683.99 0.44L738.75 1.76L778.3 3.96L810.17 7.05L837.17 11.05L860.66 15.96L881.45 21.81L900.02 28.63L916.73 36.44L931.81 45.28L945.43 55.21L957.72 66.28L968.79 78.57L978.72 92.19L987.56 107.27L995.37 123.98L1002.19 142.55L1008.04 163.34L1012.95 186.83L1016.95 213.83L1020.04 245.7L1022.24 285.25L1023.56 340.01Z";

/** The chamfer: the same plate again, inset, over the face gradient. */
const FACE_TRANSFORM = "translate(61.44 61.44) scale(0.88)";

/**
 * The groove. The mark is stroked twice — once offset down the light axis in a
 * lighter ink, once in place in a darker one. The lighter copy shows only along
 * the lower-right edge, which is the wall of the cut that turns into the light.
 * Two paths standing in for the shader that renders the real icon.
 */
const HIGHLIGHT_TRANSFORM = "translate(4.7 11.3)";

const MARK = [
  { d: "M455.68 348.16L384 348.16L384 486.4L322.56 512L384 537.6L384 675.84L455.68 675.84", w: 48.13 },
  { d: "M568.32 348.16L640 348.16L640 486.4L701.44 512L640 537.6L640 675.84L568.32 675.84", w: 48.13 },
  { d: "M465.92 512L558.08 512", w: 49.15 },
] as const;

function Mark({ stroke, opacity }: { stroke: string; opacity?: number }) {
  return (
    <g fill="none" stroke={stroke} strokeOpacity={opacity} strokeLinecap="round" strokeLinejoin="round">
      {MARK.map((p) => (
        <path key={p.d} d={p.d} strokeWidth={p.w} />
      ))}
    </g>
  );
}

export function AppMark({ size = 88 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="The mailmux app icon"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="mailmux-chamfer" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8d949f" />
          <stop offset="0.55" stopColor="#2a2e35" />
          <stop offset="1" stopColor="#0d0e12" />
        </linearGradient>
        <linearGradient id="mailmux-face" x1="0.12" y1="0" x2="0.88" y2="1">
          <stop offset="0" stopColor="#454a55" />
          <stop offset="1" stopColor="#171920" />
        </linearGradient>
      </defs>

      <path d={PLATE} fill="url(#mailmux-chamfer)" />
      <g transform={FACE_TRANSFORM}>
        <path d={PLATE} fill="url(#mailmux-face)" />
      </g>

      <g className="mailmux-mark-engrave">
        <g transform={HIGHLIGHT_TRANSFORM}>
          <Mark stroke="#79808c" opacity={0.6} />
        </g>
        <Mark stroke="#0f1116" />
      </g>
    </svg>
  );
}

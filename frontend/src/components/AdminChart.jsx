/**
 * The charts on the admin dashboard.
 *
 * Hand-drawn SVG rather than a charting library: the whole requirement is one
 * series over time in a small box, and the smallest sensible library is a
 * bigger download than the entire admin page. Nothing here needs a legend, a
 * second axis, or a tooltip engine.
 *
 * Deliberately plain — this is a tool, not a presentation. What it has to get
 * right is that the shape is honest: a gap in the data has to look like a gap,
 * and the y-axis has to start at zero, because an axis that starts at the
 * minimum turns a 2% wobble into a mountain range.
 */

const PAD = { l: 34, r: 6, t: 8, b: 16 };

function niceMax(v) {
  // Round the top of the axis up to something a person would choose, so the
  // label reads 500 rather than 487.
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (v <= mag * step) return mag * step;
  }
  return mag * 10;
}

const fmtShort = (n) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000)     return `${(n / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

/**
 * @param points  [{ t, ...metrics }] — already bucketed and gap-filled by the
 *                server, so index position IS time position and no date maths
 *                is needed here.
 * @param metric  which key to draw
 */
export default function AdminChart({
  points = [], metric, color = '#1250B4', height = 120, kind = 'bar',
}) {
  if (!points.length) {
    return <div className="text-xs text-muted text-center py-8">No data in this range</div>;
  }

  const W = 320, H = height;
  const vals = points.map(p => Number(p[metric]) || 0);
  const max = niceMax(Math.max(...vals));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => PAD.t + ih - (v / max) * ih;

  // Three gridlines, labelled. Any more is clutter at this size.
  const ticks = [0, max / 2, max];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img"
      aria-label={`${metric} over time`} preserveAspectRatio="none">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)}
            stroke="currentColor" strokeWidth="0.5" className="text-border" opacity="0.7" />
          {/* preserveAspectRatio="none" stretches the drawing to the box, which
              would stretch the type with it — so the labels are drawn outside
              the scaled space by being sized in absolute user units and kept
              small. Good enough at this size and far simpler than a second
              overlaid SVG. */}
          <text x={PAD.l - 4} y={y(t) + 3} textAnchor="end" fontSize="8"
            fill="currentColor" className="text-muted">{fmtShort(t)}</text>
        </g>
      ))}

      {kind === 'bar' ? (
        points.map((p, i) => {
          const v = Number(p[metric]) || 0;
          // One pixel minimum on a non-zero value: a real but tiny day should
          // be visible as something rather than rounding away into the axis
          // and reading as nothing happened.
          const h = v > 0 ? Math.max(1, ih - (y(v) - PAD.t)) : 0;
          const bw = Math.max(1, (iw / points.length) * 0.7);
          return h > 0 ? (
            <rect key={p.t} x={x(i) - bw / 2} y={PAD.t + ih - h} width={bw} height={h}
              fill={color} rx={bw > 3 ? 1 : 0} />
          ) : null;
        })
      ) : (
        <>
          <path
            d={points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(Number(p[metric]) || 0)}`).join(' ')}
            fill="none" stroke={color} strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={`${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(Number(p[metric]) || 0)}`).join(' ')} L${x(points.length - 1)},${PAD.t + ih} L${x(0)},${PAD.t + ih} Z`}
            fill={color} opacity="0.12"
          />
        </>
      )}

      {/* First and last bucket, so the range is readable off the chart itself
          rather than only from the picker above it. */}
      <text x={PAD.l} y={H - 4} fontSize="8" fill="currentColor" className="text-muted">
        {points[0].t}
      </text>
      <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize="8" fill="currentColor" className="text-muted">
        {points[points.length - 1].t}
      </text>
    </svg>
  );
}

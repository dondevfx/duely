import { ICON_ALIGN } from './UiIcon';

/**
 * RankIcon — the badge for each ELO rank.
 *
 * These were emoji: 🥉 🥈 🥇 for the first three, then 💠 ✦ 👑 for the rest.
 * Two problems with that. The medals are a different metaphor from the gems
 * and the crown, so the ladder did not read as one progression; and ✦ is a
 * plain text star that renders in the page's font colour, so Diamond had no
 * colour of its own at all.
 *
 * One shape language now: a shield, filling in and gaining detail as the rank
 * climbs, in each rank's own colour. The colours are the ones already defined
 * in utils/ranks.js and are passed in rather than repeated here, so the badge
 * and the rank text can never disagree.
 */

// A shield with a raised inner face, so every badge has depth rather than
// being a flat outline. Two paths: the plate, and the bevel inside it.
const SHIELD  = 'M12 2.2l8 2.9v6.3c0 4.8-3.3 8.7-8 10.7-4.7-2-8-5.9-8-10.7V5.1z';
const BEVEL   = 'M12 4.4l6 2.2v4.8c0 3.6-2.5 6.6-6 8.2-3.5-1.6-6-4.6-6-8.2V6.6z';

// A gem, used by the top ranks. Drawn as a crown, a girdle and a pavilion so
// it reads as cut stone rather than a diamond outline.
function Gem({ c, cx = 12, cy = 12.6, s = 1 }) {
  const w = 4.3 * s, top = 2.5 * s, bot = 4.4 * s;
  return (
    <g>
      <path d={`M${cx - w} ${cy - top * 0.15} L${cx} ${cy + bot} L${cx + w} ${cy - top * 0.15} Z`} fill={c} />
      <path d={`M${cx - w * 0.6} ${cy - top} L${cx + w * 0.6} ${cy - top} L${cx + w} ${cy - top * 0.15} L${cx - w} ${cy - top * 0.15} Z`}
        fill="#FFFFFF" opacity="0.55" />
      <path d={`M${cx - w} ${cy - top * 0.15} H${cx + w}`} stroke="#FFFFFF" strokeWidth={0.5 * s} opacity="0.85" />
      <path d={`M${cx - w * 0.6} ${cy - top} L${cx - w * 0.2} ${cy + bot}`} stroke="#FFFFFF" strokeWidth={0.35 * s} opacity="0.45" />
      <path d={`M${cx + w * 0.6} ${cy - top} L${cx + w * 0.2} ${cy + bot}`} stroke="#FFFFFF" strokeWidth={0.35 * s} opacity="0.45" />
    </g>
  );
}

// Chevrons — how the lower three ranks count up. Stacked rather than dotted:
// a chevron reads as a rank insignia and survives being 14px wide, where three
// small dots turn into one smudge.
function Chevrons({ n, c }) {
  const ys = n === 1 ? [13.6] : n === 2 ? [11.9, 15.1] : [10.4, 13.5, 16.6];
  return (
    <g fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {ys.map((y, i) => <path key={i} d={`M8.2 ${y + 1.9} L12 ${y} L15.8 ${y + 1.9}`} />)}
    </g>
  );
}

const plate = (c) => (
  <>
    <path d={SHIELD} fill={`${c}26`} stroke={c} strokeWidth="1.7" strokeLinejoin="round" />
    <path d={BEVEL}  fill="none"     stroke={c} strokeWidth="0.8" opacity="0.5" strokeLinejoin="round" />
    {/* a highlight down the left face, which is what stops it reading flat */}
    <path d="M12 4.4 L6 6.6v4.8c0 3.6 2.5 6.6 6 8.2z" fill="#FFFFFF" opacity="0.06" />
  </>
);

const ART = {
  Bronze:   (c) => <>{plate(c)}<Chevrons n={1} c={c} /></>,
  Silver:   (c) => <>{plate(c)}<Chevrons n={2} c={c} /></>,
  Gold:     (c) => <>{plate(c)}<Chevrons n={3} c={c} /></>,
  // Platinum onward stop counting and carry a mark instead, so the top half of
  // the ladder is obviously a different tier and not just "four chevrons".
  Platinum: (c) => (
    <>
      {plate(c)}
      <Gem c={c} s={0.78} cy={12.2} />
      <path d="M7.6 8.4l1.1 1.1M16.4 8.4l-1.1 1.1" stroke={c} strokeWidth="1.2"
        strokeLinecap="round" opacity="0.8" />
    </>
  ),
  Diamond:  (c) => (
    <>
      {plate(c)}
      <Gem c={c} s={1} cy={12.4} />
      {/* sparkles, so Diamond outranks Platinum at a glance */}
      <path d="M6.6 7.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill={c} opacity="0.9" />
      <path d="M17.6 9.2l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z" fill={c} opacity="0.75" />
    </>
  ),
  Champion: (c) => (
    <>
      {plate(c)}
      <path d="M7 16.2l-1.2-7 3.7 2.6L12 7.4l2.5 4.4 3.7-2.6-1.2 7z" fill={c} />
      <rect x="7" y="17" width="10" height="2" rx="0.8" fill={c} />
      <circle cx="5.8" cy="8.6" r="1" fill={c} />
      <circle cx="18.2" cy="8.6" r="1" fill={c} />
      <circle cx="12" cy="6.6" r="1.1" fill={c} />
    </>
  ),
  Unranked: (c) => (
    <>
      <path d={SHIELD} fill="none" stroke={c} strokeWidth="1.5"
        strokeDasharray="2.8 2.2" strokeLinejoin="round" opacity="0.8" />
      <text x="12" y="15.8" fontSize="8" fontWeight="900" textAnchor="middle"
        fontFamily="system-ui, sans-serif" fill={c} opacity="0.8">?</text>
    </>
  ),
};

export default function RankIcon({ rank, size = 18, className = '', title }) {
  // Accepts the rank object from utils/ranks.js, or just its name.
  const name  = typeof rank === 'string' ? rank : rank?.name;
  const color = (typeof rank === 'object' && rank?.color) || '#64748b';
  const Art = ART[name] || ART.Unranked;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}
      role={title ? 'img' : 'presentation'}
      aria-label={title || name || undefined}
      aria-hidden={title || name ? undefined : 'true'}
      focusable="false"
    >
      {Art(color)}
    </svg>
  );
}

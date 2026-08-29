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

// The shield outline every rank shares.
const SHIELD = 'M12 2.4l7.6 2.7v6.2c0 4.6-3.1 8.3-7.6 10.3-4.5-2-7.6-5.7-7.6-10.3V5.1z';

function Pips({ n, color }) {
  // Bronze/Silver/Gold are told apart by how many pips they carry, so the
  // three lowest ranks are distinguishable without relying on metal colour —
  // which is the pair most often confused at a glance, and the pair most
  // players actually sit in.
  const xs = n === 1 ? [12] : n === 2 ? [9.4, 14.6] : [7.2, 12, 16.8];
  return (
    <g>
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy="12.4" r="1.5" fill={color} />
      ))}
    </g>
  );
}

const ART = {
  Bronze:   (c) => <><path d={SHIELD} fill={`${c}22`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" /><Pips n={1} color={c} /></>,
  Silver:   (c) => <><path d={SHIELD} fill={`${c}2E`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" /><Pips n={2} color={c} /></>,
  Gold:     (c) => <><path d={SHIELD} fill={`${c}33`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" /><Pips n={3} color={c} /></>,
  // Platinum onward stop counting pips and gain a mark instead, so the top
  // half of the ladder is obviously a different tier and not just "four pips".
  Platinum: (c) => (
    <>
      <path d={SHIELD} fill={`${c}33`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 7.6l3.1 4.4L12 16.4 8.9 12z" fill={c} opacity="0.9" />
    </>
  ),
  Diamond:  (c) => (
    <>
      <path d={SHIELD} fill={`${c}38`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.4 10.4h7.2L12 17.2z" fill={c} />
      <path d="M9.6 7.2h4.8l1.2 3.2H8.4z" fill={c} opacity="0.75" />
    </>
  ),
  Champion: (c) => (
    <>
      <path d={SHIELD} fill={`${c}3D`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.4 15.4l-1-6 3.4 2.4L12 7.6l2.2 4.2 3.4-2.4-1 6z" fill={c} />
      <rect x="7.4" y="16.2" width="9.2" height="1.7" rx="0.6" fill={c} />
    </>
  ),
  Unranked: (c) => (
    <>
      <path d={SHIELD} fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2.6 2" strokeLinejoin="round" />
      <text x="12" y="15.6" fontSize="7.5" fontWeight="900" textAnchor="middle"
        fontFamily="system-ui, sans-serif" fill={c}>?</text>
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
      className={`inline-block shrink-0 align-middle ${className}`}
      role={title ? 'img' : 'presentation'}
      aria-label={title || name || undefined}
      aria-hidden={title || name ? undefined : 'true'}
      focusable="false"
    >
      {Art(color)}
    </svg>
  );
}

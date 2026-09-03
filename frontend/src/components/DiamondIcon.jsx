import { useId } from 'react';
/**
 * DiamondIcon — the diamond currency.
 *
 * Replaces the 💎 emoji, which renders as a different gem on every platform
 * and could not be sized or coloured to sit beside a number. This is drawn to
 * match what the emoji looked like on the phones the site was built against:
 * a cyan brilliant seen face-on, with the crown facets above the girdle and
 * the pavilion narrowing to a point below.
 *
 * Sized in `em` by default so it scales with the text it sits next to, the
 * same way CoinIcon does — a currency mark should follow its number.
 */
export default function DiamondIcon({ size = '1em', className = '', title }) {
  // useId is stable across server and client render and unique per instance,
  // which is exactly what an SVG def needs and what a hand-written constant
  // cannot be.
  const uid = useId();
  const crownId = `dia_crown_${uid}`;
  const pavId   = `dia_pav_${uid}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      className={`inline-block shrink-0 ${className}`}
      style={{ verticalAlign: '-0.12em' }}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      {/* Ids unique per instance, via useId.
          These were the fixed strings "dia_crown" and "dia_pav", and a page
          with eleven diamonds on it therefore declared the same two ids
          eleven times. An id is document-wide: every url(#dia_pav) reference
          resolved to whichever copy happened to be first in the DOM, so all
          eleven icons were painted from one icon's defs. It looks harmless
          while they are identical and is not — unmount the first one and the
          other ten lose their fill, because the gradient they point at no
          longer exists. */}
      <defs>
        <linearGradient id={crownId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#BFF3FF" />
          <stop offset="100%" stopColor="#5CD8F5" />
        </linearGradient>
        <linearGradient id={pavId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#3FC4EC" />
          <stop offset="100%" stopColor="#137FB8" />
        </linearGradient>
      </defs>
      {/* pavilion — girdle down to the point */}
      <path d="M2.6 9.9h18.8L12 21.6z" fill={`url(#${pavId})`} />
      {/* crown — table and the facets above the girdle */}
      <path d="M7.4 3.2h9.2l4.8 6.7H2.6z" fill={`url(#${crownId})`} />
      {/* facet lines, the thing that makes it read as a gem and not a kite */}
      <path d="M7.4 3.2 5.6 9.9 12 21.6 18.4 9.9 16.6 3.2" fill="none"
        stroke="rgba(255,255,255,0.55)" strokeWidth="0.85" strokeLinejoin="round" />
      <path d="M2.6 9.9h18.8" stroke="rgba(255,255,255,0.75)" strokeWidth="0.9" />
      <path d="M5.6 9.9 12 3.2l6.4 6.7" fill="none"
        stroke="rgba(255,255,255,0.4)" strokeWidth="0.75" />
      {/* highlight on the table */}
      <path d="M8.6 4.6h4.1l-1.2 3.6H7.4z" fill="rgba(255,255,255,0.5)" />
    </svg>
  );
}

// The diamond drawn as bare SVG geometry, for use INSIDE an existing <svg>.
//
// DiamondIcon renders its own <svg> element, and an <svg> is not a legal child
// of <text> — dropping it in there silently renders nothing, which is what
// emptied both wheels. This is the same shape as plain paths that can sit in
// any SVG scene.
export function DiamondGlyph({ cx, cy, size = 11, opacity = 1 }) {
  const w = size * 0.42, hTop = size * 0.30, hBot = size * 0.52;
  return (
    <g opacity={opacity}>
      <path d={`M${cx - w} ${cy - hTop * 0.1} L${cx} ${cy + hBot} L${cx + w} ${cy - hTop * 0.1} Z`} fill="#2FA9D8" />
      <path d={`M${cx - w * 0.62} ${cy - hTop} L${cx + w * 0.62} ${cy - hTop} L${cx + w} ${cy - hTop * 0.1} L${cx - w} ${cy - hTop * 0.1} Z`} fill="#7FE3FA" />
      <path d={`M${cx - w} ${cy - hTop * 0.1} L${cx + w} ${cy - hTop * 0.1}`} stroke="rgba(255,255,255,0.8)" strokeWidth={size * 0.06} />
    </g>
  );
}

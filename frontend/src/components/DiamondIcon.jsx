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
      <defs>
        <linearGradient id="dia_crown" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#BFF3FF" />
          <stop offset="100%" stopColor="#5CD8F5" />
        </linearGradient>
        <linearGradient id="dia_pav" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#3FC4EC" />
          <stop offset="100%" stopColor="#137FB8" />
        </linearGradient>
      </defs>
      {/* pavilion — girdle down to the point */}
      <path d="M2.6 9.9h18.8L12 21.6z" fill="url(#dia_pav)" />
      {/* crown — table and the facets above the girdle */}
      <path d="M7.4 3.2h9.2l4.8 6.7H2.6z" fill="url(#dia_crown)" />
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

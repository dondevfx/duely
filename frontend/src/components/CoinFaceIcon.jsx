/**
 * The Coin Flip coin, as a small icon.
 *
 * The betting screen picked heads and tails with a 🔵 and a ⚪ — two coloured
 * dots that look nothing like the coin the game actually flips, and that render
 * as different shapes on different phones. The result card and the flip banner
 * used the same two.
 *
 * Drawn from the SAME description as Coin3D's faces in CoinFlipGame: heads is
 * blue metal lit from the upper left with a white H, tails is the pale silver
 * face with a blue T, both with the milled rim. So what you pick looks like
 * what lands.
 *
 * SVG rather than a copy of the 3D coin's DOM: that one is a stack of absolutely
 * positioned layers sized for a 200px coin, and it does not survive being shrunk
 * to sit next to a word.
 */

// The reeded rim — short radial ticks around the edge, the flat equivalent of
// CoinDetail's repeating-conic-gradient.
function Rim({ color, r = 21 }) {
  const ticks = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    ticks.push(
      <line
        key={i}
        x1={24 + Math.cos(a) * (r - 2.4)} y1={24 + Math.sin(a) * (r - 2.4)}
        x2={24 + Math.cos(a) * r}        y2={24 + Math.sin(a) * r}
        stroke={color} strokeWidth="1.5" strokeLinecap="butt"
      />,
    );
  }
  return <g opacity="0.65">{ticks}</g>;
}

export default function CoinFaceIcon({ side = 'heads', size = '1em', className = '', title }) {
  const heads = side === 'heads';
  const id = `cf_${side}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48"
      className={`inline-block shrink-0 align-middle ${className}`}
      role={title ? 'img' : 'presentation'}
      aria-label={title || (heads ? 'heads' : 'tails')}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      <defs>
        {/* Lit from 38%/32%, the same offset the 3D faces use, which is what
            makes it read as a struck coin rather than a flat disc. */}
        <radialGradient id={id} cx="38%" cy="32%" r="72%">
          {heads ? (
            <>
              <stop offset="0%" stopColor="#A0D8FF" />
              <stop offset="42%" stopColor="#1250B4" />
              <stop offset="100%" stopColor="#003088" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="42%" stopColor="#DDEFFF" />
              <stop offset="100%" stopColor="#8AB8F0" />
            </>
          )}
        </radialGradient>
      </defs>

      <circle cx="24" cy="24" r="22" fill={`url(#${id})`}
        stroke={heads ? '#0066DD' : '#90B8FF'} strokeWidth="3" />
      <Rim color={heads ? 'rgba(195,228,255,0.9)' : 'rgba(105,150,210,0.75)'} />
      {/* The inner ring both faces carry. */}
      <circle cx="24" cy="24" r="17.5" fill="none"
        stroke={heads ? 'rgba(160,216,255,0.5)' : 'rgba(255,255,255,0.65)'} strokeWidth="1.2" />
      <text
        x="24" y="24" textAnchor="middle" dominantBaseline="central"
        fontSize="24" fontWeight="900"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fill={heads ? '#FFFFFF' : '#1250B4'}
      >
        {heads ? 'H' : 'T'}
      </text>
    </svg>
  );
}

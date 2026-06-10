// Gold coin SVG that looks identical on every device/OS/browser
// Use this instead of the 🪙 emoji anywhere you want a consistent coin icon.
export default function CoinIcon({ size = '1em', style = {} }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ display: 'inline-block', verticalAlign: '-0.15em', flexShrink: 0, ...style }}
      aria-label="coins"
    >
      <defs>
        <radialGradient id="coinFace" cx="38%" cy="35%" r="65%">
          <stop offset="0%"   stopColor="#FFED8A" />
          <stop offset="55%"  stopColor="#F5C518" />
          <stop offset="100%" stopColor="#C8860A" />
        </radialGradient>
        <radialGradient id="coinEdge" cx="50%" cy="50%" r="50%">
          <stop offset="70%"  stopColor="#D4920E" />
          <stop offset="100%" stopColor="#9A6200" />
        </radialGradient>
      </defs>
      {/* Coin edge (shadow/depth) */}
      <ellipse cx="12" cy="13" rx="9" ry="4.5" fill="url(#coinEdge)" />
      {/* Coin face */}
      <ellipse cx="12" cy="11" rx="9" ry="4.5" fill="url(#coinFace)" />
      {/* Shine highlight */}
      <ellipse cx="9.5" cy="9.5" rx="3" ry="1.4" fill="rgba(255,255,255,0.35)" transform="rotate(-20 9.5 9.5)" />
      {/* Dollar mark */}
      <text x="12" y="13.5" textAnchor="middle" fontSize="5.5" fontWeight="900"
        fill="#9A6200" fontFamily="system-ui,sans-serif">$</text>
    </svg>
  );
}

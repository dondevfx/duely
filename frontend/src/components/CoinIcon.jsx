// Pure CSS gold coin — renders identically on every device, OS, and browser.
// No emoji, no SVG image paths, just a gradient circle.
export default function CoinIcon({ size = '1em' }) {
  return (
    <span
      aria-label="coins"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(145deg, #FFE566 0%, #F5C518 45%, #D4920E 75%, #C07800 100%)',
        border: '1px solid rgba(160,100,0,0.4)',
        boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.25)',
        flexShrink: 0,
        verticalAlign: '-0.1em',
      }}
    />
  );
}

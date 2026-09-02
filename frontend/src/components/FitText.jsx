import { useRef, useLayoutEffect, useState } from 'react';

/**
 * Text that shrinks to fit its box instead of spilling out of it or being cut.
 *
 * The stat tiles — balance, wagered, wins, coins collected — are a fixed grid
 * with a big bold number in each. They were guarded with `truncate` and
 * `overflow-hidden`, which are not fixes: truncate cuts "2,500 coins" down to
 * "2,500 c…" and overflow-hidden just hides the end. Either way the number a
 * player is trying to read is the part that goes missing, and it gets worse the
 * more they win, which is exactly backwards.
 *
 * Scaled rather than re-sized. A transform is not part of layout, so measuring
 * cannot be disturbed by the change it triggers — the usual font-size loop
 * oscillates when shrinking the text changes the wrapping that made it too big.
 * It also keeps the baseline and the tile height identical whether or not any
 * shrinking happened, so a row of tiles stays level.
 *
 * Only ever scales DOWN: text that fits is left exactly as designed.
 */
export default function FitText({
  children,
  className = '',
  // A floor, not a target. Real values never come close: fmtCoins abbreviates
  // at a million, so the longest a balance gets is "999,999.99" and the longest
  // stat is "999,999.99 coins", both of which shrink far less than this. It
  // exists so a value that somehow arrives unabbreviated still fits rather than
  // spilling out of the tile — which is the whole point of this component.
  min = 0.3,
  title,
  style,
}) {
  const boxRef = useRef(null);
  const innerRef = useRef(null);
  const [scaled, setScaled] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;

    const fit = () => {
      // Measure at natural size, or we would be measuring the last fit.
      inner.style.transform = 'none';
      const avail = box.clientWidth;
      const need = inner.scrollWidth;
      if (!avail || !need) return;
      const s = need > avail ? Math.max(min, avail / need) : 1;
      inner.style.transform = s < 1 ? `scale(${s})` : 'none';
      setScaled(s < 1);
    };

    fit();
    // Re-fit on rotation, font load, or the tile changing width — not just on
    // mount, or a landscape phone keeps the portrait scale.
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    if (document.fonts?.ready) document.fonts.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
  });

  return (
    <div ref={boxRef} className={`overflow-hidden ${className}`} style={style}>
      <span
        ref={innerRef}
        // origin-LEFT, not centre, and this is the whole correctness of the
        // component.
        //
        // A transform scales about the element's own natural box, and the
        // natural box here is the OVERSIZED one — that is the only case where
        // any scaling happens. Scaling 83px of text about its own centre
        // inside a 53px container leaves it centred on 83px, which sits 15px
        // to the right of where the container is, so the right-hand end fell
        // outside and the container's own overflow-hidden cut it off. That is
        // how "Champion" became "Champio" AFTER being shrunk to fit: it did
        // fit, it was just in the wrong place.
        //
        // From the left it lands correctly by construction. The scale is
        // exactly avail/need, so the scaled width is exactly the container
        // width — starting at the left edge means ending at the right edge,
        // and a box filled edge to edge needs no centring.
        className="inline-block whitespace-nowrap origin-left will-change-transform"
        // The full value is always reachable even at the smallest scale.
        title={title}
        data-fit-scaled={scaled ? 'true' : undefined}
      >
        {children}
      </span>
    </div>
  );
}

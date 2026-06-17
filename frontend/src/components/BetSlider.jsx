import { useEffect, useRef } from 'react';

function fmtFee(fee) {
  if (fee < 1)     return `${fee}`;
  if (fee >= 1000) return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

function applySliderDOM(rawIdx, fees, thumb, fill, display) {
  const maxIdx = fees.length - 1;
  const clamped = Math.max(0, Math.min(maxIdx, rawIdx));
  const pct = maxIdx > 0 ? (clamped / maxIdx) * 100 : 0;
  if (thumb)   thumb.style.left   = `${pct}%`;
  if (fill)    fill.style.width   = `${pct}%`;
  if (display) display.textContent = fmtFee(fees[Math.round(clamped)] ?? fees[0]);
}

/**
 * Smooth DOM-driven bet slider — zero React re-renders during drag.
 * Props:
 *   fees        number[]   — array of bet amounts
 *   entryFee    number     — current committed fee (React state)
 *   setEntryFee fn         — called once on pointer release with snapped fee
 *   currLabel   ReactNode  — coin icon or '💎' to show next to amount
 */
export default function BetSlider({ fees, entryFee, setEntryFee, currLabel }) {
  const trackRef   = useRef(null);
  const thumbRef   = useRef(null);
  const fillRef    = useRef(null);
  const displayRef = useRef(null);
  const dragRef    = useRef({ active: false, fees, setEntryFee });

  // Keep dragRef current on every render
  dragRef.current.fees       = fees;
  dragRef.current.setEntryFee = setEntryFee;

  // Sync DOM when entryFee or fees changes externally
  useEffect(() => {
    const idx = Math.max(0, fees.indexOf(entryFee));
    applySliderDOM(idx, fees, thumbRef.current, fillRef.current, displayRef.current);
  }, [fees, entryFee]);

  // Attach native pointer events once — smooth on mouse and touch
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    function rawFromX(clientX) {
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pct * (dragRef.current.fees.length - 1);
    }

    function onDown(e) {
      dragRef.current.active = true;
      track.setPointerCapture(e.pointerId);
      applySliderDOM(rawFromX(e.clientX), dragRef.current.fees, thumbRef.current, fillRef.current, displayRef.current);
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragRef.current.active) return;
      applySliderDOM(rawFromX(e.clientX), dragRef.current.fees, thumbRef.current, fillRef.current, displayRef.current);
    }

    function onUp(e) {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      const raw     = rawFromX(e.clientX);
      const snapped = Math.round(Math.max(0, Math.min(dragRef.current.fees.length - 1, raw)));
      applySliderDOM(snapped, dragRef.current.fees, thumbRef.current, fillRef.current, displayRef.current);
      dragRef.current.setEntryFee(dragRef.current.fees[snapped]);
    }

    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup',   onUp);
    track.addEventListener('pointercancel', onUp);
    return () => {
      track.removeEventListener('pointerdown', onDown);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup',   onUp);
      track.removeEventListener('pointercancel', onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Fee display row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted">Min: {fmtFee(fees[0])} {currLabel}</span>
        <span className="text-2xl font-black text-white">
          <span ref={displayRef}>{fmtFee(entryFee)}</span>{' '}
          <span className="text-primary">{currLabel}</span>
        </span>
        <span className="text-sm text-muted">Max: {fmtFee(fees[fees.length - 1])} {currLabel}</span>
      </div>

      {/* Slider track */}
      <div
        ref={trackRef}
        className="relative w-full h-12 flex items-center cursor-grab active:cursor-grabbing select-none touch-none"
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        {/* Track background + fill */}
        <div className="absolute left-0 right-0 h-2 rounded-full bg-border overflow-hidden">
          <div ref={fillRef} className="h-full rounded-full bg-primary" style={{ width: '0%' }} />
        </div>
        {/* Tick marks */}
        {fees.map((_, i) => {
          const pct = fees.length > 1 ? (i / (fees.length - 1)) * 100 : 0;
          return (
            <div
              key={i}
              className="absolute w-1.5 h-1.5 rounded-full bg-white opacity-50 -translate-x-1/2 pointer-events-none"
              style={{ left: `${pct}%` }}
            />
          );
        })}
        {/* Thumb */}
        <div
          ref={thumbRef}
          className="absolute w-6 h-6 rounded-full bg-white border-2 border-primary -translate-x-1/2 pointer-events-none"
          style={{ left: '0%', boxShadow: '0 2px 12px rgba(30,144,255,0.6)' }}
        />
      </div>
    </>
  );
}

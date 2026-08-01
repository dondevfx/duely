import { useEffect, useRef } from 'react';

function fmtFee(fee) {
  if (fee < 1)     return `${fee}`;
  if (fee >= 1000) return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

function calcPayout(fee, isDiamonds, payoutMult = 0.95) {
  if (isDiamonds) return (fee * 2).toLocaleString();
  const p = fee * 2 * payoutMult;
  return p % 1 === 0 ? p.toLocaleString() : p.toFixed(2);
}

function applySliderDOM(rawIdx, fees, isDiamonds, thumb, fill, display, payout, payoutMult = 0.95) {
  const maxIdx = fees.length - 1;
  const clamped = Math.max(0, Math.min(maxIdx, rawIdx));
  const pct = maxIdx > 0 ? (clamped / maxIdx) * 100 : 0;
  const fee = fees[Math.round(clamped)] ?? fees[0];
  if (thumb)   thumb.style.left    = `${pct}%`;
  if (fill)    fill.style.width    = `${pct}%`;
  if (display) display.textContent = fmtFee(fee);
  if (payout)  payout.textContent  = fee > 0 ? `+${calcPayout(fee, isDiamonds, payoutMult)}` : '';
}

/**
 * Smooth DOM-driven bet slider — zero React re-renders during drag.
 * Props:
 *   fees        number[]   — array of bet amounts
 *   entryFee    number     — current committed fee (React state)
 *   setEntryFee fn         — called once on pointer release with snapped fee
 *   currLabel   ReactNode  — coin icon or '💎' to show next to amount
 *   isDiamonds  bool       — controls payout formula (2x vs 1.9x)
 */
export default function BetSlider({ fees, entryFee, setEntryFee, currLabel, isDiamonds = false, payoutMult = 0.95 }) {
  const trackRef   = useRef(null);
  const thumbRef   = useRef(null);
  const fillRef    = useRef(null);
  const displayRef = useRef(null);
  const payoutRef  = useRef(null);
  const dragRef    = useRef({ active: false, fees, setEntryFee, isDiamonds, payoutMult });

  dragRef.current.fees        = fees;
  dragRef.current.setEntryFee = setEntryFee;
  dragRef.current.isDiamonds  = isDiamonds;
  dragRef.current.payoutMult  = payoutMult;

  // Sync DOM when entryFee / fees / isDiamonds changes externally
  useEffect(() => {
    const idx = Math.max(0, fees.indexOf(entryFee));
    applySliderDOM(idx, fees, isDiamonds, thumbRef.current, fillRef.current, displayRef.current, payoutRef.current, payoutMult);
  }, [fees, entryFee, isDiamonds, payoutMult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach native pointer events once — smooth on mouse and touch
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    function rawFromX(clientX) {
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pct * (dragRef.current.fees.length - 1);
    }

    function apply(raw) {
      applySliderDOM(raw, dragRef.current.fees, dragRef.current.isDiamonds,
        thumbRef.current, fillRef.current, displayRef.current, payoutRef.current, dragRef.current.payoutMult);
    }

    function onDown(e) {
      dragRef.current.active = true;
      track.setPointerCapture(e.pointerId);
      apply(rawFromX(e.clientX));
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragRef.current.active) return;
      apply(rawFromX(e.clientX));
    }

    function onUp(e) {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      const snapped = Math.round(Math.max(0, Math.min(dragRef.current.fees.length - 1, rawFromX(e.clientX))));
      apply(snapped);
      dragRef.current.setEntryFee(dragRef.current.fees[snapped]);
    }

    track.addEventListener('pointerdown',   onDown);
    track.addEventListener('pointermove',   onMove);
    track.addEventListener('pointerup',     onUp);
    track.addEventListener('pointercancel', onUp);
    return () => {
      track.removeEventListener('pointerdown',   onDown);
      track.removeEventListener('pointermove',   onMove);
      track.removeEventListener('pointerup',     onUp);
      track.removeEventListener('pointercancel', onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Fee display row */}
      <div className="flex items-center justify-center sm:justify-between mb-1.5 sm:mb-3">
        <span className="hidden sm:inline text-sm text-muted">Min: {fmtFee(fees[0])} {currLabel}</span>
        <span className="text-2xl sm:text-2xl font-black text-white">
          <span ref={displayRef}>{fmtFee(entryFee)}</span>{' '}
          <span className="text-primary">{currLabel}</span>
        </span>
        <span className="hidden sm:inline text-sm text-muted">Max: {fmtFee(fees[fees.length - 1])} {currLabel}</span>
      </div>

      {/* Slider track.
          The thumb is 24px wide and centred on its position, so it sticks out
          12px past each end of the track. Without this inset it hangs off the
          side of the card — and off the screen — at the min and max stops. */}
      <div className="px-3">
      <div
        ref={trackRef}
        className="relative w-full h-9 sm:h-12 flex items-center cursor-grab active:cursor-grabbing select-none touch-none"
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div className="absolute left-0 right-0 h-2 rounded-full bg-border overflow-hidden">
          <div ref={fillRef} className="h-full rounded-full bg-primary" style={{ width: '0%' }} />
        </div>
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
        <div
          ref={thumbRef}
          className="absolute w-6 h-6 rounded-full bg-white border-2 border-primary -translate-x-1/2 pointer-events-none"
          style={{ left: '0%', boxShadow: '0 2px 12px rgba(18,80,180,0.6)' }}
        />
      </div>
      </div>

      {/* Live payout — updates during drag. On a phone the label and figure
          share one line; stacked they cost ~20px the action buttons need. */}
      {entryFee > 0 && (
        <div className="mt-1 sm:mt-4 text-center flex items-baseline justify-center gap-2 sm:block">
          <div className="text-[10px] sm:text-xs text-muted uppercase tracking-widest mb-0 sm:mb-1 font-semibold">Win Payout</div>
          <div className="text-lg sm:text-3xl font-black text-success inline-flex items-center gap-1" style={{ textShadow: '0 0 16px rgba(34,197,94,0.4)' }}>
            <span ref={payoutRef}>{entryFee > 0 ? `+${calcPayout(entryFee, isDiamonds, payoutMult)}` : ''}</span>
            {' '}{currLabel}
          </div>
        </div>
      )}
    </>
  );
}

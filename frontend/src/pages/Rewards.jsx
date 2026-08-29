import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import DiamondIcon, { DiamondGlyph } from '../components/DiamondIcon';
import RankIcon from '../components/RankIcon';
import UiIcon, { RakebackTierIcon } from '../components/UiIcon';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { isRanked, placementMatches } from '../utils/ranks';
import DailyBonus from '../components/DailyBonus';
import CoinIcon from '../components/CoinIcon';
import SpinWheel from '../components/SpinWheel';
import ReferralCard from '../components/ReferralCard';
import { playWheelSpin, playWin } from '../utils/sound';

// ── Tier definitions ───────────────────────────────────────────────────────
const TIERS = [
  {
    id:       'bronze',
    label:    'Bronze',
    icon:     '🥉',
    color:    '#cd7f32',
    glow:     'rgba(205,127,50,0.4)',
    minElo:   0,
    lockText: 'Reach 0 ELO',  // always unlocked at floor
    prizes:   [1000,  2000,  0, 2000,  5000,  2000,  10000, 1000],
  },
  {
    id:       'silver',
    label:    'Silver',
    icon:     '🥈',
    color:    '#a8a9ad',
    glow:     'rgba(168,169,173,0.4)',
    minElo:   1100,
    lockText: 'Reach 1100 ELO',
    prizes:   [2000,  5000,  0, 5000,  12000, 5000,  25000, 2000],
  },
  {
    id:       'gold',
    label:    'Gold',
    icon:     '🥇',
    color:    '#ffd700',
    glow:     'rgba(255,215,0,0.4)',
    minElo:   1300,
    lockText: 'Reach 1300 ELO',
    prizes:   [3000,  8000,  0, 8000,  20000, 8000,  50000, 3000],
  },
  {
    id:       'diamond',
    label:    'Diamond',
    icon:     '✦',
    color:    '#b388ff',
    glow:     'rgba(179,136,255,0.4)',
    minElo:   1500,
    lockText: 'Reach 1500 ELO',
    prizes:   [5000,  15000, 0, 15000, 40000, 15000, 75000, 5000],
  },
  {
    id:       'champion',
    label:    'Champion',
    icon:     '👑',
    color:    '#ff1744',
    glow:     'rgba(255,23,68,0.5)',
    minElo:   1900,
    lockText: 'Reach 1900 ELO',
    prizes:   [10000, 25000, 0, 25000, 60000, 25000, 100000, 10000],
  },
];

function getTierId(elo) {
  if (elo >= 1900) return 'champion';
  if (elo >= 1500) return 'diamond';
  if (elo >= 1300) return 'gold';
  if (elo >= 1100) return 'silver';
  return 'bronze';
}

// ── Segment color themes (matches SpinWheel.jsx palette) ──────────────────
// Layout: [lowest, small, coin, small, medium, small, max, lowest]
// Indices:    0       1     2     3       4       5    6     7
const SEG_THEMES = [
  { bg: '#dde3ec', fade: '#8a96a8', text: '#0f172a', border: '#94a3b8' }, // 0 – lowest (white)
  { bg: '#1d4ed8', fade: '#1e3a8a', text: '#ffffff', border: '#60a5fa' }, // 1 – small (blue)
  { bg: '#ffd700', fade: '#f59e0b', text: '#1a1000', border: '#fbbf24', isGold: true }, // 2 – coin (gold)
  { bg: '#1d4ed8', fade: '#1e3a8a', text: '#ffffff', border: '#60a5fa' }, // 3 – small (blue)
  { bg: '#0a0a0a', fade: '#000000', text: '#e2e8f0', border: '#374151' }, // 4 – medium (black)
  { bg: '#1d4ed8', fade: '#1e3a8a', text: '#ffffff', border: '#60a5fa' }, // 5 – small (blue)
  { bg: '#374151', fade: '#1f2937', text: '#d1d5db', border: '#6b7280' }, // 6 – max (grey/gold)
  { bg: '#dde3ec', fade: '#8a96a8', text: '#0f172a', border: '#94a3b8' }, // 7 – lowest (white)
];

// Segment labels — index 2 is always the coin visual
function buildLabels(prizes) {
  return prizes.map((p, i) => (i === 2 ? 'coin' : fmtPrize(p)));
}

function fmtPrize(n) {
  if (n >= 1000) return `${n / 1000}K`;
  return String(n);
}

// ── SVG wheel constants ────────────────────────────────────────────────────
const N    = 8;
const STEP = 360 / N; // 45°
const CX   = 150;
const CY   = 150;
const R    = 130;
const SIZE = CX * 2;

// ── SVG helpers ────────────────────────────────────────────────────────────
function wedge(cx, cy, r, sDeg, eDeg) {
  const rad = d => ((d - 90) * Math.PI) / 180;
  const x1  = cx + r * Math.cos(rad(sDeg));
  const y1  = cy + r * Math.sin(rad(sDeg));
  const x2  = cx + r * Math.cos(rad(eDeg));
  const y2  = cy + r * Math.sin(rad(eDeg));
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2} Z`;
}

function edgeArc(cx, cy, r, sDeg, eDeg) {
  const rad = d => ((d - 90) * Math.PI) / 180;
  const x1  = cx + r * Math.cos(rad(sDeg + 1));
  const y1  = cy + r * Math.sin(rad(sDeg + 1));
  const x2  = cx + r * Math.cos(rad(eDeg - 1));
  const y2  = cy + r * Math.sin(rad(eDeg - 1));
  return `M${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2}`;
}

function labelXY(cx, cy, r, midDeg) {
  const rad = d => ((d - 90) * Math.PI) / 180;
  return {
    x: cx + r * 0.65 * Math.cos(rad(midDeg)),
    y: cy + r * 0.65 * Math.sin(rad(midDeg)),
  };
}

// Map a spin response → which wedge actually won.
//
// The server now says exactly which segment it landed on (segIdx), coin slot
// included — it is the only source of truth for that, since a coin prize (1)
// cannot be told apart from a diamond prize by value alone. segIdx is trusted
// when present; the old value-matching search is the fallback for a stray
// deploy moment where the frontend has updated ahead of the backend.
function prizeToSegIdx(res, tierPrizes) {
  if (Number.isInteger(res?.segIdx) && res.segIdx >= 0 && res.segIdx < tierPrizes.length) {
    return res.segIdx;
  }
  const prize = res?.prize ?? res; // fallback path may be called with the bare number
  const candidates = tierPrizes
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i !== 2)
    .filter(({ p }) => p === prize);

  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)].i;
  }
  // Last resort: closest non-coin segment. Never guess the coin slot — it
  // must only ever be reached by an explicit segIdx from the server.
  const nonCoin = tierPrizes
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i !== 2);
  return nonCoin.reduce((best, cur) =>
    Math.abs(cur.p - prize) < Math.abs(best.p - prize) ? cur : best
  ).i;
}

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Single rank wheel card ─────────────────────────────────────────────────
// Each card owns its own spin state independently
function TierWheelCard({ tier, isUnlocked, isActive, statusInfo, onSpinComplete, lockText, onPrizeWon }) {
  const [spinning,       setSpinning]       = useState(false);
  const [won,            setWon]            = useState(null);
  const [err,            setErr]            = useState('');
  const [remaining,      setRemaining]      = useState(0);
  const [rotation,       setRotation]       = useState(0);
  const [localNextSpinAt, setLocalNextSpinAt] = useState(null); // set immediately after spin, before parent refreshes
  const rotRef = useRef(0);

  const labels = buildLabels(tier.prizes);
  const gradId = `rw_${tier.id}`;

  // Use localNextSpinAt (set immediately after spin) or server value — whichever is set
  const effectiveNextSpinAt = localNextSpinAt || statusInfo?.nextSpinAt;
  // While statusInfo is undefined (still loading), default to can spin so button always shows.
  // Goes false immediately after a local spin (localNextSpinAt set) or when server says cooldown active.
  const statusLoaded = statusInfo !== undefined;
  const canSpin = !spinning && !localNextSpinAt && (!statusLoaded || (statusInfo?.canSpin ?? false));

  // Clear local override once server confirms it can spin again
  useEffect(() => {
    if (statusInfo?.canSpin) setLocalNextSpinAt(null);
  }, [statusInfo?.canSpin]);

  // Countdown ticker — uses effectiveNextSpinAt so it starts immediately after spin
  useEffect(() => {
    if (!effectiveNextSpinAt) { setRemaining(0); return; }
    const tick = () => {
      const r = new Date(effectiveNextSpinAt).getTime() - Date.now();
      setRemaining(r > 0 ? r : 0);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [effectiveNextSpinAt]);

  // Idle slow rotation
  useEffect(() => {
    if (!isUnlocked) return;
    let frame;
    let last = performance.now();
    const tick = (now) => {
      if (!spinning) {
        const delta = now - last;
        rotRef.current += delta * (360 / 12000);
        setRotation(r => r + delta * (360 / 12000));
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spinning, isUnlocked]);

  async function handleSpin() {
    if (spinning || localNextSpinAt) return;
    setSpinning(true);
    setWon(null);
    setErr('');
    try {
      const res = await api.post('/rewards/spin', { tier: tier.id });
      const { prize, currency = 'diamonds', nextSpinAt } = res;
      if (onPrizeWon) onPrizeWon(prize, currency);

      const idx = prizeToSegIdx(res, tier.prizes);
      const center = idx * STEP + STEP / 2;
      const curMod = ((rotRef.current % 360) + 360) % 360;
      const jitter = (Math.random() - 0.5) * (STEP * 0.4);
      const target = ((360 - center + jitter) % 360 + 360) % 360;
      const delta = (target - curMod + 360) % 360;
      const spinDegrees = 6 * 360 + delta;
      const newRot = rotRef.current + spinDegrees;
      rotRef.current = newRot;
      setRotation(newRot);
      playWheelSpin({ duration: 4, totalDegrees: spinDegrees, segments: tier.prizes.length });

      // Set local cooldown immediately — countdown starts before parent fetchStatus returns
      setLocalNextSpinAt(nextSpinAt);

      setTimeout(() => {
        setWon({ amount: prize, currency });
        setSpinning(false);
        playWin();
        if (onSpinComplete) onSpinComplete();
      }, 4300);
    } catch (e) {
      setErr(e.message || 'Spin failed. Try again.');
      setSpinning(false);
    }
  }

  return (
    <div
      className="flex flex-col items-center rounded-2xl border overflow-hidden"
      style={{
        background:   isUnlocked ? `${tier.color}08` : 'rgba(255,255,255,0.02)',
        borderColor:  isActive ? `${tier.color}60` : isUnlocked ? `${tier.color}25` : '#1e293b',
        boxShadow:    isActive ? `0 0 24px ${tier.glow}` : 'none',
        minWidth:     0,
        position:     'relative',
        pointerEvents: isUnlocked ? 'auto' : 'none',
      }}
    >
      {/* Card header */}
      <div
        className="w-full px-4 py-3 flex items-center gap-2"
        style={{
          background:   isUnlocked ? `${tier.color}12` : 'rgba(255,255,255,0.03)',
          borderBottom: `1px solid ${isUnlocked ? tier.color + '25' : '#1e293b'}`,
        }}
      >
        {/* The rank badge, same drawing the navbar and profile use. tier.label
            matches the rank name in utils/ranks.js, which is what RankIcon
            keys on — so a wheel and its rank can never show different art. */}
        <span
          className="leading-none"
          style={{ filter: isUnlocked ? `drop-shadow(0 0 6px ${tier.color})` : 'grayscale(1) opacity(0.4)' }}
        >
          <RankIcon rank={{ name: tier.label, color: tier.color }} size={26} />
        </span>
        <div>
          <div
            className="font-black text-sm tracking-widest uppercase leading-tight"
            style={{ color: isUnlocked ? tier.color : '#475569' }}
          >
            {tier.label}
          </div>
          <div className="text-xs" style={{ color: '#475569' }}>
            {tier.minElo > 0 ? `${tier.minElo}+ ELO` : 'Starter'}
          </div>
        </div>
      </div>

      {/* Wheel area */}
      <div className="relative flex items-center justify-center select-none px-2 sm:px-4 py-3 sm:py-4">
        {/* Pointer */}
        <div
          className="absolute z-20"
          style={{
            top:         6,
            left:        '50%',
            transform:   'translateX(-50%)',
            width:       0,
            height:      0,
            borderLeft:  '10px solid transparent',
            borderRight: '10px solid transparent',
            borderTop:   '20px solid #f8fafc',
            filter:      'drop-shadow(0 2px 8px rgba(0,0,0,1))',
          }}
        />

        {/* Wheel box — see SpinWheel: the ring's percentage width resolves
            against its containing block's padding box, and the row outside
            carries px-2/sm:px-4, so the ring was measured from a wider box than
            the SVG it was meant to trace. This wrapper is the wheel's own box. */}
        <div className="relative w-full" style={{ maxWidth: SIZE }}>
          {/* Spin glow ring */}
          {spinning && (
            <div
              className="absolute rounded-full animate-pulse pointer-events-none"
              style={{
                // Same geometry as SpinWheel: the rim's outer stroke ends at 137
                // of the 150 half-viewBox, so the ring sits on it at 91.33%.
                width:      '91.33%',
                aspectRatio: '1 / 1',
                top:        '50%',
                left:       '50%',
                transform:  'translate(-50%, -50%)',
                background: 'transparent',
                border:    `2px solid ${tier.color}55`,
                boxShadow: `0 0 30px ${tier.glow}`,
              }}
            />
          )}

        {/* The SVG wheel */}
        <div
          className="w-full"
          style={{
            transform:  `rotate(${rotation}deg)`,
            transition: spinning ? 'transform 4s cubic-bezier(0.17,0.67,0.12,0.99)' : 'none',
            willChange: 'transform',
            opacity:    isUnlocked ? 1 : 0.55,
            maxWidth:   SIZE,
          }}
        >
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full h-auto block" style={{ maxWidth: SIZE }}>
            <defs>
              {SEG_THEMES.map((t, i) =>
                t.isGold ? (
                  <linearGradient key={i} id={`${gradId}_s${i}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%"   stopColor="#ffd700" />
                    <stop offset="40%"  stopColor="#f59e0b" />
                    <stop offset="80%"  stopColor="#ffd700" />
                    <stop offset="100%" stopColor="#b45309" />
                  </linearGradient>
                ) : (
                  <linearGradient key={i} id={`${gradId}_s${i}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%"   stopColor={t.bg} />
                    <stop offset="100%" stopColor={t.fade} />
                  </linearGradient>
                )
              )}
              <radialGradient id={`${gradId}_hub`} cx="40%" cy="35%" r="60%">
                <stop offset="0%"   stopColor="#1e293b" />
                <stop offset="100%" stopColor="#020617" />
              </radialGradient>
            </defs>

            {/* Outer bezel rings */}
            <circle cx={CX} cy={CY} r={R + 3} fill="none" stroke="#1e293b" strokeWidth="6" />
            <circle cx={CX} cy={CY} r={R + 6} fill="none" stroke="#0f172a" strokeWidth="2" />

            {/* Segments */}
            {labels.map((label, i) => {
              const t    = SEG_THEMES[i];
              const sDeg = i * STEP;
              const eDeg = sDeg + STEP;
              const mid  = sDeg + STEP / 2;
              const lp   = labelXY(CX, CY, R, mid);
              const isCoin = label === 'coin';
              return (
                <g key={i}>
                  <path
                    d={wedge(CX, CY, R, sDeg, eDeg)}
                    fill={`url(#${gradId}_s${i})`}
                    stroke="#0f172a"
                    strokeWidth="2"
                  />
                  <path
                    d={edgeArc(CX, CY, R - 1, sDeg, eDeg)}
                    fill="none"
                    stroke={t.border}
                    strokeWidth="3"
                    opacity="0.7"
                  />
                  {isCoin ? (
                    <g transform={`rotate(${mid}, ${lp.x}, ${lp.y})`}>
                      <defs>
                        <radialGradient id={`coin_${i}`} cx="35%" cy="30%" r="65%">
                          <stop offset="0%" stopColor="#FFE566" />
                          <stop offset="45%" stopColor="#F5C518" />
                          <stop offset="75%" stopColor="#D4920E" />
                          <stop offset="100%" stopColor="#C07800" />
                        </radialGradient>
                      </defs>
                      <circle cx={lp.x} cy={lp.y} r="9" fill={`url(#coin_${i})`} stroke="rgba(160,100,0,0.5)" strokeWidth="1" />
                    </g>
                  ) : (
                    <>
                      <text
                        x={lp.x} y={lp.y - 6}
                        textAnchor="middle" dominantBaseline="middle"
                        fill={t.text}
                        fontSize="12"
                        fontWeight="900"
                        fontFamily="system-ui, sans-serif"
                        transform={`rotate(${mid}, ${lp.x}, ${lp.y})`}
                      >
                        {label}
                      </text>
                      <g transform={`rotate(${mid}, ${lp.x}, ${lp.y})`}>
                        <DiamondGlyph cx={lp.x} cy={lp.y + 9} size={11} />
                      </g>
                    </>
                  )}
                </g>
              );
            })}

            {/* Bezel divider dots */}
            {Array.from({ length: N }).map((_, i) => {
              const rad = d => ((d - 90) * Math.PI) / 180;
              const deg = i * STEP;
              return (
                <circle
                  key={i}
                  cx={CX + (R + 3) * Math.cos(rad(deg))}
                  cy={CY + (R + 3) * Math.sin(rad(deg))}
                  r="3"
                  fill="#334155"
                  stroke="#0f172a"
                  strokeWidth="1"
                />
              );
            })}

            {/* Center hub */}
            <circle cx={CX} cy={CY} r={30} fill="#0f172a"             stroke="#1e293b"  strokeWidth="2.5" />
            <circle cx={CX} cy={CY} r={24} fill={`url(#${gradId}_hub)`} stroke="#334155" strokeWidth="1.5" />
            <circle cx={CX} cy={CY} r={18} fill="none"                stroke="#1e293b"  strokeWidth="1"   />
            <DiamondGlyph cx={CX} cy={CY + 1} size={17} />
          </svg>
        </div>
        </div>

      </div>

      {/* Full-card lock overlay — covers header, wheel, and button */}
      {!isUnlocked && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl z-10"
          style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(1px)' }}
        >
          <span className="text-4xl mb-2">🔒</span>
          <div className="text-sm font-bold text-white/80">{lockText}</div>
          <div className="text-xs text-white/40 mt-1">Advance your rank to unlock</div>
        </div>
      )}

      {/* Prize reveal */}
      {won !== null && (
        <div
          className="mx-4 mb-2 w-[calc(100%-2rem)] rounded-xl py-2 px-3 text-center"
          style={{
            background:  `${tier.color}15`,
            border:      `1px solid ${tier.color}50`,
            boxShadow:   `0 0 20px ${tier.glow}`,
            animation:   'fadeIn 0.4s ease',
          }}
        >
          {/* One inline-flex line, not text with a trailing icon.
              These cards are grid-cols-2 on a phone, which leaves about 120px
              of usable width inside this box. At a fixed 24px, "+100,000 💎"
              measured 108px of text in a 96px line and wrapped — the number on
              one line, the diamond alone underneath. nowrap keeps them
              together and the size shrinks with the viewport instead.
              Measured at 320px: 97px of text in 120px available. */}
          <div
            className="font-black inline-flex items-center justify-center gap-1.5 whitespace-nowrap max-w-full"
            style={{
              color: tier.color,
              textShadow: `0 0 16px ${tier.color}`,
              fontSize: 'clamp(1rem, 4.5vw, 1.5rem)',
              lineHeight: 1.25,
            }}
          >
            <span>+{won.amount.toLocaleString()}</span>
            <span className="inline-flex items-center leading-none">
              {won.currency === 'coins' ? <CoinIcon size="0.85em" /> : <DiamondIcon size="0.85em" />}
            </span>
          </div>
          <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>Added to your balance!</div>
        </div>
      )}

      {/* Error */}
      {err && (
        <p className="mx-4 mb-2 text-xs text-center" style={{ color: '#ef4444' }}>{err}</p>
      )}

      {/* Button / countdown */}
      <div className="w-full px-4 pb-4">
        {isUnlocked ? (
          canSpin ? (
            <button
              onClick={handleSpin}
              disabled={spinning}
              className="w-full py-2.5 rounded-xl font-black text-xs tracking-widest uppercase transition-all"
              style={spinning ? {
                background: '#0f172a', color: '#334155', cursor: 'not-allowed', border: '1px solid #1e293b',
              } : {
                background: `linear-gradient(135deg, ${tier.color}cc 0%, ${tier.color}66 100%)`,
                color: '#fff', boxShadow: `0 0 18px ${tier.glow}, 0 0 6px ${tier.color}44`,
                border: `1px solid ${tier.color}60`,
              }}
            >
              {spinning ? 'Spinning…' : 'Spin'}
            </button>
          ) : (
            <div
              className="w-full text-center py-2.5 rounded-xl"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #1e293b' }}
            >
              <div className="text-xs mb-0.5" style={{ color: '#475569' }}>Next spin in</div>
              <div className="font-mono font-black text-lg" style={{ color: '#e2e8f0' }}>
                {remaining > 0 ? fmtCountdown(remaining) : '…'}
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

// ── Main Rewards page ──────────────────────────────────────────────────────
export default function Rewards() {
  const { profile, session, refreshProfile, updateProfile } = useAuth();
  const elo        = profile?.elo ?? 1000;
  const activeTier = getTierId(elo);

  const [statusMap, setStatusMap] = useState({});

  const fetchStatus = useCallback(async () => {
    if (!session) return;
    try {
      const d = await api.get('/rewards/spin-status');
      setStatusMap(d.tiers || {});
    } catch {
      // fail silently
    }
  }, [session]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  // Re-fetch when ELO changes (e.g. after winning a game or admin adjustment)
  useEffect(() => { if (session) fetchStatus(); }, [elo]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-[calc(100vh-56px)] px-4 py-8">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">

        {/* Referral offer — first thing on the page, on every screen size. */}
        {session && <ReferralCard />}

        {/* Page title */}
        <div className="text-center">
          <h1 className="text-2xl font-black text-white tracking-widest uppercase">Daily Rewards</h1>
          <p className="text-sm mt-1" style={{ color: '#64748b' }}>
            Spin your rank wheels and the daily wheel once every 24 hours to win Diamonds
          </p>
        </div>

        {/* Guest login prompt */}
        {!session && (
          <div className="bg-primary/10 border border-primary/30 rounded-2xl p-6 text-center">
            <div className="text-3xl mb-2">🎡</div>
            <p className="text-white font-bold mb-1">Log in to spin the wheels</p>
            <p className="text-muted text-sm mb-4">Earn free diamonds every day — no purchase needed</p>
            <Link to="/login" className="inline-block px-8 py-3 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all">
              Login to Spin
            </Link>
          </div>
        )}

        {/* 6 wheel cards — 5 rank wheels + daily spin. Two per row on phones so a
            pair is visible at a time, three per row from large screens up. */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {TIERS.map(tier => {
            const placementDone = isRanked(profile);
            const placement = placementMatches(profile);
            const isUnlocked = session
              ? (tier.id === 'bronze' ? true : placementDone && tier.minElo <= elo)
              : false;
            const isActive = session && tier.id === activeTier;
            const lockText = !session
              ? 'Login to spin'
              : !placementDone && tier.id !== 'bronze'
                ? `${placement}/3 placement matches`
                : tier.lockText;
            return (
              <TierWheelCard
                key={tier.id}
                tier={tier}
                isUnlocked={isUnlocked}
                isActive={isActive}
                statusInfo={session ? statusMap[tier.id] : undefined}
                onSpinComplete={() => { fetchStatus(); refreshProfile(); }}
                onPrizeWon={(prize, currency) => updateProfile(
                  currency === 'coins'
                    ? { c_coins:  Math.max(0, (profile?.c_coins  ?? 0) + prize) }
                    : { diamonds: Math.max(0, (profile?.diamonds ?? 0) + prize) }
                )}
                lockText={lockText}
              />
            );
          })}
          {/* 6th wheel — daily spin */}
          {session ? <SpinWheel /> : (
            <div className="relative rounded-2xl overflow-hidden">
              <div className="pointer-events-none opacity-40 select-none">
                <SpinWheel locked />
              </div>
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 rounded-2xl gap-2">
                <span className="text-3xl">🔒</span>
                <p className="text-white font-bold text-sm">Login to spin</p>
              </div>
            </div>
          )}
        </div>

        {/* 1-min diamond bonus */}
        {session ? <DailyBonus /> : (
          <div className="bg-surface border border-surfaceLight rounded-2xl p-5 text-center">
            <div className="text-2xl mb-2"><DiamondIcon /></div>
            <div className="font-bold text-white mb-1">Diamond Bonus</div>
            <div className="text-sm text-muted mb-3">Claim 500 free diamonds every minute</div>
            <Link to="/login" className="inline-block px-6 py-2.5 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all text-sm">
              Login to Claim
            </Link>
          </div>
        )}

        {/* Rakeback quick-info section */}
        <div
          className="rounded-2xl border px-6 py-5"
          style={{ background: 'rgba(255,255,255,0.02)', borderColor: '#1e293b' }}
        >
          <h2 className="font-black text-white text-base tracking-wider uppercase mb-3 flex items-center gap-2">
            <UiIcon name="rakeback" size={18} />Rakeback
          </h2>
          <p className="text-sm" style={{ color: '#64748b' }}>
            Earn coins back on every game — no matter if you win or lose.<br />
            Portions credited instantly, daily, and weekly.<br />
            Claim anytime from the <UiIcon name="rakeback" size={14} className="align-middle" /> button in the top bar.
          </p>
        </div>

      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}



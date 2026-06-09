import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

// Segments: White=1K (59%), Blue=5K (35%), Black=20K (5%), Grey=50K (1%)
const SEG = [
  { label: '1K',   prize: 1000,  theme: 'white' },
  { label: '5K',   prize: 5000,  theme: 'blue'  },
  { label: '1K',   prize: 1000,  theme: 'white' },
  { label: '20K',  prize: 20000, theme: 'black' },
  { label: '1K',   prize: 1000,  theme: 'white' },
  { label: '5K',   prize: 5000,  theme: 'blue'  },
  { label: '1K',   prize: 1000,  theme: 'white' },
  { label: '50K',  prize: 50000, theme: 'grey'  },
];

const THEMES = {
  white: { bg: '#dde3ec', fade: '#8a96a8', text: '#0f172a', glow: '#94a3b8', border: '#94a3b8' },
  blue:  { bg: '#1d4ed8', fade: '#1e3a8a', text: '#ffffff', glow: '#3b82f6', border: '#60a5fa' },
  black: { bg: '#0a0a0a', fade: '#000000', text: '#e2e8f0', glow: '#374151', border: '#374151' },
  grey:  { bg: '#374151', fade: '#1f2937', text: '#d1d5db', glow: '#6b7280', border: '#6b7280' },
};

const N    = SEG.length;
const STEP = 360 / N;
const CX   = 150;
const CY   = 150;
const R    = 130;

function prizeToSeg(prize) {
  if (prize === 50000) return 7;
  if (prize === 20000) return 3;
  if (prize === 5000)  return Math.random() < 0.5 ? 1 : 5;
  return [0, 2, 4, 6][Math.floor(Math.random() * 4)];
}

function wedge(cx, cy, r, sDeg, eDeg) {
  const rad = d => ((d - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(sDeg));
  const y1 = cy + r * Math.sin(rad(sDeg));
  const x2 = cx + r * Math.cos(rad(eDeg));
  const y2 = cy + r * Math.sin(rad(eDeg));
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2} Z`;
}

function edgeArc(cx, cy, r, sDeg, eDeg) {
  const rad = d => ((d - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(sDeg + 1));
  const y1 = cy + r * Math.sin(rad(sDeg + 1));
  const x2 = cx + r * Math.cos(rad(eDeg - 1));
  const y2 = cy + r * Math.sin(rad(eDeg - 1));
  return `M${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2}`;
}

function labelXY(cx, cy, r, midDeg) {
  const rad = d => ((d - 90) * Math.PI) / 180;
  return {
    x: cx + r * 0.65 * Math.cos(rad(midDeg)),
    y: cy + r * 0.65 * Math.sin(rad(midDeg)),
  };
}

function fmtCountdown(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export default function SpinWheel() {
  const { refreshProfile } = useAuth();
  const [status,    setStatus]    = useState({ canSpin: false });
  const [spinning,  setSpinning]  = useState(false);
  const [rotation,  setRotation]  = useState(0);
  const rotRef = useRef(0);
  const [won,       setWon]       = useState(null);
  const [err,       setErr]       = useState('');
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    let frame;
    let last = performance.now();
    const tick = (now) => {
      if (!spinning) {
        const delta = now - last;
        rotRef.current += delta * (360 / 10000);
        setRotation(r => r + delta * (360 / 10000));
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spinning]);

  const fetchStatus = useCallback(async () => {
    try {
      const d = await api.get('/bonus/spin-status');
      setStatus(d);
      setRemaining(d.nextSpinAt ? new Date(d.nextSpinAt).getTime() - Date.now() : 0);
    } catch {
      setStatus({ canSpin: true });
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (!status?.nextSpinAt) return;
    const id = setInterval(() => {
      const r = new Date(status.nextSpinAt).getTime() - Date.now();
      if (r <= 0) { clearInterval(id); fetchStatus(); }
      else setRemaining(r);
    }, 1000);
    return () => clearInterval(id);
  }, [status, fetchStatus]);

  async function handleSpin() {
    if (spinning || !status?.canSpin) return;
    setSpinning(true);
    setWon(null);
    setErr('');
    try {
      const { prize } = await api.post('/bonus/spin', {});
      const idx    = prizeToSeg(prize);
      const center = idx * STEP + STEP / 2;
      const curMod = ((rotRef.current % 360) + 360) % 360;
      const target = (360 - center) % 360;
      const delta  = (target - curMod + 360) % 360;
      const newRot = rotRef.current + 5 * 360 + delta;
      rotRef.current = newRot;
      setRotation(newRot);
      setTimeout(() => {
        setWon(prize);
        setSpinning(false);
        refreshProfile();
        fetchStatus();
      }, 4300);
    } catch (e) {
      setErr(e.message);
      setSpinning(false);
    }
  }

  const SIZE = CX * 2;
  const canSpin = status.canSpin;
  const wonTheme = won != null ? (won >= 50000 ? 'grey' : won >= 20000 ? 'black' : won >= 5000 ? 'blue' : 'white') : null;

  return (
    <div className="bg-surface border border-surfaceLight rounded-2xl flex flex-col items-center gap-4 overflow-hidden">

      {/* Top banner */}
      <div className="w-full px-5 pt-5 text-center">
        <div className="font-black text-white text-lg tracking-widest uppercase">Daily Spin</div>
        <div className="text-xs mt-1" style={{ color: '#64748b' }}>Win up to <span className="font-bold text-white">50,000 💎</span></div>
      </div>

      {/* Wheel */}
      <div className="relative flex items-center justify-center select-none px-5">
        {/* Pointer */}
        <div className="absolute z-20" style={{
          top: -2, left: '50%', transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '11px solid transparent',
          borderRight: '11px solid transparent',
          borderTop: '22px solid #f8fafc',
          filter: 'drop-shadow(0 2px 8px rgba(0,0,0,1))',
        }} />

        {/* Spin ring glow */}
        {spinning && (
          <div className="absolute rounded-full animate-pulse" style={{
            width: SIZE + 20, height: SIZE + 20,
            background: 'transparent',
            border: '2px solid rgba(255,255,255,0.12)',
            boxShadow: '0 0 30px rgba(255,255,255,0.08)',
          }} />
        )}

        <div style={{
          transform: `rotate(${rotation}deg)`,
          transition: spinning ? 'transform 4s cubic-bezier(0.17,0.67,0.12,0.99)' : 'none',
          willChange: 'transform',
        }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
            <defs>
              {SEG.map((seg, i) => {
                const t = THEMES[seg.theme];
                return (
                  <linearGradient key={i} id={`seg${i}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor={t.bg} />
                    <stop offset="100%" stopColor={t.fade} />
                  </linearGradient>
                );
              })}
              <radialGradient id="hubGrad" cx="40%" cy="35%" r="60%">
                <stop offset="0%" stopColor="#1e293b" />
                <stop offset="100%" stopColor="#020617" />
              </radialGradient>
            </defs>

            {/* Outer border ring */}
            <circle cx={CX} cy={CY} r={R + 3} fill="none" stroke="#1e293b" strokeWidth="6" />
            <circle cx={CX} cy={CY} r={R + 6} fill="none" stroke="#0f172a" strokeWidth="2" />

            {/* Segments */}
            {SEG.map((seg, i) => {
              const t    = THEMES[seg.theme];
              const sDeg = i * STEP;
              const eDeg = sDeg + STEP;
              const mid  = sDeg + STEP / 2;
              const lp   = labelXY(CX, CY, R, mid);
              return (
                <g key={i}>
                  {/* Filled wedge */}
                  <path
                    d={wedge(CX, CY, R, sDeg, eDeg)}
                    fill={`url(#seg${i})`}
                    stroke="#0f172a"
                    strokeWidth="2"
                  />
                  {/* Colored outer arc accent */}
                  <path
                    d={edgeArc(CX, CY, R - 1, sDeg, eDeg)}
                    fill="none"
                    stroke={t.border}
                    strokeWidth="3"
                    opacity="0.7"
                  />
                  {/* Amount label */}
                  <text
                    x={lp.x} y={lp.y - 6}
                    textAnchor="middle" dominantBaseline="middle"
                    fill={t.text}
                    fontSize={seg.theme === 'black' ? '13' : '12'}
                    fontWeight="900"
                    fontFamily="system-ui, sans-serif"
                    transform={`rotate(${mid}, ${lp.x}, ${lp.y})`}
                  >
                    {seg.label}
                  </text>
                  <text
                    x={lp.x} y={lp.y + 9}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize="10"
                    transform={`rotate(${mid}, ${lp.x}, ${lp.y})`}
                  >
                    💎
                  </text>
                </g>
              );
            })}

            {/* Divider dots on bezel */}
            {SEG.map((_, i) => {
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
            <circle cx={CX} cy={CY} r={30} fill="#0f172a" stroke="#1e293b" strokeWidth="2.5" />
            <circle cx={CX} cy={CY} r={24} fill="url(#hubGrad)" stroke="#334155" strokeWidth="1.5" />
            <circle cx={CX} cy={CY} r={18} fill="none" stroke="#1e293b" strokeWidth="1" />
            <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle" fontSize="16">💎</text>
          </svg>
        </div>
      </div>

      {/* Prize legend strip */}
      <div className="w-full px-5 pb-5 flex flex-col gap-3">
        {/* Win result */}
        {won !== null && wonTheme && (
          <div className="rounded-xl py-3 px-4 text-center"
            style={{ background: `${THEMES[wonTheme].fade}22`, border: `1px solid ${THEMES[wonTheme].border}`, boxShadow: `0 0 20px ${THEMES[wonTheme].glow}33` }}>
            <div className="font-black text-2xl" style={{ color: THEMES[wonTheme].glow }}>
              +{won.toLocaleString()} 💎
            </div>
            <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>
              {won === 50000 ? '🏆 JACKPOT! Maximum prize!' : won === 20000 ? 'Massive win!' : 'Added to your balance!'}
            </div>
          </div>
        )}

        {err && <p className="text-sm text-center" style={{ color: '#ef4444' }}>{err}</p>}

        {/* Button */}
        {canSpin ? (
          <button
            onClick={handleSpin}
            disabled={spinning}
            className="w-full py-3 rounded-xl font-black text-sm tracking-widest uppercase transition-all"
            style={spinning ? {
              background: '#0f172a', color: '#334155', cursor: 'not-allowed', border: '1px solid #1e293b',
            } : {
              background: 'linear-gradient(135deg, #1d4ed8 0%, #0a0a0a 100%)',
              color: '#fff',
              boxShadow: '0 0 20px rgba(29,78,216,0.35)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {spinning ? 'Spinning...' : 'Spin'}
          </button>
        ) : (
          <div className="text-center w-full py-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #1e293b' }}>
            <div className="text-xs mb-1" style={{ color: '#475569' }}>Next spin in</div>
            <div className="font-mono font-black text-xl" style={{ color: '#e2e8f0' }}>
              {remaining > 0 ? fmtCountdown(remaining) : '...'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';

export default function RejoinPopup({ secondsLeft: initial, onRejoin, onDismiss }) {
  const [secs, setSecs] = useState(Math.max(1, initial));

  useEffect(() => {
    const id = setInterval(() => {
      setSecs(s => {
        if (s <= 1) { clearInterval(id); onDismiss?.(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const R = 34;
  const circ = 2 * Math.PI * R;
  const pct = secs / 30;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-primary/40 rounded-2xl p-8 max-w-sm w-full text-center shadow-glow animate-scale-in relative">
        <button
          onClick={onDismiss}
          className="absolute top-3 right-4 text-muted hover:text-white text-2xl font-light transition-colors leading-none"
          aria-label="Close"
        >×</button>

        <div className="text-4xl mb-3">🎮</div>
        <h2 className="text-xl font-black text-white mb-1">Active Game Found</h2>
        <p className="text-muted text-sm mb-5">You have an ongoing match. Rejoin before time runs out!</p>

        <div className="relative w-20 h-20 mx-auto mb-6">
          <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
            <circle cx="40" cy="40" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
            <circle
              cx="40" cy="40" r={R} fill="none"
              stroke={secs <= 10 ? '#ef4444' : '#1250B4'}
              strokeWidth="6"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - pct)}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 0.85s linear, stroke 0.3s' }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`text-2xl font-black ${secs <= 10 ? 'text-danger' : 'text-white'}`}>{secs}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onDismiss}
            className="flex-1 px-4 py-3 rounded-xl border border-border text-muted hover:text-white hover:border-white/30 transition-all text-sm font-bold"
          >
            Leave Match
          </button>
          <button
            onClick={onRejoin}
            className="flex-1 px-4 py-3 rounded-xl bg-primary hover:bg-primary/80 text-white font-black text-sm transition-all"
            style={{ boxShadow: '0 0 20px rgba(18,80,180,0.35)' }}
          >
            Rejoin Game
          </button>
        </div>
      </div>
    </div>
  );
}

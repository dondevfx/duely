import { useState, useEffect } from 'react';

// Countries where online gambling has significant legal restrictions.
// This is a soft warning only — the user can dismiss it and continue playing.
const RESTRICTED = {
  US: 'United States',
  CN: 'China',
  AE: 'United Arab Emirates',
  SG: 'Singapore',
  QA: 'Qatar',
  KW: 'Kuwait',
  IR: 'Iran',
  KP: 'North Korea',
  SA: 'Saudi Arabia',
  PK: 'Pakistan',
  AF: 'Afghanistan',
};

const DISMISSED_KEY = 'geo_warning_v1';

export default function GeoWarningModal() {
  const [countryName, setCountryName] = useState(null);

  useEffect(() => {
    // Show every new tab session — clears on tab close, persists through refreshes
    if (sessionStorage.getItem(DISMISSED_KEY)) return;

    fetch('https://ipapi.co/json/', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const name = RESTRICTED[d?.country_code];
        if (name) setCountryName(name);
      })
      .catch(() => {}); // never block on geo failure
  }, []);

  function dismiss() {
    sessionStorage.setItem(DISMISSED_KEY, '1');
    setCountryName(null);
  }

  if (!countryName) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border p-8 shadow-2xl text-center"
        style={{ background: '#0d1117', borderColor: '#1e293b' }}
      >
        {/* Close ✕ in corner */}
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-white hover:bg-surfaceLight transition-colors text-lg"
          aria-label="Close"
        >
          ✕
        </button>

        <div className="text-5xl mb-5">🚫</div>

        <h2 className="text-2xl font-black text-white mb-3">
          Not Available in Your Region
        </h2>

        <p className="text-sm leading-relaxed" style={{ color: '#94a3b8' }}>
          Duely is not available to players in{' '}
          <span className="font-bold text-white">{countryName}</span>.
        </p>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export default function PWAInstallPrompt() {
  const [prompt, setPrompt]   = useState(null);
  const [visible, setVisible] = useState(false);
  const [iosPrompt, setIosPrompt] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem('pwa_dismissed')) return;
    if (isInStandaloneMode()) return;

    if (isIos()) {
      // Show iOS-specific instructions after a short delay
      const t = setTimeout(() => setIosPrompt(true), 3000);
      return () => clearTimeout(t);
    }

    const handler = e => {
      e.preventDefault();
      setPrompt(e);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  async function install() {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') sessionStorage.setItem('pwa_dismissed', '1');
    setVisible(false);
  }

  function dismiss() {
    sessionStorage.setItem('pwa_dismissed', '1');
    setVisible(false);
    setIosPrompt(false);
  }

  if (!visible && !iosPrompt) return null;

  if (iosPrompt) {
    return (
      <div
        className="fixed bottom-6 left-1/2 z-[9998] px-5 py-4 rounded-2xl shadow-2xl border max-w-xs w-full"
        style={{
          transform: 'translateX(-50%)',
          background: '#0d1117',
          borderColor: '#1e293b',
          boxShadow: '0 0 30px rgba(18,80,180,0.2)',
          animation: 'slideUp 0.35s ease',
        }}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="text-2xl shrink-0">📲</div>
          <div>
            <div className="text-sm font-bold text-white leading-tight">Add Duely to Home Screen</div>
            <div className="text-xs text-muted mt-0.5">Play like a native app</div>
          </div>
          <button onClick={dismiss} className="shrink-0 text-muted hover:text-white text-lg leading-none ml-auto transition-colors">✕</button>
        </div>
        <div className="text-xs text-muted space-y-1.5">
          <div className="flex items-center gap-2"><span className="text-primary font-bold">1.</span> Tap the <span className="text-white font-semibold">Share</span> button <span>⬆️</span> at the bottom of Safari</div>
          <div className="flex items-center gap-2"><span className="text-primary font-bold">2.</span> Scroll down and tap <span className="text-white font-semibold">Add to Home Screen</span></div>
          <div className="flex items-center gap-2"><span className="text-primary font-bold">3.</span> Tap <span className="text-white font-semibold">Add</span> to confirm</div>
        </div>
        <style>{`@keyframes slideUp { from { transform: translateX(-50%) translateY(80px); opacity:0; } to { transform: translateX(-50%) translateY(0); opacity:1; } }`}</style>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-6 left-1/2 z-[9998] flex items-center gap-4 px-5 py-3 rounded-2xl shadow-2xl border"
      style={{
        transform: 'translateX(-50%)',
        background: '#0d1117',
        borderColor: '#1e293b',
        boxShadow: '0 0 30px rgba(18,80,180,0.2)',
        animation: 'slideUp 0.35s ease',
      }}
    >
      <div className="text-2xl">📲</div>
      <div className="min-w-0">
        <div className="text-sm font-bold text-white leading-tight">Add Duely to Home Screen</div>
        <div className="text-xs text-muted">Play like a native app</div>
      </div>
      <button
        onClick={install}
        className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold text-white transition-all"
        style={{ background: 'linear-gradient(135deg,#1d4ed8,#1e3a8a)', boxShadow: '0 0 12px rgba(29,78,216,0.4)' }}
      >
        Install
      </button>
      <button
        onClick={dismiss}
        className="shrink-0 text-muted hover:text-white text-lg leading-none transition-colors"
        aria-label="Dismiss"
      >
        ✕
      </button>
      <style>{`@keyframes slideUp { from { transform: translateX(-50%) translateY(80px); opacity:0; } to { transform: translateX(-50%) translateY(0); opacity:1; } }`}</style>
    </div>
  );
}

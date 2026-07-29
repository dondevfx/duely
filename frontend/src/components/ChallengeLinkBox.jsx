import { useState } from 'react';

// Shows the shareable challenge link (primary) with the raw room code as a
// fallback. Used on every game's "waiting for opponent" screen.
export default function ChallengeLinkBox({ code, gameType }) {
  const [copied, setCopied] = useState(false);
  if (!code) return null;

  const link = `${window.location.origin}/challenge/${gameType}/${code}`;

  function copy() {
    navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mb-6">
      <p className="text-muted mb-3 text-sm">Send this link to a friend — they tap it and join you.</p>

      <button
        onClick={copy}
        className="w-full bg-primary hover:bg-blue-500 text-white font-black py-4 rounded-xl transition-all mb-3 text-base"
      >
        {copied ? '✓ Link Copied!' : '📋 Copy Challenge Link'}
      </button>

      <button onClick={copy} className="w-full text-left mb-4">
        <code className="block text-[11px] font-mono text-muted break-all bg-surface border border-border rounded-lg px-3 py-2 hover:border-primary transition-colors">
          {link}
        </code>
      </button>

      <div className="text-xs text-muted">
        or share the code:{' '}
        <span className="font-mono font-black tracking-[0.2em] text-primary text-sm">{code}</span>
      </div>
    </div>
  );
}

import { useState } from 'react';

// Shown when no card on-ramp is configured — i.e. right now, while provider
// approval is pending.
//
// Card money can still reach a Duely balance today: the player buys USDC in a
// mainstream consumer app with their card, then withdraws it to the deposit
// address we already generate for them. No merchant relationship, no approval,
// nothing to integrate — the user buys in their own name and the existing chain
// monitor credits the arrival like any other deposit.
//
// It is more steps than a Buy button, so the job of this panel is to remove
// every avoidable one: the address is right here, pre-copied, and the apps are
// one tap away. When a provider is approved this is replaced by the real
// button, not kept alongside it.
const APPS = [
  { name: 'Coinbase', url: 'https://www.coinbase.com/price/usdc', note: 'Card & bank' },
  { name: 'Cash App', url: 'https://cash.app/',                   note: 'Card & balance' },
  { name: 'Kraken',   url: 'https://www.kraken.com/prices/usdc',  note: 'Card & bank' },
];

export default function BuyCryptoGuide({ address, onGetAddress, loading }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!address) return;
    navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mb-4 pb-4 border-b border-surfaceLight">
      <h3 className="text-sm font-bold text-white mb-1">💳 Don't have crypto?</h3>
      <p className="text-xs text-muted mb-3">
        Buy USDC with your card in any of these apps, then send it to your deposit address below.
        It lands in your balance automatically.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {APPS.map(app => (
          <a
            key={app.name}
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-bg border border-border rounded-xl px-2 py-2.5 text-center hover:border-primary transition-all"
          >
            <div className="text-xs font-bold text-white leading-tight">{app.name}</div>
            <div className="text-[10px] text-muted mt-0.5">{app.note}</div>
          </a>
        ))}
      </div>

      {/* The address is the step people get wrong, so it is right here rather
          than behind the coin picker below. Solana network, USDC — both stated,
          because sending on the wrong network is the usual way funds are lost. */}
      {address ? (
        <>
          <p className="text-[11px] text-muted mb-1.5">
            Send <span className="text-white font-bold">USDC</span> on the{' '}
            <span className="text-white font-bold">Solana</span> network to:
          </p>
          <button onClick={copy} className="w-full text-left">
            <code className="block text-[10px] leading-tight font-mono text-muted break-all bg-bg border border-border rounded-lg px-2 py-2 hover:border-primary transition-colors">
              {address}
            </code>
          </button>
          <button
            onClick={copy}
            className="w-full mt-2 py-2 rounded-xl bg-primary/15 border border-primary/40 text-primary text-xs font-black hover:bg-primary/25 transition-all"
          >
            {copied ? '✓ Address Copied' : 'Copy Address'}
          </button>
        </>
      ) : (
        <button
          onClick={onGetAddress}
          disabled={loading}
          className="w-full py-2 rounded-xl bg-primary/15 border border-primary/40 text-primary text-xs font-black hover:bg-primary/25 transition-all disabled:opacity-40"
        >
          {loading ? 'Generating…' : 'Show my USDC address'}
        </button>
      )}
    </div>
  );
}

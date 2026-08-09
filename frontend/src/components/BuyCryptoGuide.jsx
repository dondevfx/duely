import { useState } from 'react';

// Shown when no card on-ramp is configured — i.e. while provider approval is
// pending. Card money can still reach a balance: buy USDC with a card in a
// consumer app, send it to the deposit address we already generate, and the
// existing chain monitor credits it like any other deposit.
//
// TWO ROUTES, because only one of them can be deep-linked:
//
//   Wallet apps  — `solana:` is the Solana Pay URI standard. Tapping it opens
//                  Phantom / Solflare / Trust / Coinbase Wallet / Exodus
//                  directly on a send screen with recipient, token and amount
//                  already filled in. The QR encodes the same URI, so scanning
//                  from any wallet lands in the same place.
//
//   Exchanges    — Coinbase, Cash App and Kraken do NOT publish a scheme that
//                  opens their send screen pointed at an external address, and
//                  they are right not to: that is exactly the flow a phishing
//                  attack wants. So these stay plain links to a buy page, and
//                  the copy says so rather than implying a one-tap send.

// Circle's USDC mint on Solana. MUST match USDC_MINT in blockchainMonitor —
// paying to a different mint produces a token the monitor does not watch, so
// the deposit would silently never credit.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const APPS = [
  { name: 'Coinbase', url: 'https://www.coinbase.com/price/usdc' },
  { name: 'Cash App', url: 'https://cash.app/' },
  { name: 'Kraken',   url: 'https://www.kraken.com/prices/usdc' },
];

function solanaPayUri(address, amount) {
  const p = new URLSearchParams({ 'spl-token': USDC_MINT, label: 'Duely' });
  if (amount > 0) p.set('amount', String(amount));
  return `solana:${address}?${p.toString()}`;
}

export default function BuyCryptoGuide({ address, onGetAddress, loading }) {
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState('');
  const [showQr, setShowQr] = useState(false);

  const amt = parseFloat(amount) > 0 ? parseFloat(amount) : 0;
  const payUri = address ? solanaPayUri(address, amt) : null;

  function copy() {
    if (!address) return;
    navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!address) {
    return (
      <div className="mb-4 pb-4 border-b border-surfaceLight">
        <h3 className="text-sm font-bold text-white mb-1">💳 Don't have crypto?</h3>
        <p className="text-xs text-muted mb-3">
          Buy USDC with your card, then send it here — it lands in your balance automatically.
        </p>
        <button
          onClick={onGetAddress}
          disabled={loading}
          className="w-full py-2.5 rounded-xl bg-primary text-white text-xs font-black hover:bg-blue-500 transition-all disabled:opacity-40"
        >
          {loading ? 'Generating…' : 'Get started'}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 pb-4 border-b border-surfaceLight">
      <h3 className="text-sm font-bold text-white mb-3">💳 Fund with a card</h3>

      {/* Step 1 — buy. Plain links; no deep link into a send screen exists. */}
      <p className="text-[11px] text-muted mb-1.5">
        <span className="text-white font-bold">1.</span> Buy USDC with your card
      </p>
      <div className="grid grid-cols-3 gap-2 mb-4">
        {APPS.map(app => (
          <a
            key={app.name}
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-bg border border-border rounded-xl px-2 py-2 text-center hover:border-primary transition-all"
          >
            <div className="text-xs font-bold text-white leading-tight">{app.name}</div>
          </a>
        ))}
      </div>

      {/* Step 2 — send. This half CAN be one tap, via Solana Pay. */}
      <p className="text-[11px] text-muted mb-1.5">
        <span className="text-white font-bold">2.</span> Send it to your account
      </p>

      <input
        type="number"
        inputMode="decimal"
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="Amount in USDC (optional)"
        className="w-full bg-bg border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-muted focus:outline-none focus:border-primary mb-2"
      />

      {/* Opens an installed Solana wallet on its send screen, prefilled. Does
          nothing in a desktop browser with no wallet registered for the scheme,
          which is why the QR and the raw address are both still offered. */}
      <a
        href={payUri}
        className="block w-full py-2.5 rounded-xl bg-primary text-white text-xs font-black text-center hover:bg-blue-500 transition-all"
      >
        📲 Open in wallet app
      </a>

      <div className="flex gap-2 mt-2">
        <button
          onClick={() => setShowQr(v => !v)}
          className="flex-1 py-2 rounded-xl bg-bg border border-border text-muted text-xs font-bold hover:border-primary hover:text-white transition-all"
        >
          {showQr ? 'Hide QR' : 'Scan QR'}
        </button>
        <button
          onClick={copy}
          className="flex-1 py-2 rounded-xl bg-bg border border-border text-muted text-xs font-bold hover:border-primary hover:text-white transition-all"
        >
          {copied ? '✓ Copied' : 'Copy address'}
        </button>
      </div>

      {showQr && (
        <div className="mt-3 flex flex-col items-center">
          {/* Encodes the Solana Pay URI, not the bare address, so scanning from
              a wallet prefills the token and amount too. */}
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(payUri)}&margin=2`}
            alt="Solana Pay QR code"
            width={180}
            height={180}
            className="rounded-lg bg-white p-1"
          />
          <p className="text-[10px] text-muted mt-2 text-center">
            Scan from any Solana wallet
          </p>
        </div>
      )}

      <p className="text-[10px] text-muted mt-3 leading-snug">
        Sending from an exchange? Copy the address above and withdraw{' '}
        <span className="text-white font-bold">USDC</span> on the{' '}
        <span className="text-white font-bold">Solana</span> network.
      </p>
      <code className="block text-[10px] leading-tight font-mono text-muted/70 break-all bg-bg border border-border rounded-lg px-2 py-1.5 mt-1.5">
        {address}
      </code>
    </div>
  );
}

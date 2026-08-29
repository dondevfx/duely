import { useState } from 'react';
import { Link } from 'react-router-dom';
import DiamondIcon from '../components/DiamondIcon';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';
import { fmtCoins, fmtDiamonds, fmtExact } from '../utils/format';


export default function Tip() {
  const ready = usePageReady();
  const { profile, session, refreshProfile } = useAuth();

  const [currency, setCurrency]   = useState('coins');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount]       = useState('');
  const [sending, setSending]     = useState(false);
  const [result, setResult]       = useState(null); // { type: 'success'|'error', text }

  const isDiamonds    = currency === 'diamonds';
  const currencyLabel = isDiamonds ? <DiamondIcon /> : <CoinIcon size="0.85em" />;
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const tipAmount     = isDiamonds ? Math.floor(parseFloat(amount)) : parseFloat(amount);

  // Demo accounts cannot deposit, so this form doubles as their balance setter:
  // the amount typed becomes the balance outright. Enforced on the server from
  // the DEMO_ACCOUNT_IDS allowlist — this only changes what the page says and
  // which fields it asks for.
  const demoSetter = !!profile?.is_demo;

  // Setting a balance is not spending one, so the affordability check does not
  // apply — raising the balance would otherwise be blocked for being more than
  // the current balance.
  //
  // `sending` is part of this for the same reason the withdraw form checks its
  // loading flag: the server deducts and pushes the new balance down the socket
  // before this request returns, so mid-send the typed amount is larger than
  // the balance and a false "Insufficient balance" flashes on a tip that is
  // going through. Once submitted, the server decides.
  const insufficient  = !demoSetter && !sending && tipAmount > 0 && myBalance < tipAmount;

  function handleCurrencySwitch(c) {
    setCurrency(c);
    setAmount('');
    setResult(null);
  }

  async function handleSend() {
    if (!demoSetter && !recipient.trim()) return;
    if (!Number.isFinite(tipAmount) || tipAmount < 0) return;
    setSending(true);
    setResult(null);
    try {
      const data = await api.post('/wallet/tip', {
        recipientUsername: recipient.trim(),
        amount: tipAmount,
        currency,
      });
      const label = isDiamonds
        ? <span className="inline-flex items-center gap-1">{Number(data.amount).toLocaleString()} <DiamondIcon /></span>
        : `${parseFloat(data.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} coins`;
      setResult({
        type: 'success',
        // Nodes again: `label` may carry the drawn diamond.
        text: data.demoBalanceSet
          ? <span className="inline-flex items-center gap-1">Balance set to {label}.</span>
          : <span className="inline-flex items-center gap-1">Sent {label} to {data.recipient}!</span>,
      });
      setRecipient('');
      setAmount('');
      await refreshProfile();
    } catch (err) {
      setResult({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  }

  const amountLabel = Number.isFinite(tipAmount)
    ? (isDiamonds ? <span className="inline-flex items-center gap-1">{tipAmount.toLocaleString()} <DiamondIcon /></span>
                  : tipAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' coins')
    : '';
  // Nodes, not strings: amountLabel carries the drawn diamond, and dropping a
  // node into a template literal renders "[object Object]".
  const sendLabel = demoSetter
    ? (amountLabel ? <span className="inline-flex items-center gap-1">Set balance to {amountLabel}</span> : 'Set Balance')
    : (tipAmount > 0 ? <span className="inline-flex items-center gap-1">Send {amountLabel}</span> : 'Send');

  if (!session) return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex items-center justify-center px-4">
      <div className="text-center">
        <div className="text-5xl mb-4">💸</div>
        <h2 className="text-2xl font-black text-white mb-2">Tip a Player</h2>
        <p className="text-muted mb-6">Login to send coins or diamonds to other players.</p>
        <Link to="/login" className="px-6 py-3 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all">Login to Tip</Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="w-full max-w-md animate-slide-up">
        <h1 className="text-4xl font-black text-white text-center mb-2">
          {demoSetter ? 'Set Balance' : 'Send Tip'}
        </h1>
        <p className="text-center text-muted mb-8">
          {demoSetter
            ? 'Demo account — the amount you enter becomes your balance'
            : 'Send coins or diamonds to any player'}
        </p>

        {/* Currency toggle */}
        <div className="flex items-center gap-1 bg-surface border border-border rounded-xl p-1 mb-6">
          <button
            onClick={() => handleCurrencySwitch('coins')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${
              !isDiamonds ? 'bg-primary text-white shadow-glow' : 'text-muted hover:text-white'
            }`}
          >
            <CoinIcon size="0.85em" /> Coins
          </button>
          <button
            onClick={() => handleCurrencySwitch('diamonds')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${
              isDiamonds ? 'bg-primary text-white shadow-glow' : 'text-muted hover:text-white'
            }`}
          >
            <DiamondIcon /> Diamonds
          </button>
        </div>

        {/* Balance */}
        {profile && (
          <div className="bg-surface border border-border rounded-xl px-4 py-3 mb-6 flex items-center justify-between gap-3">
            <span className="text-sm text-muted shrink-0">Your {isDiamonds ? 'diamonds' : 'balance'}</span>
            <span className="font-mono font-black text-white min-w-0 overflow-hidden" title={isDiamonds ? `${fmtExact(profile.diamonds, true)} diamonds` : `${fmtExact(profile.c_coins)} coins`}>
              {isDiamonds
                ? <span className="inline-flex items-center gap-1 max-w-full"><span className="truncate min-w-0">{fmtDiamonds(profile.diamonds)}</span> <DiamondIcon className="text-sm" /></span>
                : <span className="inline-flex items-center gap-1 max-w-full"><span className="truncate min-w-0">{fmtCoins(profile.c_coins)}</span> <CoinIcon size="0.85em" /></span>
              }
            </span>
          </div>
        )}

        <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col gap-5">
          {/* Recipient — meaningless when the form is setting your own balance */}
          {!demoSetter && (
          <div>
            <label className="block text-sm text-muted mb-2">Recipient username</label>
            <input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="Enter username"
              className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white placeholder-muted text-sm focus:outline-none focus:border-primary transition-colors"
            />
          </div>
          )}

          {/* Amount */}
          <div>
            <label className="block text-sm text-muted mb-2">
              Amount ({isDiamonds ? 'Diamonds' : 'Coins'})
            </label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder={isDiamonds ? '0' : '0.00'}
              min="0"
              step={isDiamonds ? '1' : '1'}
              className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white placeholder-muted text-sm focus:outline-none focus:border-primary transition-colors mb-3"
            />
          </div>

          {insufficient && (
            <p className="text-danger text-xs -mt-2">
              Insufficient {isDiamonds ? 'diamonds' : 'balance'} — you have{' '}
              {isDiamonds
                ? <span className="inline-flex items-center gap-1">{(profile?.diamonds ?? 0).toLocaleString()} <DiamondIcon /></span>
                : `${profile?.c_coins?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} coins`}
            </p>
          )}

          <GlowButton
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleSend}
            disabled={
              sending
              || (!demoSetter && (!recipient.trim() || !tipAmount || tipAmount <= 0))
              || (demoSetter && (!Number.isFinite(tipAmount) || tipAmount < 0))
              || insufficient
            }
          >
            {sending ? (demoSetter ? 'Setting...' : 'Sending...') : sendLabel}
          </GlowButton>

          {result && (
            <p className={`text-sm font-medium text-center ${
              result.type === 'success' ? 'text-success' : 'text-danger'
            }`}>
              {result.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}


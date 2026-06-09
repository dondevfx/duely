import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';

const COIN_AMOUNTS    = [1, 5, 10, 25, 50, 100];
const DIAMOND_AMOUNTS = [50, 100, 250, 500, 1000];

export default function Tip() {
  const ready = usePageReady();
  const { profile, session, refreshProfile } = useAuth();

  const [currency, setCurrency]   = useState('coins');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount]       = useState('');
  const [sending, setSending]     = useState(false);
  const [result, setResult]       = useState(null); // { type: 'success'|'error', text }

  const isDiamonds    = currency === 'diamonds';
  const quickAmounts  = isDiamonds ? DIAMOND_AMOUNTS : COIN_AMOUNTS;
  const currencyLabel = isDiamonds ? '💎' : '🪙';
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const tipAmount     = isDiamonds ? Math.floor(parseFloat(amount)) : parseFloat(amount);
  const insufficient  = tipAmount > 0 && myBalance < tipAmount;

  function handleCurrencySwitch(c) {
    setCurrency(c);
    setAmount('');
    setResult(null);
  }

  async function handleSend() {
    if (!recipient.trim() || !tipAmount || tipAmount <= 0) return;
    setSending(true);
    setResult(null);
    try {
      const data = await api.post('/wallet/tip', {
        recipientUsername: recipient.trim(),
        amount: tipAmount,
        currency,
      });
      const label = isDiamonds
        ? `${data.amount} 💎`
        : `${parseFloat(data.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 🪙`;
      setResult({ type: 'success', text: `Sent ${label} to ${data.recipient}!` });
      setRecipient('');
      setAmount('');
      await refreshProfile();
    } catch (err) {
      setResult({ type: 'error', text: err.message });
    } finally {
      setSending(false);
    }
  }

  const sendLabel = tipAmount > 0
    ? `Send ${isDiamonds ? tipAmount + ' 💎' : tipAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
    : 'Send';

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
        <h1 className="text-4xl font-black text-white text-center mb-2">Send Tip</h1>
        <p className="text-center text-muted mb-8">Send coins or diamonds to any player</p>

        {/* Currency toggle */}
        <div className="flex items-center gap-1 bg-surface border border-border rounded-xl p-1 mb-6">
          <button
            onClick={() => handleCurrencySwitch('coins')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${
              !isDiamonds ? 'bg-primary text-white shadow-glow' : 'text-muted hover:text-white'
            }`}
          >
            🪙 Coins
          </button>
          <button
            onClick={() => handleCurrencySwitch('diamonds')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${
              isDiamonds ? 'bg-primary text-white shadow-glow' : 'text-muted hover:text-white'
            }`}
          >
            💎 Diamonds
          </button>
        </div>

        {/* Balance */}
        {profile && (
          <div className="bg-surface border border-border rounded-xl px-4 py-3 mb-6 flex items-center justify-between">
            <span className="text-sm text-muted">Your {isDiamonds ? 'diamonds' : 'balance'}</span>
            <span className="font-mono font-black text-white">
              {isDiamonds
                ? <>{(profile.diamonds ?? 0).toLocaleString()} <span className="text-sm">💎</span></>
                : <>{profile.c_coins?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '0.00'} 🪙</>
              }
            </span>
          </div>
        )}

        <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col gap-5">
          {/* Recipient */}
          <div>
            <label className="block text-sm text-muted mb-2">Recipient username</label>
            <input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="Enter username"
              className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white placeholder-muted text-sm focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm text-muted mb-2">
              Amount ({isDiamonds ? 'Diamonds' : '🪙 Coins'})
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
            {/* Quick amounts */}
            <div className="flex flex-wrap gap-2">
              {quickAmounts.map(q => (
                <button
                  key={q}
                  onClick={() => setAmount(String(q))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    tipAmount === q
                      ? 'bg-primary border-primary text-white shadow-glow'
                      : 'border-surfaceLight text-muted hover:border-primary hover:text-white'
                  }`}
                >
                  {q} {currencyLabel}
                </button>
              ))}
            </div>
          </div>

          {insufficient && (
            <p className="text-danger text-xs -mt-2">
              Insufficient {isDiamonds ? 'diamonds' : 'balance'} — you have{' '}
              {isDiamonds
                ? `${(profile?.diamonds ?? 0).toLocaleString()} 💎`
                : `${profile?.c_coins?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 🪙`}
            </p>
          )}

          <GlowButton
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleSend}
            disabled={sending || !recipient.trim() || !tipAmount || tipAmount <= 0 || insufficient}
          >
            {sending ? 'Sending...' : sendLabel}
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


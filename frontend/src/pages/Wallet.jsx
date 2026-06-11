import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { supabase } from '../utils/supabase';
import GlowButton from '../components/GlowButton';
import DailyBonus from '../components/DailyBonus';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

// ── Supported deposit coins ───────────────────────────────────────────
const COINS = [
  { id: 'sol',  label: 'SOL',  network: 'Solana',   minUsd: 2  },
  { id: 'usdc', label: 'USDC', network: 'Solana',   minUsd: 2  },
  { id: 'btc',  label: 'BTC',  network: 'Bitcoin',  minUsd: 10 },
  { id: 'eth',  label: 'ETH',  network: 'Ethereum', minUsd: 10 },
  { id: 'bnb',  label: 'BNB',  network: 'BSC',      minUsd: 10 },
  { id: 'ltc',  label: 'LTC',  network: 'Litecoin', minUsd: 10 },
  { id: 'doge', label: 'DOGE', network: 'Dogecoin', minUsd: 10 },
  { id: 'trx',  label: 'TRX',  network: 'TRON',     minUsd: 10 },
];

// ── Supported withdrawal coins ────────────────────────────────────────
const WITHDRAW_COINS = [
  { id: 'sol',  label: 'SOL',  network: 'Solana'   },
  { id: 'usdc', label: 'USDC', network: 'Solana'   },
  { id: 'btc',  label: 'BTC',  network: 'Bitcoin'  },
  { id: 'eth',  label: 'ETH',  network: 'Ethereum' },
  { id: 'bnb',  label: 'BNB',  network: 'BSC'      },
  { id: 'ltc',  label: 'LTC',  network: 'Litecoin' },
  { id: 'doge', label: 'DOGE', network: 'Dogecoin' },
  { id: 'trx',  label: 'TRX',  network: 'TRON'     },
];

const MIN_WITHDRAWAL = 5;

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Coin grid ─────────────────────────────────────────────────────────
function CoinGrid({ coins, selected, onSelect, showMin = false }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
      {coins.map(c => (
        <button
          key={c.id}
          onClick={() => onSelect(c)}
          className={`relative py-3 px-2 rounded-xl border text-center transition-all ${
            selected?.id === c.id
              ? 'bg-primary border-primary text-white shadow-glow'
              : 'border-border bg-surfaceLight text-muted hover:border-primary hover:text-white'
          }`}
        >
          <div className="text-xs font-black mt-0.5">{c.label}</div>
          <div className="text-[10px] opacity-60 leading-tight">{c.network}</div>
          {showMin && c.minUsd && (
            <div className="text-[10px] leading-tight text-success font-semibold">min ${c.minUsd}</div>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────
function TxRow({ tx }) {
  const isDeposit = tx.type === 'deposit';
  return (
    <div className="flex items-center justify-between py-3 border-b border-surfaceLight/50 last:border-0">
      <div className="flex items-center gap-3">
        <span className={`text-lg ${isDeposit ? 'text-success' : 'text-danger'}`}>{isDeposit ? '↓' : '↑'}</span>
        <div>
          <div className="text-sm text-white font-medium capitalize">{tx.type}</div>
          <div className="text-xs text-muted">
            {tx.crypto_amount && tx.crypto_symbol
              ? `${tx.crypto_amount} ${tx.crypto_symbol}`
              : null}
            {tx.tx_hash && <span className="ml-2 font-mono opacity-50">{tx.tx_hash.slice(0, 12)}…</span>}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className={`text-sm font-bold ${isDeposit ? 'text-success' : 'text-danger'}`}>
          <span className="inline-flex items-center gap-0.5">{isDeposit ? '+' : '-'}{fmt(tx.amount_c)} <CoinIcon size="0.8em" /></span>
        </div>
        <div className="flex items-center gap-1.5 justify-end mt-0.5">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-bold ${
            tx.status === 'confirmed'  ? 'bg-success/10 text-success border-success/30' :
            tx.status === 'pending'    ? 'bg-warning/10 text-warning border-warning/30' :
            'bg-muted/10 text-muted border-border'
          }`}>{tx.status || 'pending'}</span>
          <span className="text-xs text-muted">{new Date(tx.created_at).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────
export default function Wallet() {
  const ready = usePageReady();
  const { profile, session, refreshProfile } = useAuth();

  // Deposit state
  const [depCoin, setDepCoin]       = useState(COINS[0]);
  const [depLoading, setDepLoading] = useState(false);
  const [depAddress, setDepAddress] = useState(null); // { address, memo, coin, min_usd }
  const [depMsg, setDepMsg]         = useState(null);
  const [depCopied, setDepCopied]   = useState(false);
  const [depPolling, setDepPolling] = useState(false);

  // Withdraw state
  const [witCoin, setWitCoin]           = useState(WITHDRAW_COINS[0]);
  const [witAddress, setWitAddress]     = useState('');
  const [witMemo, setWitMemo]           = useState('');
  const [witAmountUsd, setWitAmountUsd] = useState('');
  const [witLoading, setWitLoading]     = useState(false);
  const [witMsg, setWitMsg]             = useState(null);
  const [witMfaCode, setWitMfaCode]     = useState('');
  const [hasMfa, setHasMfa]             = useState(false);
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    api.get('/wallet/transactions?limit=50').then(setTransactions).catch(() => {});
    supabase.auth.mfa.listFactors()
      .then(({ data }) => setHasMfa(data?.totp?.some(f => f.status === 'verified') ?? false))
      .catch(() => {});
  }, []);

  // ── Get deposit address ───────────────────────────────────────────────
  async function handleGetAddress() {
    setDepLoading(true);
    setDepAddress(null);
    setDepMsg(null);
    setDepPolling(false);
    try {
      const data = await api.post('/wallet/get-address', { coin: depCoin.id });
      setDepAddress(data);
      startPolling();
    } catch (err) {
      setDepMsg({ type: 'error', text: err.message });
    } finally {
      setDepLoading(false);
    }
  }

  function startPolling() {
    setDepPolling(true);
    const startBalance = profile?.c_coins ?? 0;
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 120) { clearInterval(interval); setDepPolling(false); return; }
      try {
        const { c_coins } = await api.get('/wallet/balance');
        if (c_coins > startBalance) {
          clearInterval(interval);
          setDepPolling(false);
          setDepMsg({ type: 'success', text: `+${fmt(c_coins - startBalance)} coins received! Balance updated.` });
          refreshProfile();
          api.get('/wallet/transactions?limit=50').then(setTransactions).catch(() => {});
        }
      } catch {}
    }, 10000);
  }

  function copyAddr(text) {
    navigator.clipboard.writeText(text).catch(() => {});
    setDepCopied(true);
    setTimeout(() => setDepCopied(false), 2000);
  }

  // ── Withdraw ──────────────────────────────────────────────────────────
  async function handleWithdraw() {
    if (!witAmountUsd || parseFloat(witAmountUsd) < MIN_WITHDRAWAL || !witAddress.trim()) return;
    if (hasMfa && witMfaCode.length !== 6) {
      setWitMsg({ type: 'error', text: 'Enter the 6-digit code from your authenticator app.' });
      return;
    }
    setWitLoading(true);
    setWitMsg(null);
    try {
      if (hasMfa) {
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const factor = factors?.totp?.find(f => f.status === 'verified');
        if (factor) {
          const { error: mfaErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: witMfaCode });
          if (mfaErr) throw new Error('Invalid authenticator code.');
        }
      }
      const data = await api.post('/wallet/withdraw', {
        amountUsd: parseFloat(witAmountUsd),
        coin:      witCoin.id,
        address:   witAddress.trim(),
        memo:      witMemo.trim() || undefined,
      });
      setWitMsg({ type: 'success', text: `Withdrawal of ~${data.expected_output} ${witCoin.label} initiated. New balance: ${fmt(data.new_balance)} coins` });
      setWitAddress('');
      setWitMemo('');
      setWitAmountUsd('');
      setWitMfaCode('');

      await refreshProfile();
      api.get('/wallet/transactions?limit=50').then(setTransactions).catch(() => {});
    } catch (err) {
      setWitMsg({ type: 'error', text: err.message });
    } finally {
      setWitLoading(false);
    }
  }

  function copyText(text) { navigator.clipboard.writeText(text).catch(() => {}); }

  if (!session) return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex items-center justify-center px-4">
      <div className="text-center">
        <div className="text-5xl mb-4">💰</div>
        <h2 className="text-2xl font-black text-white mb-2">Wallet</h2>
        <p className="text-muted mb-6">Login to deposit, withdraw, and manage your balance.</p>
        <Link to="/login" className="px-6 py-3 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all">Login to Access</Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">Wallet</h1>
        <p className="text-muted mb-8">Manage your Coins — 1 Coin = $1 USD</p>

        {/* ── Balance card ────────────────────────────────────────────── */}
        <div className="bg-gradient-to-br from-primary/20 to-accent/10 border border-primary/30 rounded-2xl p-6 mb-6">
          <div className="text-sm text-muted mb-1">Coin Balance</div>
          <div className="text-5xl font-black text-white font-mono mb-1">
            {fmt(profile?.c_coins)}
            <span className="text-2xl text-primary ml-2"><CoinIcon size="1.25rem" /></span>
          </div>
          <div className="text-sm text-muted">≈ ${fmt(profile?.c_coins)} USD</div>
        </div>

        {/* ── Daily bonus ──────────────────────────────────────────────── */}
        {profile && <div className="mb-6"><DailyBonus /></div>}

        {/* ── Deposit ──────────────────────────────────────────────────── */}
        <div className="bg-surface border border-surfaceLight rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-1">Deposit</h2>
          <p className="text-sm text-muted mb-4">Select a coin and send to your deposit address.</p>

          <div className="flex flex-col gap-4">
            <div>
              <p className="text-xs text-muted mb-2">Select coin</p>
              <CoinGrid
                coins={COINS}
                selected={depCoin}
                onSelect={c => { setDepCoin(c); setDepAddress(null); setDepMsg(null); setDepPolling(false); }}
                showMin
              />
            </div>

            {!depAddress && (
              <GlowButton
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handleGetAddress}
                disabled={depLoading}
              >
                {depLoading ? 'Generating address...' : `Get ${depCoin.label} Deposit Address`}
              </GlowButton>
            )}

            {/* Address + QR */}
            {depAddress && (
              <div className="bg-bg border border-primary/30 rounded-xl p-5 space-y-4 animate-slide-down">
                {/* QR Code */}
                <div className="flex justify-center">
                  <div className="bg-white p-3 rounded-xl">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(depAddress.address)}&margin=2`}
                      alt="Deposit QR code"
                      width={180}
                      height={180}
                      className="rounded-lg block"
                    />
                  </div>
                </div>

                {/* Minimum notice */}
                <div className="bg-primary/10 border border-primary/20 rounded-lg px-4 py-2.5 text-center">
                  <p className="text-sm text-white font-semibold">
                    Send any amount — minimum ${depAddress.min_usd}
                  </p>
                  <p className="text-xs text-muted mt-0.5">Balance credited with exact USD value received after network fees</p>
                </div>

                {/* Address */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-muted font-semibold uppercase tracking-wider">{depCoin.label} Address ({depCoin.network})</span>
                    <button onClick={() => copyAddr(depAddress.address)} className="text-xs text-primary hover:underline font-semibold">
                      {depCopied ? '✓ Copied!' : 'Copy'}
                    </button>
                  </div>
                  <button onClick={() => copyAddr(depAddress.address)} className="w-full text-left">
                    <code className="block text-xs font-mono text-white break-all bg-surface px-3 py-3 rounded-lg hover:border-primary border border-transparent transition-colors">
                      {depAddress.address}
                    </code>
                  </button>
                </div>

                {/* Memo / destination tag (some coins require this) */}
                {depAddress.memo && (
                  <div className="bg-danger/10 border border-danger/30 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-danger font-bold uppercase">⚠️ Memo Required</span>
                      <button onClick={() => copyText(depAddress.memo)} className="text-xs text-primary hover:underline">Copy</button>
                    </div>
                    <code className="block text-sm font-mono text-white bg-bg px-3 py-2 rounded-lg">{depAddress.memo}</code>
                    <p className="text-xs text-danger mt-1">You must include this memo or your funds will be lost.</p>
                  </div>
                )}

                {/* Polling indicator */}
                {depPolling && (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted py-1">
                    <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    Waiting for payment — balance updates automatically...
                  </div>
                )}

                <button
                  onClick={() => { setDepAddress(null); setDepPolling(false); }}
                  className="w-full text-xs text-muted hover:text-white transition-colors text-center pt-1"
                >
                  Use a different coin
                </button>
              </div>
            )}
          </div>

          {depMsg && (
            <p className={`mt-3 text-sm font-medium ${depMsg.type === 'success' ? 'text-success' : 'text-danger'}`}>
              {depMsg.text}
            </p>
          )}
        </div>

        {/* ── Withdraw ─────────────────────────────────────────────────── */}
        <div className="bg-surface border border-surfaceLight rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-1">Withdraw</h2>
          <p className="text-sm text-muted mb-4">
            Convert Coins to any crypto.
          </p>

          <div className="flex flex-col gap-4">
            <div>
              <p className="text-xs text-muted mb-2">Select coin to receive</p>
              <CoinGrid
                coins={WITHDRAW_COINS}
                selected={witCoin}
                onSelect={c => { setWitCoin(c); setWitMemo(''); }}
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">Your {witCoin.label} address</label>
              <input
                value={witAddress}
                onChange={e => setWitAddress(e.target.value)}
                placeholder={`${witCoin.label} wallet address`}
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white placeholder-muted text-sm font-mono focus:outline-none focus:border-primary transition-colors"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted">Amount (USD) — <span className="text-success font-semibold">min ${MIN_WITHDRAWAL}</span></label>
                <span className="text-xs text-muted">Balance: <span className="text-white font-bold inline-flex items-center gap-0.5">{fmt(profile?.c_coins)} <CoinIcon size="0.75em" /></span></span>
              </div>
              <input
                type="number" min={MIN_WITHDRAWAL} max={profile?.c_coins ?? 0} step="1"
                value={witAmountUsd}
                onChange={e => setWitAmountUsd(e.target.value)}
                placeholder={`min $${MIN_WITHDRAWAL}`}
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white placeholder-muted text-sm focus:outline-none focus:border-primary transition-colors"
              />
              {witAmountUsd && parseFloat(witAmountUsd) > (profile?.c_coins ?? 0) && (
                <p className="text-xs text-danger mt-1">Exceeds your balance of {fmt(profile?.c_coins)} coins</p>
              )}
              {witAmountUsd && parseFloat(witAmountUsd) < MIN_WITHDRAWAL && parseFloat(witAmountUsd) > 0 && (
                <p className="text-xs text-danger mt-1">Minimum withdrawal is ${MIN_WITHDRAWAL}</p>
              )}
            </div>

            {hasMfa && (
              <div>
                <label className="block text-xs text-muted mb-1">🔐 Authenticator Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={witMfaCode}
                  onChange={e => setWitMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white text-sm font-mono placeholder-muted focus:outline-none focus:border-primary transition-colors"
                />
                <p className="text-[10px] text-muted mt-1">Open your authenticator app and enter the current 6-digit code.</p>
              </div>
            )}

            <GlowButton
              variant="outline"
              size="lg"
              className="w-full"
              onClick={handleWithdraw}
              disabled={
                witLoading ||
                !witAmountUsd ||
                parseFloat(witAmountUsd) < MIN_WITHDRAWAL ||
                !witAddress.trim() ||
                parseFloat(witAmountUsd) > (profile?.c_coins ?? 0) ||
                (hasMfa && witMfaCode.length !== 6)
              }
            >
              {witLoading ? 'Processing...' : `Withdraw ${witCoin.label}`}
            </GlowButton>
          </div>

          {witMsg && (
            <p className={`mt-3 text-sm font-medium ${witMsg.type === 'success' ? 'text-success' : 'text-danger'}`}>
              {witMsg.text}
            </p>
          )}
        </div>


      </div>
    </div>
  );
}

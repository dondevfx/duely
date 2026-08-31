import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import DiamondIcon from '../components/DiamondIcon';
import { api } from '../utils/api';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

// Every filter has to fit on ONE line, on a phone, without a scroll bar — a
// row you have to drag sideways hides its own options, and the two on the end
// were never being found.
//
// Eight full labels come to roughly 500px of text, so they cannot all fit
// across 375px. `short` is what a phone shows instead; the full label returns
// at the `sm` breakpoint. `text` is the plain-string form, used by the empty
// state, which cannot render an element.
// `label` is what a wide row shows, `short` what a narrow one shows, and
// `text` the plain-string name — used by the empty state, which cannot render
// an element, and as the accessible name when the short form is an icon.
//
// "Match Wins"/"Match Losses" lost the prefix: with it the long row needed
// 681px and could never fit, since the row tops out at 640px.
const FILTERS = [
  { key: 'all',        label: 'All',                                                                                    short: 'All',                     text: 'All' },
  { key: 'deposit',    label: 'Deposits',                                                                               short: 'In',                      text: 'Deposits' },
  { key: 'withdrawal', label: 'Withdrawals',                                                                            short: 'Out',                     text: 'Withdrawals' },
  { key: 'match_win',  label: 'Wins',                                                                                   short: 'Wins',                    text: 'Match Wins' },
  { key: 'match_loss', label: 'Losses',                                                                                 short: 'Losses',                  text: 'Match Losses' },
  { key: 'coins',      label: <span className="inline-flex items-center gap-1"><CoinIcon size="0.9em" /> Coins</span>,   short: <CoinIcon size="1.1em" />, text: 'Coins' },
  { key: 'diamonds',   label: <span className="inline-flex items-center gap-1"><DiamondIcon size="0.9em" /> Diamonds</span>,                                                                            short: <DiamondIcon size="1.1em" />,                      text: 'Diamonds' },
  { key: 'tip',        label: 'Tips',                                                                                   short: 'Tips',                    text: 'Tips' },
];

const POSITIVE_TYPES = new Set(['deposit', 'match_win', 'bonus', 'tip_received', 'daily_bonus', 'diamond_bonus', 'referral_bonus']);

function isPositive(type) {
  if (POSITIVE_TYPES.has(type)) return true;
  if (type && type.includes('win'))      return true;
  if (type && type.includes('deposit'))  return true;
  if (type && type.includes('bonus'))    return true;
  if (type && type.includes('received')) return true;
  return false;
}

function humanize(type) {
  if (!type) return 'Unknown';
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusBadge(status) {
  if (status === 'confirmed') {
    return { label: 'Confirmed', classes: 'bg-success/10 text-success border-success/30' };
  }
  if (status === 'pending') {
    return { label: 'Pending', classes: 'bg-warning/10 text-warning border-warning/30' };
  }
  if (status === 'pending_review') {
    return { label: 'Under Review', classes: 'bg-orange-500/10 text-orange-400 border-orange-500/30' };
  }
  if (status === 'pending_manual') {
    return { label: 'Manual Review', classes: 'bg-orange-500/10 text-orange-400 border-orange-500/30' };
  }
  return { label: status ?? 'Pending', classes: 'bg-muted/10 text-muted border-border' };
}

function TxRow({ tx }) {
  const positive    = isPositive(tx.type);
  const badge       = statusBadge(tx.status);
  const isDiamonds  = tx.crypto_symbol?.toLowerCase() === 'diamonds';
  const amountLabel = isDiamonds
    ? <span className="inline-flex items-center gap-1">{Number(tx.crypto_amount || 0).toLocaleString()} <DiamondIcon size="0.85em" /></span>
    : `${fmt(tx.amount_c)} coins`;

  return (
    <div className="flex items-center justify-between py-3.5 border-b border-surfaceLight/50 last:border-0 gap-4">
      {/* Left: icon + label */}
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`text-xl leading-none shrink-0 ${positive ? 'text-success' : 'text-danger'}`}
          aria-hidden="true"
        >
          {positive ? '↑' : '↓'}
        </span>
        <div className="min-w-0">
          <div className="text-sm text-white font-semibold leading-snug">
            {humanize(tx.type)}
          </div>
          {tx.notes && (
            <div className="text-xs text-muted leading-snug mt-0.5">{tx.notes}</div>
          )}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {tx.crypto_amount && tx.crypto_symbol && !isDiamonds && (
              <span className="text-xs text-muted">
                {tx.crypto_amount} {tx.crypto_symbol.toUpperCase()}
              </span>
            )}
            {tx.tx_hash && (
              <span className="text-[0.625rem] font-mono text-muted/60 truncate max-w-[120px]">
                {tx.tx_hash.slice(0, 10)}…
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right: amount + status + date */}
      <div className="text-right shrink-0">
        <div className={`text-sm font-bold ${positive ? 'text-success' : 'text-danger'}`}>
          {positive ? '+' : '-'}{amountLabel}
        </div>
        <div className="flex items-center gap-1.5 justify-end mt-1 flex-wrap">
          <span className={`text-[0.625rem] px-1.5 py-0.5 rounded-full border font-bold ${badge.classes}`}>
            {badge.label}
          </span>
          <span className="text-xs text-muted whitespace-nowrap">
            {new Date(tx.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day:   'numeric',
              year:  'numeric',
            })}
            {' '}
            <span className="opacity-60">
              {new Date(tx.created_at).toLocaleTimeString('en-US', {
                hour:   '2-digit',
                minute: '2-digit',
              })}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function matchesFilter(tx, filterKey) {
  if (filterKey === 'all') return true;
  if (filterKey === 'diamonds') {
    return tx.crypto_symbol?.toLowerCase() === 'diamonds';
  }
  if (filterKey === 'coins') {
    // All coin-denominated activity — the counterpart to the Diamonds tab
    return tx.crypto_symbol?.toLowerCase() !== 'diamonds';
  }
  if (filterKey === 'tip') {
    return tx.type === 'tip_sent' || tx.type === 'tip_received' || tx.type === 'tip';
  }
  if (filterKey === 'bonus') {
    return (
      tx.type === 'bonus' ||
      tx.type === 'daily_bonus' ||
      tx.type === 'referral_bonus' ||
      (tx.type && tx.type.includes('bonus'))
    );
  }
  return tx.type === filterKey;
}

const PAGE_SIZE = 200;

export default function Transactions() {
  const ready = usePageReady();
  const { profile } = useAuth();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [error, setError]               = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [hasMore, setHasMore]           = useState(false);
  const [offset, setOffset]             = useState(0);

  function fetchTxs(off = 0, append = false) {
    if (off === 0) setLoading(true); else setLoadingMore(true);
    api.get(`/wallet/transactions?limit=${PAGE_SIZE}&offset=${off}`)
      .then(data => {
        const rows = Array.isArray(data) ? data : [];
        setTransactions(prev => append ? [...prev, ...rows] : rows);
        setHasMore(rows.length === PAGE_SIZE);
        setOffset(off + rows.length);
        setError(null);
      })
      .catch(err => {
        setError(err.message || 'Failed to load transactions.');
      })
      .finally(() => { setLoading(false); setLoadingMore(false); });
  }

  useEffect(() => { fetchTxs(0, false); }, []);

  const filtered = transactions.filter(tx => matchesFilter(tx, activeFilter));

  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">

        {/* Header */}
        <h1 className="text-4xl font-black text-white mb-2">Transactions</h1>
        <p className="text-muted mb-8">Full history of your Coin activity</p>

        {/* Filter tabs */}
        {/* One straight line, no sideways scroll and no second row. The outer
            div is the query container; the label length and spacing inside
            follow ITS width. See .tx-filters in index.css. */}
        <div className="tx-filters mb-6">
          <div className="tx-row bg-surface border border-surfaceLight rounded-2xl p-1.5 flex flex-nowrap">
            {FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                // flex-auto, not flex-1: equal widths would size every button
                // to the longest label, which left "Losses" flush against its
                // own edge at 320px. Sized by content, sharing the slack.
                //
                // The short form can be an icon alone, which says nothing to a
                // screen reader, so the name is always spelled out here.
                aria-label={f.text}
                aria-pressed={activeFilter === f.key}
                className={`tx-btn flex-auto flex items-center justify-center px-1 py-1.5
                            text-[0.6875rem] font-bold rounded-xl transition-all whitespace-nowrap ${
                  activeFilter === f.key
                    ? 'bg-primary text-white shadow-glow'
                    : 'text-muted hover:text-white hover:bg-surfaceLight'
                }`}
              >
                <span className="tx-abbr">{f.short}</span>
                <span className="tx-full">{f.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Content card */}
        <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-muted text-sm">Loading transactions…</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <p className="text-danger font-semibold">Something went wrong</p>
              <p className="text-muted text-sm">{error}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <CoinIcon size="2.5rem" />
              <p className="text-white font-bold text-lg">
                {activeFilter === 'all' ? 'No transactions yet' : `No ${(() => { const f = FILTERS.find(x => x.key === activeFilter); return f?.text ?? (typeof f?.label === 'string' ? f.label : ''); })()} found`}
              </p>
              <p className="text-muted text-sm max-w-xs">
                {activeFilter === 'all'
                  ? 'Your deposit, withdrawal, and match history will appear here.'
                  : 'Try a different filter or check back later.'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-bold text-white">
                  {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}
                  {hasMore && <span className="text-muted font-normal"> (more available)</span>}
                </h2>
                {activeFilter !== 'all' && (
                  <button
                    onClick={() => setActiveFilter('all')}
                    className="text-xs text-primary hover:underline"
                  >
                    Clear filter
                  </button>
                )}
              </div>
              {filtered.map(tx => (
                <TxRow key={tx.id} tx={tx} />
              ))}
              {hasMore && (
                <div className="mt-4 flex justify-center">
                  <button
                    onClick={() => fetchTxs(offset, true)}
                    disabled={loadingMore}
                    className="px-6 py-2.5 bg-surfaceLight border border-border rounded-xl text-sm font-bold text-white hover:border-primary hover:bg-primary/10 disabled:opacity-50 transition-all"
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}


import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { usePageReady } from '../hooks/usePageReady';


function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Keys are the real matches.game_type values written by each engine — not
// guessed, checked against blockBlastEngine/wordleEngine/coinFlipEngine/
// blackjackEngine/towerEngine/carDashEngine directly. Tower and Rush Hour
// were missing entirely; their match counts were real in the database the
// whole time, just never rendered.
const GAME_LABELS = [
  { key: 'blockBlast', label: 'Block Burst' },
  { key: 'scrabble',   label: 'Word VS' },
  { key: 'coin_flip',  label: 'Coin Flip' },
  { key: 'blackjack',  label: 'Blackjack' },
  { key: 'tower',      label: 'Tower' },
  { key: 'carDash',    label: 'Rush Hour' },
  { key: 'colorRush',  label: 'Color Rush' },
];

const TYPE_LABELS = {
  deposit:       { label: 'Deposit',      color: 'text-success' },
  withdrawal:    { label: 'Withdrawal',   color: 'text-danger' },
  match_win:     { label: 'Match Win',    color: 'text-success' },
  match_loss:    { label: 'Match Loss',   color: 'text-danger' },
  daily_bonus:   { label: 'Daily Bonus',  color: 'text-accent' },
  diamond_bonus: { label: 'Diamond Spin', color: 'text-accent' },
};

function StatCard({ label, value, sub, color = 'text-white' }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-5">
      <div className={`text-2xl font-black ${color}`}>{value}</div>
      <div className="text-sm font-semibold text-white mt-1">{label}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}


// One stuck transaction, with what an operator needs to decide: who, how much,
// which failure, when, and the error the code recorded.
//
// Credit is a separate field from Resolve on purpose. Several of these states
// mean the money already reached the player, so a single "fix it" button that
// always credited would pay twice.
const SEVERITY = {
  refund_failed:    { label: 'Money owed',      cls: 'text-danger border-danger/50 bg-danger/10' },
  // ChangeNow could not deliver a withdrawal. The coins are deducted and
  // DELIBERATELY not auto-refunded: their terminal statuses do not all mean the
  // same thing to us — 'refunded' means the crypto is coming BACK to us, while
  // 'failed' can include a payout that partly went. Crediting on all of them
  // would sometimes pay a player who already has their crypto, so this waits
  // for a person. The notes line carries what ChangeNow said; the buttons below
  // are Refund, Money arrived, or Decline.
  withdraw_failed:  { label: 'Withdrawal failed', cls: 'text-danger border-danger/50 bg-danger/10' },
  // Broadcast, but the chain could not be read, so it was deliberately NOT
  // refunded — the player may already hold the crypto. Check the hash first.
  payout_uncertain: { label: 'Outcome unknown', cls: 'text-danger border-danger/50 bg-danger/10' },
  // A withdrawal in a state nothing currently writes, so nothing will ever
  // move it on. Left over from older code.
  pending:          { label: 'Stranded',        cls: 'text-danger border-danger/40 bg-danger/5' },
  payout_failed:    { label: 'Payout failed',   cls: 'text-danger border-danger/50 bg-danger/10' },
  stuck:            { label: 'Swap gave up',    cls: 'text-warning border-warning/50 bg-warning/10' },
  pending_retry:    { label: 'Retrying',        cls: 'text-warning border-warning/40 bg-warning/5' },
  converting:       { label: 'Converting >1h',  cls: 'text-muted border-border' },
  // A fiat payout still in flight. Normal for days on ACH, so it only reaches
  // this queue once it is well past any reasonable window.
  sending:          { label: 'Payout in flight', cls: 'text-muted border-border' },
};

function AttentionRow({ tx, busy, onResolve }) {
  const [ctx, setCtx]   = useState(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(tx.amount_c ?? ''));
  const [note, setNote]     = useState('');
  const sev = SEVERITY[tx.status] || { label: tx.status, cls: 'text-muted border-border' };
  const ageH = Math.floor((Date.now() - new Date(tx.created_at)) / 3600000);

  // Loaded on expand rather than for every row — the queue would otherwise fire
  // a query per row on every dashboard load.
  async function expand() {
    setOpen(o => !o);
    if (!ctx) {
      try { setCtx(await api.get(`/admin/transactions/${tx.id}/context`)); }
      catch { setCtx({ failed: true }); }
    }
  }

  return (
    <div className="bg-bg border border-border rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${sev.cls}`}>
          {sev.label}
        </span>
        <span className="text-sm font-bold text-white">
          {tx.profiles?.username || tx.user_id?.slice(0, 8)}
        </span>
        <span className="text-sm text-white font-mono">
          {tx.type} · {Number(tx.amount_c || 0).toFixed(2)} {tx.crypto_symbol || ''}
        </span>
        <span className="text-xs text-muted ml-auto">
          {ageH < 1 ? 'under an hour' : `${ageH}h old`}
        </span>
        <button onClick={expand}
          className="text-xs px-2 py-1 rounded-lg border border-border text-muted hover:text-white hover:border-primary">
          {open ? 'Hide' : 'Investigate'}
        </button>
      </div>

      {tx.notes && <p className="text-[11px] text-danger/80 font-mono break-all mt-2">{tx.notes}</p>}

      {open && (
        <div className="mt-3 pt-3 border-t border-border">
          {!ctx ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : ctx.failed ? (
            <p className="text-xs text-danger">Could not load context.</p>
          ) : (
            <>
              {/* The question that decides everything: were they already paid? */}
              <div className={`text-xs font-bold mb-2 ${ctx.alreadyCredited ? 'text-warning' : 'text-muted'}`}>
                {ctx.alreadyCredited
                  ? '⚠ A manual credit already references this transaction — check before paying again.'
                  : 'No manual credit recorded against this transaction yet.'}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                {[
                  ['Balance now', Number(ctx.balance).toFixed(2)],
                  ['Deposited',   Number(ctx.deposited).toFixed(2)],
                  ['Withdrawn',   Number(ctx.withdrawn).toFixed(2)],
                  ['Diamonds',    ctx.diamonds],
                ].map(([k, v]) => (
                  <div key={k} className="bg-surface border border-border rounded-lg px-2 py-1.5">
                    <div className="text-sm font-black text-white">{v}</div>
                    <div className="text-[9px] text-muted">{k}</div>
                  </div>
                ))}
              </div>

              {ctx.explorer && (
                <a href={ctx.explorer} target="_blank" rel="noopener noreferrer"
                  className="inline-block text-xs text-primary hover:underline mb-3">
                  Check on-chain ↗
                </a>
              )}

              {ctx.related?.length > 0 && (
                <div className="mb-3 max-h-40 overflow-y-auto">
                  <div className="text-[10px] text-muted font-bold uppercase mb-1">Their recent activity</div>
                  {ctx.related.slice(0, 10).map(r => (
                    <div key={r.id} className="text-[10px] text-muted font-mono flex gap-2 py-0.5">
                      <span className="w-32 shrink-0">{new Date(r.created_at).toLocaleString()}</span>
                      <span className="w-24 shrink-0">{r.type}</span>
                      <span className="w-16 shrink-0 text-white">{Number(r.amount_c || 0).toFixed(2)}</span>
                      <span className="truncate">{r.status}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2 mb-2">
                <input value={amount} onChange={e => setAmount(e.target.value)}
                  placeholder="Amount" inputMode="decimal"
                  className="w-24 bg-surface border border-border rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-primary" />
                <input value={note} onChange={e => setNote(e.target.value)}
                  placeholder="What you found (recorded on the row)"
                  className="flex-1 min-w-[160px] bg-surface border border-border rounded-lg px-2 py-1.5 text-xs text-white placeholder-muted focus:outline-none focus:border-primary" />
              </div>

              {/* Each action is separate and says exactly what it does. A single
                  "fix" button would have to guess, and guessing here pays twice. */}
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => onResolve('credit', amount, note)}
                  className="px-3 py-1.5 rounded-lg bg-success/20 border border-success/50 text-success text-xs font-bold hover:bg-success/30 disabled:opacity-40">
                  Refund / credit {amount || '…'}
                </button>
                <button disabled={busy} onClick={() => onResolve('mark_sent', 0, note)}
                  className="px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/50 text-primary text-xs font-bold hover:bg-primary/30 disabled:opacity-40">
                  Money arrived — resolve
                </button>
                <button disabled={busy} onClick={() => onResolve('deduct', amount, note)}
                  className="px-3 py-1.5 rounded-lg bg-warning/20 border border-warning/50 text-warning text-xs font-bold hover:bg-warning/30 disabled:opacity-40">
                  Claw back {amount || '…'}
                </button>
                <button disabled={busy} onClick={() => onResolve('decline', 0, note)}
                  className="px-3 py-1.5 rounded-lg bg-danger/20 border border-danger/50 text-danger text-xs font-bold hover:bg-danger/30 disabled:opacity-40">
                  Decline
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// One support thread, with the reply box and a close action.
function TicketThread({ ticket, onReply, onClose, busy }) {
  const [body, setBody] = useState('');
  return (
    <div className="bg-bg border border-border rounded-xl p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold text-white">{ticket.subject}</span>
        <span className="text-xs text-muted">
          {ticket.profiles?.username} · balance {Number(ticket.profiles?.c_coins ?? 0).toFixed(2)}
        </span>
        <button onClick={onClose} disabled={busy}
          className="ml-auto text-xs px-2 py-1 rounded-lg border border-border text-muted hover:text-white">
          Close
        </button>
      </div>

      {ticket.transaction_id && (
        <p className="text-[10px] text-primary font-mono mb-2">
          linked transaction: {ticket.transaction_id}
        </p>
      )}

      <div className="space-y-2 mb-3 max-h-64 overflow-y-auto">
        {(ticket.messages || []).map(m => (
          <div key={m.id} className={`rounded-lg px-2 py-1.5 ${m.is_staff
            ? 'bg-primary/10 border border-primary/30' : 'bg-surface border border-border'}`}>
            <div className="text-[9px] text-muted mb-0.5">
              {m.is_staff ? 'Staff' : 'Player'} · {new Date(m.created_at).toLocaleString()}
            </div>
            <p className="text-xs text-white whitespace-pre-wrap break-words">{m.body}</p>
          </div>
        ))}
      </div>

      <textarea value={body} onChange={e => setBody(e.target.value)} rows={2}
        placeholder="Reply to the player…"
        className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-xs text-white placeholder-muted focus:outline-none focus:border-primary mb-2" />
      <button onClick={() => { onReply(body); setBody(''); }} disabled={busy || !body.trim()}
        className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold hover:bg-blue-500 disabled:opacity-40">
        Send reply
      </button>
    </div>
  );
}

export default function Admin() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats]           = useState(null);
  const [txs, setTxs]               = useState([]);
  const [attention, setAttention]   = useState([]);
  const [resolving, setResolving]   = useState(null);
  const [tickets, setTickets]       = useState([]);
  const [openTicket, setOpenTicket] = useState(null);
  const [users, setUsers]           = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [tab, setTab]               = useState('overview');
  const [kycQueue, setKycQueue]     = useState([]);
  // Which sections failed to load, so a partial dashboard says so instead of
  // rendering empty panels that look like real zeroes.
  const [loadErrors, setLoadErrors] = useState([]);
  const [kycBusy, setKycBusy]       = useState(null);

  // ── Player detail panel ──────────────────────────────────────────────
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [playerDetail, setPlayerDetail]     = useState(null);
  const [playerLoading, setPlayerLoading]   = useState(false);
  const [banReason, setBanReason]           = useState('');
  const [playerReports, setPlayerReports]   = useState([]);
  const [avatarBusy, setAvatarBusy]         = useState(false);
  const [banBusy, setBanBusy]               = useState(false);
  const [adjustAmount, setAdjustAmount]     = useState('');
  const [adjustNote, setAdjustNote]         = useState('');
  const [adjustBusy, setAdjustBusy]         = useState(false);
  const [panelMsg, setPanelMsg]             = useState('');

  async function openPlayer(id) {
    setSelectedUserId(id);
    setPlayerDetail(null);
    setPlayerLoading(true);
    setPanelMsg('');
    setBanReason('');
    setAdjustAmount('');
    setAdjustNote('');
    setPlayerReports([]);
    try {
      setPlayerDetail(await api.get(`/admin/users/${id}`));
      // Fetched separately and deliberately NOT awaited with the profile: a
      // missing player_reports table must not stop the panel opening. That is
      // the same mistake that made this panel unreachable in the first place.
      api.get(`/admin/users/${id}/reports`)
        .then(r => setPlayerReports(r.reports || []))
        .catch(() => setPlayerReports([]));
    } catch (e) {
      setPanelMsg(`Could not load player: ${e.message}`);
    } finally {
      setPlayerLoading(false);
    }
  }

  function closePlayer() {
    setSelectedUserId(null);
    setPlayerDetail(null);
  }

  async function refreshPlayer() {
    if (!selectedUserId) return;
    try { setPlayerDetail(await api.get(`/admin/users/${selectedUserId}`)); } catch {}
  }

  async function removeAvatar(banFuture) {
    setAvatarBusy(true);
    setPanelMsg('');
    try {
      await api.post(`/admin/users/${selectedUserId}/remove-avatar`, { banFuture });
      await refreshPlayer();
      setPanelMsg(banFuture ? 'Picture removed and uploads blocked.' : 'Picture removed.');
    } catch (e) {
      setPanelMsg(`Could not remove the picture: ${e.message}`);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function restoreAvatar() {
    setAvatarBusy(true);
    setPanelMsg('');
    try {
      await api.post(`/admin/users/${selectedUserId}/restore-avatar`);
      await refreshPlayer();
      setPanelMsg('Upload privileges restored.');
    } catch (e) {
      setPanelMsg(`Could not restore: ${e.message}`);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function decideReport(id, decision) {
    try {
      await api.post(`/admin/reports/${id}/decide`, { decision });
      setPlayerReports(rs => rs.map(r => (r.id === id ? { ...r, status: decision } : r)));
    } catch (e) {
      setPanelMsg(`Could not update that report: ${e.message}`);
    }
  }

  async function banPlayer() {
    if (!banReason.trim()) { setPanelMsg('A reason is required.'); return; }
    setBanBusy(true);
    setPanelMsg('');
    try {
      await api.post(`/admin/users/${selectedUserId}/ban`, { reason: banReason.trim() });
      setBanReason('');
      await refreshPlayer();
      setUsers(u => u.map(x => x.id === selectedUserId ? { ...x, banned: true } : x));
    } catch (e) {
      setPanelMsg(`Ban failed: ${e.message}`);
    } finally {
      setBanBusy(false);
    }
  }

  async function unbanPlayer() {
    setBanBusy(true);
    setPanelMsg('');
    try {
      await api.post(`/admin/users/${selectedUserId}/unban`);
      await refreshPlayer();
      setUsers(u => u.map(x => x.id === selectedUserId ? { ...x, banned: false } : x));
    } catch (e) {
      setPanelMsg(`Unban failed: ${e.message}`);
    } finally {
      setBanBusy(false);
    }
  }

  async function adjustPlayerBalance() {
    const amount = Number(adjustAmount);
    if (!Number.isFinite(amount) || amount === 0) { setPanelMsg('Enter a non-zero amount.'); return; }
    if (!adjustNote.trim()) { setPanelMsg('A note is required.'); return; }
    setAdjustBusy(true);
    setPanelMsg('');
    try {
      await api.post(`/admin/users/${selectedUserId}/adjust-balance`, { amount, note: adjustNote.trim() });
      setAdjustAmount('');
      setAdjustNote('');
      await refreshPlayer();
      // Keep the Users table's own coin figure in sync without a full reload.
      setUsers(u => u.map(x => x.id === selectedUserId ? { ...x, c_coins: (x.c_coins ?? 0) + amount } : x));
    } catch (e) {
      setPanelMsg(`Adjustment failed: ${e.message}`);
    } finally {
      setAdjustBusy(false);
    }
  }
  const [loading, setLoading]       = useState(true);
  const [coinSupply, setCoinSupply]   = useState(null);
  const [supplyLoading, setSupplyLoading] = useState(false);

  const [collectingFees, setCollectingFees]   = useState(false);
  const [collectMsg, setCollectMsg]           = useState('');
  const [addingDiamonds, setAddingDiamonds]   = useState(false);
  const [diamondMsg, setDiamondMsg]           = useState('');
  const [removingCoins, setRemovingCoins]     = useState(false);
  const [removeCoinsMsg, setRemoveCoinsMsg]   = useState('');
  const [eloMsg, setEloMsg]                 = useState('');
  const [eloLoading, setEloLoading]         = useState(false);
  const [setEloUsername, setSetEloUsername] = useState('');
  const [setEloValue, setSetEloValue]       = useState('');
  const [playerEloMsg, setPlayerEloMsg]       = useState('');
  const [playerEloLoading, setPlayerEloLoading] = useState(false);
  const [creatorUsername, setCreatorUsername] = useState('');
  const [creatorCode, setCreatorCode]         = useState('');
  const [creatorLoading, setCreatorLoading]   = useState(false);
  const [creatorMsg, setCreatorMsg]           = useState('');

  useEffect(() => {
    if (!profile) return;
    if (!profile.is_admin) { navigate('/'); return; }
    load();
  }, [profile]);

  async function load() {
    setLoading(true);
    setLoadErrors([]);

    // allSettled, not all. The first three calls had no .catch(), so ONE of
    // them failing rejected the whole Promise.all and none of the six setters
    // ran — every panel rendered empty at once, with the only trace a
    // console.error nobody was watching. That is the "admin page shows
    // nothing tracked" report: almost certainly /admin/stats, which runs 16
    // queries in a single un-caught Promise.all of its own server-side.
    //
    // Each section now stands or falls on its own, and whatever did fail is
    // named on screen instead of being swallowed.
    const calls = [
      ['stats',       '/admin/stats',                        setStats],
      ['transactions','/admin/transactions?limit=100',       setTxs],
      ['users',       '/admin/users?limit=100',              setUsers],
      // Separate call rather than filtering the list above: the queue is
      // sorted by severity server-side, and a stuck row from last week would
      // never appear in the most recent 100 transactions.
      ['attention',   '/admin/transactions?needsAttention=1', setAttention],
      // Tickets waiting on staff. A list of every ticket ever raised is not a
      // work queue, so this defaults to the open ones.
      ['support',     '/admin/support/tickets',              setTickets],
      // Pending only — an approved submission is a record, not a task.
      ['kyc',         '/admin/kyc?status=pending',           setKycQueue],
    ];

    const results = await Promise.allSettled(calls.map(([, url]) => api.get(url)));
    const failed = [];
    results.forEach((r, i) => {
      const [name, , setter] = calls[i];
      if (r.status === 'fulfilled') setter(r.value);
      else {
        failed.push(`${name}: ${r.reason?.message || 'failed'}`);
        console.error(`[admin] ${name} failed:`, r.reason?.message);
      }
    });
    setLoadErrors(failed);
    setLoading(false);
  }

  // Resolve one stuck row. creditAmount is optional — several of these states
  // mean the money DID reach the player, and crediting those would pay twice,
  // so the operator decides after checking rather than the UI assuming.
  async function resolveTx(tx, action, amount, note) {
    setResolving(tx.id);
    try {
      await api.post(`/admin/transactions/${tx.id}/resolve`, { action, amount, note });
      await load();
    } catch (e) {
      alert(`Could not resolve: ${e.message}`);
    } finally {
      setResolving(null);
    }
  }

  async function viewTicket(id) {
    try { setOpenTicket(await api.get(`/admin/support/tickets/${id}`)); }
    catch (e) { alert(e.message); }
  }

  async function replyTicket(body) {
    if (!body?.trim()) return;
    setResolving(openTicket.id);
    try {
      await api.post(`/admin/support/tickets/${openTicket.id}/reply`, { body });
      await viewTicket(openTicket.id);
      await load();
    } catch (e) { alert(e.message); }
    finally { setResolving(null); }
  }

  async function closeTicket(id) {
    try { await api.post(`/admin/support/tickets/${id}/close`); setOpenTicket(null); await load(); }
    catch (e) { alert(e.message); }
  }

  // Approve or reject one submission. The row is removed locally rather than
  // reloading the whole dashboard: the queue is the work list, and a decided
  // item leaving it is the feedback.
  async function decideKyc(id, decision, reason) {
    setKycBusy(id);
    try {
      await api.post(`/admin/kyc/${id}/decide`, { decision, reason });
      setKycQueue(q => q.filter(k => k.id !== id));
    } catch (e) {
      // 409 means somebody else already reviewed it, so drop it either way.
      if (e.status === 409) setKycQueue(q => q.filter(k => k.id !== id));
      else alert(`Could not save that decision: ${e.message}`);
    } finally {
      setKycBusy(null);
    }
  }

  async function loadCoinSupply() {
    setSupplyLoading(true);
    try {
      const data = await api.get('/admin/coin-supply');
      setCoinSupply(data.total);
    } catch (e) {
      console.error('Coin supply error:', e.message);
    } finally {
      setSupplyLoading(false);
    }
  }

  async function handleCollectFees() {
    if (collectingFees) return;
    setCollectingFees(true);
    setCollectMsg('');
    try {
      const d = await api.post('/admin/collect-fees', {});
      await refreshProfile();
      load(); // refresh stats
      if (d.collected > 0) {
        setCollectMsg(`Collected ${fmt(d.collected)} 🪙 → balance: ${fmt(d.c_coins)} 🪙`);
      } else {
        setCollectMsg('No fees to collect right now.');
      }
    } catch (e) {
      setCollectMsg(`Error: ${e.message}`);
    } finally {
      setCollectingFees(false);
    }
  }

  async function handleAddDiamonds() {
    if (addingDiamonds) return;
    setAddingDiamonds(true);
    setDiamondMsg('');
    try {
      const d = await api.post('/admin/add-diamonds', {});
      await refreshProfile();
      setDiamondMsg(`Done! Balance: ${(d.diamonds ?? 0).toLocaleString()} 💎`);
    } catch (e) {
      setDiamondMsg(`Error: ${e.message}`);
    } finally {
      setAddingDiamonds(false);
    }
  }

  async function handleRemoveCoins() {
    if (removingCoins) return;
    setRemovingCoins(true);
    setRemoveCoinsMsg('');
    try {
      await api.post('/admin/remove-coins', {});
      await refreshProfile();
      setRemoveCoinsMsg('Done! Coin balance cleared.');
    } catch (e) {
      setRemoveCoinsMsg(`Error: ${e.message}`);
    } finally {
      setRemovingCoins(false);
    }
  }

  async function handleAdjustElo(delta) {
    if (eloLoading) return;
    setEloLoading(true);
    setEloMsg('');
    try {
      const d = await api.post('/admin/adjust-elo', { delta });
      await refreshProfile();
      setEloMsg(`Done! New ELO: ${d.elo}`);
    } catch (e) {
      setEloMsg(`Error: ${e.message}`);
    } finally {
      setEloLoading(false);
    }
  }

  async function handleSetPlayerElo(e) {
    e.preventDefault();
    if (playerEloLoading || !setEloUsername.trim() || setEloValue === '') return;
    setPlayerEloLoading(true);
    setPlayerEloMsg('');
    try {
      const d = await api.post('/admin/set-player-elo', { username: setEloUsername.trim(), elo: parseInt(setEloValue, 10) });
      setPlayerEloMsg(`✓ ${d.username}: ${d.oldElo} → ${d.newElo} ELO`);
      setSetEloUsername('');
      setSetEloValue('');
    } catch (e) {
      setPlayerEloMsg(`Error: ${e.message}`);
    } finally {
      setPlayerEloLoading(false);
    }
  }

  async function handleSetCreatorCode(e) {
    e.preventDefault();
    if (creatorLoading) return;
    setCreatorLoading(true);
    setCreatorMsg('');
    try {
      const d = await api.post('/admin/set-creator-code', { username: creatorUsername, code: creatorCode });
      setCreatorMsg(`Set! ${d.username} → code "${d.code}" (2% creator)`);
      setCreatorUsername('');
      setCreatorCode('');
    } catch (err) {
      setCreatorMsg(`Error: ${err.message}`);
    } finally {
      setCreatorLoading(false);
    }
  }

  async function searchUsers(q) {
    setUserSearch(q);
    try {
      const u = await api.get(`/admin/users?search=${encodeURIComponent(q)}&limit=100`);
      setUsers(u);
    } catch {}
  }

  if (!profile || !profile.is_admin) return null;

  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-6xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-black text-white">Admin Dashboard</h1>
            <p className="text-muted text-sm mt-1">Platform overview and management</p>
          </div>
          <button onClick={load} className="px-4 py-2 text-sm font-semibold text-muted border border-border rounded-xl hover:border-primary hover:text-white transition-all">
            ↻ Refresh
          </button>
        </div>

        {/* A section that failed to load says so. Without this an empty
            dashboard is indistinguishable from a real platform with no
            activity — which is exactly how "shows nothing tracked" looked. */}
        {/* Individual queries inside /admin/stats can fail while the request
            itself succeeds — supabase-js resolves with { error } rather than
            rejecting, so those tiles read 0 and look like a genuinely empty
            platform. The route now reports which ones. */}
        {stats?.query_errors?.length > 0 && (
          <div className="mb-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
            <p className="text-sm font-bold text-warning mb-1">
              {stats.query_errors.length} stat{stats.query_errors.length > 1 ? 's' : ''} could not be read — those tiles show 0 but are not really 0
            </p>
            <ul className="text-xs text-warning/80 font-mono space-y-0.5">
              {stats.query_errors.map(e => <li key={e}>{e}</li>)}
            </ul>
          </div>
        )}

        {loadErrors.length > 0 && (
          <div className="mb-6 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
            <p className="text-sm font-bold text-danger mb-1">
              {loadErrors.length} section{loadErrors.length > 1 ? 's' : ''} failed to load
            </p>
            <ul className="text-xs text-danger/80 font-mono space-y-0.5">
              {loadErrors.map(e => <li key={e}>{e}</li>)}
            </ul>
            <p className="text-[11px] text-muted mt-2">
              Everything else below still loaded and is accurate.
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <StatCard label="Total Users"      value={stats?.total_users?.toLocaleString() ?? '—'}  color="text-accent" />
              <StatCard label="Total Matches"    value={stats?.total_matches?.toLocaleString() ?? '—'} color="text-primary" />
              <StatCard label="Matches Today"    value={stats?.matches_today?.toLocaleString() ?? '—'} sub={`+${stats?.new_users_today ?? 0} new users`} color="text-white" />
              <StatCard label="Pending Withdrawals" value={stats?.pending_withdrawals ?? 0}            color={stats?.pending_withdrawals > 0 ? 'text-warning' : 'text-muted'} />
            </div>

            {/* New accounts & activity */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <StatCard label="New Users (7d)"   value={stats?.new_users_7d?.toLocaleString() ?? '—'}  sub={`${stats?.new_users_30d ?? 0} in last 30d`} color="text-accent" />
              <StatCard label="Matches (7d)"     value={stats?.matches_7d?.toLocaleString() ?? '—'}    sub={`${stats?.matches_30d ?? 0} in last 30d`} color="text-primary" />
              <StatCard label="Active Players (24h)" value={stats?.active_users_24h?.toLocaleString() ?? '—'} sub="played at least 1 match" color="text-success" />
              <StatCard label="Active Players (7d)"  value={stats?.active_users_7d?.toLocaleString() ?? '—'}  sub="played at least 1 match" color="text-white" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <StatCard label="Uncollected Fees"   value={`${fmt(stats?.fee_balance)} 🪙`}             sub="click Collect to claim" color={stats?.fee_balance > 0 ? 'text-warning' : 'text-muted'} />
              <StatCard label="Wallet Balance"     value={`${fmt(stats?.fees_coins)} 🪙`}              sub={`${(stats?.fees_diamonds ?? 0).toLocaleString()} 💎`} color="text-success" />
              <StatCard label="Total Fees Claimed" value={`${fmt(stats?.total_fees_claimed)} 🪙`}      sub="all time" color="text-accent" />
              <StatCard label="Total Wagered"      value={`${fmt(stats?.total_wagered)} 🪙`}           sub="prize pool across all matches" color="text-white" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <StatCard label="Diamonds in Circulation" value={(stats?.total_diamonds_circulating ?? 0).toLocaleString()} sub="sum of all player balances" color="text-accent" />
              {/* What the wheels have handed out. Coins and diamonds are
                  separate tiles because they are separate money: the rank
                  wheels pay diamonds, and only the 1-in-10M slot pays coins. */}
              <StatCard label="Coins Paid by Wheels"    value={(stats?.wheel_coins_paid ?? 0).toLocaleString()}    sub="all-time, incl. the coin slot" color="text-warning" />
              <StatCard label="Diamonds Paid by Wheels" value={(stats?.wheel_diamonds_paid ?? 0).toLocaleString()} sub="all-time, daily + rank wheels" color="text-accent" />
            </div>

            {/* Matches by game */}
            <div className="bg-surface border border-border rounded-2xl p-5 mb-8">
              <h2 className="text-white font-bold text-lg mb-4">Matches by Game</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                {GAME_LABELS.map(({ key, label }) => (
                  <div key={key} className="bg-bg border border-border rounded-xl p-4 text-center">
                    <div className="text-2xl font-black text-white">{(stats?.matches_by_game?.[key] ?? 0).toLocaleString()}</div>
                    <div className="text-xs text-muted mt-1">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Coin Supply ──────────────────────────────────────────── */}
            <div className="bg-surface border border-border rounded-2xl p-5 mb-8 flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg">Total Coins in Circulation</h2>
                <p className="text-xs text-muted mt-0.5">Sum of all player balances — should match your USDC float</p>
                {coinSupply !== null && (
                  <div className="text-3xl font-black text-success mt-2">${fmt(coinSupply)} <span className="text-base text-muted">coins</span></div>
                )}
              </div>
              <button
                onClick={loadCoinSupply}
                disabled={supplyLoading}
                className="px-4 py-2 text-sm font-bold rounded-xl border border-primary text-primary hover:bg-primary hover:text-white transition-all disabled:opacity-50"
              >
                {supplyLoading ? 'Loading...' : 'Check'}
              </button>
            </div>

            {/* Admin Tools */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
              {/* Collect Fees */}
              <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-3" style={{ borderColor: stats?.fee_balance > 0 ? 'rgba(234,179,8,0.4)' : undefined }}>
                <div className="font-bold text-white text-sm">Collect Fee Earnings</div>
                <div className="text-xs text-muted">
                  Moves <span className="font-bold" style={{ color: stats?.fee_balance > 0 ? '#eab308' : undefined }}>{fmt(stats?.fee_balance)} 🪙</span> of uncollected match fees into your coin balance.
                </div>
                <button
                  onClick={handleCollectFees}
                  disabled={collectingFees || !(stats?.fee_balance > 0)}
                  className="w-full py-2 rounded-xl text-sm font-bold transition-all"
                  style={collectingFees || !(stats?.fee_balance > 0) ? {
                    background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: collectingFees ? 'wait' : 'not-allowed',
                  } : {
                    background: 'linear-gradient(135deg, #ca8a04 0%, #1e293b 100%)',
                    color: '#fff', border: '1px solid rgba(202,138,4,0.4)',
                    boxShadow: '0 0 18px rgba(234,179,8,0.25)',
                  }}
                >
                  {collectingFees ? 'Collecting…' : `Collect ${fmt(stats?.fee_balance)} 🪙`}
                </button>
                {collectMsg && <div className="text-xs text-center" style={{ color: collectMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{collectMsg}</div>}
              </div>

              {/* Add 5M Diamonds */}
              <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-3">
                <div className="font-bold text-white text-sm">Add 5M Diamonds</div>
                <div className="text-xs text-muted">Credits 5,000,000 💎 directly to your admin account.</div>
                <button
                  onClick={handleAddDiamonds}
                  disabled={addingDiamonds}
                  className="w-full py-2 rounded-xl text-sm font-bold transition-all"
                  style={addingDiamonds ? {
                    background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: 'not-allowed',
                  } : {
                    background: 'linear-gradient(135deg, #7c3aed 0%, #1e293b 100%)',
                    color: '#fff', border: '1px solid rgba(124,58,237,0.4)',
                    boxShadow: '0 0 18px rgba(124,58,237,0.25)',
                  }}
                >
                  {addingDiamonds ? 'Adding…' : '+ 5,000,000 💎'}
                </button>
                {diamondMsg && <div className="text-xs text-center" style={{ color: diamondMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{diamondMsg}</div>}
              </div>

              {/* Set Creator Code */}
              <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-3">
                <div className="font-bold text-white text-sm">Set Creator Code</div>
                <div className="text-xs text-muted">Assign a code to a user — they earn 2% of match pot, you (admin) earn 3%.</div>
                <form onSubmit={handleSetCreatorCode} className="flex flex-col gap-2">
                  <input
                    value={creatorUsername}
                    onChange={e => setCreatorUsername(e.target.value)}
                    placeholder="Username"
                    className="w-full bg-bg border border-border rounded-xl px-3 py-2 text-white text-sm placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                  <input
                    value={creatorCode}
                    onChange={e => setCreatorCode(e.target.value.toUpperCase())}
                    placeholder="Code (4-12 chars, A-Z 0-9)"
                    maxLength={12}
                    className="w-full bg-bg border border-border rounded-xl px-3 py-2 text-white text-sm placeholder-muted focus:outline-none focus:border-primary transition-colors font-mono"
                  />
                  <button
                    type="submit"
                    disabled={creatorLoading || !creatorUsername || !creatorCode}
                    className="w-full py-2 rounded-xl text-sm font-bold transition-all"
                    style={creatorLoading || !creatorUsername || !creatorCode ? {
                      background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: 'not-allowed',
                    } : {
                      background: 'linear-gradient(135deg, #1d4ed8 0%, #0f172a 100%)',
                      color: '#fff', border: '1px solid rgba(29,78,216,0.4)',
                      boxShadow: '0 0 18px rgba(29,78,216,0.25)',
                    }}
                  >
                    {creatorLoading ? 'Saving…' : 'Assign Code'}
                  </button>
                </form>
                {creatorMsg && <div className="text-xs text-center" style={{ color: creatorMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{creatorMsg}</div>}
              </div>

              {/* Adjust ELO */}
              <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-3">
                <div className="font-bold text-white text-sm">Adjust My ELO</div>
                <div className="text-xs text-muted">Your current ELO: <span className="text-white font-mono">{profile?.elo ?? '—'}</span></div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAdjustElo(-50)}
                    disabled={eloLoading}
                    className="flex-1 py-2 rounded-xl text-sm font-bold transition-all"
                    style={eloLoading ? {
                      background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: 'not-allowed',
                    } : {
                      background: 'linear-gradient(135deg, #7f1d1d 0%, #0f172a 100%)',
                      color: '#fff', border: '1px solid rgba(239,68,68,0.4)',
                      boxShadow: '0 0 12px rgba(239,68,68,0.2)',
                    }}
                  >
                    −50 ELO
                  </button>
                  <button
                    onClick={() => handleAdjustElo(50)}
                    disabled={eloLoading}
                    className="flex-1 py-2 rounded-xl text-sm font-bold transition-all"
                    style={eloLoading ? {
                      background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: 'not-allowed',
                    } : {
                      background: 'linear-gradient(135deg, #14532d 0%, #0f172a 100%)',
                      color: '#fff', border: '1px solid rgba(34,197,94,0.4)',
                      boxShadow: '0 0 12px rgba(34,197,94,0.2)',
                    }}
                  >
                    +50 ELO
                  </button>
                </div>
                {eloMsg && <div className="text-xs text-center" style={{ color: eloMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{eloMsg}</div>}
              </div>

              {/* Set Player ELO */}
              <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-3">
                <div className="font-bold text-white text-sm">Set Player ELO</div>
                <div className="text-xs text-muted">Look up a player by username and set their ELO to an exact value.</div>
                <form onSubmit={handleSetPlayerElo} className="flex flex-col gap-2">
                  <input
                    value={setEloUsername}
                    onChange={e => setSetEloUsername(e.target.value)}
                    placeholder="Username"
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary"
                  />
                  <input
                    type="number"
                    value={setEloValue}
                    onChange={e => setSetEloValue(e.target.value)}
                    placeholder="New ELO (e.g. 1200)"
                    min="0"
                    className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    disabled={playerEloLoading || !setEloUsername.trim() || setEloValue === ''}
                    className="w-full py-2 rounded-xl text-sm font-bold transition-all"
                    style={playerEloLoading || !setEloUsername.trim() || setEloValue === '' ? {
                      background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: 'not-allowed',
                    } : {
                      background: 'linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%)',
                      color: '#fff', border: '1px solid rgba(18,80,180,0.4)',
                      boxShadow: '0 0 12px rgba(18,80,180,0.2)',
                    }}
                  >
                    {playerEloLoading ? 'Applying…' : 'Apply ELO'}
                  </button>
                </form>
                {playerEloMsg && <div className="text-xs text-center" style={{ color: playerEloMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{playerEloMsg}</div>}
              </div>

              {/* Remove Coins */}
              <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-3">
                <div className="font-bold text-white text-sm">Remove My Coins</div>
                <div className="text-xs text-muted">Current balance: <span className="text-white font-mono">{profile?.c_coins?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '0.00'} 🪙</span></div>
                <button
                  onClick={handleRemoveCoins}
                  disabled={removingCoins}
                  className="w-full py-2 rounded-xl text-sm font-bold transition-all"
                  style={removingCoins ? {
                    background: '#0f172a', color: '#334155', border: '1px solid #1e293b', cursor: 'not-allowed',
                  } : {
                    background: 'linear-gradient(135deg, #7f1d1d 0%, #1a0000 100%)',
                    color: '#fff', border: '1px solid rgba(239,68,68,0.5)',
                    boxShadow: '0 0 14px rgba(239,68,68,0.2)',
                  }}
                >
                  {removingCoins ? 'Removing…' : '🗑 Remove All Coins'}
                </button>
                {removeCoinsMsg && <div className="text-xs text-center" style={{ color: removeCoinsMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{removeCoinsMsg}</div>}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
              {['attention', 'kyc', 'support', 'transactions', 'users'].map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold capitalize transition-all ${
                    tab === t ? 'bg-primary text-white'
                      : t === 'attention' && attention.length > 0
                        ? 'text-danger border border-danger/50 hover:bg-danger/10'
                        : 'text-muted border border-border hover:border-primary hover:text-white'
                  }`}>
                  {t === 'attention'    ? `⚠ Needs Attention (${attention.length})`
                    : t === 'kyc'          ? `KYC (${kycQueue.length})`
                    : t === 'support'      ? `Support (${tickets.length})`
                    : t === 'transactions' ? `Transactions (${txs.length})`
                    : `Users (${users.length})`}
                </button>
              ))}
            </div>

            {/* KYC review queue.
                Approval is a human decision and stays one — this is the last
                check before somebody is allowed to take money off the platform. */}
            {tab === 'kyc' && (
              <div className="bg-surface border border-border rounded-2xl p-4">
                {kycQueue.length === 0 ? (
                  <p className="text-muted text-sm text-center py-8">Nothing waiting for review.</p>
                ) : (
                  <div className="space-y-3">
                    {kycQueue.map(k => (
                      <div key={k.id} className="border border-border rounded-xl p-4">
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="min-w-0">
                            <div className="text-white font-bold text-sm">
                              {k.legal_name || '(name not returned)'}
                              <span className="text-muted font-normal"> · @{k.username ?? 'unknown'}</span>
                            </div>
                            <div className="text-xs text-muted mt-1 leading-relaxed">
                              {/* Didit's own word for it. "In Review" means a
                                  reviewer THERE is looking — usually the right
                                  move is to wait, not to decide it here. */}
                              Didit says: <span className="text-white">{k.didit_status || 'no result yet'}</span><br />
                              {[k.city, k.region, k.country].filter(Boolean).join(', ') || 'no address returned'}
                            </div>
                            <div className="text-[11px] text-muted/70 mt-1.5">
                              Balance {Number(k.balance ?? 0).toFixed(2)} · submitted{' '}
                              {new Date(k.submitted_at).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              onClick={() => decideKyc(k.id, 'approved')}
                              disabled={kycBusy === k.id}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-success/15 text-success border border-success/40 hover:bg-success/25 disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => {
                                // A reason is required by the API, because the
                                // player is shown it and "rejected" alone tells
                                // them nothing they can act on.
                                const reason = window.prompt('Why is this rejected? The player sees this.');
                                if (reason && reason.trim()) decideKyc(k.id, 'rejected', reason.trim());
                              }}
                              disabled={kycBusy === k.id}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25 disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Needs-attention queue */}
            {tab === 'attention' && (
              <div className="bg-surface border border-border rounded-2xl p-4">
                {attention.length === 0 ? (
                  <p className="text-sm text-muted text-center py-8">
                    Nothing stuck — every deposit and withdrawal has settled.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {attention.map(t => (
                      <AttentionRow key={t.id} tx={t} busy={resolving === t.id}
                        onResolve={(action, amount, note) => resolveTx(t, action, amount, note)} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Support inbox */}
            {tab === 'support' && (
              <div className="bg-surface border border-border rounded-2xl p-4">
                {openTicket ? (
                  <>
                    <button onClick={() => setOpenTicket(null)}
                      className="text-xs text-muted hover:text-white mb-3">← Inbox</button>
                    <TicketThread ticket={openTicket} busy={resolving === openTicket.id}
                      onReply={replyTicket} onClose={() => closeTicket(openTicket.id)} />
                  </>
                ) : tickets.length === 0 ? (
                  <p className="text-sm text-muted text-center py-8">No open tickets.</p>
                ) : (
                  <div className="space-y-2">
                    {tickets.map(t => (
                      <button key={t.id} onClick={() => viewTicket(t.id)}
                        className="w-full text-left bg-bg border border-border rounded-xl px-3 py-2 hover:border-primary transition-all">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white truncate flex-1">{t.subject}</span>
                          {t.transaction_id && <span className="text-[9px] text-primary shrink-0">has transaction</span>}
                        </div>
                        <div className="text-[10px] text-muted mt-0.5">
                          {t.profiles?.username} · {new Date(t.updated_at).toLocaleString()}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Transactions table */}
            {tab === 'transactions' && (
              <div className="bg-surface border border-border rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-3">User</th>
                        <th className="text-left px-4 py-3">Type</th>
                        <th className="text-right px-4 py-3">Amount</th>
                        <th className="text-left px-4 py-3">Status</th>
                        <th className="text-left px-4 py-3">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txs.map(tx => {
                        const meta = TYPE_LABELS[tx.type] || { label: tx.type, color: 'text-muted' };
                        return (
                          <tr key={tx.id} className="border-b border-border/50 last:border-0 hover:bg-surfaceLight/30 transition-colors">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black shrink-0"
                                  style={{
                                    backgroundColor: `${tx.profiles?.profile_color || '#1250B4'}22`,
                                    border: `1.5px solid ${tx.profiles?.profile_color || '#1250B4'}`,
                                    color: tx.profiles?.profile_color || '#1250B4',
                                  }}>
                                  {tx.profiles?.avatar_url
                                    ? <img src={tx.profiles.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                                    : (tx.profiles?.username?.[0]?.toUpperCase() ?? '?')}
                                </div>
                                <span className="text-white font-medium">{tx.profiles?.username ?? 'Unknown'}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`font-semibold ${meta.color}`}>{meta.label}</span>
                            </td>
                            <td className="px-4 py-3 text-right font-mono font-bold text-white">
                              {fmt(tx.amount_c)} 🪙
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                                tx.status === 'confirmed' ? 'bg-success/10 text-success border-success/30' :
                                tx.status === 'pending'   ? 'bg-warning/10 text-warning border-warning/30' :
                                'bg-danger/10 text-danger border-danger/30'
                              }`}>
                                {tx.status ?? 'confirmed'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-muted text-xs">{fmtDate(tx.created_at)}</td>
                          </tr>
                        );
                      })}
                      {txs.length === 0 && (
                        <tr><td colSpan={5} className="text-center text-muted py-10">No transactions yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Users table */}
            {tab === 'users' && (
              <div className="bg-surface border border-border rounded-2xl overflow-hidden">
                <div className="p-4 border-b border-border">
                  <input
                    value={userSearch}
                    onChange={e => searchUsers(e.target.value)}
                    placeholder="Search by username..."
                    className="w-full sm:w-72 bg-bg border border-border rounded-xl px-3 py-2 text-white text-sm placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-3">User</th>
                        <th className="text-right px-4 py-3">ELO</th>
                        <th className="text-right px-4 py-3">W / L</th>
                        <th className="text-right px-4 py-3">Coins</th>
                        <th className="text-right px-4 py-3">Diamonds</th>
                        <th className="text-left px-4 py-3">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map(u => (
                        <tr
                          key={u.id}
                          onClick={() => openPlayer(u.id)}
                          className="border-b border-border/50 last:border-0 hover:bg-surfaceLight/30 transition-colors cursor-pointer"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shrink-0"
                                style={{
                                  backgroundColor: `${u.profile_color || '#1250B4'}22`,
                                  border: `1.5px solid ${u.profile_color || '#1250B4'}`,
                                  color: u.profile_color || '#1250B4',
                                }}>
                                {u.avatar_url
                                  ? <img src={u.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                                  : u.username?.[0]?.toUpperCase()}
                              </div>
                              <span className="text-white font-medium">{u.username}</span>
                              {u.banned && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-danger/15 text-danger border border-danger/40">
                                  BANNED
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-accent font-bold">{u.elo}</td>
                          <td className="px-4 py-3 text-right">
                            <span className="text-success font-bold">{u.wins}</span>
                            <span className="text-muted"> / </span>
                            <span className="text-danger font-bold">{u.losses}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-white font-bold">{fmt(u.c_coins)}</td>
                          <td className="px-4 py-3 text-right font-mono text-white">{(u.diamonds ?? 0).toLocaleString()}</td>
                          <td className="px-4 py-3 text-muted text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                      {users.length === 0 && (
                        <tr><td colSpan={6} className="text-center text-muted py-10">No users found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Player detail panel ─────────────────────────────────────────── */}
      {selectedUserId && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
          onClick={closePlayer}
        >
          <div
            className="w-full max-w-2xl bg-surface border border-border rounded-2xl p-5 my-8"
            onClick={(e) => e.stopPropagation()}
          >
            {playerLoading && <p className="text-muted text-sm py-8 text-center">Loading…</p>}

            {!playerLoading && playerDetail && (() => {
              const p = playerDetail.profile;
              return (
                <>
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-full overflow-hidden flex items-center justify-center text-lg font-black shrink-0"
                        style={{
                          backgroundColor: `${p.profile_color || '#1250B4'}22`,
                          border: `2px solid ${p.profile_color || '#1250B4'}`,
                          color: p.profile_color || '#1250B4',
                        }}>
                        {p.avatar_url
                          ? <img src={p.avatar_url} alt="" className="w-full h-full object-cover" />
                          : p.username?.[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-black text-lg">{p.username}</span>
                          {p.banned && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-danger/15 text-danger border border-danger/40">BANNED</span>
                          )}
                        </div>
                        <div className="text-xs text-muted">
                          Joined {new Date(p.created_at).toLocaleDateString()} · KYC {p.kyc_status ?? 'unverified'}
                          {!p.email_confirmed_at && <span className="text-warning"> · email unverified</span>}
                        </div>
                      </div>
                    </div>
                    <button onClick={closePlayer} aria-label="Close"
                      className="shrink-0 w-8 h-8 rounded-lg text-muted hover:text-white hover:bg-surfaceLight text-lg font-bold flex items-center justify-center transition-all">
                      ✕
                    </button>
                  </div>

                  {/* Quick stats */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    {[
                      ['ELO', p.elo],
                      ['W / L', `${p.wins} / ${p.losses}`],
                      ['Coins', fmt(p.c_coins)],
                      ['Diamonds', (p.diamonds ?? 0).toLocaleString()],
                    ].map(([label, value]) => (
                      <div key={label} className="bg-bg border border-border rounded-xl p-3 text-center">
                        <div className="text-lg font-black text-white font-mono">{value}</div>
                        <div className="text-[10px] text-muted mt-0.5 uppercase tracking-wide">{label}</div>
                      </div>
                    ))}
                  </div>

                  {panelMsg && <p className="text-xs text-danger mb-3">{panelMsg}</p>}

                  {/* Ban / unban */}
                  <div className="bg-bg border border-border rounded-xl p-4 mb-4">
                    {p.banned ? (
                      <>
                        <p className="text-xs text-muted mb-2">
                          Banned {p.banned_at ? new Date(p.banned_at).toLocaleString() : ''} — {p.ban_reason}
                        </p>
                        <button onClick={unbanPlayer} disabled={banBusy}
                          className="px-4 py-2 text-sm font-bold rounded-xl border border-success text-success hover:bg-success hover:text-white transition-all disabled:opacity-50">
                          {banBusy ? 'Working…' : 'Unban player'}
                        </button>
                      </>
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          value={banReason}
                          onChange={e => setBanReason(e.target.value)}
                          placeholder="Reason — the player sees this"
                          className="flex-1 bg-surface border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-danger"
                        />
                        <button onClick={banPlayer} disabled={banBusy || !banReason.trim()}
                          className="px-4 py-2 text-sm font-bold rounded-xl border border-danger text-danger hover:bg-danger hover:text-white transition-all disabled:opacity-50 whitespace-nowrap">
                          {banBusy ? 'Working…' : 'Ban player'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Profile picture moderation */}
                  <div className="bg-bg border border-border rounded-xl p-4 mb-4">
                    <p className="text-xs text-muted mb-2">Profile picture</p>
                    {p.avatar_banned && (
                      <p className="text-xs text-warning mb-2">
                        Upload privileges revoked - this player cannot set a new picture.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => removeAvatar(true)}
                        disabled={avatarBusy || (!p.avatar_url && p.avatar_banned)}
                        className="px-3 py-2 text-xs font-bold rounded-lg bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25 disabled:opacity-40"
                      >
                        Remove picture + block uploads
                      </button>
                      <button
                        onClick={() => removeAvatar(false)}
                        disabled={avatarBusy || !p.avatar_url}
                        className="px-3 py-2 text-xs font-bold rounded-lg text-muted border border-border hover:text-white disabled:opacity-40"
                      >
                        Remove only
                      </button>
                      {p.avatar_banned && (
                        <button
                          onClick={restoreAvatar}
                          disabled={avatarBusy}
                          className="px-3 py-2 text-xs font-bold rounded-lg bg-success/15 text-success border border-success/40 hover:bg-success/25 disabled:opacity-40"
                        >
                          Allow uploads again
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Reports against this player */}
                  <div className="bg-bg border border-border rounded-xl p-4 mb-4">
                    <p className="text-xs text-muted mb-2">
                      Reports ({playerReports.length})
                      {playerReports.some(r => r.status === 'open') && (
                        <span className="ml-2 text-danger font-bold">
                          {playerReports.filter(r => r.status === 'open').length} open
                        </span>
                      )}
                    </p>
                    {playerReports.length === 0 ? (
                      <p className="text-xs text-muted/70">No reports.</p>
                    ) : (
                      <div className="space-y-2 max-h-56 overflow-y-auto">
                        {playerReports.map(r => (
                          <div key={r.id} className="border border-border rounded-lg px-3 py-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${
                                r.status === 'open' ? 'text-danger border-danger/50 bg-danger/10'
                                  : r.status === 'actioned' ? 'text-success border-success/40 bg-success/10'
                                  : 'text-muted border-border'
                              }`}>
                                {r.status}
                              </span>
                              <span className="text-xs font-bold text-white">
                                {r.reason === 'pfp' ? 'Profile picture' : r.reason === 'cheating' ? 'Cheating' : 'Other'}
                              </span>
                              <span className="text-[11px] text-muted">
                                by {r.reporter?.username ?? 'unknown'} · {fmtDate(r.created_at)}
                              </span>
                              {r.status === 'open' && (
                                <span className="ml-auto flex gap-1">
                                  <button onClick={() => decideReport(r.id, 'actioned')}
                                    className="text-[11px] px-2 py-1 rounded border border-success/40 text-success hover:bg-success/10">
                                    Actioned
                                  </button>
                                  <button onClick={() => decideReport(r.id, 'dismissed')}
                                    className="text-[11px] px-2 py-1 rounded border border-border text-muted hover:text-white">
                                    Dismiss
                                  </button>
                                </span>
                              )}
                            </div>
                            {r.details && <p className="text-[11px] text-muted mt-1 break-words">{r.details}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Manual balance adjustment */}
                  <div className="bg-bg border border-border rounded-xl p-4 mb-4">
                    <p className="text-xs text-muted mb-2">Adjust coin balance — refunds and corrections only. Positive credits, negative debits.</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        value={adjustAmount}
                        onChange={e => setAdjustAmount(e.target.value)}
                        placeholder="Amount, e.g. 10 or -10"
                        inputMode="decimal"
                        className="sm:w-40 bg-surface border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary"
                      />
                      <input
                        value={adjustNote}
                        onChange={e => setAdjustNote(e.target.value)}
                        placeholder="Note — required, kept on the transaction"
                        className="flex-1 bg-surface border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary"
                      />
                      <button onClick={adjustPlayerBalance} disabled={adjustBusy || !adjustAmount || !adjustNote.trim()}
                        className="px-4 py-2 text-sm font-bold rounded-xl bg-primary text-white hover:bg-blue-500 transition-all disabled:opacity-50 whitespace-nowrap">
                        {adjustBusy ? 'Working…' : 'Apply'}
                      </button>
                    </div>
                  </div>

                  {/* Recent matches */}
                  <div className="mb-4">
                    <h3 className="text-white font-bold text-sm mb-2">Recent matches</h3>
                    <div className="max-h-52 overflow-y-auto border border-border rounded-xl divide-y divide-border">
                      {playerDetail.matches.length === 0 && (
                        <p className="text-xs text-muted text-center py-4">No matches yet</p>
                      )}
                      {playerDetail.matches.map(m => (
                        <div key={m.id} className="px-3 py-2 flex items-center justify-between text-xs">
                          <span className="text-white">
                            {m.game_type} <span className="text-muted">vs {m.opponent}</span>
                          </span>
                          <span className={m.won ? 'text-success font-bold' : 'text-danger font-bold'}>
                            {m.won ? 'WIN' : 'LOSS'}
                          </span>
                          <span className="text-muted">{new Date(m.played_at).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Deposits and withdrawals, side by side.
                      Split out of the combined list below because these are
                      the two that matter when you are looking at a player for
                      a reason — real money in, real money out — and scanning
                      for them among match wins and daily bonuses is exactly
                      the work this panel should be doing for you.

                      Both totals count CONFIRMED rows only. A failed or
                      pending withdrawal has not left the platform, and
                      including it would overstate what this player has
                      actually taken out. */}
                  {(() => {
                    const deposits = playerDetail.transactions.filter(t => t.type === 'deposit');
                    const withdrawals = playerDetail.transactions.filter(t => t.type === 'withdrawal');
                    const sum = (rows) => rows
                      .filter(t => t.status === 'confirmed')
                      .reduce((a, t) => a + Math.abs(Number(t.amount_c) || 0), 0);

                    const Column = ({ title, rows, total, tone }) => (
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between mb-1.5 gap-2">
                          <h3 className="text-white font-bold text-sm">{title}</h3>
                          <span className={`text-xs font-black ${tone}`}>
                            {fmt(total)}
                          </span>
                        </div>
                        <div className="max-h-40 overflow-y-auto border border-border rounded-xl divide-y divide-border">
                          {rows.length === 0 ? (
                            <p className="text-xs text-muted text-center py-3">None</p>
                          ) : rows.map(t => (
                            <div key={t.id} className="px-2.5 py-1.5 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className={`font-bold shrink-0 ${tone}`}>{fmt(t.amount_c)}</span>
                                <span className="text-muted shrink-0">{t.crypto_symbol || ''}</span>
                                <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border ${
                                  t.status === 'confirmed' ? 'text-success border-success/40'
                                    : t.status === 'pending' || t.status === 'converting' || t.status === 'sending'
                                      ? 'text-warning border-warning/40'
                                      : 'text-danger border-danger/40'
                                }`}>
                                  {t.status}
                                </span>
                              </div>
                              <div className="text-[10px] text-muted mt-0.5">{fmtDate(t.created_at)}</div>
                              {t.notes && <div className="text-[10px] text-danger/80 break-all mt-0.5">{t.notes}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div className="flex flex-col sm:flex-row gap-4 mb-4">
                        <Column title="Deposits"    rows={deposits}    total={sum(deposits)}    tone="text-success" />
                        <Column title="Withdrawals" rows={withdrawals} total={sum(withdrawals)} tone="text-danger" />
                      </div>
                    );
                  })()}

                  {/* Recent transactions */}
                  <div>
                    <h3 className="text-white font-bold text-sm mb-2">Everything else</h3>
                    <div className="max-h-52 overflow-y-auto border border-border rounded-xl divide-y divide-border">
                      {playerDetail.transactions.filter(t => t.type !== 'deposit' && t.type !== 'withdrawal').length === 0 && (
                        <p className="text-xs text-muted text-center py-4">Nothing else</p>
                      )}
                      {playerDetail.transactions.filter(t => t.type !== 'deposit' && t.type !== 'withdrawal').map(t => (
                        <div key={t.id} className="px-3 py-2 flex items-center justify-between text-xs gap-2">
                          <span className="text-white capitalize shrink-0">{t.type.replace(/_/g, ' ')}</span>
                          <span className="text-muted truncate">{t.notes}</span>
                          <span className={Number(t.amount_c) >= 0 ? 'text-success font-bold shrink-0' : 'text-danger font-bold shrink-0'}>
                            {Number(t.amount_c) >= 0 ? '+' : ''}{fmt(t.amount_c)}
                          </span>
                          <span className="text-muted shrink-0">{t.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}


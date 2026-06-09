import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { usePageReady } from '../hooks/usePageReady';

const ADMIN_ID = '423d2b0c-1dae-4947-8340-b07575954383';

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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

export default function Admin() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats]           = useState(null);
  const [txs, setTxs]               = useState([]);
  const [users, setUsers]           = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [tab, setTab]               = useState('overview');
  const [loading, setLoading]       = useState(true);

  const [addingDiamonds, setAddingDiamonds]   = useState(false);
  const [diamondMsg, setDiamondMsg]           = useState('');
  const [removingCoins, setRemovingCoins]     = useState(false);
  const [removeCoinsMsg, setRemoveCoinsMsg]   = useState('');
  const [eloMsg, setEloMsg]                 = useState('');
  const [eloLoading, setEloLoading]         = useState(false);
  const [creatorUsername, setCreatorUsername] = useState('');
  const [creatorCode, setCreatorCode]         = useState('');
  const [creatorLoading, setCreatorLoading]   = useState(false);
  const [creatorMsg, setCreatorMsg]           = useState('');

  useEffect(() => {
    if (!profile) return;
    if (profile.id !== ADMIN_ID) { navigate('/'); return; }
    load();
  }, [profile]);

  async function load() {
    setLoading(true);
    try {
      const [s, t, u] = await Promise.all([
        api.get('/admin/stats'),
        api.get('/admin/transactions?limit=100'),
        api.get('/admin/users?limit=100'),
      ]);
      setStats(s);
      setTxs(t);
      setUsers(u);
    } catch (e) {
      console.error('Admin load error:', e.message);
    } finally {
      setLoading(false);
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

  if (!profile || profile.id !== ADMIN_ID) return null;

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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
              <StatCard label="Fees Collected"   value={`${fmt(stats?.fees_coins)} 🪙`}               sub={`${(stats?.fees_diamonds ?? 0).toLocaleString()} 💎`} color="text-success" />
              <StatCard label="Total Wagered"    value={`${fmt(stats?.total_wagered)} 🪙`}            color="text-white" />
              <StatCard label="Platform Fee Rate" value="5%"                                           sub="on coin matches" color="text-muted" />
            </div>

            {/* Admin Tools */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
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
              {['transactions', 'users'].map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold capitalize transition-all ${
                    tab === t ? 'bg-primary text-white' : 'text-muted border border-border hover:border-primary hover:text-white'
                  }`}>
                  {t === 'transactions' ? `Transactions (${txs.length})` : `Users (${users.length})`}
                </button>
              ))}
            </div>

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
                                    backgroundColor: `${tx.profiles?.profile_color || '#1E90FF'}22`,
                                    border: `1.5px solid ${tx.profiles?.profile_color || '#1E90FF'}`,
                                    color: tx.profiles?.profile_color || '#1E90FF',
                                  }}>
                                  {tx.profiles?.username?.[0]?.toUpperCase() ?? '?'}
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
                        <tr key={u.id} className="border-b border-border/50 last:border-0 hover:bg-surfaceLight/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shrink-0"
                                style={{
                                  backgroundColor: `${u.profile_color || '#1E90FF'}22`,
                                  border: `1.5px solid ${u.profile_color || '#1E90FF'}`,
                                  color: u.profile_color || '#1E90FF',
                                }}>
                                {u.username?.[0]?.toUpperCase()}
                              </div>
                              <span className="text-white font-medium">{u.username}</span>
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
    </div>
  );
}


import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { getRank } from '../utils/ranks';
import CoinIcon from '../components/CoinIcon';
import { usePageReady } from '../hooks/usePageReady';

function RankBadge({ rank }) {
  if (rank === 1) return <span className="text-yellow-400 font-black">🥇</span>;
  if (rank === 2) return <span className="text-gray-300 font-black">🥈</span>;
  if (rank === 3) return <span className="text-amber-600 font-black">🥉</span>;
  return <span className="text-muted font-mono text-sm">#{rank}</span>;
}

const TABS = [
  { id: 'elo',             label: 'ELO',             icon: '⚔️', endpoint: '/leaderboard',                 valueKey: 'elo',           isDiamond: false, label2: 'ELO' },
  { id: 'wagered',         label: 'Wagered',          icon: 'coin', endpoint: '/leaderboard/wagered',       valueKey: 'total_wagered', isDiamond: false, label2: 'Wagered' },
  { id: 'wagered-diamonds',label: '💎 Wagered',       icon: '',   endpoint: '/leaderboard/wagered-diamonds',valueKey: 'total_wagered', isDiamond: true,  label2: 'Wagered' },
  { id: 'games',           label: 'Games',           icon: '🎮', endpoint: null,                           valueKey: null,            isDiamond: false, label2: 'Score' },
  { id: 'streak',          label: '🔥 Streaks',       icon: '',   endpoint: '/leaderboard/streak',          valueKey: 'current_streak',isDiamond: false, label2: 'Streak' },
];

const GAME_LEADERBOARDS = [
  { id: 'blockBlast',    label: 'Block Burst',  icon: '🟦', scoreLabel: 'Score' },
  { id: 'carDash',       label: 'Rush Hour',    icon: '🚗', scoreLabel: 'Score', showTime: true },
  { id: 'tower',         label: 'Tower',        icon: '🧊', scoreLabel: 'Blocks' },
  { id: 'scrabble',      label: 'Word VS',      icon: '🔤', scoreLabel: 'Wins'  },
  { id: 'coinFlip',      label: 'Coin Flip',    icon: '🟡', scoreLabel: 'Wins'  },
  { id: 'blackjack',     label: 'Blackjack',    icon: '🃏', scoreLabel: 'Wins'  },
];

function getNextMonday() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntilMonday);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

function formatMs(ms) {
  if (ms <= 0) return '0d 0h 0m';
  const totalSeconds = Math.floor(ms / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

export default function Leaderboard() {
  const ready = usePageReady();
  const { profile, session } = useAuth();
  const [activeTab, setActiveTab] = useState('elo');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);
  const [gameData, setGameData] = useState({});
  const [gameLoading, setGameLoading] = useState(false);
  const [resetMs, setResetMs] = useState(() => getNextMonday() - Date.now());

  const tab = TABS.find(t => t.id === activeTab);

  useEffect(() => {
    if (activeTab === 'games') return;
    setLoading(true);
    const userId = profile?.id || '';
    api.get(`${tab.endpoint}?userId=${userId}`)
      .then(res => setData(d => ({ ...d, [activeTab]: res })))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeTab, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedGame) return;
    if (gameData[selectedGame]) return;
    setGameLoading(true);
    const userId = profile?.id || '';
    api.get(`/leaderboard/game/${selectedGame}?userId=${userId}`)
      .then(res => setGameData(d => ({ ...d, [selectedGame]: res })))
      .catch(() => {})
      .finally(() => setGameLoading(false));
  }, [selectedGame, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const interval = setInterval(() => {
      setResetMs(getNextMonday() - Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const current = data[activeTab];
  const allPlayers = current?.players ?? [];
  // Hide players with no activity: for ELO, require at least 1 win; for others, require value > 0
  // Re-number rank sequentially after filtering — the backend's `rank` field reflects
  // position in the unfiltered list, so displaying it as-is leaves gaps wherever a
  // hidden (inactive) player sat between two visible ones.
  const players = allPlayers
    .filter(p => {
      if (tab?.id === 'elo') return (p.wins ?? 0) > 0;
      if (tab?.id === 'streak') return (p.current_streak ?? 0) > 0;
      return (p[tab?.valueKey ?? ''] ?? 0) > 0;
    })
    .map((p, i) => ({ ...p, rank: i + 1 }));
  const userRank = current?.userRank ?? null;
  const myEntry = players.find(p => p.id === profile?.id);

  function fmtValue(player) {
    const v = player[tab.valueKey] ?? 0;
    if (tab.id === 'elo') return `${getRank(v).icon} ${v} ELO`;
    if (tab.id === 'streak') return player.current_streak >= 1 ? `🔥 ${player.current_streak}` : `0 wins`;
    if (tab.isDiamond) return `💎 ${Number(v).toLocaleString()}`;
    return <span className="inline-flex items-center gap-1"><CoinIcon size="0.85em" /> {Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
  }

  // Get user's own value from profile for rank banner (works even outside top 500)
  function fmtMyValue() {
    if (!profile) return '';
    if (tab.id === 'elo') return `${getRank(profile.elo ?? 0).icon} ${profile.elo ?? 0} ELO`;
    if (tab.id === 'wagered' || tab.id === 'wagered-diamonds') {
      const myEntry = players.find(p => p.id === profile.id);
      const w = myEntry?.total_wagered ?? current?.userWagered ?? 0;
      if (tab.isDiamond) return `💎 ${Number(w).toLocaleString()}`;
      return <span className="inline-flex items-center gap-1"><CoinIcon size="0.85em" />{Number(w).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
    }
    if (tab.id === 'streak') return `🔥 ${profile?.current_streak ?? 0}`;
    return '';
  }

  // Games tab content
  const gameMeta = selectedGame ? GAME_LEADERBOARDS.find(g => g.id === selectedGame) : null;
  const currentGameData = selectedGame ? gameData[selectedGame] : null;
  const gamePlayers = (currentGameData?.players ?? []).filter(p => (p.score ?? 0) > 0);
  const gameUserRank = currentGameData?.userRank ?? null;
  const myGameEntry = gamePlayers.find(p => p.id === profile?.id);

  // Leaderboard is public — viewable without logging in (top players load with
  // no userId; the "your rank" highlight just won't show until you're signed in).

  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="mb-6 text-center">
          <h1 className="text-4xl font-black text-white mb-2">Leaderboard</h1>
          <p className="text-muted">Top 500 players</p>
          <p className="text-xs text-muted mt-1">
            Resets Monday · {formatMs(resetMs)} remaining
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 bg-surface border border-surfaceLight rounded-2xl p-1.5">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => { setActiveTab(t.id); if (t.id !== 'games') setSelectedGame(null); }}
              className={`flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl text-[10px] sm:text-sm font-bold transition-all whitespace-nowrap ${
                activeTab === t.id
                  ? 'bg-primary text-white shadow-glow'
                  : 'text-muted hover:text-white'
              }`}
            >
              {t.icon === 'coin' ? <CoinIcon size="0.9em" /> : t.icon ? <span>{t.icon}</span> : null}
              <span>{t.icon ? t.label2 || t.label : t.label}</span>
            </button>
          ))}
        </div>

        {activeTab === 'games' ? (
          /* ── Games Tab ── */
          <div>
            {!selectedGame ? (
              /* Game picker grid */
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {GAME_LEADERBOARDS.map(g => (
                  <button
                    key={g.id}
                    onClick={() => setSelectedGame(g.id)}
                    className="bg-surface border border-surfaceLight hover:border-primary rounded-2xl p-5 text-center transition-all hover:bg-surfaceLight/30 group"
                  >
                    <div className="text-3xl mb-2">{g.icon}</div>
                    <div className="text-sm font-bold text-white group-hover:text-primary transition-colors">{g.label}</div>
                    <div className="text-xs text-muted mt-0.5">{g.scoreLabel}</div>
                  </button>
                ))}
              </div>
            ) : (
              /* Game leaderboard */
              <div>
                <button
                  onClick={() => setSelectedGame(null)}
                  className="mb-4 flex items-center gap-2 text-sm text-muted hover:text-white transition-colors"
                >
                  ← Back to games
                </button>

                <div className="flex items-center gap-3 mb-4">
                  <span className="text-2xl">{gameMeta?.icon}</span>
                  <h2 className="text-xl font-black text-white">{gameMeta?.label} Leaderboard</h2>
                </div>

                {/* User rank banner */}
                {profile && (
                  <div className="mb-4 bg-primary/10 border border-primary/30 rounded-xl px-4 py-3 flex items-center justify-between">
                    <div className="text-sm text-primary font-semibold">Your Rank</div>
                    <div className="text-sm font-bold text-white flex items-center gap-2">
                      {gameUserRank != null ? `#${gameUserRank.rank}` : (gameLoading ? '...' : 'Unranked')}
                      {gameUserRank != null && (
                        <span className="text-muted text-xs">
                          ({Number(myGameEntry?.score ?? gameUserRank.score ?? 0).toLocaleString()} {gameMeta?.scoreLabel})
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {gameLoading ? (
                  <div className="flex justify-center py-20">
                    <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <div className="bg-surface border border-surfaceLight rounded-2xl overflow-hidden">
                    <div className="grid grid-cols-10 px-3 sm:px-5 py-3 text-xs text-muted font-semibold uppercase tracking-wider border-b border-surfaceLight">
                      <span className="col-span-1">Rank</span>
                      <span className={gameMeta?.showTime ? 'col-span-4' : 'col-span-6'}>Player</span>
                      {gameMeta?.showTime && <span className="col-span-2 text-right">Time</span>}
                      <span className="col-span-3 text-right">{gameMeta?.scoreLabel}</span>
                    </div>

                    {gamePlayers.map((player, i) => {
                      const isMe = profile?.id === player.id;
                      return (
                        <div
                          key={player.id}
                          className={`
                            grid grid-cols-10 px-3 sm:px-5 py-3 sm:py-4 items-center border-b border-surfaceLight/50 transition-colors
                            ${isMe ? 'bg-primary/10 border-l-2 border-l-primary' : 'hover:bg-surfaceLight/30'}
                            ${i === 0 ? 'bg-yellow-500/5' : ''}
                          `}
                        >
                          <span className="col-span-1 flex items-center">
                            <RankBadge rank={player.rank} />
                          </span>
                          <span className={`${gameMeta?.showTime ? 'col-span-4' : 'col-span-6'} flex items-center gap-1.5 sm:gap-2 min-w-0`}>
                            <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                              {player.username?.[0]?.toUpperCase()}
                            </div>
                            <span className={`font-semibold truncate text-sm sm:text-base ${isMe ? 'text-primary' : 'text-white'}`}>
                              {player.username}
                              {isMe && <span className="ml-1 text-xs text-muted hidden sm:inline">(you)</span>}
                            </span>
                            {(player.current_streak ?? 0) >= 2 && (
                              <span className="text-xs font-bold shrink-0" style={{ color: '#fb923c', textShadow: '0 0 5px rgba(251,146,60,0.5)' }}>
                                🔥{player.current_streak}
                              </span>
                            )}
                          </span>
                          {gameMeta?.showTime && (
                            <span className="col-span-2 text-right font-mono text-xs sm:text-sm text-muted">
                              {player.ms != null ? (player.ms / 1000).toFixed(1) + 's' : '—'}
                            </span>
                          )}
                          <span className="col-span-3 text-right font-mono font-bold text-sm text-accent">
                            {Number(player.score).toLocaleString()}
                          </span>
                        </div>
                      );
                    })}

                    {gamePlayers.length === 0 && (
                      <div className="text-center py-12 text-muted">No scores yet</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* ── Standard ELO/Diamonds/Coins tabs ── */
          <>
            {/* User's rank banner */}
            {profile && (
              <div className="mb-4 bg-primary/10 border border-primary/30 rounded-xl px-4 py-3 flex items-center justify-between">
                <div className="text-sm text-primary font-semibold">Your Rank</div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  {userRank != null ? `#${userRank}` : (loading ? '...' : '—')}
                  <span className="text-muted text-xs">({fmtMyValue()})</span>
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-20">
                <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="bg-surface border border-surfaceLight rounded-2xl overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-10 px-3 sm:px-5 py-3 text-xs text-muted font-semibold uppercase tracking-wider border-b border-surfaceLight">
                  <span className="col-span-1">Rank</span>
                  <span className="col-span-5 sm:col-span-5">Player</span>
                  <span className="col-span-3 sm:col-span-3 text-right">{tab.label2}</span>
                  <span className="col-span-1 text-right hidden sm:block">W%</span>
                </div>

                {players.map((player, i) => {
                  const winRate = player.wins + player.losses > 0
                    ? ((player.wins / (player.wins + player.losses)) * 100).toFixed(0)
                    : 0;
                  const isMe = profile?.id === player.id;

                  return (
                    <div
                      key={player.id}
                      className={`
                        grid grid-cols-10 px-3 sm:px-5 py-3 sm:py-4 items-center border-b border-surfaceLight/50 transition-colors
                        ${isMe ? 'bg-primary/10 border-l-2 border-l-primary' : 'hover:bg-surfaceLight/30'}
                        ${i === 0 ? 'bg-yellow-500/5' : ''}
                      `}
                    >
                      <span className="col-span-1 flex items-center">
                        <RankBadge rank={player.rank} />
                      </span>

                      <span className="col-span-5 flex items-center gap-1.5 sm:gap-2 min-w-0">
                        <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                          {player.username?.[0]?.toUpperCase()}
                        </div>
                        <span className={`font-semibold truncate text-sm sm:text-base ${isMe ? 'text-primary' : 'text-white'}`}>
                          {player.username}
                          {isMe && <span className="ml-1 text-xs text-muted hidden sm:inline">(you)</span>}
                        </span>
                        {(player.current_streak ?? 0) >= 2 && (
                          <span className="text-xs font-bold shrink-0" style={{ color: '#fb923c', textShadow: '0 0 5px rgba(251,146,60,0.5)' }}>
                            🔥{player.current_streak}
                          </span>
                        )}
                      </span>

                      <span className={`col-span-3 text-right font-mono font-bold text-sm ${
                        tab.id === 'elo' ? '' : tab.isDiamond ? 'text-cyan-300' : 'text-yellow-300'
                      }`} style={tab.id === 'elo' ? { color: getRank(player.elo).color } : {}}>
                        {fmtValue(player)}
                      </span>

                      <span className="col-span-1 text-right text-muted text-xs hidden sm:block">{winRate}%</span>
                    </div>
                  );
                })}

                {players.length === 0 && (
                  <div className="text-center py-12 text-muted">No players yet</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


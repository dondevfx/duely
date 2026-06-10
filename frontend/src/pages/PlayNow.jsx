import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { usePageReady } from '../hooks/usePageReady';
import { getRank } from '../utils/ranks';
import CoinIcon from '../components/CoinIcon';

const T_ROWS = 20, T_COLS = 10;

function MiniTetrisBoard({ board, username, color }) {
  const cell = 7;
  const empty = Array.from({ length: T_ROWS }, () => Array(T_COLS).fill(0));
  const b = board || empty;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="text-xs font-black truncate max-w-[70px]" style={{ color: color || '#1E90FF' }}>{username}</div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${T_COLS}, ${cell}px)`,
        gap: '0.5px',
        background: '#060b14',
        padding: 3,
        borderRadius: 4,
        border: `1px solid ${color || '#1E90FF'}44`,
        boxShadow: board ? `0 0 12px ${color || '#1E90FF'}22` : 'none',
      }}>
        {b.map((row, r) => row.map((c, col) => (
          <div key={`${r}-${col}`} style={{
            width: cell, height: cell,
            background: c || '#0a0f1a',
            boxShadow: c ? `0 0 3px ${c}99` : 'none',
          }} />
        )))}
      </div>
      {!board && <div className="text-[10px] text-muted animate-pulse">Waiting…</div>}
    </div>
  );
}

const GAME_LABELS = {
  tetris:        '🟩 Block Fall',
  'block-blast': '🟦 Block Burst',
  chess:         '♟ Chess',
  c4:            '🔴 Drop Zone',
  piano:         '🎹 Tile Tap',
  type:          '⌨️ Type Race',
};

const GAME_ROUTES = {
  tetris:        '/game/tetris',
  'block-blast': '/game/block-blast',
  chess:         '/game/chess',
  c4:            '/game/c4',
  piano:         '/game/piano',
  type:          '/game/type',
};

function SpectatorModal({ game, onClose }) {
  const { socket, activeGames } = useSocket();
  const live = activeGames.find(g => g.id === game.id) || game;
  const color1 = live.player1?.profileColor || '#1E90FF';
  const color2 = live.player2?.profileColor || '#ef4444';
  const sym = live.currency === 'diamonds' ? '💎' : <CoinIcon size="0.85em" />;
  const isTetris = live.gameType === 'tetris';

  const [board0, setBoard0] = useState(null);
  const [board1, setBoard1] = useState(null);

  useEffect(() => {
    if (!socket || !game.id) return;
    socket.emit('join_spectator', { roomId: game.id });
    const onBoard = ({ playerIdx, board }) => {
      if (playerIdx === 0) setBoard0(board);
      else if (playerIdx === 1) setBoard1(board);
    };
    socket.on('tetris_spectator_board', onBoard);
    return () => {
      socket.emit('leave_spectator', { roomId: game.id });
      socket.off('tetris_spectator_board', onBoard);
    };
  }, [socket, game.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-surfaceLight rounded-2xl p-6 w-full mx-4 shadow-2xl"
        style={{ maxWidth: isTetris ? 480 : 380, borderColor: 'rgba(239,68,68,0.3)', boxShadow: '0 0 40px rgba(239,68,68,0.12)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-sm font-black text-red-400 uppercase tracking-widest">Live</span>
            <span className="text-sm text-muted ml-1">{GAME_LABELS[live.gameType] || live.gameType}</span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white text-xl leading-none transition-colors">✕</button>
        </div>

        {/* Bet */}
        {live.entryFee > 0 && (
          <div className="text-center mb-4">
            <span className="px-3 py-1 rounded-full text-sm font-black" style={{ background: 'rgba(255,215,0,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
              {live.entryFee} {sym} each · {live.currency === 'diamonds' ? (live.entryFee * 2).toLocaleString() : (live.entryFee * 2 * 0.95).toFixed(2)} {sym} prize
            </span>
          </div>
        )}

        {isTetris ? (
          /* Tetris: render both boards side by side */
          <div className="flex items-start justify-center gap-6">
            <MiniTetrisBoard board={board0} username={live.player1?.username} color={color1} />
            <div className="flex flex-col items-center gap-3 pt-6 shrink-0">
              <div className="text-sm font-black text-muted">VS</div>
              <div className="text-center space-y-1">
                <div className="text-xs text-muted">Score</div>
                <div className="text-lg font-black font-mono" style={{ color: color1 }}>{(live.score1 || 0).toLocaleString()}</div>
                <div className="text-xs text-muted">—</div>
                <div className="text-lg font-black font-mono" style={{ color: color2 }}>{(live.score2 || 0).toLocaleString()}</div>
              </div>
            </div>
            <MiniTetrisBoard board={board1} username={live.player2?.username} color={color2} />
          </div>
        ) : (
          /* Other games: player avatars + live scores */
          <>
            <div className="flex items-center gap-4 mb-4">
              <div className="flex-1 text-center">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-black mx-auto mb-1"
                  style={{ backgroundColor: `${color1}22`, border: `2px solid ${color1}`, color: color1 }}>
                  {(live.player1?.username || '?')[0].toUpperCase()}
                </div>
                <div className="text-xs font-black text-white truncate">{live.player1?.username}</div>
                <div className="text-[10px] text-muted">{live.player1?.elo} ELO</div>
              </div>
              <div className="text-base font-black text-muted">VS</div>
              <div className="flex-1 text-center">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-black mx-auto mb-1"
                  style={{ backgroundColor: `${color2}22`, border: `2px solid ${color2}`, color: color2 }}>
                  {(live.player2?.username || '?')[0].toUpperCase()}
                </div>
                <div className="text-xs font-black text-white truncate">{live.player2?.username}</div>
                <div className="text-[10px] text-muted">{live.player2?.elo} ELO</div>
              </div>
            </div>
            {(live.score1 > 0 || live.score2 > 0) ? (
              <div className="bg-bg rounded-xl p-4 flex items-center justify-between">
                <div className="text-2xl font-black font-mono" style={{ color: color1 }}>{(live.score1 || 0).toLocaleString()}</div>
                <div className="text-xs text-muted">score</div>
                <div className="text-2xl font-black font-mono" style={{ color: color2 }}>{(live.score2 || 0).toLocaleString()}</div>
              </div>
            ) : (
              <div className="bg-bg rounded-xl p-4 text-center">
                <div className="text-muted text-sm animate-pulse">Game in progress…</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function PlayNow() {
  const { queueEntries, activeGames } = useSocket();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const ready = usePageReady();
  const [spectating, setSpectating] = useState(null);

  // Auto-open spectator when navigated here with a spectateGame id
  useEffect(() => {
    const id = location.state?.spectateGame;
    if (!id || activeGames.length === 0) return;
    const game = activeGames.find(g => g.id === id);
    if (game) setSpectating(game);
  }, [location.state?.spectateGame, activeGames]);

  function handleJoin(entry) {
    const route = GAME_ROUTES[entry.gameType];
    if (!route) return;
    if (!profile) { navigate('/login'); return; }
    navigate(route, { state: { autoQueue: true, entryFee: entry.entryFee, betCurrency: entry.currency } });
  }

  return (
    <div
      className="min-h-screen bg-bg pt-16 transition-opacity duration-300"
      style={{ opacity: ready ? 1 : 0 }}
    >
      <div className="max-w-7xl mx-auto px-4 py-10 pb-24">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-3xl font-black text-white">⚡ Play Now</h1>
          <p className="text-muted mt-1">Live matchmaking — jump into an open game</p>
        </div>

        {/* Live Now section */}
        {spectating && <SpectatorModal game={spectating} onClose={() => setSpectating(null)} />}

        {activeGames.length > 0 && (
          <div className="mb-10">
            <h2 className="text-xl font-black text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
              Live Now
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {activeGames.map(game => {
                const color1 = game.player1?.profileColor || '#1E90FF';
                const color2 = game.player2?.profileColor || '#ef4444';
                return (
                  <div key={game.id}
                    className="bg-surface border border-surfaceLight rounded-2xl p-4 flex flex-col gap-3 cursor-pointer hover:border-red-500/50 transition-colors"
                    onClick={() => setSpectating(game)}
                    style={{ borderColor: 'rgba(239,68,68,0.3)', boxShadow: '0 0 12px rgba(239,68,68,0.08)' }}
                  >
                    {/* Game type + bet */}
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-black text-red-400">{GAME_LABELS[game.gameType] || game.gameType}</span>
                      <span className="text-xs font-bold text-white">
                        {game.entryFee > 0 ? <span className="inline-flex items-center gap-0.5">{game.entryFee} {game.currency === 'diamonds' ? '💎' : <CoinIcon size="0.85em" />}</span> : 'Free'}
                      </span>
                    </div>

                    {/* Players vs */}
                    <div className="flex items-center gap-2">
                      {/* Player 1 */}
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <div className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-black"
                          style={{ backgroundColor: `${color1}22`, border: `1.5px solid ${color1}`, color: color1 }}>
                          {(game.player1?.username || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-white truncate">{game.player1?.username}</div>
                          <div className="text-[10px] text-muted">{game.player1?.elo} ELO</div>
                        </div>
                      </div>

                      <div className="text-xs font-black text-muted shrink-0">VS</div>

                      {/* Player 2 */}
                      <div className="flex items-center gap-1.5 flex-1 min-w-0 justify-end">
                        <div className="min-w-0 text-right">
                          <div className="text-xs font-bold text-white truncate">{game.player2?.username}</div>
                          <div className="text-[10px] text-muted">{game.player2?.elo} ELO</div>
                        </div>
                        <div className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-xs font-black"
                          style={{ backgroundColor: `${color2}22`, border: `1.5px solid ${color2}`, color: color2 }}>
                          {(game.player2?.username || '?')[0].toUpperCase()}
                        </div>
                      </div>
                    </div>

                    {/* Live scores (if available) */}
                    {(game.score1 > 0 || game.score2 > 0) && (
                      <div className="flex justify-between text-center">
                        <span className="text-lg font-black text-success">{game.score1?.toLocaleString()}</span>
                        <span className="text-xs text-muted self-center">score</span>
                        <span className="text-lg font-black text-danger">{game.score2?.toLocaleString()}</span>
                      </div>
                    )}

                    {/* LIVE badge */}
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-[10px] font-bold text-red-400 uppercase tracking-widest">Live</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Queue section */}
        {queueEntries.length === 0 ? (
          /* Empty state — only show when no live games either */
          activeGames.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
              <div className="w-24 h-24 rounded-full bg-surface border border-surfaceLight flex items-center justify-center text-5xl animate-pulse">
                🎮
              </div>
              <div>
                <p className="text-xl font-bold text-white">No matches in queue</p>
                <p className="text-muted mt-1">Be the first to start one</p>
              </div>
              <button
                onClick={() => navigate('/game/random')}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold bg-primary/15 text-primary hover:bg-primary hover:text-white transition-all"
              >
                Play a Game
              </button>
            </div>
          )
        ) : (
          /* Queue entry grid */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {queueEntries.map(entry => {
              const rank = getRank(entry.elo);
              const initial = (entry.username || 'P')[0].toUpperCase();
              const gameLabel = GAME_LABELS[entry.gameType] || entry.gameType;

              const color = entry.profileColor || '#1E90FF';
              return (
                <div
                  key={entry.id}
                  className="bg-surface border border-surfaceLight rounded-2xl p-5 flex flex-col gap-4"
                  style={{ animation: 'slideIn 0.3s ease' }}
                >
                  {/* Game name + bet on same row */}
                  <div className="flex items-center justify-between">
                    <div className="text-base font-black text-primary">{gameLabel}</div>
                    <div className="text-base font-black text-white">
                      {entry.entryFee > 0
                        ? <span className="inline-flex items-center gap-0.5">{entry.entryFee} {entry.currency === 'diamonds' ? '💎' : <CoinIcon size="0.85em" />}</span>
                        : 'Free'}
                    </div>
                  </div>

                  {/* Player avatar + info */}
                  <div className="flex items-center gap-3">
                    {/* Avatar circle — same style as Navbar/LeftSidebar */}
                    <div className="relative shrink-0">
                      <div
                        className="w-12 h-12 rounded-full flex items-center justify-center font-black text-lg"
                        style={{
                          backgroundColor: `${color}22`,
                          border: `2px solid ${color}`,
                          color,
                        }}
                      >
                        {initial}
                      </div>
                      {/* Rank badge */}
                      <span className="absolute -bottom-1 -right-1 text-sm leading-none" title={rank.name}>
                        {rank.icon}
                      </span>
                      {/* Win streak badge */}
                      {(entry.currentStreak ?? 0) >= 1 && (
                        <span
                          className="absolute -top-1 -left-1 flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-black leading-none px-0.5"
                          style={{ background: 'rgba(0,0,0,0.85)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.4)', textShadow: '0 0 6px rgba(251,146,60,0.6)' }}
                        >
                          🔥{entry.currentStreak}
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="text-base font-black text-white truncate">{entry.username}</div>
                      <div className="text-sm text-muted">{entry.elo} ELO · {rank.name}</div>
                    </div>
                  </div>

                  {/* Join button */}
                  <button
                    onClick={() => handleJoin(entry)}
                    className="block w-full text-center py-2.5 rounded-xl text-base font-bold bg-primary/15 text-primary hover:bg-primary hover:text-white transition-all"
                  >
                    Join →
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        @keyframes slideIn {
          from { transform: translateY(-20px); opacity: 0; }
          to   { transform: translateY(0);     opacity: 1; }
        }
      `}</style>
    </div>
  );
}


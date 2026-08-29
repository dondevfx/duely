import { useState, useEffect, useRef } from 'react';
import GameIcon from '../components/GameIcon';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { usePageReady } from '../hooks/usePageReady';

const PREMIUM = {
  '0,0': 'TW', '0,5': 'TW', '5,0': 'TW', '5,5': 'TW',
  '1,1': 'DW', '1,4': 'DW', '4,1': 'DW', '4,4': 'DW',
  '0,2': 'TL', '0,3': 'TL', '2,0': 'TL', '3,0': 'TL',
  '2,5': 'TL', '3,5': 'TL', '5,2': 'TL', '5,3': 'TL',
  '2,2': '★',
  '2,3': 'DL', '3,2': 'DL', '3,3': 'DL',
};
const PREMIUM_COLORS = {
  'TW': { bg: '#3d1212', border: '#922',   textColor: '#e88' },
  'DW': { bg: '#3a1e0a', border: '#964',   textColor: '#daa' },
  'TL': { bg: '#0c1f38', border: '#336',   textColor: '#79a' },
  'DL': { bg: '#0c1a2a', border: '#245',   textColor: '#68a' },
  '★':  { bg: '#1a1500', border: '#665520', textColor: '#bb9' },
};
const LETTER_VALUES = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,
  N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,
};
const BOARD_SIZE = 6;
const CELL_SIZE = typeof window !== 'undefined'
  ? Math.min(62, Math.floor((Math.min(window.innerWidth, 480) - 42) / BOARD_SIZE))
  : 62;

function SpectateBoard({ board }) {
  return (
    <div style={{
      display: 'inline-grid',
      gridTemplateColumns: `repeat(${BOARD_SIZE}, ${CELL_SIZE}px)`,
      gap: 3,
      background: '#6b4c2a',
      padding: 8,
      borderRadius: 12,
      border: '3px solid #4a3018',
      boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
    }}>
      {Array.from({ length: BOARD_SIZE }, (_, r) =>
        Array.from({ length: BOARD_SIZE }, (_, c) => {
          const cell = board?.[r]?.[c];
          const prem = PREMIUM[`${r},${c}`];
          const premStyle = prem ? PREMIUM_COLORS[prem] : null;
          return (
            <div
              key={`${r}-${c}`}
              style={{
                width: CELL_SIZE, height: CELL_SIZE,
                borderRadius: 5,
                background: cell ? '#e8d5a8' : premStyle ? premStyle.bg : '#162032',
                border: `1.5px solid ${cell ? '#b8985a' : premStyle ? premStyle.border : '#1e3050'}`,
                boxShadow: cell ? '0 2px 4px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2)' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative',
              }}
            >
              {cell ? (
                <>
                  <span style={{ fontSize: 24, fontWeight: 900, color: '#2c1a00' }}>{cell.letter}</span>
                  <span style={{ position: 'absolute', bottom: 2, right: 3, fontSize: 8, fontWeight: 700, color: 'rgba(80,50,10,0.6)' }}>
                    {LETTER_VALUES[cell.letter] || ''}
                  </span>
                </>
              ) : premStyle ? (
                <span style={{ fontSize: 10, color: premStyle.textColor, fontWeight: 900 }}>{prem}</span>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

export default function SpectateView() {
  const ready = usePageReady();
  const { gameId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { socket } = useSocket();
  const fromPath = location.state?.from ?? '/';

  const [snapshot, setSnapshot] = useState(null);
  const [scores, setScores] = useState({});
  const [board, setBoard] = useState(null);
  const [lastWords, setLastWords] = useState([]);
  const [lastScore, setLastScore] = useState(null);
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);
  const [ended, setEnded] = useState(false);
  const [winner, setWinner] = useState(null);

  const snapshotRef = useRef(null);

  useEffect(() => {
    if (!socket || !gameId) return;

    socket.emit('spectate_game', { gameId });

    socket.on('spectate_snapshot', (snap) => {
      setSnapshot(snap);
      snapshotRef.current = snap;
      if (snap.board) setBoard(snap.board);
      if (snap.scores) setScores(snap.scores);
      if (snap.score1 != null) setScore1(snap.score1);
      if (snap.score2 != null) setScore2(snap.score2);
    });

    // Word VS live updates
    socket.on('scrabble_word_played', ({ board: b, scores: sc, words, score }) => {
      if (b) setBoard(b);
      if (sc) setScores(sc);
      if (words) setLastWords(words);
      if (score != null) setLastScore(score);
    });

    // Block Burst score updates
    socket.on('block_blast_opponent_score', ({ score: s }) => setScore2(s));
    socket.on('block_blast_score_ping',     ({ score: s }) => setScore1(s));

    // Game ended
    function handleEnd(res) {
      setEnded(true);
      const snap = snapshotRef.current;
      if (!snap) return;
      const p1 = snap.player1;
      if (res.winnerId) {
        const winnerPlayer = res.winnerId === p1?.userId ? p1 : snap.player2;
        setWinner(winnerPlayer?.username ?? 'Unknown');
      } else if (res.winnerUsername) {
        setWinner(res.winnerUsername);
      }
    }

    socket.on('scrabble_result',      handleEnd);
    socket.on('block_blast_result',   handleEnd);
    socket.on('coin_flip_result',     handleEnd);
    socket.on('bj_result',            handleEnd);

    return () => {
      socket.off('spectate_snapshot');
      socket.off('scrabble_word_played');
      socket.off('block_blast_opponent_score');
      socket.off('block_blast_score_ping');
      socket.off('scrabble_result',    handleEnd);
      socket.off('block_blast_result', handleEnd);
      socket.off('coin_flip_result',   handleEnd);
      socket.off('bj_result',          handleEnd);
    };
  }, [socket, gameId]);

  const p1 = snapshot?.player1;
  const p2 = snapshot?.player2;
  const gameType = snapshot?.gameType;

  const p1Score = gameType === 'scrabble'
    ? (scores[p1?.userId] ?? 0)
    : score1;
  const p2Score = gameType === 'scrabble'
    ? (scores[p2?.userId] ?? 0)
    : score2;

  const gameLabel = {
    scrabble:   'Word VS',
    blockBlast: 'Block Burst',
    coinFlip:   'Coin Flip',
    blackjack:  'Blackjack',
    carDash:    'Rush Hour',
    colorRush:  'Color Rush',
    tower:      'Tower',
  }[gameType] ?? 'Live Game';

  return (
    <div
      className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4 py-6"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      {!snapshot ? (
        <div className="text-center animate-fade-in">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted">Joining live match…</p>
        </div>
      ) : snapshot.gameType === 'unknown' ? (
        <div className="text-center animate-fade-in">
          <div className="text-5xl mb-4">🏁</div>
          <h2 className="text-2xl font-bold text-white mb-2">Game not found</h2>
          <p className="text-muted mb-6 text-sm">This match may have already ended.</p>
          <button
            onClick={() => navigate(fromPath)}
            className="px-6 py-2 rounded-xl bg-primary text-white font-bold hover:bg-primary/80 transition-all"
          >
            Go Back
          </button>
        </div>
      ) : (
        <div className="w-full max-w-lg flex flex-col items-center gap-5 animate-fade-in">

          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-danger/20 border border-danger/40 text-danger text-xs font-bold mb-2 animate-pulse">
              <span className="w-2 h-2 rounded-full bg-danger inline-block" />
              LIVE
            </div>
            <h1 className="text-2xl font-black text-white flex items-center justify-center gap-2">
              <GameIcon game={gameType} size={26} />{gameLabel}
            </h1>
          </div>

          {/* Scoreboard */}
          <div className="w-full bg-surface border border-border rounded-2xl p-4 flex items-center justify-between">
            <div className="text-center flex-1">
              <div className="text-2xl font-black text-success font-mono">{p1Score.toLocaleString()}</div>
              <div className="text-sm text-white font-bold">{p1?.username ?? '—'}</div>
            </div>
            <div className="text-muted font-black text-xl px-4">VS</div>
            <div className="text-center flex-1">
              <div className="text-2xl font-black text-danger font-mono">{p2Score.toLocaleString()}</div>
              <div className="text-sm text-white font-bold">{p2?.username ?? '—'}</div>
            </div>
          </div>

          {/* Word VS board */}
          {gameType === 'scrabble' && board && (
            <>
              {lastWords.length > 0 && (
                <div className="text-center text-sm text-muted">
                  <span className="text-white font-bold">{lastWords.join(', ')}</span>
                  {lastScore != null && <span className="text-success font-bold ml-1">+{lastScore} pts</span>}
                </div>
              )}
              <SpectateBoard board={board} />
            </>
          )}

          {/* Non-board games: just show a waiting message */}
          {gameType !== 'scrabble' && !ended && (
            <div className="text-muted text-sm animate-pulse">Match in progress…</div>
          )}

          {/* Game ended overlay */}
          {ended && (
            <div className="w-full bg-surface border border-border rounded-2xl p-6 text-center">
              <div className="text-5xl mb-3">🏆</div>
              <h2 className="text-2xl font-black text-white mb-1">
                {winner ? `${winner} wins!` : 'Game Over!'}
              </h2>
              <p className="text-muted text-sm mb-4">The match has ended.</p>
              <button
                onClick={() => navigate(fromPath)}
                className="px-6 py-2 rounded-xl bg-primary text-white font-bold hover:bg-primary/80 transition-all"
              >
                Go Back
              </button>
            </div>
          )}

          {!ended && (
            <button
              onClick={() => navigate(fromPath)}
              className="text-sm text-muted hover:text-white transition-colors"
            >
              ← Stop watching
            </button>
          )}
        </div>
      )}
    </div>
  );
}

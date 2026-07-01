import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import GameLobby, { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import GlowButton from '../components/GlowButton';
import CoinIcon from '../components/CoinIcon';

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

// ── Duely brand colours ──────────────────────────────────────────────────────
const C = {
  correct: '#22c55e',
  present: '#f59e0b',
  absent:  '#2d3748',
  empty:   'transparent',
  border:  { empty: 'rgba(255,255,255,0.15)', active: 'var(--color-primary)', correct: '#22c55e', present: '#f59e0b', absent: '#374151' },
  key:     { default: '#374151', correct: '#16a34a', present: '#b45309', absent: '#1f2937' },
};

const WORDLE_CSS = `
@keyframes wdl-flip {
  0%   { transform: rotateX(0deg); }
  49%  { transform: rotateX(-90deg); }
  50%  { transform: rotateX(-90deg); }
  100% { transform: rotateX(0deg); }
}
@keyframes wdl-pop {
  0%   { transform: scale(1); }
  50%  { transform: scale(1.12); }
  100% { transform: scale(1); }
}
@keyframes wdl-shake {
  0%,100% { transform: translateX(0); }
  20%     { transform: translateX(-6px); }
  40%     { transform: translateX(6px); }
  60%     { transform: translateX(-4px); }
  80%     { transform: translateX(4px); }
}
@keyframes wdl-bounce {
  0%,100% { transform: translateY(0); }
  40%     { transform: translateY(-12px); }
  70%     { transform: translateY(-6px); }
}
@keyframes wdl-pulse-border {
  0%,100% { box-shadow: 0 0 0 0 rgba(30,144,255,0.25); }
  50%     { box-shadow: 0 0 0 4px rgba(30,144,255,0.25); }
}
.wdl-tile { transition: background 0s, border-color 0.1s; perspective: 250px; }
.wdl-tile.flip { animation: wdl-flip 0.5s ease forwards; }
.wdl-tile.bounce { animation: wdl-bounce 0.6s ease; }
.wdl-row.shake { animation: wdl-shake 0.4s ease; }
.wdl-active-row .wdl-tile:not(.flip):not(.revealed) {
  animation: wdl-pulse-border 2s ease-in-out infinite;
}
.wdl-key { transition: background 0.2s, color 0.2s; user-select: none; -webkit-tap-highlight-color: transparent; }
.wdl-key:active { opacity: 0.75; transform: scale(0.96); }
`;

const ROWS_KB = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L'],
  ['ENTER','Z','X','C','V','B','N','M','⌫'],
];

export default function WordleGame() {
  const navigate   = useNavigate();
  const location   = useLocation();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const { profile } = useAuth();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  const socketRef  = useRef(socket);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  // ── Shared phase + bet state ──────────────────────────────────────────────
  const [phase,       setPhase]       = useState('lobby');
  const [entryFee,    setEntryFee]    = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [roomId,      setRoomId]      = useState(null);
  const [opponent,    setOpponent]    = useState(null);
  const [countdown,   setCountdown]   = useState(null);
  const [privateCode, setPrivateCode] = useState('');
  const [statusMsg,   setStatusMsg]   = useState('');

  const lastSettingsRef = useRef({ entryFee: 0, currency: betCurrency });

  const balance = betCurrency === 'diamonds' ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const isDiamonds = betCurrency === 'diamonds';

  useEffect(() => {
    if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active game state ──────────────────────────────────────────────────────
  const [guesses,   setGuesses]   = useState([]);
  const [currentRow, setCurrentRow] = useState([]);
  const [letterMap, setLetterMap] = useState({});
  const [oppCount,  setOppCount]  = useState(0);
  const [shakeRow,  setShakeRow]  = useState(false);
  const [flipRow,   setFlipRow]   = useState(null);
  const [bounceRow, setBounceRow] = useState(null);
  const [errorMsg,  setErrorMsg]  = useState('');
  const [oppFailed, setOppFailed] = useState(false);
  const [failSecs,  setFailSecs]  = useState(null);
  const [myDone,    setMyDone]    = useState(false);
  const [result,    setResult]    = useState(null);
  const failIntervalRef = useRef(null);

  // ── Forfeit on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
    };
  }, []);

  // ── Socket event listeners ────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    socket.on('scrabble_match_found', ({ roomId: rid, opponent: opp, entryFee: fee, currency: cur }) => {
      setRoomId(rid);
      setOpponent(opp);
      setEntryFee(fee || 0);
      if (cur) setBetCurrency(cur);
    });

    socket.on('scrabble_countdown', ({ count }) => {
      setCountdown(count);
      setPhase('countdown');
    });

    socket.on('match_cancelled', ({ message }) => {
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled');
    });

    socket.on('wordle_start', () => {
      setCountdown(null);
      setGuesses([]);
      setCurrentRow([]);
      setLetterMap({});
      setOppCount(0);
      setMyDone(false);
      setOppFailed(false);
      setFailSecs(null);
      setResult(null);
      setPhase('playing');
    });

    socket.on('wordle_guess_result', ({ feedback, guessNumber, solved }) => {
      const rowIndex = guessNumber - 1;
      setGuesses(prev => { const n = [...prev]; n[rowIndex] = feedback; return n; });
      setFlipRow(rowIndex);
      setTimeout(() => {
        setFlipRow(null);
        setLetterMap(prev => {
          const next = { ...prev };
          const RANK = { correct: 2, present: 1, absent: 0 };
          for (const { letter, status } of feedback) {
            if ((RANK[status] ?? -1) > (RANK[next[letter]] ?? -1)) next[letter] = status;
          }
          return next;
        });
        if (solved) {
          setBounceRow(rowIndex);
          setTimeout(() => setBounceRow(null), 700);
          setMyDone(true);
        }
      }, WORD_LENGTH * 300 + 50);
      setCurrentRow([]);
    });

    socket.on('wordle_error', ({ error }) => {
      flashError(error);
      triggerShake();
    });

    socket.on('wordle_opponent_progress', ({ guessCount }) => setOppCount(guessCount));

    socket.on('wordle_opponent_failed', ({ timeLimit }) => {
      setOppFailed(true);
      let secs = timeLimit;
      setFailSecs(secs);
      if (failIntervalRef.current) clearInterval(failIntervalRef.current);
      failIntervalRef.current = setInterval(() => {
        secs--;
        setFailSecs(secs);
        if (secs <= 0) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
      }, 1000);
    });

    socket.on('wordle_result', (res) => {
      if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
      setResult(res);
      setPhase('result');
    });

    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    socket.on('private_room_error', ({ message }) => {
      setStatusMsg(message || 'Private room error');
      setPhase('lobby');
    });

    socket.on('opponent_disconnected', () => {
      if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
      setStatusMsg('Opponent disconnected — you win!');
    });

    socket.on('scrabble_queue_left', () => { setPhase('lobby'); setStatusMsg(''); });

    return () => {
      socket.off('scrabble_match_found');
      socket.off('scrabble_countdown');
      socket.off('match_cancelled');
      socket.off('wordle_start');
      socket.off('wordle_guess_result');
      socket.off('wordle_error');
      socket.off('wordle_opponent_progress');
      socket.off('wordle_opponent_failed');
      socket.off('wordle_result');
      socket.off('private_room_created');
      socket.off('private_room_error');
      socket.off('opponent_disconnected');
      socket.off('scrabble_queue_left');
    };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-queue from quick-match ────────────────────────────────────────────
  const _autoFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _autoFired.current || !authenticated || !socket) return;
    _autoFired.current = true;
    const fee = location.state.entryFee ?? 0;
    const cur = location.state.currency ?? 'coins';
    setEntryFee(fee);
    setBetCurrency(cur);
    lastSettingsRef.current = { entryFee: fee, currency: cur };
    socket.emit('join_scrabble_queue', { entryFee: fee, currency: cur });
    setPhase('queue');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, authenticated]);

  // ── Error flash ───────────────────────────────────────────────────────────
  const errorTimeoutRef = useRef(null);
  function flashError(msg) {
    setErrorMsg(msg);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setErrorMsg(''), 1800);
  }
  function triggerShake() {
    setShakeRow(true);
    setTimeout(() => setShakeRow(false), 450);
  }

  // ── Queue / private actions ───────────────────────────────────────────────
  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    socket.emit('join_scrabble_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent…');
  }

  function leaveQueue() {
    socket.emit('leave_scrabble_queue');
    setPhase('lobby');
    setStatusMsg('');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'scrabble', entryFee: fee, currency: cur });
  }

  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'scrabble', code });
  }

  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setGuesses([]);
    setCurrentRow([]);
    setLetterMap({});
    setStatusMsg('');
    setPrivateCode('');
  }

  function playAgain() {
    const s = lastSettingsRef.current;
    socket.emit('join_scrabble_queue', { entryFee: s.entryFee, currency: s.currency });
    setPhase('queue');
    setGuesses([]); setCurrentRow([]); setLetterMap({});
    setMyDone(false); setOppFailed(false); setFailSecs(null); setResult(null);
    setStatusMsg('Finding an opponent…');
  }

  // ── Keyboard input (playing phase) ────────────────────────────────────────
  const handleKey = useCallback((key) => {
    if (phase !== 'playing' || myDone) return;
    if (key === 'ENTER' || key === 'Enter') {
      if (currentRow.length < WORD_LENGTH) { flashError('Not enough letters'); triggerShake(); return; }
      socket.emit('wordle_guess', { roomId, guess: currentRow.join('') });
    } else if (key === '⌫' || key === 'Backspace') {
      setCurrentRow(prev => prev.slice(0, -1));
    } else if (/^[A-Za-z]$/.test(key) && currentRow.length < WORD_LENGTH) {
      setCurrentRow(prev => [...prev, key.toUpperCase()]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, myDone, currentRow, roomId, socket]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      handleKey(e.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleKey]);

  // ── Tile / key style helpers ──────────────────────────────────────────────
  function tileStyle(status, isCurrentRow, colIdx, isFlipping) {
    const revealed = !!status;
    let bg = C.empty, border = C.border.empty, color = 'rgba(255,255,255,0.85)';
    if (isFlipping) { bg = C[status] || C.absent; border = C[status] || C.absent; color = '#fff'; }
    else if (revealed) { bg = C[status]; border = C.border[status] || C.absent; color = '#fff'; }
    else if (isCurrentRow) { border = C.border.active; }
    const glow = revealed
      ? status === 'correct' ? '0 0 14px rgba(34,197,94,0.45)'
      : status === 'present' ? '0 0 14px rgba(245,158,11,0.35)' : 'none'
      : 'none';
    return {
      background: bg, border: `2px solid ${border}`, color, boxShadow: glow,
      animationDelay: isFlipping ? `${colIdx * 300}ms` : '0ms',
      animationDuration: isFlipping ? '500ms' : undefined,
    };
  }

  function keyStyle(letter) {
    const status = letterMap[letter];
    return {
      background: status ? C.key[status] : C.key.default,
      color: status ? '#fff' : 'rgba(255,255,255,0.9)',
      boxShadow: status === 'correct' ? '0 0 10px rgba(22,163,74,0.4)' : status === 'present' ? '0 0 10px rgba(180,83,9,0.4)' : 'none',
    };
  }

  function gridRows() {
    const rows = [];
    for (let r = 0; r < MAX_GUESSES; r++) {
      if (r < guesses.length) {
        rows.push({ cells: guesses[r], type: 'submitted', idx: r });
      } else if (r === guesses.length && phase === 'playing' && !myDone) {
        const cells = Array(WORD_LENGTH).fill(null).map((_, c) =>
          c < currentRow.length ? { letter: currentRow[c], status: null } : { letter: '', status: null }
        );
        rows.push({ cells, type: 'current', idx: r });
      } else {
        rows.push({ cells: Array(WORD_LENGTH).fill({ letter: '', status: null }), type: 'future', idx: r });
      }
    }
    return rows;
  }

  // ── Phase: lobby ─────────────────────────────────────────────────────────
  if (phase === 'lobby') {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4 py-8">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <GameLobby
          title="🔤 Word VS"
          description="Guess the same 5-letter word as your opponent. Solve it first and win instantly — 6 tries each."
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={balance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
          gameType="scrabble"
          liveCount={playerCounts?.scrabble ?? 0}
        />
      </div>
    );
  }

  // ── Phase: queue ─────────────────────────────────────────────────────────
  if (phase === 'queue') {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching…</h2>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── Phase: private_waiting ────────────────────────────────────────────────
  if (phase === 'private_waiting') {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <div className="w-full max-w-md text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-black text-white mb-2">Private Room</h2>
          <p className="text-muted mb-4 text-sm">Share this code with a friend</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 inline-block min-w-[200px]" style={{ boxShadow: '0 0 20px rgba(30,144,255,0.2)' }}>
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary" style={{ textShadow: '0 0 20px rgba(30,144,255,0.5)' }}>
              {privateCode}
            </div>
          </div>
          <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
          <GlowButton variant="ghost" onClick={cancelPrivate}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── Phase: countdown ─────────────────────────────────────────────────────
  if (phase === 'countdown') {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <div className="text-center animate-fade-in">
          <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1E90FF' }}>
            {countdown ?? '…'}
          </div>
          <p className="text-muted">Get ready…</p>
          {opponent && <p className="text-xs text-muted mt-2">vs {opponent.username}</p>}
        </div>
      </div>
    );
  }

  // ── Phase: result ─────────────────────────────────────────────────────────
  if (phase === 'result' && result) {
    const won  = result.iWon;
    const draw = result.isDraw;
    const word = result.word;

    function MiniGrid({ guesses: gs, label }) {
      return (
        <div className="flex flex-col gap-1 items-center">
          <p className="text-xs text-muted font-medium mb-1">{label}</p>
          {Array(MAX_GUESSES).fill(null).map((_, r) => {
            const row = gs[r] || [];
            return (
              <div key={r} className="flex gap-1">
                {Array(WORD_LENGTH).fill(null).map((__, c) => {
                  const cell = row[c];
                  const bg  = cell ? C[cell.status] : 'transparent';
                  const brd = cell ? (C.border[cell.status] || '#374151') : 'rgba(255,255,255,0.1)';
                  return (
                    <div key={c} className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold text-white"
                      style={{ background: bg, border: `1.5px solid ${brd}` }}>
                      {cell?.letter || ''}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4 py-8 gap-6">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <div className="text-center">
          <div className="text-4xl mb-3">{draw ? '🤝' : won ? '🏆' : '💀'}</div>
          <h2 className="text-3xl font-black" style={{ color: draw ? 'var(--color-muted)' : won ? C.correct : '#ef4444' }}>
            {draw ? 'DRAW' : won ? 'YOU WIN' : 'YOU LOSE'}
          </h2>
          <p className="text-muted text-sm mt-1">
            The word was <span className="text-white font-black tracking-widest">{word}</span>
          </p>
        </div>

        <div className="flex gap-6 justify-center flex-wrap">
          <MiniGrid guesses={result.myGuesses} label="You" />
          <MiniGrid guesses={result.opponentGuesses} label={result.opponentUsername || 'Opponent'} />
        </div>

        <div className="flex gap-3 flex-wrap justify-center">
          <GlowButton variant="primary" onClick={playAgain}>Play Again</GlowButton>
          <GlowButton variant="ghost" onClick={backToLobby}>Back to Lobby</GlowButton>
        </div>
      </div>
    );
  }

  // ── Phase: playing ────────────────────────────────────────────────────────
  const rows = gridRows();

  return (
    <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col select-none" style={{ touchAction: 'manipulation' }}>
      <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surfaceLight">
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {['W','O','R','D'].map((l, i) => (
              <div key={i} className="w-5 h-5 rounded text-[9px] font-black flex items-center justify-center text-white"
                style={{ background: [C.correct, C.present, C.correct, C.present][i] }}>
                {l}
              </div>
            ))}
          </div>
          <span className="text-white font-black text-sm">Word VS</span>
        </div>
        <div className="flex items-center gap-3">
          {entryFee > 0 && (
            <span className="text-xs text-muted flex items-center gap-1">
              {entryFee}{isDiamonds ? ' 💎' : <CoinIcon size="0.8em" />}
            </span>
          )}
          <button onClick={() => { socket.emit('player_forfeit'); navigate('/'); }}
            className="text-xs text-muted hover:text-white transition-colors">
            Quit
          </button>
        </div>
      </div>

      {/* Opponent status bar */}
      <div className="px-4 py-2 border-b border-surfaceLight/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: C.correct }} />
          <span className="text-xs text-muted">
            <span className="text-white font-medium">{opponent?.username}</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted mr-1">Guesses:</span>
          {Array(MAX_GUESSES).fill(null).map((_, i) => (
            <div key={i} className="w-3 h-3 rounded-sm transition-all"
              style={{ background: i < oppCount ? (oppFailed && oppCount >= MAX_GUESSES ? '#ef4444' : 'var(--color-primary)') : 'rgba(255,255,255,0.1)' }} />
          ))}
        </div>
      </div>

      {/* 60-second countdown banner */}
      {oppFailed && failSecs !== null && failSecs > 0 && !myDone && (
        <div className="px-4 py-2 text-center" style={{ background: 'rgba(239,68,68,0.12)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}>
          <span className="text-sm font-bold" style={{ color: failSecs <= 15 ? '#ef4444' : '#f59e0b' }}>
            ⏱ Opponent failed — you have {failSecs}s to guess the word
          </span>
        </div>
      )}

      {/* Done banner */}
      {myDone && !result && (
        <div className="px-4 py-2 text-center" style={{ background: 'rgba(34,197,94,0.12)', borderBottom: '1px solid rgba(34,197,94,0.2)' }}>
          <span className="text-sm font-bold text-green-400">You solved it — waiting for opponent…</span>
        </div>
      )}

      {/* Error toast */}
      {errorMsg && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-xl font-bold text-sm text-white shadow-xl"
          style={{ background: '#1f2937', border: '1px solid rgba(255,255,255,0.15)' }}>
          {errorMsg}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 flex flex-col items-center justify-center py-3 gap-2">
        {rows.map((row, rIdx) => {
          const isCurrentRow  = row.type === 'current';
          const isFlippingRow = flipRow === rIdx;
          const isBouncing    = bounceRow === rIdx;
          const isShaking     = shakeRow && isCurrentRow;
          return (
            <div key={rIdx} className={`flex gap-2 wdl-row${isShaking ? ' shake' : ''}${isCurrentRow ? ' wdl-active-row' : ''}`}>
              {row.cells.map((cell, cIdx) => {
                const status   = row.type === 'submitted' ? cell.status : null;
                const letter   = cell.letter || '';
                const revealed = row.type === 'submitted';
                return (
                  <div key={cIdx}
                    className={`wdl-tile w-14 h-14 rounded-xl flex items-center justify-center text-2xl font-black${revealed && isFlippingRow ? ' flip' : ''}${isBouncing ? ' bounce' : ''}`}
                    style={tileStyle(status, isCurrentRow, cIdx, revealed && isFlippingRow)}>
                    {letter}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Virtual keyboard */}
      <div className="px-2 pb-4 pt-2 flex flex-col gap-1.5" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
        {ROWS_KB.map((row, rIdx) => (
          <div key={rIdx} className="flex justify-center gap-1.5">
            {row.map(key => {
              const isWide = key === 'ENTER' || key === '⌫';
              return (
                <button key={key} onPointerDown={(e) => { e.preventDefault(); handleKey(key); }}
                  className="wdl-key rounded-lg font-bold flex items-center justify-center transition-transform"
                  style={{
                    ...keyStyle(key.length === 1 ? key : null),
                    minWidth: isWide ? 62 : 36,
                    height: 52,
                    fontSize: isWide ? 11 : 16,
                    padding: isWide ? '0 8px' : 0,
                  }}>
                  {key}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

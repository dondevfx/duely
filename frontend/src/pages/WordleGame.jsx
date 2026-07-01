import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import GameLobby, { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import GlowButton from '../components/GlowButton';
import ResultScreen from '../components/ResultScreen';

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

// ── Colours ──────────────────────────────────────────────────────────────────
const CLR = {
  correct: '#22c55e',
  present: '#f59e0b',
  absent:  '#2d3748',
  border:  {
    empty:   'rgba(255,255,255,0.15)',
    active:  '#1E90FF',
    correct: '#22c55e',
    present: '#f59e0b',
    absent:  '#374151',
  },
  key: {
    default: '#374151',
    correct: '#22c55e',
    present: '#f59e0b',
    absent:  '#1a1f2e',
  },
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
  50%  { transform: scale(1.1); }
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
  40%     { transform: translateY(-10px); }
  70%     { transform: translateY(-4px); }
}
.wdl-tile { perspective: 250px; }
.wdl-tile.flip { animation: wdl-flip 0.5s ease forwards; }
.wdl-tile.bounce { animation: wdl-bounce 0.5s ease; }
.wdl-tile.pop { animation: wdl-pop 0.08s ease; }
.wdl-row.shake { animation: wdl-shake 0.35s ease; }
.wdl-key { user-select: none; -webkit-tap-highlight-color: transparent; transition: background 0.15s, color 0.15s; }
.wdl-key:active { opacity: 0.7; transform: scale(0.95); }
`;

const KB_ROWS = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L'],
  ['ENTER','Z','X','C','V','B','N','M','⌫'],
];

// ── Solo word list (client-side only — no server needed) ─────────────────────
const SOLO_WORDS = [
  'ABOUT','ABOVE','ABUSE','ACUTE','AFTER','AGAIN','ALARM','ALIVE','ALLOW','ALONE',
  'ALTER','ANGEL','ANGRY','APPLE','ARENA','ARISE','ARRAY','ATTIC','AVOID','AWAKE',
  'AWARD','BADGE','BEACH','BEARD','BEAST','BLACK','BLADE','BLAST','BLAZE','BLEED',
  'BLEND','BLIND','BLOCK','BLOOD','BLOOM','BLUNT','BOARD','BOOST','BRAVE','BREAD',
  'BREAK','BRIDE','BRING','BROWN','BRUSH','BUILD','BURST','CANDY','CAUSE','CHAOS',
  'CHARM','CHASE','CHECK','CHESS','CHEST','CHIEF','CHILD','CIVIL','CLASH','CLASS',
  'CLEAN','CLEAR','CLICK','CLIFF','CLIMB','CLOCK','CLOSE','CLOUD','COACH','COLOR',
  'COUNT','COURT','COVER','CRACK','CRANE','CRASH','CRAZY','CREAM','CRIME','CROSS',
  'CROWD','CROWN','CRUEL','CRUSH','CYCLE','DANCE','DEATH','DEMON','DEPTH','DIRTY',
  'DODGE','DOUBT','DRAFT','DRAIN','DREAM','DRINK','DRIVE','DRUNK','EARLY','EARTH',
  'EIGHT','ELITE','EMPTY','ENJOY','EQUAL','ERROR','EXACT','EXIST','EXTRA','FAITH',
  'FALSE','FANCY','FAULT','FEAST','FIBER','FIGHT','FINAL','FLAME','FLASH','FLOAT',
  'FLOOD','FOCUS','FORCE','FOUND','FRAME','FRAUD','FRESH','FROST','FULLY','FUNNY',
  'GIANT','GLASS','GLEAM','GLOBE','GOING','GRACE','GRAND','GRAPE','GRASS','GRAVE',
  'GREAT','GREED','GRIND','GROSS','GROUP','GROVE','GUARD','GUESS','GUIDE','HAPPY',
  'HARSH','HEART','HEAVY','HEIST','HONEY','HONOR','HORSE','HOTEL','HOUSE','HUMAN',
  'HUMOR','IDEAL','IMAGE','INNER','IVORY','JEWEL','JUDGE','JUICE','JUMBO','LARGE',
  'LASER','LAUGH','LAYER','LEARN','LEGAL','LEMON','LEVEL','LIGHT','LIMIT','LOCAL',
  'LOGIC','LUCKY','MAGIC','MAJOR','MAPLE','MARCH','MATCH','MERCY','METAL','MODEL',
  'MONEY','MONTH','MORAL','MOUNT','MOUSE','MOUTH','MUSIC','NERVE','NEVER','NIGHT',
  'NOBLE','NOISE','NORTH','NOVEL','NURSE','ORDER','OUTER','OZONE','PAINT','PANIC',
  'PAPER','PARTY','PAUSE','PEACH','PEARL','PHONE','PHOTO','PILOT','PITCH','PLACE',
  'PLAIN','PLANE','PLANT','POLAR','PORCH','POWER','PRESS','PRICE','PRIDE','PRIZE',
  'PROVE','PULSE','PUNCH','QUEEN','QUICK','QUIET','QUOTE','RADAR','RADIO','RAISE',
  'RANGE','RAPID','REACH','READY','REALM','RIDER','RISKY','RIVER','ROBOT','ROUGH',
  'ROUND','ROYAL','RULER','SADLY','SAINT','SALAD','SAUCE','SCALE','SCENE','SCORE',
  'SCOUT','SENSE','SEVEN','SHARE','SHARK','SHARP','SHELL','SHIFT','SHINE','SHIRT',
  'SHOOT','SHORT','SHOUT','SIGHT','SINCE','SKILL','SKULL','SLAVE','SLEEP','SLICE',
  'SLIDE','SLOPE','SMART','SMELL','SMOKE','SNAKE','SOLAR','SOLVE','SPACE','SPARK',
  'SPEAK','SPEND','SPICE','SPINE','SPLIT','SPOON','SPORT','STAIN','STAND','STARE',
  'START','STEAL','STEAM','STEEL','STICK','STILL','STOCK','STOOD','STORE','STORM',
  'STORY','STUDY','STYLE','SUGAR','SUNNY','SUPER','SWEAR','SWEET','SWIFT','SWING',
  'TABLE','TASTE','TEETH','TEMPO','THICK','THORN','THREE','THUMB','TIGER','TIRED',
  'TITLE','TOAST','TOPIC','TOTAL','TOUCH','TOUGH','TOWER','TOXIC','TRACE','TRACK',
  'TRADE','TRAIL','TRAIN','TRAIT','TRASH','TRICK','TROOP','TRUCK','TRULY','TRUST',
  'TRUTH','TWICE','TWIST','UNCLE','UNDER','UNION','UNTIL','UPPER','UPSET','URBAN',
  'USUAL','VALID','VALUE','VIRAL','VIRUS','VISIT','VOICE','WATCH','WATER','WEARY',
  'WEIRD','WHALE','WHEAT','WHEEL','WHERE','WHILE','WHITE','WHOLE','WITCH','WOMAN',
  'WORLD','WORRY','WORSE','WORTH','WRECK','WRONG','YACHT','YIELD','YOUNG','YOUTH',
];

function getSoloWord() {
  return SOLO_WORDS[Math.floor(Math.random() * SOLO_WORDS.length)];
}

function evalGuessLocal(secret, guess) {
  const result = Array(WORD_LENGTH).fill('absent');
  const sec = secret.split('');
  const gue = guess.split('');
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (gue[i] === sec[i]) { result[i] = 'correct'; sec[i] = null; gue[i] = null; }
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (gue[i] === null) continue;
    const j = sec.indexOf(gue[i]);
    if (j !== -1) { result[i] = 'present'; sec[j] = null; }
  }
  return result.map((status, i) => ({ letter: guess[i], status }));
}

// ── Mini guess grid for result screen extra rows ──────────────────────────────
function MiniGrid({ guesses, label }) {
  return (
    <div className="flex flex-col gap-1 items-center">
      <p className="text-xs text-muted font-semibold mb-0.5 uppercase tracking-wide">{label}</p>
      {Array(MAX_GUESSES).fill(null).map((_, r) => {
        const row = guesses[r] || [];
        return (
          <div key={r} className="flex gap-1">
            {Array(WORD_LENGTH).fill(null).map((__, c) => {
              const cell = row[c];
              return (
                <div key={c} className="w-7 h-7 rounded flex items-center justify-center text-[11px] font-black text-white"
                  style={{
                    background: cell ? CLR[cell.status] : 'transparent',
                    border: `1.5px solid ${cell ? (CLR.border[cell.status] || '#374151') : 'rgba(255,255,255,0.1)'}`,
                  }}>
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

export default function WordleGame() {
  const navigate   = useNavigate();
  const location   = useLocation();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const { profile } = useAuth();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  const socketRef = useRef(socket);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  // ── Phase + bet state ─────────────────────────────────────────────────────
  const [phase,       setPhase]       = useState('lobby');
  const [entryFee,    setEntryFee]    = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [roomId,      setRoomId]      = useState(null);
  const [opponent,    setOpponent]    = useState(null);
  const [countdown,   setCountdown]   = useState(null);
  const [privateCode, setPrivateCode] = useState('');
  const [statusMsg,   setStatusMsg]   = useState('');
  const lastModeRef   = useRef('pvp'); // 'pvp' | 'solo' | 'private'
  const lastSettingsRef = useRef({ entryFee: 0, currency: betCurrency });
  const eloBeforeRef  = useRef(profile?.elo ?? 1000);

  const isDiamonds = betCurrency === 'diamonds';
  const balance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  useEffect(() => {
    if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Game state ────────────────────────────────────────────────────────────
  const [guesses,    setGuesses]    = useState([]);
  const [currentRow, setCurrentRow] = useState([]);
  const [letterMap,  setLetterMap]  = useState({});
  const [oppCount,   setOppCount]   = useState(0);
  const [shakeRow,   setShakeRow]   = useState(false);
  const [flipRow,    setFlipRow]    = useState(null);
  const [bounceRow,  setBounceRow]  = useState(null);
  const [errorMsg,   setErrorMsg]   = useState('');
  const [oppFailed,  setOppFailed]  = useState(false);
  const [failSecs,   setFailSecs]   = useState(null);
  const [myDone,     setMyDone]     = useState(false);
  const [result,     setResult]     = useState(null);
  const failIntervalRef = useRef(null);

  // ── Solo-mode state ────────────────────────────────────────────────────────
  const [soloWord,   setSoloWord]   = useState('');
  const [soloDone,   setSoloDone]   = useState(false);

  // ── Forfeit on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
    };
  }, []);

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    socket.on('scrabble_match_found', ({ roomId: rid, opponent: opp, entryFee: fee, currency: cur }) => {
      setRoomId(rid);
      setOpponent(opp);
      setEntryFee(fee || 0);
      if (cur) setBetCurrency(cur);
      eloBeforeRef.current = profile?.elo ?? 1000;
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
      resetGameState();
      setPhase('playing');
    });

    socket.on('wordle_guess_result', ({ feedback, guessNumber, solved }) => {
      revealRow(guessNumber - 1, feedback, solved);
    });

    socket.on('wordle_error', ({ error }) => { flashError(error); triggerShake(); });

    socket.on('wordle_opponent_progress', ({ guessCount }) => setOppCount(guessCount));

    socket.on('wordle_opponent_failed', ({ timeLimit }) => {
      setOppFailed(true);
      startFailTimer(timeLimit);
    });

    socket.on('wordle_result', (res) => {
      if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
      setResult(res);
      setPhase('result');
    });

    socket.on('private_room_created', ({ code }) => { setPrivateCode(code); setPhase('private_waiting'); });
    socket.on('private_room_error',   ({ message }) => { setStatusMsg(message || 'Room error'); setPhase('lobby'); });
    socket.on('scrabble_queue_left',  () => { setPhase('lobby'); setStatusMsg(''); });
    socket.on('opponent_disconnected', () => {
      if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
    });

    return () => {
      ['scrabble_match_found','scrabble_countdown','match_cancelled','wordle_start',
       'wordle_guess_result','wordle_error','wordle_opponent_progress','wordle_opponent_failed',
       'wordle_result','private_room_created','private_room_error','scrabble_queue_left',
       'opponent_disconnected'].forEach(e => socket.off(e));
    };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-queue ────────────────────────────────────────────────────────────
  const _autoFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _autoFired.current || !authenticated || !socket) return;
    _autoFired.current = true;
    const fee = location.state.entryFee ?? 0;
    const cur = location.state.currency ?? 'coins';
    setEntryFee(fee); setBetCurrency(cur);
    lastSettingsRef.current = { entryFee: fee, currency: cur };
    lastModeRef.current = 'pvp';
    socket.emit('join_scrabble_queue', { entryFee: fee, currency: cur });
    setPhase('queue');
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helpers ───────────────────────────────────────────────────────────────
  function resetGameState() {
    setGuesses([]); setCurrentRow([]); setLetterMap({});
    setOppCount(0); setMyDone(false); setOppFailed(false);
    setFailSecs(null); setResult(null); setSoloDone(false);
    if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
  }

  const errorTORef = useRef(null);
  function flashError(msg) {
    setErrorMsg(msg);
    if (errorTORef.current) clearTimeout(errorTORef.current);
    errorTORef.current = setTimeout(() => setErrorMsg(''), 1800);
  }

  function triggerShake() {
    setShakeRow(true);
    setTimeout(() => setShakeRow(false), 400);
  }

  function startFailTimer(secs) {
    if (failIntervalRef.current) clearInterval(failIntervalRef.current);
    let s = secs;
    setFailSecs(s);
    failIntervalRef.current = setInterval(() => {
      s--;
      setFailSecs(s);
      if (s <= 0) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
    }, 1000);
  }

  function revealRow(rowIndex, feedback, solved) {
    setGuesses(prev => { const n = [...prev]; n[rowIndex] = feedback; return n; });
    setFlipRow(rowIndex);
    setTimeout(() => {
      setFlipRow(null);
      setLetterMap(prev => {
        const RANK = { correct: 2, present: 1, absent: 0 };
        const next = { ...prev };
        for (const { letter, status } of feedback) {
          if ((RANK[status] ?? -1) > (RANK[next[letter]] ?? -1)) next[letter] = status;
        }
        return next;
      });
      if (solved) { setBounceRow(rowIndex); setTimeout(() => setBounceRow(null), 600); }
    }, WORD_LENGTH * 300 + 50);
    setCurrentRow([]);
  }

  // ── Queue / lobby actions ─────────────────────────────────────────────────
  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    lastModeRef.current = 'pvp';
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    eloBeforeRef.current = profile?.elo ?? 1000;
    socket.emit('join_scrabble_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent…');
  }

  function startSolo() {
    if (!authenticated) { doAuth(); return; }
    lastModeRef.current = 'solo';
    resetGameState();
    const word = getSoloWord();
    setSoloWord(word);
    setPhase('playing');
  }

  function leaveQueue() {
    socket.emit('leave_scrabble_queue');
    setPhase('lobby'); setStatusMsg('');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    lastModeRef.current = 'private';
    socket.emit('create_private_room', { gameType: 'scrabble', entryFee: fee, currency: cur });
  }

  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    lastModeRef.current = 'pvp';
    socket.emit('join_private_room', { gameType: 'scrabble', code });
  }

  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }

  function backToLobby() {
    resetGameState();
    setPhase('lobby'); setResult(null);
    setStatusMsg(''); setPrivateCode('');
  }

  function playAgain() {
    resetGameState();
    const mode = lastModeRef.current;
    if (mode === 'solo') {
      const word = getSoloWord();
      setSoloWord(word);
      setPhase('playing');
    } else {
      const s = lastSettingsRef.current;
      eloBeforeRef.current = profile?.elo ?? 1000;
      socket.emit('join_scrabble_queue', { entryFee: s.entryFee, currency: s.currency });
      setPhase('queue'); setStatusMsg('Finding an opponent…');
    }
  }

  // ── Keyboard input ────────────────────────────────────────────────────────
  const isSolo   = lastModeRef.current === 'solo' && phase === 'playing';
  const canType  = phase === 'playing' && !myDone && !soloDone;

  const handleKey = useCallback((key) => {
    if (!canType) return;
    if (key === 'ENTER' || key === 'Enter') {
      if (currentRow.length < WORD_LENGTH) { flashError('Not enough letters'); triggerShake(); return; }
      const guess = currentRow.join('');
      if (isSolo) {
        // Local solo evaluation
        const feedback = evalGuessLocal(soloWord, guess);
        const rowIdx   = guesses.length;
        const solved   = feedback.every(c => c.status === 'correct');
        revealRow(rowIdx, feedback, solved);
        if (solved || rowIdx + 1 >= MAX_GUESSES) {
          setTimeout(() => setSoloDone(true), WORD_LENGTH * 300 + 200);
        }
      } else {
        socket.emit('wordle_guess', { roomId, guess });
      }
    } else if (key === '⌫' || key === 'Backspace') {
      setCurrentRow(prev => prev.slice(0, -1));
    } else if (/^[A-Za-z]$/.test(key) && currentRow.length < WORD_LENGTH) {
      setCurrentRow(prev => [...prev, key.toUpperCase()]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canType, currentRow, isSolo, soloWord, guesses, roomId, socket]);

  useEffect(() => {
    const onKey = (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) handleKey(e.key); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleKey]);

  // ── Tile style ────────────────────────────────────────────────────────────
  function tileStyle(status, isCurrentRow, colIdx, isFlipping) {
    const revealed = !!status;
    let bg = 'transparent', border = CLR.border.empty, color = 'rgba(255,255,255,0.9)';
    if (isFlipping) { bg = CLR[status] || CLR.absent; border = bg; color = '#fff'; }
    else if (revealed) { bg = CLR[status]; border = CLR.border[status] || CLR.border.absent; color = '#fff'; }
    else if (isCurrentRow) border = CLR.border.active;
    const glow = revealed
      ? status === 'correct' ? '0 0 12px rgba(34,197,94,0.5)'
      : status === 'present' ? '0 0 12px rgba(245,158,11,0.4)' : 'none'
      : 'none';
    return {
      background: bg, border: `2px solid ${border}`, color, boxShadow: glow,
      animationDelay: isFlipping ? `${colIdx * 300}ms` : '0ms',
    };
  }

  function keyStyle(letter) {
    const s = letterMap[letter];
    return {
      background: s ? CLR.key[s] : CLR.key.default,
      color: s ? '#fff' : s === 'absent' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)',
      boxShadow: s === 'correct' ? '0 0 10px rgba(34,197,94,0.55)' : s === 'present' ? '0 0 10px rgba(245,158,11,0.5)' : 'none',
      border: s === 'absent' ? '1px solid rgba(255,255,255,0.06)' : '1px solid transparent',
    };
  }

  function buildGridRows() {
    const rows = [];
    const submittedCount = guesses.length;
    for (let r = 0; r < MAX_GUESSES; r++) {
      if (r < submittedCount) {
        rows.push({ cells: guesses[r], type: 'submitted' });
      } else if (r === submittedCount && canType) {
        const cells = Array(WORD_LENGTH).fill(null).map((_, c) =>
          ({ letter: c < currentRow.length ? currentRow[c] : '', status: null })
        );
        rows.push({ cells, type: 'current' });
      } else {
        rows.push({ cells: Array(WORD_LENGTH).fill({ letter: '', status: null }), type: 'future' });
      }
    }
    return rows;
  }

  // ── Solo done screen ──────────────────────────────────────────────────────
  if (phase === 'playing' && soloDone) {
    const solved = guesses.length > 0 && guesses[guesses.length - 1].every(c => c.status === 'correct');
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4 py-8 gap-5">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <div className="text-center">
          <div className="text-4xl mb-3">{solved ? '🏆' : '💀'}</div>
          <h2 className="text-3xl font-black" style={{ color: solved ? CLR.correct : '#ef4444' }}>
            {solved ? `Solved in ${guesses.length}!` : 'Better Luck Next Time'}
          </h2>
          <p className="text-muted text-sm mt-1">
            The word was <span className="text-white font-black tracking-widest">{soloWord}</span>
          </p>
        </div>
        <MiniGrid guesses={guesses} label="Your guesses" />
        <div className="flex gap-3 flex-wrap justify-center mt-2">
          <GlowButton variant="primary" onClick={playAgain}>Play Again</GlowButton>
          <GlowButton variant="ghost" onClick={backToLobby}>Back to Lobby</GlowButton>
        </div>
      </div>
    );
  }

  // ── Result screen (PvP) ───────────────────────────────────────────────────
  if (phase === 'result' && result) {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-4 py-8">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <ResultScreen
          isWinner={result.iWon}
          isDraw={result.isDraw}
          winnerUsername={result.winnerUsername}
          loserUsername={result.loserUsername}
          newWinnerElo={result.newWinnerElo}
          newLoserElo={result.newLoserElo}
          eloBeforeRef={eloBeforeRef}
          balanceChange={result.balanceChange}
          currency={result.currency || betCurrency}
          entryFee={result.entryFee ?? entryFee}
          winnerStreak={result.winnerStreak ?? 0}
          isFirstWin={result.isFirstWin ?? false}
          profile={profile}
          gameLabel="🔤 Word VS"
          extraRows={[
            { label: 'The Word', value: result.word },
            { label: 'Your guesses', value: `${(result.myGuesses || []).length} / ${MAX_GUESSES}` },
            { label: 'Their guesses', value: `${(result.opponentGuesses || []).length} / ${MAX_GUESSES}` },
          ]}
          onPlayAgain={playAgain}
          onBackToLobby={backToLobby}
        />
      </div>
    );
  }

  // ── Lobby ─────────────────────────────────────────────────────────────────
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
          onBotFree={startSolo}
          botLabel="🎮 Solo Mode"
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
          gameType="scrabble"
          liveCount={playerCounts?.scrabble ?? 0}
        />
      </div>
    );
  }

  // ── Queue ─────────────────────────────────────────────────────────────────
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

  // ── Private waiting ───────────────────────────────────────────────────────
  if (phase === 'private_waiting') {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <div className="w-full max-w-md text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-black text-white mb-2">Private Room</h2>
          <p className="text-muted mb-4 text-sm">Share this code with a friend</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 inline-block min-w-[200px]"
            style={{ boxShadow: '0 0 20px rgba(30,144,255,0.2)' }}>
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary"
              style={{ textShadow: '0 0 20px rgba(30,144,255,0.5)' }}>
              {privateCode}
            </div>
          </div>
          <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
          <GlowButton variant="ghost" onClick={cancelPrivate}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
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

  // ── Playing ───────────────────────────────────────────────────────────────
  const gridRows = buildGridRows();
  const isSoloMode = lastModeRef.current === 'solo';
  const guessNum = guesses.length;

  return (
    <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col select-none overflow-hidden"
      style={{ touchAction: 'manipulation' }}>
      <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />

      {/* ── Minimal top bar: just attempt counter + quit ── */}
      <div className="flex items-center justify-between px-4 h-10 border-b border-surfaceLight shrink-0">
        <div className="text-xs text-muted font-semibold tabular-nums">
          {guessNum}/{MAX_GUESSES}
          {isSoloMode && <span className="ml-1.5 text-primary">Solo</span>}
        </div>
        <button onClick={() => { socket?.emit('player_forfeit'); navigate('/'); }}
          className="text-xs text-muted hover:text-white transition-colors">
          Quit
        </button>
      </div>

      {/* ── Error toast ── */}
      {errorMsg && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-5 py-2 rounded-xl font-bold text-sm text-white pointer-events-none"
          style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
          {errorMsg}
        </div>
      )}

      {/* ── Grid ── */}
      <div className="flex-1 flex flex-col items-center justify-center gap-[6px] py-3 px-4">
        {/* Opponent bar — sits directly above the grid, just like Block Burst's HUD */}
        {!isSoloMode && (
          <div className="flex items-center justify-between w-full max-w-[340px] mb-1">
            <span className="text-xs text-white font-semibold truncate">{opponent?.username || 'Opponent'}</span>
            <div className="flex items-center gap-1 shrink-0 ml-2">
              {Array(MAX_GUESSES).fill(null).map((_, i) => (
                <div key={i} className="w-3 h-3 rounded-sm transition-all duration-200"
                  style={{
                    background: i < oppCount
                      ? (oppFailed && oppCount >= MAX_GUESSES ? '#ef4444' : '#1E90FF')
                      : 'rgba(255,255,255,0.1)',
                  }} />
              ))}
            </div>
          </div>
        )}

        {/* Status banners — sit above the grid tiles */}
        {oppFailed && failSecs !== null && failSecs > 0 && !myDone && (
          <div className="w-full max-w-[340px] px-3 py-1.5 rounded-lg text-center mb-1"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <span className="text-xs font-bold" style={{ color: failSecs <= 15 ? '#ef4444' : '#f59e0b' }}>
              ⏱ Opponent failed — {failSecs}s left
            </span>
          </div>
        )}
        {myDone && !result && !isSoloMode && (
          <div className="w-full max-w-[340px] px-3 py-1.5 rounded-lg text-center mb-1"
            style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}>
            <span className="text-xs font-bold text-green-400">You solved it — waiting…</span>
          </div>
        )}
        {gridRows.map((row, rIdx) => {
          const isCurrentRow  = row.type === 'current';
          const isFlipping    = flipRow === rIdx;
          const isBouncing    = bounceRow === rIdx;
          const isShaking     = shakeRow && isCurrentRow;
          return (
            <div key={rIdx}
              className={`flex gap-[6px] wdl-row${isShaking ? ' shake' : ''}`}>
              {row.cells.map((cell, cIdx) => {
                const status  = row.type === 'submitted' ? cell.status : null;
                const letter  = cell.letter || '';
                const flipping = row.type === 'submitted' && isFlipping;
                return (
                  <div key={cIdx}
                    className={`wdl-tile rounded-xl flex items-center justify-center font-black text-xl${flipping ? ' flip' : ''}${isBouncing ? ' bounce' : ''}`}
                    style={{
                      ...tileStyle(status, isCurrentRow, cIdx, flipping),
                      width:  'min(calc((100vw - 80px) / 5), 62px)',
                      height: 'min(calc((100vw - 80px) / 5), 62px)',
                    }}>
                    {letter}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ── Keyboard ── */}
      <div className="shrink-0 px-2 pt-1 pb-3 flex flex-col gap-1.5"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {KB_ROWS.map((row, rIdx) => (
          <div key={rIdx} className="flex justify-center gap-1">
            {row.map(key => {
              const isWide = key === 'ENTER' || key === '⌫';
              return (
                <button key={key}
                  onPointerDown={(e) => { e.preventDefault(); handleKey(key); }}
                  className="wdl-key rounded-lg font-bold flex items-center justify-center"
                  style={{
                    ...keyStyle(key.length === 1 ? key : null),
                    width:  isWide ? 'clamp(52px, 14vw, 66px)' : 'clamp(28px, 8.5vw, 44px)',
                    height: 'clamp(44px, 12vw, 56px)',
                    fontSize: isWide ? 10 : 'clamp(13px, 4vw, 17px)',
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

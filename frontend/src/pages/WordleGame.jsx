import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { playMatchFound, playCountdown, playType } from '../utils/sound';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import GameLobby, { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import GlowButton from '../components/GlowButton';
import ResultScreen from '../components/ResultScreen';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
import { useResumeMatch } from '../hooks/useResumeMatch';

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

// ── Colours ──────────────────────────────────────────────────────────────────
const CLR = {
  correct: '#22c55e',
  present: '#f59e0b',
  absent:  '#2d3748',
  border:  {
    empty:   'rgba(255,255,255,0.15)',
    active:  '#1250B4',
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
  // Only a live match re-claims itself after a reconnect; a refresh forfeits.
  useResumeMatch(socket, () => phase === 'playing');
  const { profile, refreshProfile } = useAuth();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  const socketRef = useRef(socket);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  const refreshProfileRef = useRef(refreshProfile);
  useEffect(() => { refreshProfileRef.current = refreshProfile; }, [refreshProfile]);

  // ── Phase + bet state ─────────────────────────────────────────────────────
  const [phase,       setPhase]       = useState('lobby');
  const [entryFee,    setEntryFee]    = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [roomId,      setRoomId]      = useState(null);
  const [opponent,    setOpponent]    = useState(null);
  const [countdown,   setCountdown]   = useState(null);
  const [privateCode, setPrivateCode] = useState('');
  const [invitedFriend, setInvitedFriend] = useState(null);
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
  const soloCdTimersRef = useRef([]);

  // ── Solo-mode state ────────────────────────────────────────────────────────
  const [soloWord,      setSoloWord]      = useState('');
  const [soloDone,      setSoloDone]      = useState(false);
  const [soloSessionId, setSoloSessionId] = useState(null);
  const [soloResult,    setSoloResult]    = useState(null); // { won, payout, currency, entryFee }

  // ── Forfeit on unmount, and on tab close or refresh ───────────────────────
  // This page had only the unmount half, so closing the tab mid-match relied
  // entirely on the socket dropping. That does still settle it, but not until
  // the disconnect grace period has run.
  useEffect(() => {
    const bail = () => {
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
    };
    window.addEventListener('beforeunload', bail);
    window.addEventListener('pagehide', bail);
    return () => {
      window.removeEventListener('beforeunload', bail);
      window.removeEventListener('pagehide', bail);
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
      // Clear any running countdowns so they don't tick / setState after unmount.
      if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
      soloCdTimersRef.current.forEach(clearTimeout);
      soloCdTimersRef.current = [];
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
      playMatchFound();
    });

    socket.on('scrabble_countdown', ({ count }) => {
      setCountdown(count);
      if (count > 0) playCountdown();
      setPhase('countdown');
    });

    socket.on('match_cancelled', ({ message }) => {
      // The entry fee is deducted optimistically when a match is found, but a
      // cancellation means it was never actually taken — pull the real balance
      // so the player is not left looking at money that did not move.
      refreshProfile();
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
      refreshProfileRef.current?.();
      setTimeout(() => refreshProfileRef.current?.(), 2000);
    });

    socket.on('private_room_created', ({ code }) => { setPrivateCode(code); setInvitedFriend(null); setPhase('private_waiting'); });
    socket.on('invite_sent', ({ friendUsername }) => { setPrivateCode(''); setInvitedFriend(friendUsername || 'your friend'); setStatusMsg(''); setPhase('private_waiting'); });
    socket.on('invite_declined', ({ byUsername }) => { setInvitedFriend(null); setStatusMsg(`${byUsername || 'They'} declined your invite.`); setPhase('lobby'); });
    socket.on('invite_expired', () => { setInvitedFriend(null); setStatusMsg('Invite expired — no response.'); setPhase('lobby'); });
    socket.on('private_room_error',   ({ message }) => { setStatusMsg(message || 'Room error'); setPhase('lobby'); });
    socket.on('scrabble_queue_left',  () => { setPhase('lobby'); setStatusMsg(''); });
    socket.on('opponent_disconnected', (data = {}) => {
      if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
      if (lastModeRef.current === 'solo') return; // no opponent in solo
      // The server only sends this to the staying (winning) player. Transition
      // to the result screen so they aren't frozen on the board/countdown.
      // Pre-match ELO comes from the profile snapshot taken when the match
      // started, not from the result. ELO changes are a random 20-23 on a win
      // and 17-20 on a loss, so subtracting a fixed 25 here would report a
      // delta that never matches what actually happened.
      setResult({
        iWon: true,
        isDraw: false,
        winnerUsername: data.winnerUsername,
        loserUsername: data.loserUsername,
        newWinnerElo: data.newWinnerElo,
        newLoserElo: data.newLoserElo,
        balanceChange: data.winnerPayout != null ? { winnerPayout: data.winnerPayout } : undefined,
        currency: data.currency,
        entryFee: data.entryFee,
        disconnected: true,
      });
      setPhase('result');
      refreshProfileRef.current?.();
      setTimeout(() => refreshProfileRef.current?.(), 2000);
    });

    socket.on('wordle_solo_ready', ({ sessionId }) => {
      // Paid solo is server-authoritative — the answer word is NOT sent here.
      setSoloSessionId(sessionId);
      setSoloWord('');
      runSoloCountdown();
    });

    // Server-evaluated guess result for paid solo (mirrors wordle_guess_result)
    socket.on('wordle_solo_guess_result', ({ feedback, guessNumber, solved }) => {
      revealRow(guessNumber - 1, feedback, solved);
    });

    socket.on('wordle_solo_settled', (res) => {
      if (res?.word) setSoloWord(res.word); // reveal the answer for the result screen
      setSoloResult(res);
      // Delay so the final row's flip animation finishes before the result card
      setTimeout(() => setSoloDone(true), WORD_LENGTH * 300 + 400);
      refreshProfileRef.current?.();
      setTimeout(() => refreshProfileRef.current?.(), 2000);
    });

    socket.on('wordle_solo_error', ({ error }) => {
      setStatusMsg(error || 'Failed to start solo');
      setPhase('lobby');
    });

    return () => {
      ['scrabble_match_found','scrabble_countdown','match_cancelled','wordle_start',
       'wordle_guess_result','wordle_error','wordle_opponent_progress','wordle_opponent_failed',
       'wordle_result','private_room_created','private_room_error','scrabble_queue_left',
       'invite_sent','invite_declined','invite_expired',
       'opponent_disconnected','wordle_solo_ready','wordle_solo_settled','wordle_solo_error',
       'wordle_solo_guess_result',
      ].forEach(e => socket.off(e));
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

  // Auto-join a private room from an accepted friend invite.
  const _autoJoinFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoJoin || !location.state?.joinCode || _autoJoinFired.current) return;
    if (!authenticated || !socket) return;
    _autoJoinFired.current = true;
    const code = location.state.joinCode;
    window.history.replaceState({}, '');
    setTimeout(() => joinPrivate(code), 300);
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helpers ───────────────────────────────────────────────────────────────
  function resetGameState() {
    setGuesses([]); setCurrentRow([]); setLetterMap({});
    setOppCount(0); setMyDone(false); setOppFailed(false);
    setFailSecs(null); setResult(null); setSoloDone(false);
    setSoloResult(null); setSoloSessionId(null);
    if (failIntervalRef.current) { clearInterval(failIntervalRef.current); failIntervalRef.current = null; }
    soloCdTimersRef.current.forEach(clearTimeout);
    soloCdTimersRef.current = [];
  }

  // 3·2·1 countdown for solo modes (PvP/bot get theirs from the server).
  function runSoloCountdown() {
    soloCdTimersRef.current.forEach(clearTimeout);
    setCountdown(3);
    setPhase('countdown');
    playCountdown();
    soloCdTimersRef.current = [
      setTimeout(() => { setCountdown(2); playCountdown(); }, 1000),
      setTimeout(() => { setCountdown(1); playCountdown(); }, 2000),
      setTimeout(() => { setCountdown(null); setPhase('playing'); }, 3000),
    ];
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
    runSoloCountdown();
  }

  function startSoloPaid() {
    if (!authenticated) { doAuth(); return; }
    lastModeRef.current = 'solo';
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    resetGameState();
    socket.emit('wordle_solo_start', { entryFee, currency: betCurrency });
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
    setPhase('lobby'); setPrivateCode(''); setInvitedFriend(null); setStatusMsg('');
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
      runSoloCountdown();
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
      playType();
      if (currentRow.length < WORD_LENGTH) { flashError('Not enough letters'); triggerShake(); return; }
      const guess = currentRow.join('');
      if (isSolo && soloSessionId) {
        // Paid solo is server-authoritative: submit the guess and let the server
        // evaluate it (wordle_solo_guess_result) and settle (wordle_solo_settled).
        // The client never sees the word or decides the outcome.
        socket.emit('wordle_solo_guess', { sessionId: soloSessionId, guess });
      } else if (isSolo) {
        // Free practice solo — no money/ELO, evaluated locally against a client word.
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
      playType();
    } else if (/^[A-Za-z]$/.test(key) && currentRow.length < WORD_LENGTH) {
      setCurrentRow(prev => [...prev, key.toUpperCase()]);
      playType();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canType, currentRow, isSolo, soloWord, soloSessionId, guesses, roomId, socket]);

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
    const paidFee    = soloResult?.entryFee ?? 0;
    const paidPayout = soloResult?.payout   ?? 0;
    const newElo     = soloResult?.newElo   ?? null;
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-3 sm:px-4 py-0 sm:py-8">
        <style dangerouslySetInnerHTML={{ __html: WORDLE_CSS }} />
        <ResultScreen
          isWinner={solved}
          isDraw={false}
          winnerUsername={solved ? (profile?.username ?? 'You') : null}
          loserUsername={solved ? null : (profile?.username ?? 'You')}
          newWinnerElo={solved ? newElo : undefined}
          newLoserElo={solved ? undefined : newElo}
          eloBeforeRef={eloBeforeRef}
          entryFee={paidFee}
          balanceChange={paidFee > 0 && solved ? { winnerPayout: paidPayout } : null}
          currency={soloResult?.currency ?? betCurrency}
          profile={profile}
          gameLabel="🔤 Word VS"
          extraRows={[
            { label: 'The Word', value: soloWord },
            { label: 'Guesses', value: `${guesses.length} / ${MAX_GUESSES}` },
          ]}
          onPlayAgain={playAgain}
          onBackToLobby={backToLobby}
        />
      </div>
    );
  }

  // ── Result screen (PvP) ───────────────────────────────────────────────────
  if (phase === 'result' && result) {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-3 sm:px-4 py-0 sm:py-8">
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
          disconnected={result.disconnected}
          profile={profile}
          gameLabel="🔤 Word VS"
          extraRows={result.disconnected
            ? [{ label: 'Result', value: 'Opponent forfeited' }]
            : [
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
          onBot={startSoloPaid}
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
          {invitedFriend ? (
            <>
              <h2 className="text-2xl font-black text-white mb-2">Invite Sent</h2>
              <div className="w-14 h-14 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto my-6" />
              <p className="text-muted text-sm mb-6">Waiting for <span className="text-white font-bold">{invitedFriend}</span> to accept…</p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-black text-white mb-2">Challenge Ready</h2>
              <ChallengeLinkBox code={privateCode} gameType="scrabble" />
              <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
            </>
          )}
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
          <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>
            {countdown ?? '…'}
          </div>
          <p className="text-muted">Get ready…</p>
          {lastModeRef.current === 'solo'
            ? <p className="text-xs text-muted mt-2">vs Duely Bot</p>
            : opponent && <p className="text-xs text-muted mt-2">vs {opponent.username}</p>}
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

      {/* ── Grid area ── */}
      <div className="flex-1 flex flex-col items-center justify-center gap-3 py-3 px-4 relative">

        {/* ── Error toast — top of the board, centered on the board ── */}
        {errorMsg && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 px-5 py-2 rounded-xl font-bold text-sm text-white pointer-events-none whitespace-nowrap"
            style={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
            {errorMsg}
          </div>
        )}

        {/* HUD — matches Block Blast layout exactly */}
        <div className="flex items-center justify-between w-full max-w-lg gap-2">
          {/* My guess count */}
          <div className="text-center min-w-[72px]">
            <div className="text-xl font-black font-mono text-success">{guessNum}</div>
            <div className="text-[10px] text-muted">{profile?.username ?? 'You'}</div>
          </div>

          {/* Center: mode */}
          <div className="text-center flex-1">
            {isSoloMode ? (
              <span className="text-sm text-muted">Solo — <span className="text-accent font-semibold">Practice</span></span>
            ) : (
              <>
                <div className="text-base font-black text-accent">Word Race</div>
                {oppFailed && failSecs !== null && failSecs > 0 && !myDone && (
                  <div className="text-xs font-bold mt-0.5" style={{ color: failSecs <= 15 ? '#ef4444' : '#f59e0b' }}>
                    ⏱ {failSecs}s left
                  </div>
                )}
                {myDone && !result && (
                  <div className="text-xs font-bold text-green-400 mt-0.5">Solved! Waiting…</div>
                )}
              </>
            )}
          </div>

          {/* Opponent guess count */}
          <div className="text-center min-w-[72px]">
            <div className={`text-xl font-black font-mono ${oppCount > guessNum ? 'text-danger' : oppCount < guessNum ? 'text-success' : 'text-accent'}`}>
              {isSoloMode ? '—' : oppCount}
            </div>
            <div className="text-[10px] text-muted">
              {isSoloMode ? 'Solo' : (opponent?.username ?? 'Opponent')}
            </div>
          </div>
        </div>

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

import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GameLobby from '../components/GameLobby';
import GlowButton from '../components/GlowButton';
import ResultScreen from '../components/ResultScreen';
import { usePageReady } from '../hooks/usePageReady';
import { useResumeMatch } from '../hooks/useResumeMatch';
import { playMatchFound, playCountdown, playGo } from '../utils/sound';
import HighwayCanvas from '../components/HighwayCanvas';

function fmtTime(ms) {
  const s = (ms ?? 0) / 1000;
  return s.toFixed(1) + 's';
}

export default function CarDashGame() {
  const ready = usePageReady();
  const location = useLocation();
  const { profile, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  const [phase, _setPhase] = useState('lobby'); // lobby | queue | playing | result
  const phaseRef = useRef('lobby');
  const setPhase = (p) => { phaseRef.current = p; _setPhase(p); };

  const [entryFee, setEntryFee] = useState(location.state?.entryFee ?? 1);
  const [statusMsg, setStatusMsg] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [opponent, setOpponent] = useState(null);
  const [seed, setSeed] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [myMs, setMyMs] = useState(0);
  const [oppMs, setOppMs] = useState(0);
  const [oppCrashed, setOppCrashed] = useState(false);
  const [crashed, setCrashed] = useState(false);
  const [result, setResult] = useState(null);

  const roomIdRef = useRef(null);
  const crashedRef = useRef(false);
  const lastModeRef = useRef(null); // 'pvp' | 'bot_paid' | 'bot_free'
  const lastSettingsRef = useRef({ entryFee: 0, currency: 'coins' });
  const socketRef = useRef(socket);
  const profileRef = useRef(profile);
  const eloBeforeRef = useRef(profile?.elo ?? 1000);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  // Only a live match re-claims itself after a reconnect; a refresh forfeits.
  useResumeMatch(socket, () => phaseRef.current === 'playing');

  const isDiamonds = betCurrency === 'diamonds';
  const balance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  // Forfeit on unmount (same contract as the other games)
  useEffect(() => () => {
    if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
  }, []);

  // Lock the page while the match is live. The countdown screen is tall enough
  // to scroll, and any scroll offset was still applied when the canvas mounted,
  // so the road came up shifted off the top of the viewport. Pinning the
  // scroller to the top and disabling it removes the cause rather than
  // compensating for it afterwards.
  useEffect(() => {
    if (phase !== 'queue' && phase !== 'playing') return;
    const main = document.querySelector('main');
    if (!main) return;
    const prev = main.style.overflowY;
    main.scrollTop = 0;
    main.style.overflowY = 'hidden';
    return () => { main.style.overflowY = prev; };
  }, [phase]);

  useEffect(() => {
    if (!socket) return;

    socket.on('car_dash_queue_joined', () => { setPhase('queue'); setStatusMsg('Waiting for opponent…'); });
    socket.on('car_dash_queue_left',   () => { setPhase('lobby'); setStatusMsg(''); });
    socket.on('match_cancelled', ({ message }) => { setPhase('lobby'); setStatusMsg(message || 'Match cancelled.'); });

    socket.on('car_dash_match_found', ({ roomId: rid, opponent: opp, entryFee: fee, currency }) => {
      roomIdRef.current = rid;
      setRoomId(rid);
      setOpponent(opp);
      setMyMs(0); setOppMs(0); setOppCrashed(false); setCrashed(false); setResult(null); crashedRef.current = false;
      setPhase('queue');
      playMatchFound();
      if ((fee ?? 0) > 0) {
        updateProfile(currency === 'diamonds'
          ? { diamonds: Math.max(0, (profile?.diamonds ?? 0) - fee) }
          : { c_coins: Math.max(0, (profile?.c_coins ?? 0) - fee) });
      }
    });

    socket.on('car_dash_countdown', ({ count }) => { setCountdown(count); playCountdown(); });

    socket.on('car_dash_start', ({ seed: s }) => {
      setSeed(s);
      setCountdown(0);
      setPhase('playing');
      playGo();
    });

    socket.on('car_dash_opponent_progress', ({ ms }) => setOppMs(ms));
    socket.on('car_dash_opponent_crashed', ({ ms }) => { setOppMs(ms); setOppCrashed(true); });
    socket.on('car_dash_crashed', ({ ms }) => { setMyMs(ms); setCrashed(true); });

    socket.on('car_dash_result', (data) => {
      if (!roomIdRef.current) return;
      roomIdRef.current = null;
      // Derive pre-match ELO from the server values so the delta is exact
      const iWon = data.winnerId === profileRef.current?.id;
      if (data.newWinnerElo != null) {
        eloBeforeRef.current = iWon ? data.newWinnerElo - 25 : data.newLoserElo + 25;
      }
      setResult(data);
      setPhase('result');
      refreshProfile();
    });

    socket.on('opponent_disconnected', (data = {}) => {
      if (!roomIdRef.current) return;
      roomIdRef.current = null;
      setResult({ ...data, disconnected: true });
      setPhase('result');
      refreshProfile();
    });

    socket.on('error', ({ message }) => { setStatusMsg(message); setPhase('lobby'); });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      [
        'car_dash_queue_joined','car_dash_queue_left','match_cancelled','car_dash_match_found',
        'car_dash_countdown','car_dash_start','car_dash_opponent_progress','car_dash_opponent_crashed',
        'car_dash_crashed','car_dash_result','opponent_disconnected','error',
      ].forEach(e => socket.off(e));
    };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  function joinQueue() {
    eloBeforeRef.current = profile?.elo ?? 1000;
    lastModeRef.current = 'pvp';
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    setStatusMsg('');
    setPhase('queue');
    socket?.emit('join_car_dash_queue', { entryFee, currency: betCurrency });
  }
  function leaveQueue() { socket?.emit('leave_car_dash_queue'); setPhase('lobby'); setStatusMsg(''); }
  function playVsBot() {
    lastModeRef.current = 'bot_paid';
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    socket?.emit('play_car_dash_vs_bot', { entryFee, currency: betCurrency });
  }
  function playVsBotFree() {
    lastModeRef.current = 'bot_free';
    lastSettingsRef.current = { entryFee: 0, currency: 'coins' };
    socket?.emit('play_car_dash_vs_bot', { entryFee: 0, currency: 'coins' });
  }
  function createPrivate(fee, cur) { socket?.emit('create_private_room', { gameType: 'carDash', entryFee: fee, currency: cur }); }
  function joinPrivate(code)       { socket?.emit('join_private_room', { gameType: 'carDash', code }); }

  // Gameplay callbacks from the canvas — the run reports score + time survived.
  const onProgress = (score, ms) => {
    setMyMs(ms);
    if (roomIdRef.current) socket?.emit('car_dash_progress', { roomId: roomIdRef.current, ms, score });
  };
  const onCrash = (score, ms) => {
    if (crashedRef.current) return;
    crashedRef.current = true;
    setCrashed(true);
    if (roomIdRef.current) socket?.emit('car_dash_crash', { roomId: roomIdRef.current, score, ms });
  };

  function reset() {
    setPhase('lobby'); setResult(null); setSeed(null);
    setMyMs(0); setOppMs(0); setCrashed(false); setOppCrashed(false); setStatusMsg(''); crashedRef.current = false;
  }

  // Play Again re-enters whatever mode was just played (PvP queue, paid bot or
  // free bot) instead of dumping the player back at the lobby.
  function playAgain() {
    const mode = lastModeRef.current;
    const { entryFee: fee, currency: cur } = lastSettingsRef.current;
    reset();
    if (!socket || !mode) return;
    eloBeforeRef.current = profile?.elo ?? 1000;
    if (mode === 'pvp') {
      setPhase('queue');
      socket.emit('join_car_dash_queue', { entryFee: fee, currency: cur });
    } else {
      socket.emit('play_car_dash_vs_bot', mode === 'bot_free'
        ? { entryFee: 0, currency: 'coins' }
        : { entryFee: fee, currency: cur });
    }
  }

  // ── Result ──
  if (phase === 'result' && result) {
    const isWinner = result.winnerId === profile?.id;
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-4">
        <ResultScreen
          isWinner={isWinner}
          winnerUsername={result.winnerUsername}
          loserUsername={result.loserUsername}
          newWinnerElo={result.newWinnerElo}
          newLoserElo={result.newLoserElo}
          eloBeforeRef={eloBeforeRef}
          profile={profile}
          balanceChange={result.balanceChange}
          currency={result.currency}
          entryFee={result.entryFee}
          disconnected={result.disconnected}
          // The match is decided on SCORE, with time only breaking a tie, so the
          // score is shown first — otherwise a player who survived longer but
          // scored less has no way to see why they lost.
          extraRows={[
            { label: 'Your Score', value: (isWinner ? result.winnerScore : result.loserScore)?.toLocaleString() },
            { label: 'Opponent Score', value: (isWinner ? result.loserScore : result.winnerScore)?.toLocaleString() },
            { label: 'Your Time', value: fmtTime(isWinner ? result.winnerMs : result.loserMs) },
            { label: 'Opponent Time', value: fmtTime(isWinner ? result.loserMs : result.winnerMs) },
          ].filter(r => r.value !== undefined && r.value !== null)}
          onPlayAgain={playAgain}
          onBackToLobby={reset}
        />
      </div>
    );
  }

  // ── Playing ──
  if (phase === 'playing') {
    return (
      <HighwayCanvas
        seed={seed}
        onProgress={onProgress}
        onCrash={onCrash}
      />
    );
  }

  // ── Queue / countdown ──
  if (phase === 'queue') {
    if (countdown > 0) {
      return (
        <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
          <div className="text-center animate-fade-in">
            <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>{countdown}</div>
            <p className="text-muted">Get ready...</p>
            {opponent && <p className="text-xs text-muted mt-2">vs {opponent.username}</p>}
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching...</h2>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── Lobby (identical UI to every other game) ──
  return (
    <div
      className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-3 sm:px-4 py-0 sm:py-8"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      <GameLobby
        title="🚗 Rush Hour"
        description="Weave through traffic at full speed. Both players get the exact same road — whoever survives the longest wins."
        controls="← → or A/D to change lanes · swipe or tap the sides on mobile"
        betCurrency={betCurrency} setBetCurrency={setBetCurrency}
        entryFee={entryFee} setEntryFee={setEntryFee}
        balance={balance}
        authenticated={authenticated} doAuth={doAuth}
        onQueue={joinQueue}
        onBot={playVsBot}
        onBotFree={playVsBotFree}
        onCreatePrivate={createPrivate}
        onJoinPrivate={joinPrivate}
        statusMsg={statusMsg}
        gameType="carDash"
        liveCount={playerCounts?.['car-dash'] ?? 0}
      />
    </div>
  );
}

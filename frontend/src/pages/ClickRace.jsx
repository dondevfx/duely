import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';

const GAME_DURATION = 10000;
const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

export default function ClickRace() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]           = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]     = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent]     = useState(null);
  const [roomId, setRoomId]         = useState(null);
  const [countdown, setCountdown]   = useState(3);
  const [myClicks, setMyClicks]     = useState(0);
  const [oppClicks, setOppClicks]   = useState(0);
  const [timeLeft, setTimeLeft]     = useState(GAME_DURATION);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');
  const [flash, setFlash]           = useState(false);
  const [privateCode, setPrivateCode] = useState('');
  const [roundScore, setRoundScore] = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult]   = useState(null);

  const roomIdRef    = useRef(null);
  const eloBeforeRef = useRef(null);
  const socketRef    = useRef(null);
  const clicksRef    = useRef(0);       // local click count (no React re-render lag)
  const activeRef    = useRef(false);
  const timerRef     = useRef(null);
  const tapAreaRef   = useRef(null);

  roomIdRef.current = roomId;
  socketRef.current = socket;

  const isDiamonds = betCurrency === 'diamonds';
  const myBalance  = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  const { RejoinOverlay } = useGamePageRejoin('clickRace', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('active'); },
    () => setPhase('lobby'),
  );

  // Socket listeners
  useEffect(() => {
    if (!socket) return;

    socket.on('private_room_created',  ({ code }) => { setPrivateCode(code); setPhase('private_waiting'); });
    socket.on('click_queue_joined',   () => setStatusMsg('Searching for opponent...'));
    socket.on('click_match_found',    ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp || null);
      setPhase('countdown');
    });
    socket.on('click_race_countdown', ({ count }) => {
      setCountdown(count);
      if (count === 3) { setRoundResult(null); activeRef.current = false; clearInterval(timerRef.current); }
    });

    socket.on('click_round_result', ({ round, roundWinnerId, scores }) => {
      const myId = profile?.id;
      activeRef.current = false;
      clearInterval(timerRef.current);
      setRoundResult({ round, won: roundWinnerId === myId, scores });
      setCurrentRound(round + 1);
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('countdown');
    });

    socket.on('click_race_go', () => {
      clicksRef.current = 0;
      activeRef.current = true;
      setMyClicks(0);
      setOppClicks(0);
      setTimeLeft(GAME_DURATION);
      setPhase('active');

      // Local countdown timer (display only — server is authoritative)
      let remaining = GAME_DURATION;
      timerRef.current = setInterval(() => {
        remaining -= 100;
        setTimeLeft(Math.max(0, remaining));
        if (remaining <= 0) clearInterval(timerRef.current);
      }, 100);
    });

    socket.on('click_race_tick', ({ timeLeft: tl, counts }) => {
      setTimeLeft(tl);
      if (opponent) {
        const oppId = opponent.userId;
        if (counts[oppId] !== undefined) setOppClicks(counts[oppId]);
      }
    });

    socket.on('click_race_result', (data) => {
      activeRef.current = false;
      clearInterval(timerRef.current);
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      if (data.scores) {
        const myId = profile?.id;
        setRoundScore({
          me:  data.scores[myId] ?? 0,
          opp: data.scores[Object.keys(data.scores).find(k => k !== myId)] ?? 0,
        });
      }
      setPhase('result');
      refreshProfile();
    });

    socket.on('click_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('opponent_disconnected', (data = {}) => {
      activeRef.current = false;
      clearInterval(timerRef.current);
      const myId = profile?.id;
      const payout = data.winnerPayout ?? null;
      setResult({
        winnerId: data.winnerId || myId,
        loserId: data.loserId,
        disconnected: true,
        balanceChange: payout != null ? { winnerPayout: payout } : undefined,
        currency: data.currency,
      });
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      refreshProfile();
    });
    socket.on('error', ({ message }) => setStatusMsg(message));

    return () => {
      socket.off('private_room_created');
      socket.off('click_queue_joined');
      socket.off('click_match_found');
      socket.off('click_race_countdown');
      socket.off('click_round_result');
      socket.off('click_race_go');
      socket.off('click_race_tick');
      socket.off('click_race_result');
      socket.off('click_rematch_requested');
      socket.off('opponent_disconnected');
      socket.off('error');
    };
  }, [socket, opponent, refreshProfile]);

  // Cleanup timer on unmount
  useEffect(() => () => clearInterval(timerRef.current), []);

  const handleTap = useCallback((e) => {
    e.preventDefault();
    if (!activeRef.current) return;

    clicksRef.current++;
    setMyClicks(clicksRef.current);

    // Emit to server
    const sk = socketRef.current;
    if (sk) sk.emit('click_race_click', { roomId: roomIdRef.current });

    // Flash tap area
    const el = tapAreaRef.current;
    if (el) {
      el.style.background = 'rgba(30,144,255,0.18)';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (el) el.style.background = '';
      }));
    }
  }, []);

  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('join_click_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_click_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_click_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_click_queue');
    setPhase('lobby');
    setStatusMsg('');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'clickRace', entryFee: fee ?? entryFee, currency: cur ?? betCurrency });
  }
  function joinPrivate(code) {
    if (!code?.trim()) return;
    socket.emit('join_private_room', { code: code.trim(), entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room', { code: privateCode });
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }

  function requestRematch() {
    socket.emit('click_rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    activeRef.current = false;
    clearInterval(timerRef.current);
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setMyClicks(0);
    setOppClicks(0);
    setTimeLeft(GAME_DURATION);
    setStatusMsg('');
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
  }

  const isWinner    = result && result.winnerId === profile?.id;
  const pct         = timeLeft / GAME_DURATION;
  const timeColor   = pct > 0.5 ? 'bg-success' : pct > 0.25 ? 'bg-warning' : 'bg-danger';
  const myResult    = result ? result.clicks?.[profile?.id] ?? 0 : 0;
  const oppResult   = result && opponent ? result.clicks?.[opponent.userId] ?? 0 : 0;

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {RejoinOverlay}

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="👆 Click Race"
          description="Tap as fast as you can for 10 seconds — most clicks wins"
          betCurrency={betCurrency}
          setBetCurrency={setBetCurrency}
          entryFee={entryFee}
          setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated}
          doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
        />
      )}

      {/* PRIVATE WAITING */}
      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in max-w-sm w-full">
          <h2 className="text-2xl font-bold text-white mb-2">Room Created</h2>
          <p className="text-muted mb-4">Share this code with your opponent:</p>
          <div className="text-5xl font-black font-mono text-accent tracking-widest mb-2 bg-surface border border-border rounded-xl py-4">{privateCode}</div>
          <button onClick={() => navigator.clipboard.writeText(privateCode)} className="text-xs text-primary hover:underline mb-6 block mx-auto">Copy code</button>
          <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted text-sm mb-4">Waiting for opponent to join...</p>
          <button onClick={cancelPrivate} className="text-xs text-muted hover:text-white transition-colors">Cancel</button>
        </div>
      )}

      {/* ── QUEUE ── */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6 text-sm">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* ── COUNTDOWN ── */}
      {phase === 'countdown' && (
        <div className="flex flex-col items-center animate-fade-in">
          {opponent && (
            <p className="text-muted mb-8 text-lg">
              vs <span className="text-white font-bold">{opponent.username}</span>
              <span className="text-muted ml-2">(ELO {opponent.elo})</span>
            </p>
          )}
          <div className="w-48 h-48 rounded-full border-4 border-primary bg-primary/10 shadow-glow flex items-center justify-center mx-auto">
            <span className="text-7xl font-black text-white">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">Get ready to tap!</p>
        </div>
      )}

      {/* Round overlay */}
      {roundResult && (phase === 'countdown' || phase === 'active') && (
        <div className="fixed inset-0 flex items-center justify-center bg-bg/90 z-40 animate-fade-in">
          <div className="text-center">
            <div className="text-5xl mb-3">{roundResult.won ? '✅' : '❌'}</div>
            <div className={`text-2xl font-black mb-1 ${roundResult.won ? 'text-success' : 'text-danger'}`}>
              Round {roundResult.round} {roundResult.won ? 'Won!' : 'Lost'}
            </div>
            <div className="text-5xl font-black text-white my-3">{roundScore.me} — {roundScore.opp}</div>
            <div className="text-muted text-sm animate-pulse">Next round starting...</div>
          </div>
        </div>
      )}

      {/* ── ACTIVE ── */}
      {phase === 'active' && (
        <div className="flex flex-col items-center gap-4 w-full max-w-lg animate-fade-in">
          <div className="text-xs text-muted">
            Round {currentRound}/3 —{' '}
            <span className="text-white font-bold">{roundScore.me} — {roundScore.opp}</span>
          </div>

          {/* Score row */}
          <div className="flex items-center justify-between w-full px-2">
            <div className="text-center">
              <div className="text-4xl font-black text-white font-mono">{myClicks}</div>
              <div className="text-xs text-muted mt-0.5">You</div>
            </div>
            <div className="text-center">
              <div className={`text-5xl font-black font-mono transition-colors ${pct <= 0.25 ? 'text-danger' : pct <= 0.5 ? 'text-warning' : 'text-accent'}`}>
                {(timeLeft / 1000).toFixed(1)}s
              </div>
              <div className="text-xs text-muted mt-0.5">Remaining</div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-black text-muted font-mono">{oppClicks}</div>
              <div className="text-xs text-muted mt-0.5">{opponent?.username ?? 'Bot'}</div>
            </div>
          </div>

          {/* Timer bar */}
          <div className="w-full h-3 bg-surfaceLight rounded-full overflow-hidden">
            <div
              className={`h-full ${timeColor} rounded-full transition-all duration-100`}
              style={{ width: `${pct * 100}%` }}
            />
          </div>

          {/* Giant tap area */}
          <div
            ref={tapAreaRef}
            onPointerDown={handleTap}
            className="w-full rounded-3xl border-2 border-primary/40 bg-surface select-none touch-none cursor-pointer flex flex-col items-center justify-center gap-5 transition-colors active:bg-primary/10"
            style={{ height: 'clamp(340px, 55vw, 480px)', userSelect: 'none' }}
          >
            <div className="text-8xl pointer-events-none">👆</div>
            <div className="text-white font-bold text-2xl pointer-events-none opacity-60 tracking-wider">
              TAP HERE
            </div>
          </div>

          <p className="text-xs text-muted">Tap as fast as possible!</p>
        </div>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 ${isWinner ? '' : 'grayscale'}`}>
            {isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-2 ${isWinner ? 'text-success' : 'text-danger'}`}>
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}

          {/* Click comparison */}
          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4">
            <div className="flex items-end justify-center gap-8">
              <div className="text-center">
                <div className={`text-5xl font-black font-mono ${isWinner ? 'text-success' : 'text-white'}`}>
                  {myResult}
                </div>
                <div className="text-xs text-muted mt-1">You</div>
              </div>
              <div className="text-muted text-2xl mb-2">vs</div>
              <div className="text-center">
                <div className={`text-5xl font-black font-mono ${!isWinner ? 'text-success' : 'text-white'}`}>
                  {oppResult}
                </div>
                <div className="text-xs text-muted mt-1">{opponent?.username ?? 'Bot'}</div>
              </div>
            </div>
            <div className="text-xs text-muted text-center mt-2">clicks in 10 seconds</div>
          </div>

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-6 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-muted">Series</span>
              <span className="text-white font-bold">{roundScore.me} — {roundScore.opp}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Your ELO</span>
              <span className="text-white font-bold">{(() => {
                const elo = isWinner ? result.newWinnerElo : result.newLoserElo;
                const delta = elo - (eloBeforeRef.current ?? elo);
                return <>{elo} <span className={delta >= 0 ? 'text-success' : 'text-danger'}>({delta >= 0 ? '+' : ''}{delta})</span></>;
              })()}</span>
            </div>
            {result.balanceChange && (
              <div className="flex justify-between">
                <span className="text-muted">{isWinner ? 'Payout' : 'Entry lost'}</span>
                <span className={isWinner ? 'text-success font-bold' : 'text-danger font-bold'}>
                  {isWinner
                    ? `+${resultCurrency === 'diamonds'
                        ? Math.round(result.balanceChange.winnerPayout) + ' 💎'
                        : result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
                    : `-${entryFee} ${resultCurrency === 'diamonds' ? '💎' : '🪙'}`}
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
            {result.isBot
              ? <GlowButton variant="primary" onClick={backToLobby} className="flex-1">Play Again</GlowButton>
              : <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
            }
          </div>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
        </div>
      </div>
      )}
    </div>
  );
}




import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];
const TARGET_COUNT = 5;

function DotProgress({ filled, total, color }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`w-3 h-3 rounded-full border transition-all duration-150 ${
            i < filled
              ? `${color} border-transparent scale-110`
              : 'bg-surfaceLight border-border'
          }`}
        />
      ))}
    </div>
  );
}

export default function AimGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]               = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]         = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent]         = useState(null);
  const [roomId, setRoomId]             = useState(null);
  const [countdown, setCountdown]       = useState(3);
  const [target, setTarget]             = useState(null);
  const [myProgress, setMyProgress]     = useState(0);
  const [oppProgress, setOppProgress]   = useState(0);
  const [clicked, setClicked]           = useState(false);
  const [result, setResult]             = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]       = useState('');
  const [privateCode, setPrivateCode]   = useState('');
  const [roundScore, setRoundScore]     = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult]   = useState(null);

  const roomIdRef    = useRef(null);
  const eloBeforeRef = useRef(null);
  roomIdRef.current = roomId;

  const isDiamonds    = betCurrency === 'diamonds';
  const fees          = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currencyLabel = isDiamonds ? '💎' : '🪙';
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient  = entryFee > 0 && myBalance < entryFee;

  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  useEffect(() => {
    if (!socket) return;

    socket.on('aim_queue_joined',      () => setStatusMsg('Searching for opponent...'));
    socket.on('aim_match_found',       ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      setPhase('countdown');
      setMyProgress(0);
      setOppProgress(0);
      setTarget(null);
    });
    socket.on('aim_countdown',         ({ count }) => {
      setCountdown(count);
      setPhase('countdown');
      if (count === 3) setRoundResult(null);
    });

    socket.on('aim_round_result', ({ round, roundWinnerId, scores }) => {
      const myId = profile?.id;
      setRoundResult({ round, won: roundWinnerId === myId, scores });
      setCurrentRound(round + 1);
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('countdown');
    });
    socket.on('aim_start',             ({ targets }) => {
      setTarget(targets[0]);
      setMyProgress(0);
      setOppProgress(0);
      setClicked(false);
      setPhase('active');
    });
    socket.on('aim_next',              ({ target: t, progress }) => {
      setMyProgress(progress);
      setTarget(t);
      setClicked(false);
    });
    socket.on('aim_opponent_progress', ({ progress }) => setOppProgress(progress));
    socket.on('aim_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('aim_result',            (data) => {
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
      setTarget(null);
      refreshProfile();
    });
    socket.on('opponent_disconnected', (data = {}) => {
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
      setTarget(null);
      setPhase('result');
      refreshProfile();
    });
    socket.on('error',                 ({ message }) => setStatusMsg(message));
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      socket.off('aim_queue_joined');
      socket.off('aim_match_found');
      socket.off('aim_countdown');
      socket.off('aim_round_result');
      socket.off('aim_start');
      socket.off('aim_next');
      socket.off('aim_opponent_progress');
      socket.off('aim_rematch_requested');
      socket.off('aim_result');
      socket.off('opponent_disconnected');
      socket.off('error');
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]);

  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('join_aim_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_aim_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_aim_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_aim_queue');
    setPhase('lobby');
    setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'aim', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'aim', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function handleTargetClick() {
    if (phase !== 'active' || !target || clicked) return;
    setClicked(true);
    setTarget(null); // instant visual feedback — moves immediately
    socket.emit('aim_click', { roomId: roomIdRef.current, targetId: target.id });
  }

  function requestRematch() {
    socket.emit('aim_rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setMyProgress(0);
    setOppProgress(0);
    setTarget(null);
    setStatusMsg('Waiting for opponent...');
  }

  // Fix: clear "Connecting..." if socket authenticates while we're waiting
  useEffect(() => {
    if (authenticated && statusMsg === 'Connecting...') setStatusMsg('');
  }, [authenticated]); // eslint-disable-line

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setTarget(null);
    setMyProgress(0);
    setOppProgress(0);
    setClicked(false);
    setStatusMsg('');
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
  }

  const isWinner = result && result.winnerId === profile?.id;

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🎯 Aim Trainer"
          description="Click all 5 dots as fast as you can — whoever finishes first wins"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated} doAuth={doAuth}
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
        <div className="text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-white mb-2">Private Room Created</h2>
          <p className="text-muted mb-6 text-sm">Share this code with a friend to invite them</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 shadow-glow inline-block min-w-[200px]">
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary" style={{ textShadow: '0 0 20px rgba(30,144,255,0.5)' }}>
              {privateCode}
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(privateCode)}
              className="text-xs text-muted hover:text-primary mt-3 block mx-auto transition-colors"
            >
              📋 Copy to clipboard
            </button>
          </div>
          <p className="text-muted text-sm animate-pulse mb-6">Waiting for opponent to join...</p>
          <GlowButton variant="ghost" onClick={cancelPrivate} className="border border-border">Cancel</GlowButton>
        </div>
      )}

      {/* QUEUE */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6 text-sm">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* COUNTDOWN */}
      {phase === 'countdown' && (
        <div className="flex flex-col items-center animate-fade-in">
          {opponent && (
            <p className="text-muted mb-8 text-lg text-center">
              vs <span className="text-white font-bold">{opponent.username}</span>
              <span className="text-muted ml-2">(ELO {opponent.elo})</span>
            </p>
          )}
          <div className="w-48 h-48 rounded-full border-4 border-primary bg-primary/10 shadow-glow flex items-center justify-center mx-auto">
            <span key={countdown} className="text-7xl font-black text-white animate-countdown-pop">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">Click all {TARGET_COUNT} dots as fast as you can!</p>
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

      {/* ACTIVE */}
      {phase === 'active' && (
        <div className="flex flex-col items-center gap-5 w-full max-w-3xl animate-fade-in">
          {/* Round indicator */}
          <div className="text-xs text-muted">
            Round {currentRound}/3 —{' '}
            <span className="text-white font-bold">{roundScore.me} — {roundScore.opp}</span>
          </div>
          {/* Player progress bars */}
          <div className="w-full grid grid-cols-2 gap-4">
            <div className="bg-surface border border-surfaceLight rounded-xl p-3">
              <div className="text-xs text-muted mb-2 font-semibold">{profile?.username} (you)</div>
              <DotProgress filled={myProgress} total={TARGET_COUNT} color="bg-primary" />
              <div className="text-xs text-primary font-black mt-1">{myProgress} / {TARGET_COUNT}</div>
            </div>
            <div className="bg-surface border border-surfaceLight rounded-xl p-3">
              <div className="text-xs text-muted mb-2 font-semibold">{opponent?.username ?? 'Opponent'}</div>
              <DotProgress filled={oppProgress} total={TARGET_COUNT} color="bg-accent" />
              <div className="text-xs text-accent font-black mt-1">{oppProgress} / {TARGET_COUNT}</div>
            </div>
          </div>

          {/* Play area */}
          <div
            className="relative w-full bg-surface border-2 border-surfaceLight rounded-2xl overflow-hidden cursor-crosshair select-none"
            style={{ height: 'clamp(260px, 55vw, 440px)' }}
          >
            {target ? (
              <button
                onClick={handleTargetClick}
                className="absolute focus:outline-none group"
                style={{
                  left:      `${target.x}%`,
                  top:       `${target.y}%`,
                  transform: 'translate(-50%, -50%)',
                }}
              >
                {/* Outer ring pulse */}
                <span className="absolute inset-0 rounded-full bg-accent/30 animate-ping" />
                {/* Main dot */}
                <span className="relative block w-14 h-14 rounded-full bg-accent border-4 border-white/60 shadow-[0_0_24px_rgba(0,191,255,0.8)] group-hover:scale-110 transition-transform duration-75" />
              </button>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-muted text-sm animate-pulse">
                  {myProgress >= TARGET_COUNT ? 'Done! Waiting...' : 'Get ready...'}
                </p>
              </div>
            )}
          </div>

          <p className="text-xs text-muted">Each dot moves when clicked — click all {TARGET_COUNT} first to win</p>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>
            {isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-4 ${isWinner ? 'text-success' : 'text-danger'}`}>
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}

          {result.finalProgress && (
            <div className="flex justify-center gap-10 mb-4">
              <div className="text-center">
                <DotProgress filled={result.finalProgress[profile?.id] ?? 0} total={TARGET_COUNT} color="bg-primary" />
                <div className="text-xs text-muted mt-1">{profile?.username}</div>
              </div>
              <div className="text-center">
                <DotProgress
                  filled={result.finalProgress[isWinner ? result.loserId : result.winnerId] ?? 0}
                  total={TARGET_COUNT}
                  color="bg-accent"
                />
                <div className="text-xs text-muted mt-1">
                  {isWinner ? result.loserUsername : result.winnerUsername}
                </div>
              </div>
            </div>
          )}

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
                    ? `+${resultCurrency === 'diamonds' ? Math.round(result.balanceChange.winnerPayout) + ' 💎' : result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
                    : `-${entryFee} ${resultCurrency === 'diamonds' ? '💎' : '🪙'}`}
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
            <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
          </div>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
        </div>
      </div>
      )}
    </div>
  );
}




import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import StatusIndicator from '../components/StatusIndicator';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 500, 1000, 5000];
const DIAMOND_FEES = [50, 100, 250, 500, 1000, 10000];

function playGoSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

export default function Game() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();

  const [phase, setPhase]                     = useState('lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const [entryFee, setEntryFee]               = useState(1);
  const [privateCode, setPrivateCode]         = useState('');
  const [opponent, setOpponent]               = useState(null);
  const [roomId, setRoomId]                   = useState(null);
  const [countdown, setCountdown]             = useState(3);
  const [result, setResult]                   = useState(null);
  const [statusMsg, setStatusMsg]             = useState('');
  const [reactionMs, setReactionMs]           = useState(null);
  const [resultCurrency, setResultCurrency]   = useState('coins');
  const [roundScore, setRoundScore]           = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound]       = useState(1);
  const [roundResult, setRoundResult]         = useState(null);

  // Refs — never stale inside callbacks
  const clickedRef  = useRef(false);
  const roomIdRef    = useRef(null);
  const phaseRef     = useRef('lobby');
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);

  roomIdRef.current  = roomId;
  phaseRef.current   = phase;
  profileRef.current = profile;

  const isDiamonds    = betCurrency === 'diamonds';
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  // ── Socket listeners ────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    function onQueueJoined() {
      setStatusMsg('Searching for opponent...');
    }

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      clickedRef.current = false;
      setRoomId(rid);
      setOpponent(opp);
      setEntryFee(fee);
      setRoundScore({ me: 0, opp: 0 });
      setCurrentRound(1);
      setRoundResult(null);
      setResult(null);
      setPhase('countdown');
    }

    function onGameCountdown({ count }) {
      setCountdown(count);
      setPhase('countdown');
      if (count === 3) {
        clickedRef.current = false;
        setRoundResult(null);
      }
    }

    function onGameGo() {
      clickedRef.current = false;
      playGoSound();
      setPhase('go');
    }

    function onRoundResult({ round, roundWinnerId, scores }) {
      const myId = profileRef.current?.id;
      clickedRef.current = false;
      setRoundResult({ round, won: roundWinnerId === myId });
      setCurrentRound(round + 1);
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
    }

    function onGameResult(data) {
      setResult(data);
      setReactionMs(data.reactionTimeMs);
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      refreshProfile();
    }

    function onOpponentDisconnected(data = {}) {
      const myId = profileRef.current?.id;
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
    }

    function onPrivateCreated({ roomId: rid, inviteCode: code }) {
      setRoomId(rid);
      setPrivateCode(code);
      setPhase('private_waiting');
      setStatusMsg('Waiting for opponent to join...');
    }

    function onRematchRequested() {
      setStatusMsg('Opponent wants a rematch!');
    }

    function onError({ message }) {
      setStatusMsg(message);
    }

    socket.on('queue_joined',          onQueueJoined);
    socket.on('match_found',           onMatchFound);
    socket.on('game_countdown',        onGameCountdown);
    socket.on('game_go',               onGameGo);
    socket.on('game_round_result',     onRoundResult);
    socket.on('game_result',           onGameResult);
    socket.on('opponent_disconnected', onOpponentDisconnected);
    socket.on('private_created',       onPrivateCreated);
    socket.on('rematch_requested',     onRematchRequested);
    socket.on('error',                 onError);

    return () => {
      socket.off('queue_joined',          onQueueJoined);
      socket.off('match_found',           onMatchFound);
      socket.off('game_countdown',        onGameCountdown);
      socket.off('game_go',               onGameGo);
      socket.off('game_round_result',     onRoundResult);
      socket.off('game_result',           onGameResult);
      socket.off('opponent_disconnected', onOpponentDisconnected);
      socket.off('private_created',       onPrivateCreated);
      socket.off('rematch_requested',     onRematchRequested);
      socket.off('error',                 onError);
    };
  }, [socket, refreshProfile]);

  // ── Actions ─────────────────────────────────────────────────────────────
  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting... please try again.'); return; }
    socket.emit('join_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_queue');
    setPhase('lobby');
    setStatusMsg('');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('create_private', { entryFee: fee ?? entryFee });
  }

  function joinPrivate(code) {
    if (!code?.trim()) return;
    socket.emit('join_private', { inviteCode: code.trim() });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }

  function cancelPrivate() {
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  const handleClick = useCallback(() => {
    if (phaseRef.current !== 'go') return;
    if (clickedRef.current) return;
    clickedRef.current = true;
    socket.emit('player_click', { roomId: roomIdRef.current });
  }, [socket]);

  function requestRematch() {
    clickedRef.current = false;
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    socket.emit('rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setStatusMsg('');
    setReactionMs(null);
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    clickedRef.current = false;
  }

  const isWinner = result && result.winnerId === profile?.id;

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* ── LOBBY ──────────────────────────────────────────────────────────── */}
      {phase === 'lobby' && (
        <GameLobby
          title="⚡ Reaction Duel"
          description="First to click after GO wins the round"
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

      {/* ── QUEUE ──────────────────────────────────────────────────────────── */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* ── PRIVATE ROOM — waiting for opponent ────────────────────────────── */}
      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in max-w-sm w-full">
          <h2 className="text-2xl font-bold text-white mb-2">Room Created</h2>
          <p className="text-muted mb-4">Share this code with your opponent:</p>
          <div className="text-5xl font-black font-mono text-accent tracking-widest mb-2 bg-surface border border-border rounded-xl py-4">{privateCode}</div>
          <button
            onClick={() => navigator.clipboard.writeText(privateCode)}
            className="text-xs text-primary hover:underline mb-6 block mx-auto"
          >
            Copy code
          </button>
          <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted text-sm mb-4">Waiting for opponent to join...</p>
          <button onClick={cancelPrivate} className="text-xs text-muted hover:text-white transition-colors">Cancel</button>
        </div>
      )}

      {/* ── COUNTDOWN ──────────────────────────────────────────────────────── */}
      {phase === 'countdown' && (
        <div className="flex flex-col items-center animate-fade-in">
          {opponent && (
            <p className="text-muted mb-6 text-lg text-center">
              vs <span className="text-white font-bold">{opponent.username}</span>
              <span className="text-muted ml-2">(ELO {opponent.elo})</span>
            </p>
          )}
          <div className="text-xs text-muted mb-4 text-center">
            Round {currentRound}/3 —{' '}
            <span className="text-white font-bold">{roundScore.me} — {roundScore.opp}</span>
          </div>
          <StatusIndicator state="countdown" countdown={countdown} />
        </div>
      )}

      {/* ── ROUND RESULT OVERLAY ───────────────────────────────────────────── */}
      {roundResult && phase === 'countdown' && (
        <div className="fixed inset-0 flex items-center justify-center bg-bg/90 z-40 animate-fade-in pointer-events-none">
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

      {/* ── GO — click anywhere ────────────────────────────────────────────── */}
      {phase === 'go' && (
        <div
          className="flex flex-col items-center gap-8 cursor-pointer select-none w-full"
          onClick={handleClick}
        >
          {opponent && (
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-4 text-sm text-muted">
                <span className="font-bold text-white">{profile?.username}</span>
                <span>vs</span>
                <span className="font-bold text-white">{opponent.username}</span>
              </div>
              <div className="text-xs text-muted">
                Round {currentRound}/3 —{' '}
                <span className="text-white font-bold">{roundScore.me} — {roundScore.opp}</span>
              </div>
            </div>
          )}
          <StatusIndicator state="go" />
          <p className="text-white font-bold text-lg tracking-wide animate-pulse">CLICK NOW!</p>
          {entryFee > 0 && (
            <div className="text-xs text-muted">
              Prize pool:{' '}
              <span className="text-accent font-bold">
                {resultCurrency === 'diamonds'
                  ? `${Math.round(entryFee * 2)} 💎`
                  : `${(entryFee * 2 * 0.95).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 🪙`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── RESULT ─────────────────────────────────────────────────────────── */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>
            {isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-2 ${isWinner ? 'text-success' : 'text-danger'}`}>
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}

          {reactionMs && isWinner && (
            <p className="text-muted text-sm mb-3">
              Reaction time: <span className="text-white font-mono font-bold">{reactionMs}ms</span>
            </p>
          )}

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-muted">Series</span>
              <span className="text-white font-bold">
                {result.scores?.[profile?.id] ?? 0} — {result.scores?.[result.loserId] ?? 0}
              </span>
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
            <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
          </div>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
        </div>
      </div>
      )}
    </div>
  );
}



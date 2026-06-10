import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];
const SEQ_LEN      = 5;

// Each tile has a dim (default) and bright (lit) class
const TILES = [
  { dim: 'bg-red-900/40 border-red-700/50',     bright: 'bg-red-500 border-red-300' },
  { dim: 'bg-blue-900/40 border-blue-700/50',   bright: 'bg-blue-500 border-blue-300' },
  { dim: 'bg-green-900/40 border-green-700/50', bright: 'bg-green-500 border-green-300' },
  { dim: 'bg-yellow-900/40 border-yellow-700/50', bright: 'bg-yellow-400 border-yellow-200' },
  { dim: 'bg-purple-900/40 border-purple-700/50', bright: 'bg-purple-500 border-purple-300' },
  { dim: 'bg-orange-900/40 border-orange-700/50', bright: 'bg-orange-500 border-orange-300' },
  { dim: 'bg-cyan-900/40 border-cyan-700/50',   bright: 'bg-cyan-500 border-cyan-300' },
  { dim: 'bg-pink-900/40 border-pink-700/50',   bright: 'bg-pink-500 border-pink-300' },
  { dim: 'bg-lime-900/40 border-lime-700/50',   bright: 'bg-lime-500 border-lime-300' },
];

function ProgressBar({ label, progress, color = 'bg-primary' }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-muted mb-1">
        <span>{label}</span>
        <span>{Math.round(progress * 100)}%</span>
      </div>
      <div className="h-2 bg-surfaceLight rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-150`}
          style={{ width: `${Math.min(100, progress * 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function MemoryGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase] = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee] = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [countdown, setCountdown] = useState(3);
  const [litTile, setLitTile] = useState(null);
  const [myProgress, setMyProgress] = useState(0);
  const [opponentProgress, setOpponentProgress] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [result, setResult] = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg] = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [roundScore, setRoundScore] = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult] = useState(null);

  const roomIdRef    = useRef(null);
  const eloBeforeRef = useRef(null);
  const lastTileRef  = useRef(null);
  roomIdRef.current = roomId;

  const isDiamonds = betCurrency === 'diamonds';
  const fees = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currencyLabel = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;

  useEffect(() => {
    setEntryFee(isDiamonds ? 50 : 1);
  }, [betCurrency]);

  useEffect(() => {
    if (!socket) return;

    socket.on('memory_queue_joined', () => setStatusMsg('Searching for opponent...'));

    socket.on('memory_match_found', ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      setPhase('countdown');
      setMyProgress(0);
      setOpponentProgress(0);
      setLitTile(null);
      setFeedback(null);
    });

    socket.on('memory_countdown', ({ count }) => {
      setCountdown(count);
      setPhase('countdown');
      if (count === 3) setRoundResult(null);
    });

    socket.on('memory_round_result', ({ round, roundWinnerId, scores }) => {
      const myId = profile?.id;
      setRoundResult({ round, won: roundWinnerId === myId, scores });
      setCurrentRound(round + 1);
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('countdown');
    });

    socket.on('memory_sequence_start', () => setPhase('watch'));

    socket.on('memory_show', ({ tile }) => setLitTile(tile));
    socket.on('memory_hide', () => setLitTile(null));

    socket.on('memory_go', () => {
      setPhase('active');
      setMyProgress(0);
      setLitTile(null);
    });

    socket.on('memory_correct', ({ pos }) => {
      setMyProgress(pos);
      setFeedback({ tile: lastTileRef.current, type: 'correct' });
      setTimeout(() => setFeedback(null), 200);
    });

    socket.on('memory_wrong', () => {
      setFeedback({ tile: lastTileRef.current, type: 'wrong' });
      setTimeout(() => { setFeedback(null); setMyProgress(0); }, 350);
    });

    socket.on('memory_opponent_progress', ({ progress }) => setOpponentProgress(progress));

    socket.on('memory_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));

    socket.on('memory_result', (data) => {
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
      setPhase('result');
      refreshProfile();
    });
    socket.on('error', ({ message }) => setStatusMsg(message));
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      socket.off('memory_queue_joined');
      socket.off('memory_match_found');
      socket.off('memory_countdown');
      socket.off('memory_round_result');
      socket.off('memory_sequence_start');
      socket.off('memory_show');
      socket.off('memory_hide');
      socket.off('memory_go');
      socket.off('memory_correct');
      socket.off('memory_wrong');
      socket.off('memory_opponent_progress');
      socket.off('memory_rematch_requested');
      socket.off('memory_result');
      socket.off('opponent_disconnected');
      socket.off('error');
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]);

  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('join_memory_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_memory_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_memory_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_memory_queue');
    setPhase('lobby');
    setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'memory', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'memory', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function handleTileClick(tileIndex) {
    if (phase !== 'active') return;
    lastTileRef.current = tileIndex;
    socket.emit('memory_tile_click', { roomId: roomIdRef.current, tileIndex });
  }

  function requestRematch() {
    socket.emit('memory_rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setLitTile(null);
    setMyProgress(0);
    setOpponentProgress(0);
    setFeedback(null);
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
          title="🧠 Memory Match"
          description="Match all pairs faster than your opponent"
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
        <div className="text-center animate-fade-in">
          {opponent && (
            <p className="text-muted mb-8 text-lg">
              vs <span className="text-white font-bold">{opponent.username}</span>
              <span className="text-muted ml-2">(ELO {opponent.elo})</span>
            </p>
          )}
          <div className="w-48 h-48 rounded-full border-4 border-primary bg-primary/10 shadow-glow flex items-center justify-center mx-auto">
            <span key={countdown} className="text-7xl font-black text-white animate-countdown-pop">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">Get ready to watch the sequence...</p>
        </div>
      )}

      {/* Round overlay */}
      {roundResult && (phase === 'countdown' || phase === 'watch' || phase === 'active') && (
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

      {/* WATCH + ACTIVE */}
      {(phase === 'watch' || phase === 'active') && (
        <div className="flex flex-col items-center gap-6 w-full max-w-sm animate-fade-in">
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

          {phase === 'watch' && (
            <p className="text-accent font-semibold animate-pulse">👁 Watch the sequence!</p>
          )}
          {phase === 'active' && (
            <p className="text-white font-semibold">
              Progress:{' '}
              <span className="text-accent font-black font-mono">{myProgress} / {SEQ_LEN}</span>
            </p>
          )}

          {/* 3—3 grid */}
          <div className="grid grid-cols-3 gap-3">
            {TILES.map((tile, i) => {
              const isLit      = litTile === i;
              const isCorrect  = feedback?.tile === i && feedback.type === 'correct';
              const isWrong    = feedback?.tile === i && feedback.type === 'wrong';

              let cls = tile.dim;
              if (isLit)     cls = tile.bright + ' scale-105';
              if (isCorrect) cls = 'bg-green-500 border-green-300 scale-105';
              if (isWrong)   cls = 'bg-red-600 border-red-400 scale-95';

              return (
                <button
                  key={i}
                  onClick={() => handleTileClick(i)}
                  disabled={phase !== 'active'}
                  className={`w-24 h-24 rounded-2xl border-2 transition-all duration-100 ${cls} ${
                    phase === 'active' ? 'cursor-pointer hover:opacity-90 active:scale-95' : 'cursor-default'
                  }`}
                />
              );
            })}
          </div>

          {/* Progress bars */}
          <div className="w-full space-y-2">
            <ProgressBar label="You" progress={myProgress / SEQ_LEN} color="bg-primary" />
            <ProgressBar label={opponent?.username ?? 'Opponent'} progress={opponentProgress} color="bg-accent" />
          </div>
        </div>
      )}

      {/* RESULT */}
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
                    ? resultCurrency === 'diamonds'
                      ? `+${Math.round(result.balanceChange.winnerPayout)} 💎`
                      : <span className="inline-flex items-center gap-1">+{result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <CoinIcon size="0.8em" /></span>
                    : resultCurrency === 'diamonds'
                      ? `-${entryFee} 💎`
                      : <span className="inline-flex items-center gap-1">-{entryFee} <CoinIcon size="0.8em" /></span>}
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




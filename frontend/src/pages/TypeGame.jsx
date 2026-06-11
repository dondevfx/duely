import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.5, 1, 2, 5, 10, 25];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

function calcWpm(charsTyped, startMs) {
  const elapsed = (Date.now() - startMs) / 60000;
  return elapsed > 0 ? Math.round((charsTyped / 5) / elapsed) : 0;
}

function TypeDisplay({ text, position, wrongFlash }) {
  if (!text) return null;
  return (
    <div className="font-mono text-lg leading-relaxed tracking-wide select-none break-words whitespace-pre-wrap">
      {text.split('').map((char, i) => {
        let cls = 'text-muted/50';
        if (i < position) cls = 'text-success';
        else if (i === position) cls = wrongFlash
          ? 'bg-danger/40 text-danger rounded'
          : 'bg-primary/30 text-white rounded animate-pulse';
        return <span key={i} className={cls}>{char}</span>;
      })}
    </div>
  );
}

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

export default function TypeGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase] = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee] = useState(location.state?.entryFee ?? COIN_FEES[Math.floor(COIN_FEES.length / 2)]);
  const [opponent, setOpponent] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [text, setText] = useState('');
  const [position, setPosition] = useState(0);
  const [wrongFlash, setWrongFlash] = useState(false);
  const [opponentProgress, setOpponentProgress] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [result, setResult] = useState(null);
  const [startTime, setStartTime] = useState(null);
  const [wpm, setWpm] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [resultCurrency, setResultCurrency] = useState('coins');

  const roomIdRef    = useRef(null);
  const eloBeforeRef = useRef(null);
  const positionRef  = useRef(0);
  const textRef = useRef('');
  const startTimeRef = useRef(null);
  const wpmInterval = useRef(null);
  const mobileInputRef = useRef(null);

  roomIdRef.current = roomId;
  positionRef.current = position;
  textRef.current = text;
  startTimeRef.current = startTime;

  const isDiamonds = betCurrency === 'diamonds';
  const fees = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currencyLabel = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;

  useEffect(() => {
    setEntryFee(isDiamonds ? DIAMOND_FEES[Math.floor(DIAMOND_FEES.length / 2)] : COIN_FEES[Math.floor(COIN_FEES.length / 2)]);
  }, [betCurrency]);

  useEffect(() => {
    if (!socket) return;

    socket.on('type_queue_joined', () => setStatusMsg('Searching for opponent...'));

    socket.on('type_match_found', ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      setPhase('countdown');
      setPosition(0);
      setOpponentProgress(0);
      setWpm(0);
    });

    socket.on('type_countdown', ({ count }) => setCountdown(count));

    socket.on('type_go', ({ text: t }) => {
      setText(t);
      textRef.current = t;
      setPosition(0);
      positionRef.current = 0;
      const now = Date.now();
      setStartTime(now);
      startTimeRef.current = now;
      setPhase('active');
      wpmInterval.current = setInterval(() => {
        setWpm(calcWpm(positionRef.current, startTimeRef.current));
      }, 500);
    });

    socket.on('type_opponent_progress', ({ progress }) => setOpponentProgress(progress));

    socket.on('type_result', (data) => {
      clearInterval(wpmInterval.current);
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      refreshProfile();
    });

    socket.on('type_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('opponent_disconnected', (data = {}) => {
      const myId = profile?.id;
      const isWin = data.winnerId === myId;
      const payout = data.winnerPayout ?? null;
      setResult({
        winnerId:       data.winnerId || myId,
        loserId:        data.loserId,
        winnerUsername: isWin ? profile?.username : data.winnerUsername,
        loserUsername:  isWin ? data.loserUsername : profile?.username,
        disconnected:   true,
        balanceChange:  payout != null ? { winnerPayout: isWin ? payout : 0 } : undefined,
        entryFee:       data.entryFee,
        currency:       data.currency,
        newWinnerElo:   data.newWinnerElo,
        newLoserElo:    data.newLoserElo,
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
      socket.emit('leave_game');
      socket.off('type_queue_joined');
      socket.off('type_match_found');
      socket.off('type_countdown');
      socket.off('type_go');
      socket.off('type_opponent_progress');
      socket.off('type_result');
      socket.off('type_rematch_requested');
      socket.off('opponent_disconnected');
      socket.off('error');
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]);

  useEffect(() => {
    if (phase !== 'active') return;

    function handleKey(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = textRef.current;
      const pos = positionRef.current;
      if (pos >= t.length) return;

      if (e.key === t[pos]) {
        const newPos = pos + 1;
        positionRef.current = newPos;
        setPosition(newPos);
        setWrongFlash(false);
        socket.emit('type_progress', { roomId: roomIdRef.current, position: newPos });
        if (newPos >= t.length) {
          clearInterval(wpmInterval.current);
          socket.emit('type_complete', { roomId: roomIdRef.current });
        }
      } else if (e.key.length === 1) {
        setWrongFlash(true);
        setTimeout(() => setWrongFlash(false), 300);
      }
    }

    window.addEventListener('keydown', handleKey);
    if (mobileInputRef.current) mobileInputRef.current.focus();
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, socket]);

  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting... try again in a moment.'); return; }
    socket.emit('join_type_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_type_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_type_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_type_queue');
    setPhase('lobby');
    setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'type', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'type', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function requestRematch() {
    socket.emit('type_rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    clearInterval(wpmInterval.current);
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setText('');
    setPosition(0);
    setOpponentProgress(0);
    setWpm(0);
    setStatusMsg('');
    setStartTime(null);
  }

  const myProgress = text ? position / text.length : 0;
  const isWinner = result && result.winnerId === profile?.id;

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-6" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="⌨️ Typing Race"
          description="Race to type the given text faster than your opponent. Accuracy matters — typos slow you down. Fastest accurate typer wins!"
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
          <p className="text-muted mt-6 text-sm">Get ready to type...</p>
        </div>
      )}

      {/* ACTIVE */}
      {phase === 'active' && (
        <div className="w-full max-w-2xl animate-fade-in">
          <div className="mb-6 space-y-3">
            <ProgressBar label={`You${wpm > 0 ? ` — ${wpm} WPM` : ''}`} progress={myProgress} color="bg-primary" />
            <ProgressBar label={opponent?.username ?? 'Opponent'} progress={opponentProgress} color="bg-accent" />
          </div>
          <div
            className="bg-surface border border-border rounded-2xl p-6 mb-4 min-h-[160px] cursor-text"
            onClick={() => mobileInputRef.current?.focus()}
          >
            <TypeDisplay text={text} position={position} wrongFlash={wrongFlash} />
          </div>
          {/* Hidden input brings up mobile keyboard — keydown events bubble to window handler */}
          <input
            ref={mobileInputRef}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            style={{ position: 'absolute', opacity: 0, width: 1, height: 1, top: 0, left: 0, pointerEvents: 'none' }}
          />
          <p className="text-center text-xs text-muted">
            {wrongFlash
              ? <span className="text-danger">Wrong key — type the highlighted character</span>
              : <span className="md:hidden">Tap the text area to open your keyboard</span>}
            <span className="hidden md:inline">
              {wrongFlash ? '' : 'Just start typing — no click needed'}
            </span>
          </p>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className="text-6xl mb-4 animate-pop-in">{isWinner ? '🏆' : '💀'}</div>
          <h2 className={`text-4xl font-black mb-2 ${isWinner ? 'text-success' : 'text-danger'}`}>
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}
          {isWinner && (result.winnerStreak ?? 0) >= 2 && (
            <p className="text-lg font-bold text-orange-400 mb-3" style={{ textShadow: '0 0 10px rgba(251,146,60,0.5)' }}>
              🔥 {result.winnerStreak} Win Streak!
            </p>
          )}
          {isWinner && result.isFirstWin && (
            <div className="mb-4 px-4 py-2 rounded-xl bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 text-sm font-bold">
              🎉 First Victory! You're on the board!
            </div>
          )}
          {!isWinner && !result?.isDraw && (
            <p className="text-sm text-muted italic mb-4">
              {["Just a few words behind — your accuracy will carry you.", "Speed builds with consistency — keep typing.", "Tight race — you're getting faster every match."][Math.floor(Date.now() / 1000) % 3]}
            </p>
          )}

          <div className="bg-surface border border-border rounded-xl p-4 mb-6 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-muted">Your WPM</span>
              <span className="text-white font-bold font-mono">{result.wpm}</span>
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
                <span className={isWinner ? 'text-2xl font-black text-success' : 'text-danger font-bold'}
                  style={isWinner ? { textShadow: '0 0 12px rgba(74,222,128,0.5)' } : {}}>
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

          <GlowButton variant="primary" onClick={requestRematch} className="w-full text-lg py-3">Rematch</GlowButton>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
        </div>
      </div>
      )}
    </div>
  );
}





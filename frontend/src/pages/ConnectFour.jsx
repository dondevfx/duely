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
const ROWS = 6;
const COLS = 7;

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function Cell({ value, myPiece, flash }) {
  let bg = 'bg-slate-700/60';
  if (value === myPiece)  bg = 'bg-primary shadow-[0_0_16px_rgba(30,144,255,0.8)]';
  else if (value !== 0)   bg = 'bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.7)]';
  if (flash)              bg += ' brightness-150';
  return (
    <div className={`w-11 h-11 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-full border-2 border-black/30 transition-all duration-100 ${bg}`} />
  );
}

export default function ConnectFour() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth, requestGameState, playerCounts } = useSocket();
  const location = useLocation();

  const [phase, setPhase]             = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]       = useState(location.state?.entryFee ?? COIN_FEES[Math.floor(COIN_FEES.length / 2)]);
  const [opponent, setOpponent]       = useState(null);
  const [roomId, setRoomId]           = useState(null);
  const [countdown, setCountdown]     = useState(3);
  const [board, setBoard]             = useState(emptyBoard());
  const [myPiece, setMyPiece]         = useState(null);  // 1 or 2
  const [myTurn, setMyTurn]           = useState(false);
  const [hoverCol, setHoverCol]       = useState(null);
  const [lastMove, setLastMove]       = useState(null);
  const [result, setResult]           = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]     = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [timerEndsAt, setTimerEndsAt] = useState(null);
  const [timeLeft, setTimeLeft]       = useState(null);

  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);
  const myUserIdRef  = useRef(null);
  const totalDropsRef = useRef(0);
  roomIdRef.current  = roomId;
  profileRef.current = profile;

  const [turnCount, setTurnCount]     = useState(0);
  const [rowDropMsg, setRowDropMsg]   = useState(false);

  const isDiamonds = betCurrency === 'diamonds';
  const myBalance  = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  useEffect(() => {
    if (!socket) return;

    socket.on('c4_timer', ({ endsAt, currentTurn }) => {
      if (currentTurn === myUserIdRef.current) setTimerEndsAt(endsAt);
      else setTimerEndsAt(null);
    });
    socket.on('private_room_created', ({ code }) => { setPrivateCode(code); setPhase('private_waiting'); });
    socket.on('c4_queue_joined',     () => setStatusMsg('Searching for opponent...'));
    socket.on('c4_match_found',      ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      myUserIdRef.current  = profileRef.current?.id;
      setRoomId(rid);
      setOpponent(opp);
      setPhase('countdown');
      setBoard(emptyBoard());
      setLastMove(null);
      setMyPiece(null);
      setMyTurn(false);
    });
    socket.on('c4_countdown',        ({ count }) => setCountdown(count));
    socket.on('c4_start',            ({ board: b, turn, piece }) => {
      totalDropsRef.current = 0;
      setTurnCount(0);
      setBoard(b);
      setPhase('active');
      const me = myUserIdRef.current;
      setMyPiece(piece?.[me] ?? 1);
      setMyTurn(turn === me);
    });
    socket.on('c4_update',           ({ board: b, lastMove: lm, turn }) => {
      totalDropsRef.current++;

      // Row drop every 15 turns
      setTurnCount(prev => {
        const newCount = prev + 1;
        if (newCount % 15 === 0) {
          // Shift board up: lose top row, add empty row at bottom
          const shifted = [...b.slice(1), Array(COLS).fill(null)];
          setBoard(shifted);
          setRowDropMsg(true);
          setTimeout(() => setRowDropMsg(false), 1500);
        } else {
          setBoard(b);
        }
        return newCount;
      });

      setLastMove(lm);
      const me = myUserIdRef.current;
      setMyTurn(turn === me);
      if (turn !== me) setTimerEndsAt(null);
    });
    socket.on('c4_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('c4_result',           (data) => {
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      setMyTurn(false);
      refreshProfile();
    });
    socket.on('opponent_disconnected', (data = {}) => {
      const myId = profileRef.current?.id;
      const isWin = data.winnerId === myId;
      const payout = data.winnerPayout ?? null;
      setResult({
        winnerId:       data.winnerId || myId,
        loserId:        data.loserId,
        winnerUsername: isWin ? profileRef.current?.username : data.winnerUsername,
        loserUsername:  isWin ? data.loserUsername : profileRef.current?.username,
        disconnected:   true,
        balanceChange:  payout != null ? { winnerPayout: isWin ? payout : 0 } : undefined,
        entryFee:       data.entryFee,
        currency:       data.currency,
        newWinnerElo:   data.newWinnerElo,
        newLoserElo:    data.newLoserElo,
      });
      setResultCurrency(data.currency || 'coins');
      setMyTurn(false);
      setPhase('result');
      refreshProfile();
    });
    socket.on('error',               ({ message }) => setStatusMsg(message));

    return () => {
      socket.emit('leave_game');
      socket.off('c4_timer');
      socket.off('private_room_created');
      socket.off('c4_queue_joined');
      socket.off('c4_match_found');
      socket.off('c4_countdown');
      socket.off('c4_start');
      socket.off('c4_update');
      socket.off('c4_rematch_requested');
      socket.off('c4_result');
      socket.off('opponent_disconnected');
      socket.off('error');
    };
  }, [socket, refreshProfile]);

  // Turn timer countdown
  useEffect(() => {
    if (!timerEndsAt) { setTimeLeft(null); return; }
    const tick = () => setTimeLeft(Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [timerEndsAt]);

  useEffect(() => { if (phase !== 'active') { setTimerEndsAt(null); setTimeLeft(null); } }, [phase]);

  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('join_c4_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_c4_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('play_c4_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_c4_queue');
    setPhase('lobby');
    setStatusMsg('');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'connectfour', entryFee: fee ?? entryFee, currency: cur ?? betCurrency });
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

  function dropPiece(col) {
    if (!myTurn || phase !== 'active') return;
    socket.emit('c4_drop', { roomId: roomIdRef.current, col });
    setMyTurn(false); // optimistic — server confirms via c4_update
  }

  function requestRematch() {
    socket.emit('c4_rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setBoard(emptyBoard());
    setLastMove(null);
    setTurnCount(0);
    setRowDropMsg(false);
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setBoard(emptyBoard());
    setLastMove(null);
    setMyPiece(null);
    setMyTurn(false);
    setHoverCol(null);
    setStatusMsg('');
    totalDropsRef.current = 0;
    setTurnCount(0);
    setRowDropMsg(false);
  }

  const isWinner = result && result.winnerId === profile?.id;

  // Piece color labels for legend
  const myColor  = myPiece === 1 ? 'blue' : 'red';
  const oppColor = myPiece === 1 ? 'red'  : 'blue';

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
          title="🔴 Drop Zone"
          description="Drop pieces to connect 4 in a row — horizontal, vertical, or diagonal wins. Every 15 turns the board shifts down, adding pressure!"
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
          gameType="c4"
          liveCount={playerCounts?.c4 ?? 0}
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
            <span className="text-7xl font-black text-white">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">Get ready to play!</p>
        </div>
      )}

      {/* ACTIVE */}
      {phase === 'active' && (
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          {/* Row drop notification */}
          {rowDropMsg && (
            <div
              className="fixed top-24 left-1/2 z-50 animate-fade-in pointer-events-none select-none"
              style={{ transform: 'translateX(-50%)' }}
            >
              <div
                className="px-5 py-2 rounded-xl font-black text-lg tracking-widest shadow-2xl"
                style={{ background: 'rgba(30,144,255,0.18)', border: '2px solid #1e90ff', color: '#1e90ff', textShadow: '0 0 12px rgba(30,144,255,0.9)' }}
              >
                &#x2B07; ROW DROP!
              </div>
            </div>
          )}

          {/* Player labels */}
          <div className="flex items-center justify-between w-full max-w-lg px-2">
            <div className="flex items-center gap-2 text-sm">
              <div className="w-4 h-4 rounded-full bg-primary" />
              <span className="text-white font-bold">{profile?.username}</span>
              {myTurn && <span className="text-xs text-primary animate-pulse font-bold">← your turn</span>}
            </div>
            <div className="flex items-center gap-2 text-sm">
              {!myTurn && <span className="text-xs text-accent animate-pulse font-bold">their turn →</span>}
              <span className="text-white font-bold">{opponent?.username ?? 'Opponent'}</span>
              <div className="w-4 h-4 rounded-full bg-red-500" />
            </div>
          </div>

          {/* Board — static, no transform */}
          <div>
            <div className="bg-blue-950/60 border-2 border-blue-700/50 rounded-2xl p-2 sm:p-4 shadow-[0_0_40px_rgba(30,144,255,0.15)]">
              {/* Drop indicators — fixed height so board never shifts */}
              <div className="flex gap-2 sm:gap-3 mb-2" style={{ height: '28px' }}>
                {Array.from({ length: COLS }).map((_, col) => (
                  <div key={col} className="flex-1 flex flex-col justify-center items-center">
                  </div>
                ))}
              </div>

              {/* Grid */}
              <div className="flex gap-2 sm:gap-3">
                {Array.from({ length: COLS }).map((_, col) => (
                  <button
                    key={col}
                    onClick={() => dropPiece(col)}
                    onMouseEnter={() => setHoverCol(col)}
                    onMouseLeave={() => setHoverCol(null)}
                    disabled={!myTurn}
                    className={`relative flex flex-col gap-2 sm:gap-3 p-1 rounded-xl transition-colors ${
                      myTurn ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default'
                    }`}
                  >
                    {myTurn && hoverCol === col && (
                      <div className={`absolute -top-5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full ${myPiece === 1 ? 'bg-primary' : 'bg-red-500'} shadow-glow`} />
                    )}
                    {Array.from({ length: ROWS }).map((_, row) => (
                      <Cell
                        key={row}
                        value={board[row]?.[col] ?? 0}
                        myPiece={myPiece}
                        flash={lastMove?.col === col && lastMove?.row === row}
                      />
                    ))}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <p className="text-xs text-muted">
            {myTurn
              ? 'Click a column to drop your piece'
              : `Waiting for ${opponent?.username ?? 'opponent'}...`}
          </p>

          {timeLeft !== null && (
            <div className="w-full max-w-sm">
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: timeLeft <= 10 ? '#f87171' : timeLeft <= 20 ? '#fbbf24' : '#4ade80' }} className="font-bold">
                  ⏱ Your turn: {timeLeft}s
                </span>
              </div>
              <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'rgba(255,255,255,0.1)' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.max(0, (timeLeft / 60) * 100)}%`,
                  background: timeLeft <= 10 ? '#f87171' : timeLeft <= 20 ? '#fbbf24' : '#4ade80',
                  transition: 'width 0.25s linear, background 0.5s',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 ${result.isDraw ? '' : isWinner ? '' : 'grayscale'}`}>
            {result.isDraw ? '🤝' : isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-2 ${
            result.isDraw ? 'text-white' : isWinner ? 'text-success' : 'text-danger'
          }`}>
            {result.isDraw ? "It's a Draw!" : isWinner ? 'You Won!' : 'You Lost!'}
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
              {["One move away — you'll see it next time.", "Close game — your strategy was building.", "Tough one, but your instincts are improving."][Math.floor(Date.now() / 1000) % 3]}
            </p>
          )}

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-6 text-sm space-y-2">
            {!result.isDraw && (
              <div className="flex justify-between">
                <span className="text-muted">Your ELO</span>
                <span className="text-white font-bold">{(() => {
                  const elo = isWinner ? result.newWinnerElo : result.newLoserElo;
                  const delta = elo - (eloBeforeRef.current ?? elo);
                  return <>{elo} <span className={delta >= 0 ? 'text-success' : 'text-danger'}>({delta >= 0 ? '+' : ''}{delta})</span></>;
                })()}</span>
              </div>
            )}
            {result.balanceChange && !result.isDraw && (
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

          <GlowButton variant="primary" onClick={requestRematch} className="w-full">Play Again</GlowButton>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
        </div>
      </div>
      )}
    </div>
  );
}





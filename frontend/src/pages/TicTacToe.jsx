import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

export default function TicTacToe() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth, requestGameState } = useSocket();
  const location = useLocation();

  const [phase, setPhase]             = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]       = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent]       = useState(null);
  const [roomId, setRoomId]           = useState(null);
  const [board, setBoard]             = useState(Array(9).fill(null));
  const [myMark, setMyMark]           = useState(null);
  const [turnUserId, setTurnUserId]   = useState(null);
  const [statusMsg, setStatusMsg]     = useState('');
  const [roundScore, setRoundScore]   = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult] = useState(null);
  const [result, setResult]           = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [lastBoard, setLastBoard]     = useState(null);
  const [privateCode, setPrivateCode] = useState('');
  const [timerEndsAt, setTimerEndsAt] = useState(null);
  const [timeLeft, setTimeLeft]       = useState(null);

  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);
  const myUserIdRef  = useRef(null);
  roomIdRef.current  = roomId;
  profileRef.current = profile;

  const isDiamonds = betCurrency === 'diamonds';
  const myBalance  = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const isMyTurn   = turnUserId === profile?.id;

  const { RejoinOverlay } = useGamePageRejoin('tictactoe', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('game'); },
    () => setPhase('lobby'),
  );

  // Request current game state when navigating back after a rejoin
  useEffect(() => {
    if (location.state?.rejoin && location.state?.roomId && socket) {
      const { roomId: rid } = location.state;
      myUserIdRef.current = profile?.id;
      setRoomId(rid);
      requestGameState(rid, 'tictactoe');
    }
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket) return;

    function onPrivateRoomCreated({ code }) { setPrivateCode(code); setPhase('private_waiting'); }

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee, marks }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      myUserIdRef.current = profileRef.current?.id;
      setRoomId(rid);
      setOpponent(opp);
      setEntryFee(fee);
      setRoundScore({ me: 0, opp: 0 });
      setCurrentRound(1);
      setRoundResult(null);
      setResult(null);
      const myId = profileRef.current?.id;
      setMyMark(marks?.[myId]);
      setPhase('game');
    }

    function onRoundStart({ round, board: b, turnUserId: turn, marks }) {
      setBoard(b);
      setTurnUserId(turn);
      setCurrentRound(round);
      setRoundResult(null);
      setLastBoard(null);
      setPhase('game');
      const myId = profileRef.current?.id;
      if (marks) setMyMark(marks[myId]);
    }

    function onMove({ board: b, turnUserId: turn }) {
      setBoard(b);
      setTurnUserId(turn);
      if (turn !== myUserIdRef.current) setTimerEndsAt(null);
    }

    function onRoundResult({ board: b, round, roundWinnerId, scores }) {
      const myId = profileRef.current?.id;
      setLastBoard(b);
      setBoard(b);
      setTurnUserId(null);
      setRoundResult({ round, won: roundWinnerId === myId });
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('round_result');
    }

    function onRoundDraw({ board: b, round }) {
      setLastBoard(b);
      setBoard(b);
      setTurnUserId(null);
      setRoundResult({ round, draw: true });
      setPhase('round_result');
    }

    function onResult(data) {
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      if (data.scores) {
        const myId = profileRef.current?.id;
        setRoundScore({
          me:  data.scores[myId] ?? 0,
          opp: data.scores[Object.keys(data.scores).find(k => k !== myId)] ?? 0,
        });
      }
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

    function onError({ message }) { setStatusMsg(message); }

    socket.on('ttt_timer', ({ endsAt, currentTurn }) => {
      if (currentTurn === myUserIdRef.current) setTimerEndsAt(endsAt);
      else setTimerEndsAt(null);
    });
    socket.on('private_room_created',  onPrivateRoomCreated);
    socket.on('ttt_match_found',    onMatchFound);
    socket.on('ttt_round_start',    onRoundStart);
    socket.on('ttt_move',           onMove);
    socket.on('ttt_round_result',   onRoundResult);
    socket.on('ttt_round_draw',     onRoundDraw);
    socket.on('ttt_result',         onResult);
    socket.on('opponent_disconnected', onOpponentDisconnected);
    socket.on('error',              onError);

    return () => {
      socket.off('ttt_timer');
      socket.off('private_room_created',  onPrivateRoomCreated);
      socket.off('ttt_match_found',    onMatchFound);
      socket.off('ttt_round_start',    onRoundStart);
      socket.off('ttt_move',           onMove);
      socket.off('ttt_round_result',   onRoundResult);
      socket.off('ttt_round_draw',     onRoundDraw);
      socket.off('ttt_result',         onResult);
      socket.off('opponent_disconnected', onOpponentDisconnected);
      socket.off('error',              onError);
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

  useEffect(() => { if (phase !== 'game') { setTimerEndsAt(null); setTimeLeft(null); } }, [phase]);

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_ttt_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_ttt_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_ttt_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_ttt_queue');
    setPhase('lobby');
    setStatusMsg('');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'ttt', entryFee: fee ?? entryFee, currency: cur ?? betCurrency });
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

  function handleCellClick(i) {
    if (!isMyTurn || phase !== 'game') return;
    if (board[i] !== null) return;
    socket.emit('ttt_move', { roomId, cell: i });
  }

  function requestRematch() {
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    socket.emit('ttt_rematch_request', { roomId });
    setResult(null);
    setPhase('queue');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setBoard(Array(9).fill(null));
    setMyMark(null);
    setTurnUserId(null);
    setStatusMsg('');
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    setLastBoard(null);
  }

  const isWinner = result && result.winnerId === profile?.id;

  function CellMark({ val }) {
    if (!val) return null;
    const isX = val === 'X';
    return (
      <span
        className="text-8xl font-black select-none leading-none"
        style={{
          color: isX ? '#ff2244' : '#1E90FF',
          textShadow: isX
            ? '0 0 12px #ff2244, 0 0 30px #ff224488'
            : '0 0 12px #1E90FF, 0 0 30px #1E90FF88',
        }}
      >
        {val}
      </span>
    );
  }

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
          title="⭕ Tic Tac Toe"
          description="Best of 3 rounds — draws replay the round"
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
          <p className="text-muted mb-6">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* ── GAME ── */}
      {(phase === 'game' || phase === 'round_result') && (
        <div className="flex flex-col items-center gap-6 animate-fade-in w-full max-w-sm">
          {/* Header */}
          <div className="w-full flex items-center justify-between text-sm">
            <div className="text-center">
              <div className="font-bold text-white">{profile?.username}</div>
              <div className="text-2xl font-black" style={{ color: myMark==='X'?'#ff2244':'#1E90FF', textShadow: myMark==='X'?'0 0 10px #ff224488':'0 0 10px #1E90FF88' }}>{myMark}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-black text-white">{roundScore.me} — {roundScore.opp}</div>
              <div className="text-xs text-muted">Round {currentRound}/3</div>
            </div>
            <div className="text-center">
              <div className="font-bold text-white">{opponent?.username}</div>
              <div className="text-2xl font-black" style={{ color: myMark==='X'?'#1E90FF':'#ff2244', textShadow: myMark==='X'?'0 0 10px #1E90FF88':'0 0 10px #ff224488' }}>{myMark === 'X' ? 'O' : 'X'}</div>
            </div>
          </div>

          {/* Turn indicator */}
          {phase === 'game' && (
            <div className={`text-sm font-semibold px-4 py-1.5 rounded-full border ${
              isMyTurn
                ? 'bg-primary/20 border-primary/40 text-primary'
                : 'bg-surface border-border text-muted'
            }`}>
              {isMyTurn ? 'Your turn' : `${opponent?.username}'s turn`}
            </div>
          )}

          {/* Timer bar */}
          {timeLeft !== null && phase === 'game' && (
            <div className="w-full max-w-xs">
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: timeLeft <= 5 ? '#f87171' : timeLeft <= 10 ? '#fbbf24' : '#4ade80' }} className="font-bold">
                  ⏱ Your turn: {timeLeft}s
                </span>
              </div>
              <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'rgba(255,255,255,0.1)' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.max(0, (timeLeft / 20) * 100)}%`,
                  background: timeLeft <= 5 ? '#f87171' : timeLeft <= 10 ? '#fbbf24' : '#4ade80',
                  transition: 'width 0.25s linear, background 0.5s',
                }} />
              </div>
            </div>
          )}

          {/* Round result overlay */}
          {phase === 'round_result' && roundResult && (
            <div className={`text-center px-6 py-3 rounded-xl border ${
              roundResult.draw
                ? 'bg-surface border-border'
                : roundResult.won
                  ? 'bg-success/10 border-success/30'
                  : 'bg-danger/10 border-danger/30'
            }`}>
              <div className="text-2xl font-black mb-1">
                {roundResult.draw
                  ? '🤝 Draw — Replaying'
                  : roundResult.won
                    ? '✅ Round Won!'
                    : '❌ Round Lost'}
              </div>
              <div className="text-xs text-muted animate-pulse">Next round starting...</div>
            </div>
          )}

          {/* Board */}
          <div className="grid grid-cols-3 gap-2 w-full">
            {board.map((cell, i) => (
              <button
                key={i}
                onClick={() => handleCellClick(i)}
                disabled={phase !== 'game' || !isMyTurn || cell !== null}
                className={`aspect-square rounded-xl border-2 flex items-center justify-center transition-all
                  ${cell ? 'border-surfaceLight bg-surface cursor-default'
                    : phase === 'game' && isMyTurn
                      ? 'border-surfaceLight bg-surface hover:border-primary hover:bg-primary/10 cursor-pointer'
                      : 'border-surfaceLight bg-surface cursor-default'}
                `}
              >
                <CellMark val={cell} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 ${isWinner ? '' : 'grayscale'}`}>{isWinner ? '🏆' : '💀'}</div>
          <h2 className={`text-4xl font-black mb-2 ${isWinner ? 'text-success' : 'text-danger'}`}>
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
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
                    ? `+${resultCurrency==='diamonds' ? Math.round(result.balanceChange.winnerPayout)+' 💎' : result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })+' C'}`
                    : `-${entryFee} ${resultCurrency==='diamonds' ? '💎' : '🪙'}`}
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




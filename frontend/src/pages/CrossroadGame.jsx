import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

const CELL     = 54;
const COLS     = 9;
const ROWS_N   = 9;
const CANVAS_W = CELL * COLS;  // 486
const CANVAS_H = CELL * ROWS_N; // 486
const ROAD_ROWS = new Set([1, 2, 3, 5, 6, 7]);

const CAR_CONFIGS = [
  { row: 1, dir:  1, speed: 80,  w: 108, color: '#3498DB' },
  { row: 2, dir: -1, speed: 110, w: 90,  color: '#E74C3C' },
  { row: 3, dir:  1, speed: 140, w: 100, color: '#F39C12' },
  { row: 5, dir: -1, speed: 95,  w: 95,  color: '#9B59B6' },
  { row: 6, dir:  1, speed: 120, w: 85,  color: '#1ABC9C' },
  { row: 7, dir: -1, speed: 85,  w: 100, color: '#E67E22' },
];

function initCars() {
  const cars = [];
  for (const cfg of CAR_CONFIGS) {
    for (let i = 0; i < 2; i++) {
      cars.push({ row: cfg.row, x: i * (CANVAS_W / 2), dir: cfg.dir, speed: cfg.speed, w: cfg.w, color: cfg.color });
    }
  }
  return cars;
}

function checkHit(player, cars) {
  if (!ROAD_ROWS.has(player.row)) return false;
  const px1 = player.col * CELL + 6;
  const px2 = px1 + CELL - 12;
  return cars.some(car => car.row === player.row && px1 < car.x + car.w && px2 > car.x);
}

export default function CrossroadGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();

  const [phase, setPhase]           = useState('lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const [entryFee, setEntryFee]     = useState(1);
  const [privateCode, setPrivateCode] = useState('');
  const [opponent, setOpponent]     = useState(null);
  const [roomId, setRoomId]         = useState(null);
  const [countdown, setCountdown]   = useState(null);
  const [roundScore, setRoundScore] = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult] = useState(null);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');

  const canvasRef   = useRef(null);
  const playerRef   = useRef({ row: 8, col: 4 });
  const carsRef     = useRef(initCars());
  const oppRowRef   = useRef(8);
  const lastTimeRef = useRef(null);
  const rafRef      = useRef(null);
  const activeRef   = useRef(false);
  const crossedRef  = useRef(false);
  const coolRef     = useRef(0);
  const roomIdRef   = useRef(null);
  const profileRef  = useRef(profile);
  const phaseRef    = useRef(phase);

  roomIdRef.current  = roomId;
  profileRef.current = profile;
  phaseRef.current   = phase;

  const isDiamonds   = betCurrency === 'diamonds';
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const isWinner     = result && result.winnerId === profile?.id;

  // ── Draw ────────────────────────────────────────────────────────────
  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    for (let r = 0; r < ROWS_N; r++) {
      const y = r * CELL;
      ctx.fillStyle = (r === 0 || r === 4 || r === 8) ? '#1e6b38' : '#3d3d3d';
      ctx.fillRect(0, y, CANVAS_W, CELL);

      // Road lane lines
      if (ROAD_ROWS.has(r) && r !== 3 && r !== 7) {
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.setLineDash([20, 16]);
        ctx.beginPath();
        ctx.moveTo(0, y + CELL);
        ctx.lineTo(CANVAS_W, y + CELL);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Labels
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GOAL ★', CANVAS_W / 2, CELL / 2 + 5);
    ctx.fillStyle = '#aaa';
    ctx.font = '11px sans-serif';
    ctx.fillText('START', CANVAS_W / 2, CANVAS_H - CELL / 2 + 5);

    // Opponent row highlight
    const oRow = oppRowRef.current;
    ctx.fillStyle = 'rgba(255,80,80,0.18)';
    ctx.fillRect(0, oRow * CELL, CANVAS_W, CELL);
    ctx.fillStyle = '#ff8888';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('OPP', 5, oRow * CELL + 16);

    // Cars
    for (const car of carsRef.current) {
      const y = car.row * CELL;
      ctx.fillStyle = car.color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(car.x, y + 7, car.w, CELL - 14, 6);
      else ctx.rect(car.x, y + 7, car.w, CELL - 14);
      ctx.fill();
      // Windshield
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      const ww = Math.min(16, (car.w - 20) / 2);
      ctx.fillRect(car.x + 8, y + 13, ww, CELL - 26);
      ctx.fillRect(car.x + car.w - 8 - ww, y + 13, ww, CELL - 26);
    }

    // Player
    const p = playerRef.current;
    const px = p.col * CELL + CELL / 2;
    const py = p.row * CELL + CELL / 2;
    ctx.fillStyle = '#00BFFF';
    ctx.beginPath();
    ctx.arc(px, py, CELL / 2 - 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Eyes
    ctx.fillStyle = '#fff';
    [[px - 7, py - 5], [px + 7, py - 5]].forEach(([ex, ey]) => {
      ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
    });
  }

  // ── RAF loop ─────────────────────────────────────────────────────────
  function gameLoop(ts) {
    if (!activeRef.current) return;
    if (lastTimeRef.current === null) lastTimeRef.current = ts;
    const dt = Math.min((ts - lastTimeRef.current) / 1000, 0.1);
    lastTimeRef.current = ts;

    carsRef.current = carsRef.current.map(car => {
      let x = car.x + car.dir * car.speed * dt;
      if (car.dir === 1 && x > CANVAS_W) x = -car.w;
      if (car.dir === -1 && x + car.w < 0) x = CANVAS_W;
      return { ...car, x };
    });

    if (checkHit(playerRef.current, carsRef.current)) {
      playerRef.current = { row: 8, col: 4 };
    }

    draw();
    rafRef.current = requestAnimationFrame(gameLoop);
  }

  function startGame() {
    activeRef.current  = true;
    crossedRef.current = false;
    playerRef.current  = { row: 8, col: 4 };
    carsRef.current    = initCars();
    lastTimeRef.current = null;
    oppRowRef.current  = 8;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(gameLoop);
  }

  function stopGame() {
    activeRef.current = false;
    cancelAnimationFrame(rafRef.current);
  }

  useEffect(() => {
    if (phase === 'game') {
      const t = setTimeout(startGame, 80);
      return () => { clearTimeout(t); stopGame(); };
    }
    return stopGame;
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Socket events
  useEffect(() => {
    if (!socket) return;

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee }) {
      setRoomId(rid);
      setOpponent(opp);
      if (fee !== undefined) setEntryFee(fee);
      setRoundScore({ me: 0, opp: 0 });
      setCurrentRound(1);
      setRoundResult(null);
      setResult(null);
      setPhase('countdown');
    }

    function onCountdown({ count }) { setCountdown(count); setPhase('countdown'); }

    function onRoundStart({ round }) {
      setCurrentRound(round);
      setCountdown(null);
      setRoundResult(null);
      crossedRef.current = false;
      playerRef.current  = { row: 8, col: 4 };
      oppRowRef.current  = 8;
      setPhase('game');
    }

    function onOppProgress({ row }) { oppRowRef.current = row; }

    function onRoundResult({ round, roundWinnerId, scores }) {
      const myId = profileRef.current?.id;
      setRoundResult({ round, won: roundWinnerId === myId });
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('round_result');
      stopGame();
    }

    function onResult(data) {
      const myId = profileRef.current?.id;
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      if (data.scores) {
        setRoundScore({
          me:  data.scores[myId] ?? 0,
          opp: data.scores[Object.keys(data.scores).find(k => k !== myId)] ?? 0,
        });
      }
      setPhase('result');
      stopGame();
      refreshProfile();
    }

    function onPrivateRoomCreated({ code }) { setPrivateCode(code); setPhase('private_waiting'); }
    function onDisconnect(data = {}) {
      stopGame();
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
      setPhase('result');
      refreshProfile();
    }
    function onError({ message }) { setStatusMsg(message); }

    socket.on('private_room_created',        onPrivateRoomCreated);
    socket.on('crossroad_match_found',       onMatchFound);
    socket.on('crossroad_countdown',         onCountdown);
    socket.on('crossroad_round_start',       onRoundStart);
    socket.on('crossroad_opponent_progress', onOppProgress);
    socket.on('crossroad_round_result',      onRoundResult);
    socket.on('crossroad_result',            onResult);
    socket.on('opponent_disconnected',       onDisconnect);
    socket.on('error',                       onError);

    return () => {
      socket.off('private_room_created',        onPrivateRoomCreated);
      socket.off('crossroad_match_found',       onMatchFound);
      socket.off('crossroad_countdown',         onCountdown);
      socket.off('crossroad_round_start',       onRoundStart);
      socket.off('crossroad_opponent_progress', onOppProgress);
      socket.off('crossroad_round_result',      onRoundResult);
      socket.off('crossroad_result',            onResult);
      socket.off('opponent_disconnected',       onDisconnect);
      socket.off('error',                       onError);
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard
  useEffect(() => {
    if (phase !== 'game') return;
    const DIR_MAP = {
      ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
      w:'up', a:'left', s:'down', d:'right',
    };
    function onKey(e) {
      const dir = DIR_MAP[e.key];
      if (!dir) return;
      e.preventDefault();
      movePlayer(dir);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function movePlayer(dir) {
    if (phaseRef.current !== 'game' || crossedRef.current) return;
    const now = Date.now();
    if (now - coolRef.current < 160) return;
    coolRef.current = now;

    const p = { ...playerRef.current };
    if (dir === 'up')    p.row = Math.max(0, p.row - 1);
    if (dir === 'down')  p.row = Math.min(8, p.row + 1);
    if (dir === 'left')  p.col = Math.max(0, p.col - 1);
    if (dir === 'right') p.col = Math.min(8, p.col + 1);
    playerRef.current = p;

    if (p.row === 0 && !crossedRef.current) {
      crossedRef.current = true;
      socket?.emit('crossroad_crossed', { roomId: roomIdRef.current });
    } else {
      socket?.emit('crossroad_progress', { roomId: roomIdRef.current, row: p.row });
    }
  }

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_crossroad_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_crossroad_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_crossroad_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() { socket.emit('leave_crossroad_queue'); setPhase('lobby'); setStatusMsg(''); }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'crossroad', entryFee: fee ?? entryFee, currency: cur ?? betCurrency });
  }

  function joinPrivate(code) {
    if (!code?.trim()) return;
    socket.emit('join_private_room', { code: code.trim(), entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }

  function cancelPrivate() {
    socket.emit('cancel_private_room', { code: privateCode });
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function requestRematch() {
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    setResult(null);
    socket.emit('crossroad_rematch_request', { roomId });
    setPhase('queue');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    stopGame();
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setStatusMsg('');
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
  }

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🚦 Crossroad"
          description="Dodge cars and cross the road first — best of 3"
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
          controls="Arrow keys or WASD — reach the green zone to win the round"
        />
      )}

      {/* PRIVATE WAITING */}
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

      {/* QUEUE */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* COUNTDOWN */}
      {phase === 'countdown' && (
        <div className="text-center animate-fade-in">
          {countdown !== null ? (
            <>
              <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1E90FF' }}>
                {countdown}
              </div>
              <p className="text-muted">Get ready...</p>
            </>
          ) : (
            <>
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-muted">Match found! Starting...</p>
            </>
          )}
        </div>
      )}

      {/* GAME / ROUND_RESULT */}
      {(phase === 'game' || phase === 'round_result') && (
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          {/* Score header */}
          <div className="flex items-center justify-between w-full" style={{ maxWidth: CANVAS_W }}>
            <div className="text-center">
              <div className="text-xs text-muted mb-0.5">{profile?.username}</div>
              <div className="text-xl font-black text-primary">{roundScore.me}</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-black text-white">{roundScore.me} — {roundScore.opp}</div>
              <div className="text-xs text-muted">Round {currentRound}/3</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted mb-0.5">{opponent?.username || 'Bot'}</div>
              <div className="text-xl font-black text-accent">{roundScore.opp}</div>
            </div>
          </div>

          {phase === 'round_result' && roundResult && (
            <div className={`text-center px-6 py-2 rounded-xl border ${
              roundResult.won ? 'bg-success/10 border-success/30' : 'bg-danger/10 border-danger/30'
            }`}>
              <div className="font-black">{roundResult.won ? '✅ Round Won!' : '❌ Round Lost'}</div>
              <div className="text-xs text-muted animate-pulse">Next round starting...</div>
            </div>
          )}

          <div className="relative">
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="rounded-xl border border-border block"
              style={{ maxWidth: '95vw', maxHeight: '65vh' }}
            />
            {phase === 'round_result' && (
              <div className="absolute inset-0 bg-bg/50 rounded-xl" />
            )}
          </div>

          {/* Mobile D-pad */}
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3,3rem)', gridTemplateRows: 'repeat(3,3rem)' }}>
            <div />
            <button onPointerDown={() => movePlayer('up')}
              className="bg-surface border border-border rounded-lg flex items-center justify-center text-xl font-bold active:bg-primary/20">↑</button>
            <div />
            <button onPointerDown={() => movePlayer('left')}
              className="bg-surface border border-border rounded-lg flex items-center justify-center text-xl font-bold active:bg-primary/20">←</button>
            <button onPointerDown={() => movePlayer('down')}
              className="bg-surface border border-border rounded-lg flex items-center justify-center text-xl font-bold active:bg-primary/20">↓</button>
            <button onPointerDown={() => movePlayer('right')}
              className="bg-surface border border-border rounded-lg flex items-center justify-center text-xl font-bold active:bg-primary/20">→</button>
          </div>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>{isWinner ? '🏆' : '💀'}</div>
          <h2 className={`text-4xl font-black mb-2 animate-pop-in ${isWinner ? 'text-success' : 'text-danger'}`} style={{ animationDelay: '0.1s' }}>
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
              <span className="text-white font-bold">{isWinner ? result.newWinnerElo : result.newLoserElo}</span>
            </div>
            {result.balanceChange && (
              <div className="flex justify-between">
                <span className="text-muted">{isWinner ? 'Winnings' : 'Entry lost'}</span>
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




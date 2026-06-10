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
const ROUNDS = 3;

// Rings from center outward — dist in 0—50 units (50 = board edge)
const RINGS = [
  { name: 'bullseye', maxDist:  4, score: 100, fill: '#dc2626' },
  { name: 'bull',     maxDist: 10, score: 75,  fill: '#7f1d1d' },
  { name: 'treble',   maxDist: 20, score: 60,  fill: '#166534' },
  { name: 'inner',    maxDist: 30, score: 45,  fill: '#854d0e' },
  { name: 'double',   maxDist: 40, score: 30,  fill: '#1e3a8a' },
  { name: 'outer',    maxDist: 50, score: 15,  fill: '#1e293b' },
];

const RING_LABELS = {
  bullseye: 'BULLSEYE! +100',
  bull:     'Bull +75',
  treble:   'Treble +60',
  inner:    'Inner +45',
  double:   'Double +30',
  outer:    'Outer +15',
  miss:     'Miss +0',
};

const RING_COLORS = {
  bullseye: '#ef4444',
  bull:     '#f87171',
  treble:   '#22c55e',
  inner:    '#f59e0b',
  double:   '#60a5fa',
  outer:    '#94a3b8',
  miss:     '#374151',
};

// Color to show on slider indicator based on current position (matches ring colors)
function ringColorAt(value) {
  const dist = Math.abs(value - 50);
  if (dist <  4) return '#ef4444'; // bullseye
  if (dist < 10) return '#f87171'; // bull
  if (dist < 20) return '#22c55e'; // treble
  if (dist < 30) return '#f59e0b'; // inner
  if (dist < 40) return '#60a5fa'; // double
  return '#94a3b8';                // outer/miss
}

// Gradient that visually maps ring zones left→right (center=50% = bullseye)
const BAR_GRADIENT_H = `linear-gradient(to right,
  #0f172a 0%, #0f172a 7%,
  #1e3a8a 10%, #1e3a8a 18%,
  #854d0e 20%, #854d0e 28%,
  #166534 30%, #166534 38%,
  #7f1d1d 40%, #7f1d1d 44%,
  #dc2626 46%, #dc2626 54%,
  #7f1d1d 56%, #7f1d1d 60%,
  #166534 62%, #166534 70%,
  #854d0e 72%, #854d0e 80%,
  #1e3a8a 82%, #1e3a8a 90%,
  #0f172a 93%, #0f172a 100%)`;

const BAR_GRADIENT_V = `linear-gradient(to bottom,
  #0f172a 0%, #0f172a 7%,
  #1e3a8a 10%, #1e3a8a 18%,
  #854d0e 20%, #854d0e 28%,
  #166534 30%, #166534 38%,
  #7f1d1d 40%, #7f1d1d 44%,
  #dc2626 46%, #dc2626 54%,
  #7f1d1d 56%, #7f1d1d 60%,
  #166534 62%, #166534 70%,
  #854d0e 72%, #854d0e 80%,
  #1e3a8a 82%, #1e3a8a 90%,
  #0f172a 93%, #0f172a 100%)`;

function DartBoard({ shots, size = 240 }) {
  const C  = size / 2;
  const sc = C / 50;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ filter: 'drop-shadow(0 0 20px rgba(0,0,0,0.8))', maxWidth: '100%', height: 'auto' }}>
      <circle cx={C} cy={C} r={C - 2} fill="#0f172a" stroke="#334155" strokeWidth="2" />
      {[...RINGS].reverse().map(ring => (
        <circle key={ring.name} cx={C} cy={C} r={ring.maxDist * sc} fill={ring.fill} />
      ))}
      {RINGS.map((ring, i) => {
        const inner = i > 0 ? RINGS[i - 1].maxDist : 0;
        const midR  = ((ring.maxDist + inner) / 2) * sc;
        if (midR < 10) return null;
        return (
          <text key={ring.name} x={C} y={C - midR + 5}
            fill="rgba(255,255,255,0.55)" fontSize={Math.max(7, Math.min(11, midR * 0.32))}
            textAnchor="middle" fontWeight="bold" fontFamily="monospace">
            {ring.score}
          </text>
        );
      })}
      <line x1={C} y1={6} x2={C} y2={size - 6} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
      <line x1={6} y1={C} x2={size - 6} y2={C}  stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
      {RINGS.map(r => (
        <circle key={`sep-${r.name}`} cx={C} cy={C} r={r.maxDist * sc}
          fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
      ))}
      <circle cx={C} cy={C} r={2.5} fill="white" />
      {shots.map((shot, i) => {
        let sx = shot.x, sy = shot.y;
        const dist = Math.sqrt((sx - 50) ** 2 + (sy - 50) ** 2);
        if (dist > 49) {
          const ang = Math.atan2(sy - 50, sx - 50);
          sx = 50 + Math.cos(ang) * 49;
          sy = 50 + Math.sin(ang) * 49;
        }
        const px = C + (sx - 50) * sc;
        const py = C + (sy - 50) * sc;
        return (
          <g key={i}>
            <circle cx={px} cy={py} r={shot.fresh ? 7 : 5} fill={shot.color} stroke="white" strokeWidth="1.5"
              style={{ filter: `drop-shadow(0 0 5px ${shot.color})` }} />
            {shot.fresh && (
              <circle cx={px} cy={py} r={13} fill="none" stroke={shot.color} strokeWidth="1.5" opacity="0.5" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function AimBar({ value, locked }) {
  const color = ringColorAt(value);
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex justify-between items-center">
        <span className="text-xs font-semibold text-muted uppercase tracking-widest">← Aim →</span>
        {locked
          ? <span className="text-xs font-bold" style={{ color }}>Locked {Math.round(value)}%</span>
          : <span className="text-xs text-accent animate-pulse font-semibold">Click to stop</span>
        }
      </div>
      <div className="relative h-12 w-full max-w-xs sm:max-w-none rounded-xl border border-slate-700 overflow-hidden"
        style={{ background: BAR_GRADIENT_H, opacity: locked ? 0.7 : 1 }}>
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
        <div className="absolute top-1/2 w-10 h-10 rounded-full border-2 border-white/90"
          style={{
            left: `${value}%`,
            transform: 'translate(-50%, -50%)',
            backgroundColor: color + 'bb',
            boxShadow: `0 0 20px ${color}`,
            transition: 'none',
          }} />
      </div>
    </div>
  );
}

function PowerBar({ value, locked }) {
  const color = ringColorAt(value);
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex justify-between items-center w-full">
        <span className="text-xs font-semibold text-muted uppercase tracking-widest">↕ Power</span>
        {locked
          ? <span className="text-xs font-bold" style={{ color }}>Locked {Math.round(value)}%</span>
          : <span className="text-xs text-accent animate-pulse font-semibold">Click to stop</span>
        }
      </div>
      <div className="relative h-56 w-12 rounded-xl border border-slate-700 overflow-hidden"
        style={{ background: BAR_GRADIENT_V, opacity: locked ? 0.7 : 1 }}>
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/20" />
        <div className="absolute left-1/2 w-10 h-10 rounded-full border-2 border-white/90"
          style={{
            top: `${value}%`,
            transform: 'translate(-50%, -50%)',
            backgroundColor: color + 'bb',
            boxShadow: `0 0 20px ${color}`,
            transition: 'none',
          }} />
      </div>
    </div>
  );
}

export default function DartGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]             = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]       = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent]       = useState(null);
  const [roomId, setRoomId]           = useState(null);
  const [countdown, setCountdown]     = useState(3);

  const [round, setRound]             = useState(0);
  const [shotPhase, setShotPhase]     = useState('aim'); // 'aim' | 'power' | 'waiting'
  const [aimVal, setAimVal]           = useState(50);
  const [powerVal, setPowerVal]       = useState(50);
  const [frozenAim, setFrozenAim]     = useState(null);
  const [speed, setSpeed]             = useState(90);
  const [opponentThrew, setOpponentThrew] = useState(false);
  const [roundBanner, setRoundBanner] = useState(null); // { myRing, oppRing, totals }
  const [totals, setTotals]           = useState({});
  const [allShots, setAllShots]       = useState([]);
  const [pendingShot, setPendingShot] = useState(null);
  const [result, setResult]           = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]     = useState('');
  const [privateCode, setPrivateCode] = useState('');

  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);
  const posRef       = useRef(50);
  const dirRef       = useRef(1);
  const animRef      = useRef(null);
  const frozenAimRef = useRef(null);
  roomIdRef.current    = roomId;
  profileRef.current   = profile;
  frozenAimRef.current = frozenAim;

  const isDiamonds    = betCurrency === 'diamonds';
  const fees          = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currencyLabel = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient  = entryFee > 0 && myBalance < entryFee;

  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  // Animation re-runs when shotPhase changes — this is the fix for the power bar bug
  useEffect(() => {
    if (phase !== 'shooting' || shotPhase === 'waiting') {
      cancelAnimationFrame(animRef.current);
      return;
    }
    posRef.current = 50;
    dirRef.current = 1;
    let last = performance.now();

    function tick(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      posRef.current += dirRef.current * speed * dt;
      if (posRef.current >= 100) { posRef.current = 100; dirRef.current = -1; }
      if (posRef.current <= 0)   { posRef.current = 0;   dirRef.current =  1; }
      if (shotPhase === 'aim') setAimVal(posRef.current);
      else                     setPowerVal(posRef.current);
      animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [phase, shotPhase, speed, round]);

  useEffect(() => {
    if (!socket) return;

    socket.on('dart_queue_joined',   () => setStatusMsg('Searching for opponent...'));
    socket.on('dart_match_found',    ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid); setOpponent(opp);
      setPhase('countdown'); setAllShots([]); setTotals({});
    });
    socket.on('dart_countdown',      ({ count }) => setCountdown(count));
    socket.on('dart_round_start',    ({ round: r, speed: s }) => {
      setRound(r); setSpeed(s);
      setShotPhase('aim'); setAimVal(50); setPowerVal(50);
      setFrozenAim(null); frozenAimRef.current = null;
      setOpponentThrew(false); setPendingShot(null); setRoundBanner(null);
      setPhase('shooting');
    });
    socket.on('dart_player_threw',   ({ userId }) => {
      if (userId !== profileRef.current?.id) setOpponentThrew(true);
    });
    socket.on('dart_round_result',   (data) => {
      setTotals(data.totals);
      const me = profileRef.current?.id;
      const newShots = Object.entries(data.results).map(([uid, r]) => ({
        x: r.xAim, y: r.yPower,
        color: uid === me ? '#3b82f6' : '#ef4444',
        fresh: true,
      }));
      setAllShots(prev => prev.map(s => ({ ...s, fresh: false })).concat(newShots));
      setPendingShot(null);
      // Show result banner inline (no phase change — board stays visible)
      const myRes  = data.results[me];
      const oppRes = Object.entries(data.results).find(([uid]) => uid !== me)?.[1];
      setRoundBanner({ myRing: myRes?.ring, oppRing: oppRes?.ring, totals: data.totals });
    });
    socket.on('dart_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('dart_result',         (data) => {
      setResult(data); setResultCurrency(data.currency || 'coins');
      setPhase('result'); refreshProfile();
    });
    socket.on('opponent_disconnected', (data = {}) => {
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
    });
    socket.on('error',               ({ message }) => setStatusMsg(message));
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      ['dart_queue_joined','dart_match_found','dart_countdown','dart_round_start',
       'dart_player_threw','dart_round_result','dart_rematch_requested','dart_result',
       'opponent_disconnected','error','private_room_created'].forEach(e => socket.off(e));
    };
  }, [socket, refreshProfile]);

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_dart_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_dart_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_dart_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting free match...');
  }
  function leaveQueue() {
    socket.emit('leave_dart_queue'); setPhase('lobby'); setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'darts', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'darts', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function handleClick() {
    if (phase !== 'shooting' || roundBanner) return;
    if (shotPhase === 'aim') {
      const locked = posRef.current;
      setFrozenAim(locked);
      frozenAimRef.current = locked;
      setShotPhase('power');
    } else if (shotPhase === 'power') {
      const lockedPower = posRef.current;
      setShotPhase('waiting');
      setPendingShot({ x: frozenAimRef.current, y: lockedPower, color: '#3b82f6', fresh: true });
      socket.emit('dart_shoot', {
        roomId: roomIdRef.current,
        xAim:   frozenAimRef.current,
        yPower: lockedPower,
      });
    }
  }

  function requestRematch() {
    socket.emit('dart_rematch_request', { roomId });
    setResult(null); setPhase('countdown');
    setAllShots([]); setTotals({}); setRoundBanner(null);
    setStatusMsg('Waiting for opponent...');
  }
  function backToLobby() {
    setPhase('lobby'); setResult(null); setOpponent(null); setRoomId(null);
    setAllShots([]); setTotals({}); setRoundBanner(null); setStatusMsg('');
  }

  const isWinner   = result && result.winnerId === profile?.id;
  const me         = profile?.id;
  const boardShots = pendingShot
    ? [...allShots.map(s => ({ ...s, fresh: false })), pendingShot]
    : allShots;

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      onClick={phase === 'shooting' ? handleClick : undefined}
      style={{ cursor: phase === 'shooting' && !roundBanner ? 'crosshair' : 'default', opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🎯 Darts"
          description="Aim and shoot at the dartboard — highest score wins"
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
              vs <span className="text-white font-bold">{opponent.username}</span>{' '}
              <span className="text-muted">(ELO {opponent.elo})</span>
            </p>
          )}
          <div className="w-48 h-48 rounded-full border-4 border-primary bg-primary/10 shadow-glow flex items-center justify-center mx-auto">
            <span key={countdown} className="text-7xl font-black text-white animate-countdown-pop">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">Click to stop each bar at the center!</p>
        </div>
      )}

      {/* SHOOTING — shown for entire round (including inter-round wait) */}
      {phase === 'shooting' && (
        <div className="flex flex-col items-center gap-5 animate-fade-in select-none w-full max-w-3xl">

          {/* Round header */}
          <div className="flex items-center justify-between w-full px-1">
            <div className="text-center">
              <div className="text-xs text-muted mb-0.5">Round</div>
              <div className="text-2xl font-black text-white">
                {round} <span className="text-muted text-base">/ {ROUNDS}</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted mb-0.5">Step</div>
              <div className="text-sm font-bold text-white">
                {roundBanner ? 'Round done!' : shotPhase === 'aim' ? '1 — Aim' : shotPhase === 'power' ? '2 — Power' : 'Dart thrown!'}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted mb-0.5">vs</div>
              <div className="text-sm font-bold text-white">{opponent?.username}</div>
              {opponentThrew
                ? <div className="text-xs text-success">✓ threw</div>
                : <div className="text-xs text-muted">waiting...</div>
              }
            </div>
          </div>

          {/* Main area */}
          <div className="bg-surface border border-surfaceLight rounded-2xl p-4 sm:p-6 flex flex-col md:flex-row gap-6 items-center md:items-start w-full relative">

            {/* Dartboard */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div className="text-xs text-muted font-semibold tracking-widest uppercase">Dartboard</div>
              <DartBoard shots={boardShots} size={220} />
              <div className="flex gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" /> You
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Opp
                </span>
              </div>
              {/* Running totals */}
              {Object.keys(totals).length > 0 && (
                <div className="flex gap-4 mt-1">
                  {Object.entries(totals).map(([uid, score]) => {
                    const isMe = uid === me;
                    return (
                      <div key={uid} className="text-center">
                        <div className={`text-xl font-black ${isMe ? 'text-primary' : 'text-red-400'}`}>{score}</div>
                        <div className="text-xs text-muted">{isMe ? 'You' : 'Opp'}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="hidden md:block w-px self-stretch bg-surfaceLight shrink-0" />

            {/* Sliders */}
            <div className="flex flex-col gap-6 flex-1 min-w-0">
              {!roundBanner && (
                <>
                  <AimBar value={aimVal} locked={shotPhase !== 'aim'} />
                  {shotPhase !== 'aim' && (
                    <div className="flex gap-5 items-start">
                      <PowerBar value={powerVal} locked={shotPhase === 'waiting'} />
                      {shotPhase === 'waiting' && (
                        <div className="text-sm text-muted animate-pulse mt-20">
                          Dart thrown!<br />Waiting...
                        </div>
                      )}
                    </div>
                  )}
                  {shotPhase === 'aim' && (
                    <div className="text-xs text-muted border border-surfaceLight rounded-lg p-3 space-y-1.5">
                      <div className="text-white font-semibold mb-2">Scoring zones</div>
                      {RINGS.map(r => (
                        <div key={r.name} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: r.fill }} />
                          <span className="capitalize">{r.name}</span>
                          <span className="ml-auto font-bold text-white">{r.score} pts</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Round result banner (replaces sliders after both throw) */}
              {roundBanner && (
                <div className="flex flex-col gap-4">
                  <div className="text-center">
                    <div className="text-xs text-muted mb-2">Round {round} Result</div>
                    <div className="flex gap-6 justify-center">
                      <div className="text-center">
                        <div className="text-xs text-muted mb-1">You</div>
                        <div className="text-lg font-black" style={{ color: RING_COLORS[roundBanner.myRing] ?? '#fff' }}>
                          {RING_LABELS[roundBanner.myRing] ?? '—'}
                        </div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-muted mb-1">Opponent</div>
                        <div className="text-lg font-black" style={{ color: RING_COLORS[roundBanner.oppRing] ?? '#fff' }}>
                          {RING_LABELS[roundBanner.oppRing] ?? '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-6 justify-center">
                    {Object.entries(roundBanner.totals).map(([uid, score]) => {
                      const isMe = uid === me;
                      return (
                        <div key={uid} className="text-center bg-surfaceLight/50 rounded-xl px-6 py-3">
                          <div className={`text-3xl font-black ${isMe ? 'text-primary' : 'text-red-400'}`}>{score}</div>
                          <div className="text-xs text-muted">{isMe ? 'You' : 'Opp'}</div>
                        </div>
                      );
                    })}
                  </div>
                  {round < ROUNDS && <p className="text-xs text-muted text-center animate-pulse">Next round starting...</p>}
                </div>
              )}
            </div>
          </div>

          {!roundBanner && (
            <p className="text-xs text-muted">Click anywhere — Center = bullseye (100 pts)</p>
          )}
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 animate-pop-in ${!result.isDraw && !isWinner ? 'grayscale' : ''}`}>
            {result.isDraw ? '🤝' : isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-4 ${result.isDraw ? 'text-white' : isWinner ? 'text-success' : 'text-danger'}`}>
            {result.isDraw ? "It's a Draw!" : isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}

          <div className="flex justify-center mb-4">
            <DartBoard shots={allShots.map(s => ({ ...s, fresh: false }))} size={200} />
          </div>

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-6 text-sm space-y-2">
            {Object.entries(result.finalScores ?? {}).map(([uid, score]) => (
              <div key={uid} className="flex justify-between">
                <span className="text-muted">
                  {uid === me ? 'Your score' : (opponent?.username ?? 'Opponent')}
                </span>
                <span className="font-bold text-white">{score} pts</span>
              </div>
            ))}
            {!result.isDraw && (
              <div className="flex justify-between border-t border-border pt-2">
                <span className="text-muted">Your ELO</span>
                <span className="font-bold text-white">{(() => {
                  const elo = isWinner ? result.newWinnerElo : result.newLoserElo;
                  const delta = elo - (eloBeforeRef.current ?? elo);
                  return <>{elo} <span className={delta >= 0 ? 'text-success' : 'text-danger'}>({delta >= 0 ? '+' : ''}{delta})</span></>;
                })()}</span>
              </div>
            )}
            {result.balanceChange && !result.isDraw && (
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




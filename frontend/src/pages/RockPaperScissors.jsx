import { useState, useEffect, useRef } from 'react';
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

const CHOICES = [
  { id: 'rock',     label: 'Rock',     emoji: '🪨' },
  { id: 'paper',    label: 'Paper',    emoji: '📄' },
  { id: 'scissors', label: 'Scissors', emoji: '✂️' },
];

const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

const CS = {
  rock:     { border: '#f97316', glow: 'rgba(249,115,22,0.5)',  bg: 'rgba(249,115,22,0.08)',  text: '#f97316' },
  paper:    { border: '#00bfff', glow: 'rgba(0,191,255,0.5)',   bg: 'rgba(0,191,255,0.08)',   text: '#00bfff' },
  scissors: { border: '#ff4d6d', glow: 'rgba(255,77,109,0.5)',  bg: 'rgba(255,77,109,0.08)',  text: '#ff4d6d' },
};

const RPS_KEYFRAMES = `
  @keyframes rpsSlideLeft  { from { opacity:0; transform:translateX(-70px) scale(0.85); } to { opacity:1; transform:translateX(0) scale(1); } }
  @keyframes rpsSlideRight { from { opacity:0; transform:translateX(70px)  scale(0.85); } to { opacity:1; transform:translateX(0) scale(1); } }
  @keyframes rpsBounceIn   { 0% { opacity:0; transform:scale(0.4); } 65% { transform:scale(1.12); } 100% { opacity:1; transform:scale(1); } }
  @keyframes rpsDot        { 0%,100% { opacity:0.2; transform:translateY(0); } 50% { opacity:1; transform:translateY(-5px); } }
  @keyframes rpsChosenPop  { 0% { transform:scale(1); } 40% { transform:scale(1.2); } 100% { transform:scale(1.1) translateY(-8px); } }
`;

function ScoreBar({ myName, oppName, me, opp, round, total = 3 }) {
  return (
    <div className="w-full flex items-stretch bg-surface border border-border rounded-2xl overflow-hidden shadow-lg">
      <div className="flex-1 text-center py-3 px-4">
        <div className="text-[10px] text-muted uppercase tracking-widest mb-0.5 truncate max-w-[100px] mx-auto">{myName ?? 'You'}</div>
        <div className="text-3xl font-black text-success">{me}</div>
      </div>
      <div className="flex flex-col items-center justify-center px-5 bg-white/[0.03] border-x border-border">
        <div className="text-[10px] text-muted uppercase tracking-widest">Round</div>
        <div className="text-xl font-black text-white">{round}<span className="text-muted font-normal text-sm">/{total}</span></div>
      </div>
      <div className="flex-1 text-center py-3 px-4">
        <div className="text-[10px] text-muted uppercase tracking-widest mb-0.5 truncate max-w-[100px] mx-auto">{oppName ?? 'Opp'}</div>
        <div className={`text-3xl font-black ${opp > me ? 'text-danger' : opp < me ? 'text-muted' : 'text-muted'}`}>{opp}</div>
      </div>
    </div>
  );
}

function ChoiceCard({ choice, selected, dimmed, onClick }) {
  const s = CS[choice.id] ?? {};
  return (
    <button
      onClick={onClick}
      disabled={!!selected || dimmed !== undefined ? dimmed === true : false}
      className="flex flex-col items-center justify-center gap-3 rounded-3xl select-none focus:outline-none flex-1 min-w-0"
      style={{
        height: 'min(150px, 40vw)',
        border: `2px solid ${dimmed ? 'rgba(255,255,255,0.06)' : selected ? s.border : s.border + '55'}`,
        background: selected ? s.bg : dimmed ? 'rgba(10,15,28,0.4)' : 'rgba(18,26,46,0.55)',
        boxShadow: selected
          ? `0 0 0 1px ${s.border}33, 0 0 28px ${s.glow}, 0 0 56px ${s.glow}55, inset 0 1px 0 rgba(255,255,255,0.1)`
          : dimmed ? 'none' : `inset 0 1px 0 rgba(255,255,255,0.05)`,
        transform: selected ? 'scale(1.1) translateY(-8px)' : dimmed ? 'scale(0.9)' : 'scale(1)',
        opacity: dimmed ? 0.3 : 1,
        transition: 'all 0.22s cubic-bezier(0.34,1.56,0.64,1)',
        cursor: dimmed ? 'default' : 'pointer',
        animation: selected ? 'rpsChosenPop 0.3s ease-out forwards' : 'none',
      }}
    >
      <span
        className="text-4xl sm:text-6xl leading-none"
        style={{ filter: selected ? `drop-shadow(0 0 14px ${s.border})` : 'none', transition: 'filter 0.2s' }}
      >
        {choice.emoji}
      </span>
      <span
        className="text-xs font-bold uppercase tracking-widest"
        style={{ color: selected ? s.text : dimmed ? '#2a3450' : '#6b7a99' }}
      >
        {choice.label}
      </span>
    </button>
  );
}

function RevealCard({ choiceId, name, side, outcome }) {
  const c = CHOICES.find(x => x.id === choiceId);
  const s = CS[choiceId] ?? {};
  const won = outcome === 'win';
  const lost = outcome === 'lose';
  return (
    <div
      className="flex-1 flex flex-col items-center gap-3"
      style={{ animation: `${side === 'left' ? 'rpsSlideLeft' : 'rpsSlideRight'} 0.45s cubic-bezier(0.22,1,0.36,1) both` }}
    >
      <div className="text-[10px] text-muted uppercase tracking-widest">{name}</div>
      <div
        className="w-24 h-24 sm:w-32 sm:h-32 rounded-3xl flex items-center justify-center"
        style={{
          border: `2px solid ${won ? s.border : lost ? 'rgba(255,255,255,0.08)' : s.border + '80'}`,
          background: won ? s.bg : lost ? 'rgba(10,15,28,0.5)' : s.bg + '80',
          boxShadow: won ? `0 0 32px ${s.glow}, 0 0 64px ${s.glow}66` : 'none',
          opacity: lost ? 0.45 : 1,
          transition: 'all 0.3s ease',
        }}
      >
        <span className="text-5xl sm:text-7xl" style={{ filter: won ? `drop-shadow(0 0 16px ${s.border})` : 'none' }}>
          {c?.emoji ?? '?'}
        </span>
      </div>
      <div className="text-xs font-bold" style={{ color: won ? s.text : lost ? '#4a5568' : '#8892a4' }}>
        {won ? c?.label : lost ? c?.label : c?.label}
      </div>
    </div>
  );
}

export default function RockPaperScissors() {
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
  const [myChoice, setMyChoice]       = useState(null);
  const [oppChose, setOppChose]       = useState(false);
  const [reveal, setReveal]           = useState(null);
  const [roundScore, setRoundScore]   = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult] = useState(null);
  const [result, setResult]           = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]     = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [timerEndsAt, setTimerEndsAt] = useState(null);
  const [timeLeft, setTimeLeft]       = useState(null);

  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);
  roomIdRef.current  = roomId;
  profileRef.current = profile;

  const isDiamonds = betCurrency === 'diamonds';
  const myBalance  = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  const { RejoinOverlay } = useGamePageRejoin('rps', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('game'); },
    () => setPhase('lobby'),
  );

  useEffect(() => {
    if (!socket) return;

    function onPrivateRoomCreated({ code }) { setPrivateCode(code); setPhase('private_waiting'); }

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      setEntryFee(fee);
      setRoundScore({ me: 0, opp: 0 });
      setCurrentRound(1);
      setReveal(null);
      setResult(null);
      setRoundResult(null);
      setPhase('choosing');
    }

    function onRoundStart({ round, endsAt }) {
      setCurrentRound(round);
      if (endsAt) setTimerEndsAt(endsAt);
      setMyChoice(null);
      setOppChose(false);
      setReveal(null);
      setRoundResult(null);
      setPhase('choosing');
    }

    function onOpponentChose() { setOppChose(true); }

    function onReveal({ choices, result: res, round }) {
      const myId = profileRef.current?.id;
      setReveal({ choices, result: res, round, myId });
      setPhase('reveal');
    }

    function onTie() { setMyChoice(null); setOppChose(false); }

    function onRoundResult({ round, roundWinnerId, scores }) {
      const myId = profileRef.current?.id;
      setRoundResult({ round, won: roundWinnerId === myId });
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
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

    socket.on('private_room_created',   onPrivateRoomCreated);
    socket.on('rps_match_found',       onMatchFound);
    socket.on('rps_round_start',       onRoundStart);
    socket.on('rps_opponent_chose',    onOpponentChose);
    socket.on('rps_reveal',            onReveal);
    socket.on('rps_tie',               onTie);
    socket.on('rps_round_result',      onRoundResult);
    socket.on('rps_result',            onResult);
    socket.on('opponent_disconnected', onOpponentDisconnected);
    socket.on('error',                 onError);

    return () => {
      socket.off('private_room_created',   onPrivateRoomCreated);
      socket.off('rps_match_found',       onMatchFound);
      socket.off('rps_round_start',       onRoundStart);
      socket.off('rps_opponent_chose',    onOpponentChose);
      socket.off('rps_reveal',            onReveal);
      socket.off('rps_tie',              onTie);
      socket.off('rps_round_result',      onRoundResult);
      socket.off('rps_result',            onResult);
      socket.off('opponent_disconnected', onOpponentDisconnected);
      socket.off('error',                 onError);
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

  // Clear timer when not in choosing phase
  useEffect(() => { if (phase !== 'choosing') { setTimerEndsAt(null); setTimeLeft(null); } }, [phase]);

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_rps_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_rps_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_rps_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting free match...');
  }
  function leaveQueue() { socket.emit('leave_rps_queue'); setPhase('lobby'); setStatusMsg(''); }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'rps', entryFee: fee ?? entryFee, currency: cur ?? betCurrency });
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
  function choose(c) {
    if (myChoice || phase !== 'choosing') return;
    setMyChoice(c);
    socket.emit('rps_choice', { roomId, choice: c });
  }
  function requestRematch() {
    setRoundScore({ me: 0, opp: 0 }); setCurrentRound(1);
    setRoundResult(null); setReveal(null);
    socket.emit('rps_rematch_request', { roomId });
    setResult(null); setPhase('queue'); setStatusMsg('Waiting for opponent...');
  }
  function backToLobby() {
    setPhase('lobby'); setResult(null); setOpponent(null); setRoomId(null);
    setMyChoice(null); setOppChose(false); setReveal(null);
    setRoundScore({ me: 0, opp: 0 }); setCurrentRound(1);
    setRoundResult(null); setStatusMsg('');
  }

  const isWinner = result && result.winnerId === profile?.id;

  // Compute reveal outcome from choices
  const revealOutcome = (() => {
    if (!reveal) return { my: 'tie', opp: 'tie' };
    const myC  = reveal.choices[profile?.id];
    const oppC = reveal.choices[opponent?.userId];
    if (!myC || !oppC || myC === oppC) return { my: 'tie', opp: 'tie' };
    return BEATS[myC] === oppC ? { my: 'win', opp: 'lose' } : { my: 'lose', opp: 'win' };
  })();

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      {RejoinOverlay}
      <style>{RPS_KEYFRAMES}</style>

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="✂️ Rock Paper Scissors"
          description="Best of 3 rounds — ties replay the round"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue} onBot={playVsBot}
          onBotFree={playVsBotFree}
          onCreatePrivate={createPrivate} onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
        />
      )}

      {/* ── PRIVATE WAITING ── */}
      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in max-w-sm w-full">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-white mb-2">Private Room Created</h2>
          <p className="text-muted mb-4 text-sm">Share this code with your opponent</p>
          <div className="text-5xl font-black font-mono text-accent tracking-widest mb-2 bg-surface border border-border rounded-xl py-4 shadow-glow">{privateCode}</div>
          <button onClick={() => navigator.clipboard.writeText(privateCode)} className="text-xs text-primary hover:underline mb-6 block mx-auto">📋 Copy code</button>
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

      {/* ── CHOOSING ── */}
      {phase === 'choosing' && (
        <div className="flex flex-col items-center gap-8 w-full max-w-lg animate-fade-in">
          <ScoreBar
            myName={profile?.username} oppName={opponent?.username}
            me={roundScore.me} opp={roundScore.opp}
            round={currentRound}
          />

          <div className="text-center">
            <h2 className="text-2xl font-black text-white mb-1">
              {myChoice ? `You chose ${CHOICES.find(c => c.id === myChoice)?.label}!` : 'Choose your weapon'}
            </h2>
            <p className="text-sm text-muted">Best of 3 rounds</p>
          </div>

          {/* Timer */}
          {timeLeft !== null && !myChoice && (
            <div className="w-full max-w-sm">
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: timeLeft <= 5 ? '#f87171' : timeLeft <= 10 ? '#fbbf24' : '#4ade80' }} className="font-bold">
                  ⏱ {timeLeft}s to choose
                </span>
              </div>
              <div className="w-full rounded-full overflow-hidden" style={{ height: 5, background: 'rgba(255,255,255,0.1)' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.max(0, (timeLeft / 20) * 100)}%`,
                  background: timeLeft <= 5 ? '#f87171' : timeLeft <= 10 ? '#fbbf24' : '#4ade80',
                  transition: 'width 0.25s linear, background 0.5s',
                }} />
              </div>
            </div>
          )}

          {/* Choice cards */}
          <div className="flex gap-2 sm:gap-5 w-full max-w-sm sm:max-w-none">
            {CHOICES.map(c => (
              <ChoiceCard
                key={c.id}
                choice={c}
                selected={myChoice === c.id}
                dimmed={!!myChoice && myChoice !== c.id}
                onClick={() => choose(c.id)}
              />
            ))}
          </div>

          {/* Waiting indicator */}
          {myChoice ? (
            <div className="flex items-center gap-3 h-8">
              <div className="flex gap-1.5 items-end">
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    className="w-2 h-2 rounded-full bg-primary"
                    style={{ animation: `rpsDot 1.1s ease-in-out infinite`, animationDelay: `${i * 0.18}s` }}
                  />
                ))}
              </div>
              <span className="text-sm text-muted">
                {oppChose ? 'Both ready — revealing...' : 'Waiting for opponent...'}
              </span>
            </div>
          ) : (
            <div className="h-8" />
          )}

          {/* Previous round hint */}
          {roundResult && (
            <div className={`text-center px-5 py-2 rounded-xl text-sm font-semibold border ${
              roundResult.won
                ? 'bg-success/10 border-success/30 text-success'
                : 'bg-danger/10 border-danger/30 text-danger'
            }`}>
              Round {roundResult.round}: {roundResult.won ? '✅ You won' : '❌ You lost'}
            </div>
          )}
        </div>
      )}

      {/* ── REVEAL ── */}
      {phase === 'reveal' && reveal && (
        <div className="flex flex-col items-center gap-8 w-full max-w-lg">
          <ScoreBar
            myName={profile?.username} oppName={opponent?.username}
            me={roundScore.me} opp={roundScore.opp}
            round={currentRound}
          />

          {/* Arena */}
          <div className="flex items-center w-full gap-3">
            <RevealCard
              choiceId={reveal.choices[profile?.id]}
              name={profile?.username ?? 'You'}
              side="left"
              outcome={revealOutcome.my}
            />

            {/* VS divider */}
            <div className="flex flex-col items-center gap-1 sm:gap-2 min-w-[40px] sm:min-w-[56px]">
              <div className="text-2xl font-black text-white/30">VS</div>
              {revealOutcome.my === 'win' && (
                <div className="text-xs font-black text-success bg-success/10 border border-success/30 rounded-full px-2 py-0.5 whitespace-nowrap">
                  You Win!
                </div>
              )}
              {revealOutcome.my === 'lose' && (
                <div className="text-xs font-black text-danger bg-danger/10 border border-danger/30 rounded-full px-2 py-0.5 whitespace-nowrap">
                  You Lose
                </div>
              )}
              {revealOutcome.my === 'tie' && (
                <div className="text-xs font-black text-muted bg-white/5 border border-border rounded-full px-2 py-0.5">
                  Tie!
                </div>
              )}
            </div>

            <RevealCard
              choiceId={reveal.choices[opponent?.userId]}
              name={opponent?.username ?? 'Opponent'}
              side="right"
              outcome={revealOutcome.opp}
            />
          </div>

          {/* Outcome banner */}
          <div
            className="w-full rounded-2xl p-4 text-center border"
            style={{
              background: revealOutcome.my === 'win'
                ? 'rgba(34,197,94,0.08)'
                : revealOutcome.my === 'lose'
                  ? 'rgba(239,68,68,0.08)'
                  : 'rgba(255,255,255,0.04)',
              borderColor: revealOutcome.my === 'win'
                ? 'rgba(34,197,94,0.25)'
                : revealOutcome.my === 'lose'
                  ? 'rgba(239,68,68,0.25)'
                  : 'rgba(255,255,255,0.08)',
            }}
          >
            {revealOutcome.my === 'win' && (
              <p className="text-success font-bold text-lg">
                🎉 {CHOICES.find(c => c.id === reveal.choices[profile?.id])?.label} beats {CHOICES.find(c => c.id === reveal.choices[opponent?.userId])?.label}!
              </p>
            )}
            {revealOutcome.my === 'lose' && (
              <p className="text-danger font-bold text-lg">
                {CHOICES.find(c => c.id === reveal.choices[opponent?.userId])?.label} beats {CHOICES.find(c => c.id === reveal.choices[profile?.id])?.label}
              </p>
            )}
            {revealOutcome.my === 'tie' && (
              <p className="text-muted font-bold text-lg">⚖️ Tied — round replays</p>
            )}
          </div>
        </div>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="text-center max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div
            className="text-8xl mb-5 block"
            style={{ animation: 'rpsBounceIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both' }}
          >
            {isWinner ? '🏆' : '💀'}
          </div>
          <h2
            className={`text-4xl font-black mb-1 ${isWinner ? 'text-success' : 'text-danger'}`}
            style={{ animation: 'rpsBounceIn 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.1s both' }}
          >
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected ? (
            <p className="text-muted text-sm mb-6">Opponent disconnected</p>
          ) : (
            <p className="text-muted text-sm mb-6">
              {isWinner ? result.winnerUsername : result.loserUsername} vs {isWinner ? result.loserUsername : result.winnerUsername}
            </p>
          )}

          {/* Stats card */}
          <div className="bg-surface border border-border rounded-2xl p-5 mb-5 space-y-3 text-sm text-left">
            <div className="flex items-center justify-between">
              <span className="text-muted">Score</span>
              <span className="font-bold text-white text-lg">{roundScore.me} — {roundScore.opp}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Your ELO</span>
              <span className="font-bold text-white">{(() => {
                const elo = isWinner ? result.newWinnerElo : result.newLoserElo;
                const delta = elo - (eloBeforeRef.current ?? elo);
                return <>{elo} <span className={delta >= 0 ? 'text-success' : 'text-danger'}>({delta >= 0 ? '+' : ''}{delta})</span></>;
              })()}</span>
            </div>
            {result.balanceChange && (
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-muted">{isWinner ? 'Payout' : 'Entry lost'}</span>
                <span className={`font-bold ${isWinner ? 'text-success' : 'text-danger'}`}>
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




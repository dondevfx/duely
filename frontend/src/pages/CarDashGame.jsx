import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GameLobby from '../components/GameLobby';
import GlowButton from '../components/GlowButton';
import ResultScreen from '../components/ResultScreen';
import { usePageReady } from '../hooks/usePageReady';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { useResumeMatch } from '../hooks/useResumeMatch';
import { playMatchFound, playCountdown, playGo } from '../utils/sound';
import HighwayCanvas from '../components/HighwayCanvas';
import GameHelp from '../components/GameHelp';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
import PrivateWaiting from '../components/PrivateWaiting';

function fmtTime(ms) {
  const s = (ms ?? 0) / 1000;
  return s.toFixed(1) + 's';
}

// Shown when the opponent has crashed ahead: the score to beat and the time
// left to beat it. Without this the player has no idea they are on a clock.
function CatchupBanner({ endsAt, target }) {
  const [left, setLeft] = useState(Math.max(0, endsAt - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, endsAt - Date.now())), 100);
    return () => clearInterval(t);
  }, [endsAt]);
  const secs = (left / 1000).toFixed(1);
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20">
      <div className="px-3 py-1.5 rounded-lg bg-black/70 border border-danger/60">
        <div className="text-danger font-black text-xl tabular-nums leading-none">{secs}s</div>
        <div className="text-[10px] text-white/80 font-bold mt-0.5 whitespace-nowrap">
          BEAT {Number(target).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

export default function CarDashGame() {
  const ready = usePageReady();
  const location = useLocation();
  const { profile, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  const [phase, _setPhase] = useState('lobby'); // lobby | queue | playing | result
  const phaseRef = useRef('lobby');
  const setPhase = (p) => { phaseRef.current = p; _setPhase(p); };

  const [entryFee, setEntryFee] = useState(location.state?.entryFee ?? 1);
  const [statusMsg, setStatusMsg] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [opponent, setOpponent] = useState(null);
  const [seed, setSeed] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [myMs, setMyMs] = useState(0);
  const [oppMs, setOppMs] = useState(0);
  const [oppCrashed, setOppCrashed] = useState(false);
  const [catchup, setCatchup] = useState(null);   // { endsAt, targetScore }
  const [crashed, setCrashed] = useState(false);
  const [result, setResult] = useState(null);
  const [privateCode, setPrivateCode] = useState('');
  const [invitedFriend, setInvitedFriend] = useState(null);

  const roomIdRef = useRef(null);
  const crashedRef = useRef(false);
  const lastModeRef = useRef(null); // 'pvp' | 'bot_paid' | 'bot_free'
  const lastSettingsRef = useRef({ entryFee: 0, currency: 'coins' });
  const socketRef = useRef(socket);
  const profileRef = useRef(profile);
  const eloBeforeRef = useRef(profile?.elo ?? 1000);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  // Only a live match re-claims itself after a reconnect; a refresh forfeits.
  useResumeMatch(socket, () => phaseRef.current === 'playing');

  // Quick Match sends the player straight here with a bet already chosen and
  // expects to land them IN the queue. Rush Hour had no handling for it at all,
  // so Quick Match could pick it and then drop the player on the lobby with
  // nothing queued — the one thing Quick Match promises not to make them do.
  useEffect(() => {
    if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving from an accepted friend invite. Without this the player lands on
  // the betting screen instead of the match: the invite is accepted, the toast
  // navigates here with the room code, and nothing ever redeems it. Rush Hour
  // and Tower were the two games missing it.
    // Redeem an accepted invite.
  //
  // Keyed on the CODE and on location.key, not on a fire-once ref with only
  // [socket, authenticated] deps. Accepting an invite while already sitting on
  // that game's page is a route update, not a remount — neither dep changes, so
  // the effect never re-ran and the code was never redeemed. It looked like the
  // Accept button did nothing, and it was most visible on whichever game you
  // happened to be viewing when the invite arrived.
  const _lastJoinCode = useRef(null);
  useEffect(() => {
    const code = location.state?.joinCode;
    if (!location.state?.autoJoin || !code) return;
    if (!socket || !authenticated) return;
    if (_lastJoinCode.current === code) return;
    _lastJoinCode.current = code;
    window.history.replaceState({}, '');   // don't re-join on refresh
    setTimeout(() => joinPrivate(code), 300);
  }, [socket, authenticated, location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const _autoQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _autoQueueFired.current) return;
    if (!authenticated || !socket) return;
    _autoQueueFired.current = true;
    joinQueueWith(location.state?.entryFee, location.state?.betCurrency);
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDiamonds = betCurrency === 'diamonds';
  const balance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);

  // Forfeit on unmount AND on tab close or refresh. Rush Hour was the only game
  // missing the beforeunload half of this: navigating away inside the app
  // forfeited correctly, but closing the tab relied entirely on the socket
  // dropping. The disconnect path does catch it, so this is belt and braces —
  // it just settles the match immediately instead of after the grace period.
  // Forfeit on every way out of the page — refresh, tab close, in-app
  // navigation — but NOT on an app switch. See useLeaveGuard.
  useLeaveGuard(socket);

  // Lock the page while the match is live.
  //
  // Pinning the inner scroller once was not enough. On a phone the document
  // itself can also scroll, and the canvas changes the page height when it
  // mounts, so a scroll offset could be reintroduced AFTER the reset ran — the
  // game then came up with the top of the road cut off. This locks both
  // scrollers, and re-pins across the next few frames and on resize, which is
  // when a mobile browser reflows as its address bar shows or hides.
  useEffect(() => {
    if (phase !== 'queue' && phase !== 'playing') return;
    const main = document.querySelector('main');
    const body = document.body;
    const html = document.documentElement;
    const prev = {
      main: main ? main.style.overflowY : null,
      body: body.style.overflow,
      html: html.style.overflow,
      touch: body.style.touchAction,
    };

    const pin = () => {
      if (main) main.scrollTop = 0;
      if (window.scrollY) window.scrollTo(0, 0);
    };

    pin();
    if (main) main.style.overflowY = 'hidden';
    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    body.style.touchAction = 'none';

    // Re-pin over the next few frames: the canvas sizes itself on mount, and
    // that reflow can land after this effect has already run.
    let frames = 0;
    let raf = requestAnimationFrame(function again() {
      pin();
      if (++frames < 20) raf = requestAnimationFrame(again);
    });
    window.addEventListener('resize', pin);
    window.addEventListener('orientationchange', pin);

    // This effect locks the DOCUMENT, not just a child, so leaving it locked is
    // much worse than leaving it unlocked: a phone that suspends a backgrounded
    // tab may never run this cleanup, and the page then returns with html and
    // body frozen and nothing able to scroll or paint properly — a blank app
    // that only a reload clears. So the lock is dropped whenever the page hides
    // and retaken when it comes back.
    const restore = () => {
      if (main) main.style.overflowY = prev.main;
      body.style.overflow = prev.body;
      html.style.overflow = prev.html;
      body.style.touchAction = prev.touch;
    };
    const relock = () => {
      if (main) main.style.overflowY = 'hidden';
      body.style.overflow = 'hidden';
      html.style.overflow = 'hidden';
      body.style.touchAction = 'none';
      pin();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') restore(); else relock();
    };
    window.addEventListener('pagehide', restore);
    window.addEventListener('pageshow', relock);
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', pin);
      window.removeEventListener('orientationchange', pin);
      window.removeEventListener('pagehide', restore);
      window.removeEventListener('pageshow', relock);
      document.removeEventListener('visibilitychange', onVis);
      restore();
    };
  }, [phase]);

  useEffect(() => {
    if (!socket) return;

    socket.on('car_dash_queue_joined', () => { setPhase('queue'); setStatusMsg('Waiting for opponent…'); });
    socket.on('car_dash_queue_left',   () => { setPhase('lobby'); setStatusMsg(''); });
    socket.on('match_cancelled', ({ message }) => {
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled.');
      // The entry fee is deducted optimistically when a match is found, but a
      // cancellation means it was never actually taken — pull the real balance
      // so the player is not left looking at money that did not move.
      refreshProfile();
    });

    socket.on('car_dash_match_found', ({ roomId: rid, opponent: opp, entryFee: fee, currency }) => {
      roomIdRef.current = rid;
      setRoomId(rid);
      setOpponent(opp);
      setMyMs(0); setOppMs(0); setOppCrashed(false); setCrashed(false); setResult(null); crashedRef.current = false;
      setPhase('queue');
      playMatchFound();
      if ((fee ?? 0) > 0) {
        updateProfile(currency === 'diamonds'
          ? { diamonds: Math.max(0, (profile?.diamonds ?? 0) - fee) }
          : { c_coins: Math.max(0, (profile?.c_coins ?? 0) - fee) });
      }
    });

    // Private rooms and friend invites. Rush Hour emitted create_private_room
    // but never listened for the reply, so "Challenge a Friend" produced a code
    // on the server that the player was never shown.
    socket.on('private_room_created', ({ code }) => { setPrivateCode(code); setInvitedFriend(null); setPhase('private_waiting'); });
    socket.on('invite_sent', ({ friendUsername }) => { setPrivateCode(''); setInvitedFriend(friendUsername || 'your friend'); setStatusMsg(''); setPhase('private_waiting'); });
    socket.on('invite_declined', ({ byUsername }) => { setInvitedFriend(null); setStatusMsg(`${byUsername || 'They'} declined your invite.`); setPhase('lobby'); });
    socket.on('invite_expired', () => { setInvitedFriend(null); setStatusMsg('Invite expired — no response.'); setPhase('lobby'); });

    socket.on('car_dash_countdown', ({ count }) => { setCountdown(count); playCountdown(); });

    socket.on('car_dash_start', ({ seed: s }) => {
      setSeed(s);
      setCountdown(0);
      setPhase('playing');
      playGo();
    });

    socket.on('car_dash_opponent_progress', ({ ms }) => setOppMs(ms));
    socket.on('car_dash_opponent_crashed', ({ ms }) => { setOppMs(ms); setOppCrashed(true); });
    // The opponent crashed while ahead: a fixed window to beat their score.
    socket.on('car_dash_catchup', ({ seconds, targetScore }) => {
      setCatchup({ endsAt: Date.now() + seconds * 1000, targetScore });
    });
    socket.on('car_dash_crashed', ({ ms }) => { setMyMs(ms); setCrashed(true); });

    socket.on('car_dash_result', (data) => {
      if (!roomIdRef.current) return;
      roomIdRef.current = null;
      // Pre-match ELO comes from the profile snapshot taken when the match
      // started, not from the result. ELO changes are a random 20-23 on a win
      // and 17-20 on a loss, so subtracting a fixed 25 here would report a
      // delta that never matches what actually happened.
      setResult(data);
      setPhase('result');
      refreshProfile();
    });

    socket.on('opponent_disconnected', (data = {}) => {
      if (!roomIdRef.current) return;
      roomIdRef.current = null;
      setResult({ ...data, disconnected: true });
      setPhase('result');
      refreshProfile();
    });

    socket.on('error', ({ message }) => { setStatusMsg(message); setPhase('lobby'); });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      [
        'car_dash_queue_joined','car_dash_queue_left','match_cancelled','car_dash_match_found',
        'car_dash_countdown','car_dash_start','car_dash_opponent_progress','car_dash_opponent_crashed',
        'car_dash_crashed','car_dash_result','opponent_disconnected','error','car_dash_catchup',
        'private_room_created','invite_sent','invite_declined','invite_expired',
      ].forEach(e => socket.off(e));
    };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overrides exist for the Quick Match path. setBetCurrency from location.state
  // and this call happen in the same commit, so the closure here can still be
  // holding the previous currency — queuing at the wrong one, silently, for a
  // real bet. Passing the values explicitly removes the timing question.
  // See TowerGame: the button handler takes no arguments, because the lobby
  // wires it to onClick and React would pass the click event as the entry fee.
  function joinQueue() { joinQueueWith(); }

  function joinQueueWith(feeArg, curArg) {
    const fee = Number.isFinite(Number(feeArg)) ? Number(feeArg) : entryFee;
    const cur = typeof curArg === 'string' ? curArg : betCurrency;
    eloBeforeRef.current = profile?.elo ?? 1000;
    lastModeRef.current = 'pvp';
    lastSettingsRef.current = { entryFee: fee, currency: cur };
    setStatusMsg('');
    setPhase('queue');
    socket?.emit('join_car_dash_queue', { entryFee: fee, currency: cur });
  }
  function leaveQueue() { socket?.emit('leave_car_dash_queue'); setPhase('lobby'); setStatusMsg(''); }
  function playVsBot() {
    lastModeRef.current = 'bot_paid';
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    socket?.emit('play_car_dash_vs_bot', { entryFee, currency: betCurrency });
  }
  function playVsBotFree() {
    lastModeRef.current = 'bot_free';
    lastSettingsRef.current = { entryFee: 0, currency: 'coins' };
    socket?.emit('play_car_dash_vs_bot', { entryFee: 0, currency: 'coins' });
  }
  function createPrivate(fee, cur) { socket?.emit('create_private_room', { gameType: 'carDash', entryFee: fee, currency: cur }); }
  function joinPrivate(code)       { socket?.emit('join_private_room', { gameType: 'carDash', code }); }

  // Gameplay callbacks from the canvas — the run reports score + time survived.
  const onProgress = (score, ms) => {
    setMyMs(ms);
    if (roomIdRef.current) socket?.emit('car_dash_progress', { roomId: roomIdRef.current, ms, score });
  };
  const onCrash = (score, ms) => {
    if (crashedRef.current) return;
    crashedRef.current = true;
    setCrashed(true);
    if (roomIdRef.current) socket?.emit('car_dash_crash', { roomId: roomIdRef.current, score, ms });
  };

  function cancelPrivate() {
    socket?.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setInvitedFriend(null); setStatusMsg('');
  }

  // Clears everything from the last match WITHOUT choosing a phase, so callers
  // decide where the player lands.
  function clearMatch() {
    setResult(null); setSeed(null);
    setMyMs(0); setOppMs(0); setCrashed(false); setOppCrashed(false); setStatusMsg('');
    setPrivateCode(''); setInvitedFriend(null); setCatchup(null); crashedRef.current = false;
  }

  function reset() { clearMatch(); setPhase('lobby'); }

  // Play Again re-enters whatever mode was just played (PvP queue, paid bot or
  // free bot) instead of dumping the player back at the lobby.
  //
  // It goes straight to 'queue'. It used to call reset() first, which parks the
  // player on 'lobby' — the betting screen. For PvP that was invisible because
  // React batched the two updates, but the bot path waits for the server's
  // match_found to move the phase on, so the betting screen was on screen for
  // the whole round trip and you watched it flash past every time.
  function playAgain() {
    const mode = lastModeRef.current;
    const { entryFee: fee, currency: cur } = lastSettingsRef.current;
    clearMatch();
    if (!socket || !mode) { setPhase('lobby'); return; }
    setPhase('queue');
    eloBeforeRef.current = profile?.elo ?? 1000;
    if (mode === 'pvp') {
      socket.emit('join_car_dash_queue', { entryFee: fee, currency: cur });
    } else {
      socket.emit('play_car_dash_vs_bot', mode === 'bot_free'
        ? { entryFee: 0, currency: 'coins' }
        : { entryFee: fee, currency: cur });
    }
  }

  // ── Solo run result ──
  // A practice run has no opponent, so a win/loss screen would be inventing one.
  // Shows what you actually did: how long you lasted and what you scored.
  if (phase === 'result' && result?.soloRun) {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-4">
        <ResultScreen
          solo
          // Finishing an endless run is the goal, so it reads as a win. There is
          // no opponent to lose to and nothing staked to lose.
          isWinner
          winnerUsername={profile?.username ?? 'You'}
          profile={profile}
          gameLabel="🎮 Solo Endless"
          extraRows={[
            { label: 'Survived', value: fmtTime(result.ms) },
            { label: 'Score',    value: (result.score ?? 0).toLocaleString() },
          ]}
          onPlayAgain={playAgain}
          onBackToLobby={reset}
        />
      </div>
    );
  }

  // ── Result ──
  if (phase === 'result' && result) {
    const isWinner = result.winnerId === profile?.id;
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-4">
        <ResultScreen
          vsBot={!!result.vsBot}
          isWinner={isWinner}
          winnerUsername={result.winnerUsername}
          loserUsername={result.loserUsername}
          newWinnerElo={result.newWinnerElo}
          newLoserElo={result.newLoserElo}
          eloBeforeRef={eloBeforeRef}
          profile={profile}
          balanceChange={result.balanceChange}
          currency={result.currency}
          entryFee={result.entryFee}
          disconnected={result.disconnected}
          // The match is decided on SCORE, with time only breaking a tie, so the
          // score is shown first — otherwise a player who survived longer but
          // scored less has no way to see why they lost.
          // Grouped by player rather than by stat: your time and score together,
          // then the opponent's below, so each side reads as one result.
          extraRows={[
            { label: 'Your Time',      value: fmtTime(isWinner ? result.winnerMs : result.loserMs) },
            { label: 'Your Score',     value: (isWinner ? result.winnerScore : result.loserScore)?.toLocaleString() },
            { label: 'Opponent Time',  value: fmtTime(isWinner ? result.loserMs : result.winnerMs) },
            { label: 'Opponent Score', value: (isWinner ? result.loserScore : result.winnerScore)?.toLocaleString() },
          ].filter(r => r.value !== undefined && r.value !== null)}
          onPlayAgain={playAgain}
          onBackToLobby={reset}
        />
      </div>
    );
  }

  // ── Playing ──
  if (phase === 'playing') {
    return (
      <div className="relative">
        {/* Rush Hour's canvas has no pause input, so the panel says the match is
            still running rather than pretending otherwise. */}
        {/* bottom-left: the canvas draws the timer top-right and the score
            top-centre, and the catch-up banner takes top-left. */}
        <GameHelp gameType="carDash" placement="bottom-left" />
        <HighwayCanvas
          seed={seed}
          onProgress={onProgress}
          onCrash={onCrash}
        />
        {catchup && <CatchupBanner endsAt={catchup.endsAt} target={catchup.targetScore} />}
      </div>
    );
  }

  // ── Waiting on a private room or a friend invite ──
  if (phase === 'private_waiting') {
    return (
      <PrivateWaiting
        invitedFriend={invitedFriend}
        code={privateCode}
        gameType="carDash"
        onCancel={cancelPrivate}
      />
    );
  }

  // ── Queue / countdown ──
  if (phase === 'queue') {
    if (countdown > 0) {
      return (
        <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
          <div className="text-center animate-fade-in">
            <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>{countdown}</div>
            <p className="text-muted">Get ready...</p>
            {/* Solo Endless has no opponent — the bot is plumbing, not a rival. */}
            {opponent && lastModeRef.current !== 'bot_free' && (
              <p className="text-xs text-muted mt-2">vs {opponent.username}</p>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching...</h2>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── Lobby (identical UI to every other game) ──
  return (
    <div
      className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-3 sm:px-4 py-0 sm:py-8"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      <GameLobby
        title="🚗 Rush Hour"
        description="Weave through traffic at full speed. Both players get the exact same road — whoever survives the longest wins."
        controls="← → or A/D to change lanes · swipe or tap the sides on mobile"
        betCurrency={betCurrency} setBetCurrency={setBetCurrency}
        entryFee={entryFee} setEntryFee={setEntryFee}
        balance={balance}
        authenticated={authenticated} doAuth={doAuth}
        onQueue={joinQueue}
        onBot={playVsBot}
        onBotFree={playVsBotFree}
        botLabel="🎮 Solo Endless"
        onCreatePrivate={createPrivate}
        onJoinPrivate={joinPrivate}
        statusMsg={statusMsg}
        gameType="carDash"
        liveCount={playerCounts?.['car-dash'] ?? 0}
      />
    </div>
  );
}

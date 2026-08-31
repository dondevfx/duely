import { useState, useEffect, useRef } from 'react';
import PlayerName from '../components/PlayerName';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GameLobby from '../components/GameLobby';
import GlowButton from '../components/GlowButton';
import ResultScreen from '../components/ResultScreen';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
import PrivateWaiting from '../components/PrivateWaiting';
import TowerCanvas from '../components/TowerCanvas';
import GameHelp from '../components/GameHelp';
import { usePageReady } from '../hooks/usePageReady';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { useGameScrollLock } from '../hooks/useGameScrollLock';
import { useResumeMatch } from '../hooks/useResumeMatch';
import { playMatchFound, playCountdown, playGo, playTowerPlace, playTowerPerfect } from '../utils/sound';
import { usePrivateRematch } from '../hooks/usePrivateRematch';

// Tower — same page shape as every other game: lobby, countdown, play, result.
// Only the middle bit is game-specific.

// The surviving player's window to beat a finished score. Mirrors the engine's
// CATCHUP_MS; shown as a countdown so they know they are on a clock.
function CatchupBanner({ endsAt, target }) {
  const [left, setLeft] = useState(Math.max(0, endsAt - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, endsAt - Date.now())), 100);
    return () => clearInterval(t);
  }, [endsAt]);
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20">
      <div className="px-3 py-1.5 rounded-lg bg-black/70 border border-danger/60">
        <div className="text-danger font-black text-xl tabular-nums leading-none">
          {(left / 1000).toFixed(1)}s
        </div>
        <div className="text-[10px] text-white/80 font-bold mt-0.5 whitespace-nowrap">
          BEAT {Number(target).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

export default function TowerGame() {
  const ready = usePageReady();
  const location = useLocation();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  // Rematch for invite/code matches — same two players, no new code.
  // See usePrivateRematch: the server marks the match private, and both
  // players must accept before anything is staked.
  const privateRematch = usePrivateRematch(socket, 'tower_match_found');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  const [phase, _setPhase] = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const phaseRef = useRef('lobby');
  const setPhase = (p) => { phaseRef.current = p; _setPhase(p); };

  const [entryFee, setEntryFee]   = useState(location.state?.entryFee ?? 1);
  const [countdown, setCountdown] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [opponent, setOpponent]   = useState(null);
  const [roomId, setRoomId]       = useState(null);
  const [myScore, setMyScore]     = useState(0);
  const [oppScore, setOppScore]   = useState(0);
  const [catchup, setCatchup]     = useState(null);   // { endsAt, target }
  // Solo Endless is a practice run against nobody. It is played through the bot
  // plumbing for convenience, but showing "Duely Bot" and a score alongside it
  // tells the player they are racing something they are not.
  const [soloEndless, setSoloEndless] = useState(false);
  // Only a bot match may be paused — a PvP clock is shared, so stopping it
  // would either freeze an innocent opponent or hand out free thinking time.
  const [helpPaused, setHelpPaused] = useState(false);
  const [result, setResult]       = useState(null);
  const [privateCode, setPrivateCode]     = useState('');
  const [invitedFriend, setInvitedFriend] = useState(null);

  const roomIdRef   = useRef(null);
  const doneRef     = useRef(false);
  const lastModeRef = useRef(null);   // 'pvp' | 'bot_paid' | 'bot_free'
  const lastSettings = useRef({ entryFee: 0, currency: 'coins' });
  const eloBeforeRef = useRef(profile?.elo ?? 1000);

  useResumeMatch(socket, () => phaseRef.current === 'active');
  // Pin the page for the countdown and the run — a tap that scrolled the board
  // instead of dropping a block would cost a real match.
  useGameScrollLock(phase === 'countdown' || phase === 'active');

  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The initial phase is set to 'queue' from autoQueue, but nothing ever emitted
  // the join — so arriving from Quick Match showed a Searching screen that would
  // have spun forever against an empty queue.
  // Arriving from an accepted friend invite — see the note in CarDashGame.
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

  // Forfeit on every way out of the page — refresh, tab close, in-app
  // navigation — but NOT on an app switch. See useLeaveGuard.
  useLeaveGuard(socket);

  useEffect(() => {
    if (!socket) return;

    const onQueueJoined = () => { setPhase('queue'); setStatusMsg('Waiting for opponent…'); };
    const onCancelled = ({ message }) => {
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled.');
      // The fee is deducted optimistically on match found; a cancel means it was
      // never taken, so re-read rather than leave the player looking at money
      // that did not move.
      refreshProfile();
    };

    const onMatchFound = ({ roomId: rid, opponent: opp, entryFee: fee, currency, vsBot }) => {
      roomIdRef.current = rid;
      setRoomId(rid);
      setOpponent(opp);
      setMyScore(0); setOppScore(0); setCatchup(null); setResult(null);
      doneRef.current = false;
      eloBeforeRef.current = profile?.elo ?? 1000;
      lastSettings.current = { entryFee: fee ?? 0, currency: currency ?? 'coins' };
      lastModeRef.current = vsBot ? (fee > 0 ? 'bot_paid' : 'bot_free') : 'pvp';
      /* A free bot game hides the opponent because the bot is plumbing rather
         than a rival. A DEMO match is the opposite: it is free, it is against a
         bot, and looking like an ordinary PvP match is the entire point —
         hiding the opponent turned it into a solo run with nobody in it. The
         opponent's own isBot flag is the difference: only the openly-named
         Duely Bot carries it, a disguised one does not. */
      setSoloEndless(!!vsBot && !(fee > 0) && !!opp?.isBot);
      setPhase('countdown');
      playMatchFound();
    };

    const onCountdown = ({ count }) => { setCountdown(count); playCountdown(); };
    const onStart = () => { setCountdown(0); playGo(); setPhase('active'); };
    const onOppScore = ({ score }) => setOppScore(score);
    const onCatchup  = ({ endsAt, target }) => setCatchup({ endsAt, target });

    const onResult = (data) => {
      // Trust the server's before-value when it sends one. The local profile can
      // be a few points stale, and subtracting from the wrong baseline is what
      // turned a normal rating loss into a reported "+3".
      if (Number.isFinite(Number(data?.eloBefore))) eloBeforeRef.current = Number(data.eloBefore);
      setCatchup(null);
      setResult(data);
      setPhase('result');
      refreshProfile();
    };

    socket.on('tower_queue_joined', onQueueJoined);
    socket.on('match_cancelled', onCancelled);
    socket.on('tower_match_found', onMatchFound);
    socket.on('tower_countdown', onCountdown);
    socket.on('tower_start', onStart);
    socket.on('tower_opponent_score', onOppScore);
    socket.on('tower_catchup', onCatchup);
    socket.on('tower_result', onResult);
    socket.on('private_room_created', ({ code }) => { setPrivateCode(code); setInvitedFriend(null); setPhase('private_waiting'); });
    socket.on('private_room_error', ({ message }) => setStatusMsg(message || 'Room not found'));
    // Tower had none of the invite plumbing: no way to show that an invite was
    // sent, and no way to come back from one being declined.
    socket.on('invite_sent', ({ friendUsername }) => {
      setPrivateCode(''); setInvitedFriend(friendUsername || 'your friend');
      setStatusMsg(''); setPhase('private_waiting');
    });
    socket.on('invite_declined', ({ friendUsername }) => {
      setPhase('lobby'); setInvitedFriend(null);
      setStatusMsg(`${friendUsername || 'Your friend'} declined the invite.`);
    });
    socket.on('invite_expired', () => {
      setPhase('lobby'); setInvitedFriend(null);
      setStatusMsg('The invite expired.');
    });
    socket.on('invite_failed', ({ message }) => {
      setPhase('lobby'); setInvitedFriend(null);
      setStatusMsg(message || 'Could not send that invite.');
    });

    return () => {
      socket.off('tower_queue_joined', onQueueJoined);
      socket.off('match_cancelled', onCancelled);
      socket.off('tower_match_found', onMatchFound);
      socket.off('tower_countdown', onCountdown);
      socket.off('tower_start', onStart);
      socket.off('tower_opponent_score', onOppScore);
      socket.off('tower_catchup', onCatchup);
      socket.off('tower_result', onResult);
      socket.off('private_room_created');
      socket.off('private_room_error');
      socket.off('invite_sent'); socket.off('invite_declined');
      socket.off('invite_expired'); socket.off('invite_failed');
    };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── actions ──
  // Two entry points on purpose.
  //
  // joinQueue() is the button handler and takes NOTHING. It used to accept
  // optional fee/currency overrides for the Quick Match path — but the lobby
  // wires it straight to onClick, so React handed it the click event as the
  // first argument, the event object was sent as the entry fee, and the server
  // rejected it. Find Opponent silently stopped working on exactly the two games
  // that had the overrides.
  function joinQueue() { joinQueueWith(); }

  function joinQueueWith(feeArg, curArg) {
    if (!authenticated) return;
    const fee = Number.isFinite(Number(feeArg)) ? Number(feeArg) : entryFee;
    const cur = typeof curArg === 'string' ? curArg : betCurrency;
    lastModeRef.current = 'pvp';
    lastSettings.current = { entryFee: fee, currency: cur };
    setStatusMsg('');
    socket.emit('join_tower_queue', { entryFee: fee, currency: cur });
  }
  function playVsBot() {
    if (!authenticated) return;
    lastModeRef.current = 'bot_paid';
    socket.emit('play_tower_vs_bot', { entryFee, currency: betCurrency });
  }
  function playVsBotFree() {
    if (!authenticated) return;
    lastModeRef.current = 'bot_free';
    socket.emit('play_tower_vs_bot', { entryFee: 0, currency: 'coins' });
  }
  function createPrivate(fee, cur) {
    setPrivateCode('');
    socket.emit('create_private_room', { gameType: 'tower', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    socket.emit('join_private_room', { gameType: 'tower', code });
  }
  function cancelPrivate() {
    socket?.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setInvitedFriend(null); setStatusMsg('');
  }
  function backToLobby() {
    socket?.emit('leave_tower_queue');
    setPhase('lobby'); setResult(null); setPrivateCode(''); setStatusMsg('');
  }
  function playAgain() {
    const mode = lastModeRef.current;
    const s = lastSettings.current;
    setResult(null); setMyScore(0); setOppScore(0); setCatchup(null);
    if (mode === 'pvp') {
      socket.emit('join_tower_queue', { entryFee: s.entryFee, currency: s.currency });
      setPhase('queue');
      setStatusMsg('Waiting for opponent…');
    } else if (mode === 'bot_paid' || mode === 'bot_free') {
      socket.emit('play_tower_vs_bot', {
        entryFee: mode === 'bot_free' ? 0 : s.entryFee,
        currency: mode === 'bot_free' ? 'coins' : s.currency,
      });
    } else {
      setPhase('lobby');
    }
  }

  // ── canvas callbacks ──
  const onPerfect = () => {
    playTowerPerfect();
    // A single very short pulse. Anything longer reads as an error buzz, and on
    // a run of perfects a heavy pattern becomes irritating fast. Guarded because
    // iOS Safari has no Vibration API at all and desktop Chrome throws on some
    // platforms.
    try { navigator.vibrate?.(12); } catch { /* not supported — no fallback wanted */ }
  };

  const onScore = (score) => {
    setMyScore(score);
    if (roomIdRef.current) socket?.emit('tower_score_ping', { roomId: roomIdRef.current, score });
  };
  const onGameOver = ({ score, taps }) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (roomIdRef.current) socket?.emit('tower_complete', { roomId: roomIdRef.current, score, taps });
  };

  // ── result ──
  if (phase === 'result' && result) {
    const isWinner = result.isSolo ? !!result.humanWon : result.winnerId === profile?.id;
    const freeSolo = result.isSolo && !(result.entryFee > 0);
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-4">
        <ResultScreen
          isWinner={isWinner}
          vsBot={!!result.vsBot}
          opponent={opponent}
          solo={freeSolo}
          winnerUsername={result.isSolo
            ? (isWinner ? (profile?.username ?? 'You') : 'Duely Bot')
            : result.winnerUsername}
          loserUsername={result.isSolo
            ? (isWinner ? 'Duely Bot' : (profile?.username ?? 'You'))
            : result.loserUsername}
          newWinnerElo={result.isSolo ? (isWinner ? result.newElo : undefined) : result.newWinnerElo}
          newLoserElo={result.isSolo ? (isWinner ? undefined : result.newElo) : result.newLoserElo}
          winnerBefore={result.isSolo ? (isWinner ? result.eloBefore : undefined) : result.winnerBefore}
          loserBefore={result.isSolo ? (isWinner ? undefined : result.eloBefore) : result.loserBefore}
          eloBeforeRef={eloBeforeRef}
          balanceChange={result.balanceChange}
          currency={result.currency || betCurrency}
          entryFee={result.entryFee ?? entryFee}
          disconnected={result.disconnected}
          profile={profile}
          gameLabel={freeSolo ? '🎮 Solo Endless' : 'Tower'}
          extraRows={result.isSolo
            ? (freeSolo
                ? [{ label: 'Blocks', value: (result.playerScore ?? 0).toLocaleString() }]
                : [
                    { label: 'Your Blocks', value: (result.playerScore ?? 0).toLocaleString() },
                    { label: 'Bot Blocks',  value: (result.botScore ?? 0).toLocaleString() },
                  ])
            : [{
                label: 'Blocks',
                value: `${(isWinner ? result.winnerScore : result.loserScore) ?? 0} — ${(isWinner ? result.loserScore : result.winnerScore) ?? 0}`,
              }]}
          isPrivate={privateRematch.isPrivate}
          rematchState={privateRematch.rematchState}
          onPrivateRematch={privateRematch.requestRematch}
          onPlayAgain={playAgain}
          onBackToLobby={backToLobby}
        />
      </div>
    );
  }

  // ── countdown / play ──
  if (phase === 'countdown' || phase === 'active') {
    return (
      <div
        className="relative select-none"
        style={{
          height: 'calc(100dvh - 56px)',
          background: '#000',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          overscrollBehavior: 'none',
        }}
      >
        {/* bottom-left: the opponent's height is pinned top-right and the
            catch-up banner top-left, so the top of this canvas is spoken for. */}
        <GameHelp
          gameType="tower"
          placement="bottom-left"
          canPause={lastModeRef.current !== 'pvp'}
          onPauseChange={setHelpPaused}
        />
        <TowerCanvas
          running={phase === 'active' && !(helpPaused && lastModeRef.current !== 'pvp')}
          onScore={onScore}
          onGameOver={onGameOver}
          onPerfect={onPerfect}
          onPlace={playTowerPlace}
        />

        {catchup && <CatchupBanner endsAt={catchup.endsAt} target={catchup.target} />}

        {/* Opponent's tower height. Deliberately small and out of the way — the
            board is the thing being looked at. */}
        {opponent && !soloEndless && (
          <div className="pointer-events-none absolute right-3 top-3 z-20 text-right">
            <div className="text-[10px] uppercase tracking-widest text-white/50 font-bold">
              {opponent.username}
            </div>
            <div className="text-2xl font-black text-white/90 tabular-nums leading-none">{oppScore}</div>
          </div>
        )}

        {phase === 'countdown' && (
          // The same countdown screen the other games use — full-bleed, the
          // number at text-8xl in primary with the same glow, and "Get ready…"
          // beneath it. It previously had its own size, position and wording.
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-bg px-4">
            <div className="text-center animate-fade-in">
              <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>
                {countdown || 1}
              </div>
              <p className="text-muted">Get ready...</p>
              {opponent && !soloEndless && (
                <p className="text-xs text-muted mt-2 flex items-center justify-center gap-1.5">
                  vs <PlayerName username={opponent.username} avatarUrl={opponent.avatarUrl}
                       color={opponent.profileColor} isBot={!!opponent.isBot} size="w-5 h-5" />
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── waiting on a friend invite or a private link ──
  if (phase === 'private_waiting') {
    return (
      <PrivateWaiting
        invitedFriend={invitedFriend}
        code={privateCode}
        gameType="tower"
        onCancel={cancelPrivate}
      />
    );
  }

  // ── queue ──
  // The same searching screen every other game uses. Tower had a bespoke one
  // with its own icon, heading and copy, which made it look like a different
  // product the moment you pressed Find Opponent.
  if (phase === 'queue') {
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching...</h2>
          <GlowButton variant="ghost" onClick={backToLobby}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── lobby ──
  return (
    <div
      className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-3 sm:px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      <GameLobby
        title="Tower"
        description={
          'Stack the blocks as high as you can. Each block slides in on its own — tap to drop it, ' +
          'and anything hanging over the edge is sliced off. Land it dead center and you keep the full width.'
        }
        controls="Tap the screen or press SPACE to drop · Perfect drops keep your tower wide"
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
        gameType="tower"
        liveCount={playerCounts?.['tower'] ?? 0}
      />
      {privateCode && (
        <ChallengeLinkBox
          code={privateCode}
          gameType="tower"
          gameName="Tower"
          entryFee={entryFee}
          currency={betCurrency}
          invitedFriend={invitedFriend}
        />
      )}
    </div>
  );
}

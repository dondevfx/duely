import { useState, useEffect } from 'react';
import DiamondIcon from './DiamondIcon';
import PlayerName from './PlayerName';
import { OutcomeIcon } from './UiIcon';
import { getRank, isRanked, placementMatches, getDisplayRank } from '../utils/ranks';
import CoinIcon from './CoinIcon';
import useTournamentResult from '../hooks/useTournamentResult';
import { playWin, playLoss, playDraw } from '../utils/sound';

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Big countdown number shown below the payout — 10 seconds, flashes red at 5
function ResultTimer({ seconds = 10, onTimeout }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(id); onTimeout?.(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flashing = remaining <= 5;
  return (
    <div className="text-center mt-2 sm:mt-4">
      <div
        key={remaining}
        className={`text-4xl sm:text-5xl font-black font-mono ${flashing ? 'animate-pulse' : ''}`}
        style={{ color: remaining <= 3 ? '#ef4444' : flashing ? '#f97316' : '#64748b' }}
      >
        {remaining}
      </div>
      <div className="text-xs text-muted mt-0.5">returning to lobby…</div>
    </div>
  );
}

/**
 * ResultScreen — shared result card used by all game pages.
 *
 * Props:
 *   isWinner        bool
 *   winnerUsername  string
 *   loserUsername   string
 *   newWinnerElo    number
 *   newLoserElo     number
 *   eloBeforeRef    ref  (ref.current = elo before match)
 *   balanceChange   { winnerPayout }
 *   currency        'coins' | 'diamonds'
 *   entryFee        number
 *   disconnected    bool   (opponent left)
 *   winnerStreak    number
 *   isFirstWin      bool
 *   profile         profile object
 *   extraRows       [{ label, value }]  — game-specific stats
 *   onRematch       fn | null   (null = hide rematch button)
 *   onPlayAgain     fn          (back to lobby)
 *   rematchLabel    string      default 'Rematch'
 *   gameLabel       string      e.g. '🟩 Block Fall'
 */
export default function ResultScreen({
  isWinner,
  isDraw: reportedDraw = false,
  winnerUsername,
  loserUsername,
  // The opponent as the server described them at match_found. Their picture is
  // resolved by NAME rather than being passed per side, because the card is
  // told who won and lost by username and does not otherwise know which of the
  // two that is.
  opponent = null,
  newWinnerElo,
  newLoserElo,
  // Authoritative before-values from the engine. Optional: a page that has
  // not been wired to pass them still falls back to eloBeforeRef.
  winnerBefore = null,
  loserBefore = null,
  eloBeforeRef,
  balanceChange,
  currency = 'coins',
  entryFee = 0,
  disconnected = false,
  winnerStreak = 0,
  isFirstWin = false,
  profile,
  extraRows = [],
  onRematch,
  onPlayAgain,
  onBackToLobby,
  rematchLabel = 'Rematch',
  // Private match (invite or code): the SAME button becomes Rematch and goes
  // back to the same opponent instead of the open queue. Deliberately a
  // relabel of the existing button rather than a second one — the card is
  // meant to look identical, only the word changes.
  //
  // isPrivate comes from the server with the match, not from the page
  // remembering how it started: a reload or a rejoin loses page state, and a
  // button that silently re-queues you into the public pool when you thought
  // you were rematching a friend is worse than no button at all.
  isPrivate = false,
  // 'idle' | 'waiting' | 'requested' — drives the label while the two
  // players agree. Both must accept before anything is staked.
  rematchState = 'idle',
  onPrivateRematch,
  gameLabel = '',
  // Solo: a run with no opponent.
  //
  // It does NOT get its own headline. An earlier version said "Run Over" with a
  // neutral icon, which is exactly what made these screens look like a different
  // product — the whole point is that finishing a run reads like every other
  // result in the app. The caller passes isWinner as usual and gets Victory.
  //
  // What solo actually changes is only what would be false with nobody on the
  // other side: the "you vs them" line, the win streak, and the placement
  // tracker. Rating and payout follow the stake, not this flag, so a paid solo
  // (Word VS) keeps both rows while a free endless run shows neither.
  solo = false,
  // Whether either side was a bot. Streaks are a PvP record — applyMatchStreaks
  // no-ops the moment a bot is involved — so the card must not claim a streak
  // was reset by a loss to one. It said so on every bot defeat, which read as a
  // punishment that never actually happened.
  vsBot = false,
}) {
  // onBackToLobby falls back to onPlayAgain for pages that haven't split the two yet
  const goBack = onBackToLobby ?? onPlayAgain;
  // Null for an ordinary match, which is every match that is not a round of a
  // tournament. See the hook: the card works this out for itself rather than
  // being told, because there are a dozen call sites and one of them would
  // have been missed.
  const tour = useTournamentResult();
  // A draw the bracket announced counts as one here even when the game said
  // otherwise. A demo account's staged draw is reported by the game as the win
  // it was, and the card has to show the draw screen the bracket is running.
  const isDraw = reportedDraw || !!tour?.sudden;
  // What the final or the playoff pays is decided by the bracket, not by the
  // game's own reading — after sudden death or the deadline the two differ.
  const tourWon = tour?.iWon ?? isWinner;
  const tourPay = tour?.pays ? (tourWon ? tour.pays.win : tour.pays.lose) : 0;
  const elo = isWinner ? newWinnerElo : newLoserElo; // undefined = no ELO data yet

  // Which picture belongs to a name. There are only ever two players on this
  // card, so anything that is not me is the opponent — the card is told who
  // won and lost by username and does not otherwise know which side that is.
  const who = (name) => (name && profile?.username && name === profile.username)
    ? { username: name, avatarUrl: profile?.avatar_url, color: profile?.profile_color }
    // The BOT FACE comes from the opponent, never from the mode. vsBot is true
    // for a demo match too, and those bots wear a random human name on purpose
    // — giving them the robot face here handed the disguise away on the result
    // card while the countdown showed them correctly.
    : { username: name, avatarUrl: opponent?.avatarUrl, color: opponent?.profileColor, isBot: !!opponent?.isBot };

  // The BEFORE value the server actually computed against, when it sends one.
  //
  // eloBeforeRef is captured on the page when the player joins the queue, but
  // the server computes the new rating from whatever the profile reads at
  // SETTLEMENT. Those diverge whenever a rating moves in between — most often
  // the previous match's result landing while this one was queuing or playing.
  // Subtracting the stale queue-time baseline then reports a delta that never
  // happened: a real +22 off 1022 lands at 1044, minus a baseline of 1000,
  // and the card claims +44.
  //
  // The rating written was always correct; only the number shown was wrong.
  // Preferring the server's own before-value makes the displayed delta exactly
  // the swing that was applied, and no page can reintroduce the bug by
  // capturing its baseline at the wrong moment.
  const serverBefore = isWinner ? winnerBefore : loserBefore;
  const eloBefore = serverBefore ?? eloBeforeRef?.current ?? null;
  const rawDelta  = (elo != null && eloBefore != null) ? elo - eloBefore : null;

  // A rating cannot move more than this in one match — the server's own
  // range is +20..+23 on a win and -17..-20 on a loss, so anything larger is
  // arithmetic about a stale number, not a swing anyone received.
  //
  // This is a DISPLAY clamp and deliberately not a silent one: +44 was
  // reported twice from production and could not be reproduced by reading
  // the settlement path, so rather than guess again at the cause, the number
  // shown is bounded to what is actually possible and the real values are
  // logged for whoever looks next. The stored rating is untouched either way
  // — this only decides what the card says.
  const ELO_MAX_SWING = 25;
  let eloDelta = rawDelta;
  if (rawDelta != null && Math.abs(rawDelta) > ELO_MAX_SWING) {
    console.error(
      `[elo] impossible delta on the result card: before=${eloBefore} after=${elo} ` +
      `delta=${rawDelta} (serverBefore=${serverBefore}, refBefore=${eloBeforeRef?.current}). ` +
      `Clamping the display; the stored rating is unchanged.`);
    eloDelta = Math.sign(rawDelta) * ELO_MAX_SWING;
  }

  const totalMatches = (profile?.wins ?? 0) + (profile?.losses ?? 0);
  const ranked = isRanked(profile);
  const placement = placementMatches(profile);
  // Only a placed account has a rating to show. It used to show one whenever
  // the match was paid, so a brand-new account watched a number move that the
  // server had refused to write (placement holds every rating at 1000) — and
  // the same screen called them Unranked two rows above.
  const showElo = ranked;

  // The rating row appears only when a rating actually moved.
  //
  // The engines report null for every unrated outcome — free play, solo runs,
  // draws — so a missing value means "this mode does not rate", not "not loaded
  // yet". Previously they sent the player's UNCHANGED rating instead, which
  // rendered as "1000 (+0)": a rated match that happened to be worth nothing.
  // Free matches, solo runs and every bot match report null: those do not
  // rate at all (see ratesElo on the server), so there is no row to draw.
  const ratingMoved = elo != null && ranked;

  // A free solo run is neither staked nor rated, so the payout row would be
  // reporting on something that did not happen.
  const rated = ratingMoved || entryFee > 0;
  const showLedger = !solo || rated;

  // Play the result sound once when this card mounts.
  useEffect(() => {
    // A solo run is neither won nor lost, so it takes the neutral chime. The
    // loss sting on every practice run would read as punishment for playing.
    if (isDraw) playDraw();
    else if (isWinner) playWin();
    else playLoss();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="w-full max-w-sm mx-auto relative animate-slide-up"
      onMouseEnter={() => {}} // timer continues — intentional
    >
      <div className="bg-surface border border-surfaceLight rounded-2xl overflow-hidden shadow-2xl">
        {/* Tighter on a phone, unchanged above sm.
            The card has to fit a 667px screen — an iPhone SE or an 8 — with a
            navbar above it, and on the first three matches of an account it is
            also carrying the placement row. Every reduction here is padding or
            a gap; nothing is removed, and nothing shrinks on a desktop. */}
        <div className="p-4 sm:p-7">
          {/* Win / Loss / Draw header */}
          <div className="text-center mb-3 sm:mb-5">
            <div className="mb-2 flex justify-center">
              <OutcomeIcon kind={isDraw ? 'draw' : isWinner ? 'win' : 'loss'} size={54} />
            </div>
            <div className={`text-3xl font-black ${isDraw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`}>
              {isDraw ? 'Draw!' : isWinner ? 'Victory!' : 'Defeat'}
            </div>
            {!solo && !isDraw && isWinner && winnerStreak >= 1 && (
              <p className="text-base font-bold text-orange-400 mt-1" style={{ textShadow: '0 0 10px rgba(251,146,60,0.5)' }}>
                🔥 {winnerStreak} Win Streak!
              </p>
            )}
            {!solo && !vsBot && !isDraw && !isWinner && (
              <p className="text-sm text-muted mt-1">Your win streak has been reset</p>
            )}
            {!solo && !isDraw && isWinner && isFirstWin && (
              <div className="mt-2 px-4 py-1.5 rounded-xl bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 text-sm font-bold inline-block">
                🎉 First Victory!
              </div>
            )}
          </div>

          {/* Placement progress (first 3 matches). A solo run does not count
              toward placement, so showing the tracker here would imply it does. */}
          {/* One row on a phone, three on a desktop.
              Stacked — a label, then the dots, then a caption — this was three
              lines plus its own padding, and it only ever appears on a card
              that is already at its tallest: the first three matches an account
              plays. On a phone that pushed the bottom of the result card off
              the screen, so the thing it was reporting on could not be read.
              Same information, laid out along the short axis instead of the
              long one, and only the caption gives anything up. */}
          {!solo && !ranked && (
            <div className="mb-2 sm:mb-4 px-3 py-1.5 sm:p-3 rounded-xl bg-primary/10 border border-primary/30
                            flex items-center justify-center gap-2 sm:flex-col sm:gap-1 sm:text-center">
              <div className="text-[0.625rem] sm:text-xs font-bold text-primary whitespace-nowrap">
                Placement<span className="hidden sm:inline"> Matches</span>
              </div>
              <div className="flex justify-center gap-1.5 sm:gap-2">
                {[0,1,2].map(i => (
                  <div key={i} className={`w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 flex items-center justify-center text-[0.5rem] sm:text-[0.5625rem] font-black transition-all ${
                    i < placement
                      ? 'bg-success border-success text-white'
                      : 'border-muted text-muted'
                  }`}>
                    {i < placement ? '✓' : i + 1}
                  </div>
                ))}
              </div>
              <div className="text-[0.625rem] sm:text-xs text-muted whitespace-nowrap">
                {placement}/3<span className="hidden sm:inline"> — {3 - placement} match{3 - placement !== 1 ? 'es' : ''} to unlock ranked</span>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="bg-bg rounded-xl p-3 sm:p-4 mb-3 sm:mb-4 space-y-1.5 sm:space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted min-w-0 flex items-center gap-1.5 overflow-hidden">
                {solo ? (
                  <PlayerName username={profile?.username || 'You'} avatarUrl={profile?.avatar_url}
                    color={profile?.profile_color} size="w-5 h-5" />
                ) : (
                  <>
                    <PlayerName {...who(isWinner ? winnerUsername : loserUsername)} size="w-5 h-5" />
                    <span className="shrink-0">vs</span>
                    <PlayerName {...who(isWinner ? loserUsername : winnerUsername)} size="w-5 h-5" />
                  </>
                )}
              </span>
              {/* nowrap and shrink-0.
                  This sits opposite the player names in a justify-between row,
                  and the names take the space first — so a long username
                  squeezed "Solo Endless" until it broke across two lines, with
                  "Endless" under "Solo". The names already truncate (min-w-0 +
                  overflow-hidden on the left), so the label giving up its
                  flexibility costs nothing: the side that CAN shorten
                  gracefully is the side that does. */}
              <span className="text-xs text-muted whitespace-nowrap shrink-0">{gameLabel}</span>
            </div>
            {disconnected && (
              <div className="flex justify-between">
                <span className="text-muted">Reason</span>
                <span className="text-warning font-bold">Opponent disconnected</span>
              </div>
            )}
            {disconnected && isWinner && entryFee > 0 && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted">Prize pool</span>
                  <span className="text-white font-bold">
                    {currency === 'diamonds'
                      ? <span className="inline-flex items-center gap-1">{(entryFee * 2).toLocaleString()} <DiamondIcon size="0.85em" /></span>
                      : <span className="inline-flex items-center gap-1">{fmt(entryFee * 2)} <CoinIcon size="0.85em" /></span>}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Platform fee</span>
                  <span className="font-bold" style={{ color: '#f97316' }}>
                    {currency === 'diamonds' ? '0%' : '5%'}
                  </span>
                </div>
              </>
            )}
            {extraRows.map(r => (
              <div key={r.label} className="flex justify-between">
                <span className="text-muted">{r.label}</span>
                <span className="text-white font-bold">{r.value}</span>
              </div>
            ))}
            {/* No ELO and no payout on a solo run — nothing was staked and
                nothing was rated, and a "0" or "Unranked" row implies otherwise. */}
            {showLedger && ratingMoved && (
            <div className="flex justify-between border-t border-surfaceLight/40 pt-2">
              <span className="text-muted">ELO</span>
              {showElo ? (
                <span className="text-white font-bold">
                  {elo ?? '—'}{' '}
                  {eloDelta != null && (
                    <span className={eloDelta >= 0 ? 'text-success' : 'text-danger'}>
                      ({eloDelta >= 0 ? '+' : ''}{eloDelta})
                    </span>
                  )}
                </span>
              ) : (
                <span className="font-bold" style={{ color: '#64748b' }}>Unranked</span>
              )}
            </div>
            )}
            {/* What the final, or the playoff for third, just paid.
                A tournament round is staked at zero, so the ordinary ledger
                below has nothing to show — the stake was the entry fee and the
                prize is paid at the end. But the last two matches of a
                tournament are first against second and third against fourth,
                so both outcomes already have a price on them, and the player
                should not have to wait for settlement to be told what they
                just won. Second place is a payout too, which is why this does
                not ask who won. */}
            {/* Not while a draw is still being settled — who is paid what is
                not known yet. */}
            {tour?.pays != null && !(isDraw && !tour.decided) && (
              <div className="border-t border-surfaceLight/40 pt-3 mt-1 text-center">
                <div className="text-xs text-muted mb-1 uppercase tracking-widest font-semibold">
                  {tourPay > 0 ? 'Payout' : 'No payout'}
                </div>
                <div
                  className={`text-4xl font-black ${tourPay > 0 ? 'text-success' : 'text-muted'}`}
                  style={tourPay > 0 ? { textShadow: '0 0 20px rgba(74,222,128,0.6)' } : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {tourPay > 0 ? '+' : ''}
                    {fmt(tourPay)} <CoinIcon size="0.8em" />
                  </span>
                </div>
              </div>
            )}
            {showLedger && (balanceChange || (isDraw && entryFee > 0) || (!isDraw && entryFee > 0)) && (
              <div className="border-t border-surfaceLight/40 pt-3 mt-1 text-center">
                <div className="text-xs text-muted mb-1 uppercase tracking-widest font-semibold">
                  {isDraw ? 'Your Split' : isWinner ? 'Payout' : 'Entry Lost'}
                </div>
                <div
                  className={`text-4xl font-black ${isDraw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`}
                  style={{ textShadow: isWinner && !isDraw ? '0 0 20px rgba(74,222,128,0.6)' : isDraw ? '0 0 20px rgba(56,189,248,0.5)' : 'none' }}
                >
                  {isDraw ? (
                    currency === 'diamonds'
                      ? <span className="inline-flex items-center gap-1">+{Math.round(balanceChange?.winnerPayout ?? entryFee).toLocaleString()} <DiamondIcon size="0.8em" /></span>
                      : <span className="inline-flex items-center gap-1">+{fmt(balanceChange?.winnerPayout ?? entryFee)} <CoinIcon size="0.8em" /></span>
                  ) : isWinner ? (
                    currency === 'diamonds'
                      ? <span className="inline-flex items-center gap-1">+{Math.round(balanceChange?.winnerPayout ?? 0).toLocaleString()} <DiamondIcon size="0.8em" /></span>
                      : <span className="inline-flex items-center gap-1">+{fmt(balanceChange?.winnerPayout ?? 0)} <CoinIcon size="0.8em" /></span>
                  ) : (
                    currency === 'diamonds'
                      ? <span className="inline-flex items-center gap-1">-{entryFee} <DiamondIcon size="0.8em" /></span>
                      : <span className="inline-flex items-center gap-1">-{entryFee} <CoinIcon size="0.8em" /></span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Inside a bracket ────────────────────────────────────────
              Everything above this is unchanged: the same scoreline, rating,
              streak and payout rows an ordinary match shows, because a
              tournament round IS an ordinary match and hiding half the card
              would make it look like a lesser one.

              What changes is what comes next. There is no rematch and no
              playing again — the next thing that happens is the next round —
              so the two buttons and the lobby link collapse into one. And
              nothing here says "return to lobby" while a tournament the
              player is still in carries on without them. */}
          {tour ? (
            // A draw is not a result in a knockout. The first one goes to
            // sudden death: the countdown and a button to go, and nothing else
            // — the card above already says it was a draw.
            isDraw && !tour.isSuddenRound && !tour.decided ? (
              <SuddenDeathPanel sudden={tour.sudden} onGo={tour.suddenReady} />
            ) : isDraw && !tour.decided ? (
              // A drawn replay. Nothing is left to separate them but the coin
              // flip, which the bracket is doing now — so this waits for it
              // rather than calling the result itself.
              <p className="mt-3 sm:mt-4 text-center text-sm text-muted">
                Still level — settled by a coin flip.
              </p>
            ) : tour.over ? (
              // No second panel here.
              //
              // It said "You won the tournament" and printed the payout again,
              // directly under the payout the card had already shown — the
              // same number twice, one above the other, on the one screen
              // where the number is the point. The card above says who won and
              // what it paid; this only has to say where to go next.
              <>
                <button
                  onClick={tour.toLobby}
                  className="w-full mt-3 sm:mt-4 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                  style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
                >
                  Return to lobby
                </button>
              </>
            ) : (tour.iWon ?? isWinner) ? (
              <>
                {/* Only once there is somewhere to go.
                    Winning the final and winning a quarter-final look
                    identical on this card; the difference is whether another
                    round has been drawn or the tournament has been settled,
                    and both take a moment to arrive. Leaving on a timer before
                    then carried the champion off their own result — and the
                    payout, which is the thing they entered for, landed on a
                    screen they had already been moved past. */}
                {tour.settled && <ResultTimer seconds={8} onTimeout={tour.toBracket} />}
                <button
                  onClick={tour.toBracket}
                  className="w-full mt-3 sm:mt-4 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                  style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
                >
                  Next game
                </button>
              </>
            ) : (
              // Knocked out. A knockout is a knockout: there is no next round
              // for them and no bracket to go back to, so the card says so and
              // the only way on is the next tournament.
              <>
                <p className="mt-3 text-center text-sm text-muted">
                  Knocked out of the tournament.
                </p>
                <ResultTimer seconds={8} onTimeout={tour.toLobby} />
                <button
                  onClick={tour.toLobby}
                  className="w-full mt-3 sm:mt-4 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                  style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
                >
                  Back to tournaments
                </button>
              </>
            )
          ) : (
          <>
          {/* Countdown timer — goes back to lobby, not re-queue */}
          <ResultTimer seconds={10} onTimeout={goBack} />

          {/* Buttons */}
          <div className="flex gap-3 mt-3 sm:mt-4">
            {onRematch && (
              <button
                onClick={onRematch}
                className="flex-1 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
              >
                {rematchLabel}
              </button>
            )}
            <button
              onClick={isPrivate ? onPrivateRematch : onPlayAgain}
              disabled={isPrivate && rematchState === 'waiting'}
              className={`py-3 rounded-xl font-black text-base transition-all ${
                onRematch
                  ? 'flex-1 bg-surface border border-surfaceLight text-white hover:border-primary'
                  : 'w-full bg-primary text-white hover:bg-blue-500'
              } ${isPrivate && rematchState === 'waiting' ? 'opacity-60 cursor-default' : ''}`}
              style={!onRematch ? { boxShadow: '0 0 18px rgba(18,80,180,0.35)' } : {}}
            >
              {!isPrivate
                ? 'Play Again'
                : rematchState === 'waiting'
                  ? 'Waiting…'
                  : rematchState === 'requested'
                    ? 'Accept Rematch'
                    : 'Rematch'}
            </button>
          </div>

          <button
            onClick={goBack}
            className="w-full text-center text-xs text-muted hover:text-white transition-colors mt-3 py-1"
          >
            ← Back to lobby
          </button>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The draw screen inside a bracket: a countdown from five and a button.
 *
 * The replay starts when both players press or when the countdown ends —
 * whichever is first — and it is the SAME game, thirty seconds, best score
 * takes it. The button is the only thing here that does anything; the
 * countdown is what happens if nobody presses it.
 */
function SuddenDeathPanel({ sudden, onGo }) {
  const [now, setNow] = useState(() => Date.now());
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  // Counted to the instant the server sent, so a card that mounted a moment
  // late shows the real time left rather than starting its own five.
  const left = sudden ? Math.max(0, Math.ceil((sudden.startsAt - now) / 1000)) : null;
  return (
    <div className="mt-3 sm:mt-4 text-center">
      <div className="text-xs font-black uppercase tracking-widest text-accent">Sudden death</div>
      <div className="my-1 text-5xl font-black text-white tabular-nums" aria-live="polite">
        {left ?? 5}
      </div>
      <button
        onClick={() => { setPressed(true); onGo?.(); }}
        disabled={pressed}
        className="w-full mt-2 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all disabled:opacity-60 disabled:cursor-default"
        style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
      >
        {pressed ? 'Waiting for your opponent…' : 'Play sudden death'}
      </button>
    </div>
  );
}

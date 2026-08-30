import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import DiamondIcon from './DiamondIcon';
import GlowButton from './GlowButton';
import { useSocket } from '../context/SocketContext';
import BetSlider from './BetSlider';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';
import GameIcon from './GameIcon';
import { topUpRoute, topUpLabel } from '../utils/topUpRoute';
import CreateRoomModal from './CreateRoomModal';
import JoinRoomModal from './JoinRoomModal';
import { LockIcon } from './UiIcon';

// The secondary lobby actions: Challenge a Friend, Bet vs Bot, Play vs Bot,
// Join Game. Below Find Opponent, which is the one primary action, but not so
// small that they are awkward to hit on a phone or an iPad.
//
// Same surface and border as the Entry Fee panel above them, so the screen has
// two visual weights instead of three: one blue button that starts a match, and
// everything else in the neutral panel treatment.
//
// The text stays WHITE, unlike the panel's muted labels. An earlier version of
// these buttons used muted text on this same background and players could not
// tell they were buttons at all — the grey is what recedes here, not the label.
//
// whitespace-nowrap is load-bearing: two of these share a row, and the longest
// label ("Bet vs Bot — 50,000 💎") has to stay on one line or the row grows a
// second line and the buttons stop matching each other.
export const SMALL_BTN =
  'flex-1 px-3 sm:px-4 py-4 rounded-xl text-base font-bold whitespace-nowrap ' +
  'border border-border bg-surface text-white ' +
  'hover:border-primary hover:bg-surfaceLight active:bg-surfaceLight transition-all';

export const COIN_FEES    = [1, 5, 10, 25, 50, 100];
export const DIAMOND_FEES = [500, 5000, 50000];

function fmtFee(fee) {
  if (fee < 1)         return `${fee}`;
  if (fee >= 1000)     return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

// `gameType` on this component is the QUEUE key — it keys the bet-count map the
// server broadcasts. The friend-invite and private-room APIs take the ROOM id,
// which for two games is spelled differently. Passing the queue key straight
// through is why Block Burst invites failed with "Invalid game."
//
// The server normalises these too, so neither side alone can break it; this map
// exists so the request is correct as sent rather than correct only after being
// forgiven.
const INVITE_GAME_TYPE = {
  'block-blast': 'blockBlast',
  'car-dash':    'carDash',
  'color-rush':  'colorRush',
  'word-vs':     'scrabble',
};
const inviteTypeFor = (queueKey) => INVITE_GAME_TYPE[queueKey] || queueKey;

export default function GameLobby({
  title,
  description,
  controls,
  betCurrency,
  setBetCurrency,
  entryFee,
  setEntryFee,
  balance,
  authenticated,
  doAuth,
  onQueue,
  onBot,
  onBotFree,
  botLabel,
  onCreatePrivate,
  onJoinPrivate,
  statusMsg,
  liveCount,
  gameType,
}) {
  const [privateMode, setPrivateMode] = useState(null); // null | 'create' | 'join'
  const [joinCode, setJoinCode]       = useState('');

  const { betCounts } = useSocket() || {};
  const { session } = useAuth();
  const navigate = useNavigate();

  function guardedAction(fn) {
    return () => {
      if (!session) { navigate('/login'); return; }
      fn();
    };
  }

  const isDiamonds = betCurrency === 'diamonds';
  const fees       = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel  = isDiamonds ? <DiamondIcon /> : <CoinIcon size="0.85em" />;

  // ── Starting a match freezes the affordability check ──────────────────────
  //
  // The stake is deducted server-side and the new balance arrives on the socket
  // BEFORE this screen is replaced by the match. So for the moment in between,
  // balance < entryFee is true and the button flipped to "Insufficient 💎 — Get
  // More" on a match that was starting normally.
  //
  // Here that was worse than the cosmetic flash on the withdraw form, because
  // this button also changes WHAT IT DOES: while insufficient it navigates to
  // the top-up page. A second tap in that window — and people do tap again when
  // a button looks unresponsive — threw the player onto the rewards page while
  // the match they had just paid for was starting.
  //
  // The window is bounded rather than tied to a response, because the parent
  // has no single "it started" callback to hang it on. If the start actually
  // failed, the parent surfaces that through statusMsg and the button comes
  // back on its own.
  const [committing, setCommitting] = useState(false);
  const commitTimer = useRef(null);
  useEffect(() => () => clearTimeout(commitTimer.current), []);
  function commit(fn) {
    return (...args) => {
      setCommitting(true);
      clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => setCommitting(false), 5000);
      return fn?.(...args);
    };
  }

  const insufficient = !committing && entryFee > 0 && balance < entryFee;

  // Safety net on mount — catch case where betCurrency is already set but entryFee is stale
  useEffect(() => {
    if (!fees.includes(entryFee)) setEntryFee(fees[0]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Safety net on currency switch
  useEffect(() => {
    if (!fees.includes(entryFee)) setEntryFee(fees[0]);
  }, [betCurrency]); // eslint-disable-line react-hooks/exhaustive-deps

  function switchCurrency(cur) {
    setBetCurrency(cur);
    // Reset to first fee of new currency — avoids index mismatch between arrays
    const newFees = cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES;
    setEntryFee(newFees[0]);
  }

  const payoutAmt = isDiamonds
    ? (entryFee * 2).toLocaleString()
    : ((entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2));
  const payout = isDiamonds
    ? <span className="inline-flex items-center gap-1">{payoutAmt} <DiamondIcon /></span>
    : <span className="inline-flex items-center gap-1">{payoutAmt} <CoinIcon size="0.9em" /></span>;

  return (
    <div className="w-full max-w-md animate-slide-up">
      <h1 className="text-4xl sm:text-6xl font-black text-white text-center mb-0.5 sm:mb-3 leading-tight flex items-center justify-center gap-3">
        <GameIcon game={gameType} size={48} className="w-9 h-9 sm:w-14 sm:h-14" />{title}
      </h1>
      {/* No line clamp. This was line-clamp-2 on mobile, which cut the longer
          descriptions off mid-sentence with an ellipsis — and the rules are the
          one thing a new player actually needs to read. */}
      {description && (
        <p className="text-center text-muted text-sm sm:text-base leading-snug sm:leading-relaxed mb-1 sm:mb-6 px-2">{description}</p>
      )}

      {/* ── Entry Fee ── */}
      <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl p-2.5 sm:p-5">
        <div className="flex items-center justify-between mb-1.5 sm:mb-4">
          <span className="text-base font-bold text-white">Entry Fee</span>
          <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
            <button
              onClick={() => switchCurrency('coins')}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
            >
              <CoinIcon size="0.85em" /> Coins
            </button>
            <button
              onClick={() => switchCurrency('diamonds')}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
            >
              <DiamondIcon /> Diamonds
            </button>
          </div>
        </div>

        {/* One shared slider for every betting screen. This used to be a second,
            near-identical implementation living here, which is why the bet
            sections drifted apart between games and why a fix to the shared
            control never reached Rush Hour, Block Burst or Word VS. */}
        <BetSlider
          fees={fees}
          entryFee={entryFee}
          setEntryFee={setEntryFee}
          currLabel={currLabel}
          isDiamonds={isDiamonds}
        />

        {/* Live player count — only show when > 0 */}
        {typeof liveCount === 'number' && liveCount > 0 && (
          <div className="flex items-center gap-1.5 mt-0 sm:mt-1">
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4', animation: 'pulse 2s infinite' }} />
            <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{liveCount} playing</span>
          </div>
        )}

        {/* Per-bet live count — only show when > 0 */}
        {gameType && (() => {
          const betKey = `${gameType}:${entryFee}:${betCurrency}`;
          const betLiveCount = betCounts?.[betKey] || 0;
          if (betLiveCount <= 0) return null;
          return (
            <div className="flex items-center gap-1.5 mt-0 sm:mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4', animation: 'pulse 2s infinite' }} />
              <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>
                {betLiveCount} at this bet size
              </span>
            </div>
          );
        })()}

      </div>

      {/* ── Controls / extras ── */}
      {controls && <div className="mb-2 sm:mb-4">{controls}</div>}

      {/* ── Action Buttons ── */}
      <div className="flex flex-col gap-2 sm:gap-3">
        {!session ? (
          <GlowButton onClick={() => navigate('/login')} variant="primary" size="lg" className="w-full text-lg py-4 border border-transparent">
            <LockIcon /> Login to Play
          </GlowButton>
        ) : (
        <>
      {/* Insufficient balance is surfaced ON the action button, not as a line
          of its own. As a separate row it added ~14px of height that only ever
          appeared to players who could not afford the bet — i.e. it pushed the
          lobby off small screens in exactly the case where the buttons most
          needed to stay reachable.

          The button stays ENABLED in that state and routes to wherever the
          currency is topped up. Disabled, it named the problem and then refused
          to help with it, leaving the player to find the wallet themselves. */}
        <GlowButton
          onClick={
            !session      ? () => navigate('/login')
            : insufficient ? () => navigate(topUpRoute(betCurrency))
            : commit(onQueue)
          }
          variant="primary"
          size="lg"
          className="w-full text-lg py-4 border border-transparent"
          disabled={session && !authenticated}
        >
          {!session ? <><LockIcon /> Login to Play</> : insufficient ? topUpLabel(betCurrency) : 'Find Opponent'}
        </GlowButton>

        {/* Secondary options — small buttons, still visible but not competing
            with the one primary action above.

            Challenge a Friend sits in this group rather than above it. It used
            to be a full-height ghost button the same size as Find Opponent,
            which read as a second primary action and made the lobby tall enough
            to push the small buttons off a phone. It is a way of starting a
            match, like the three below it, so it looks like them. */}
        {session && (onBot || onBotFree || onCreatePrivate) && (
          <div className="flex flex-col gap-2 sm:gap-2 pt-0.5 sm:pt-1">
            {onCreatePrivate && (
              <button onClick={() => setPrivateMode('create')} className={SMALL_BTN}>
                🎮 Challenge a Friend
              </button>
            )}
            {/* Diamond bet-vs-bot gets its own full-width row — the label is too
                long to share a row with the other two. */}
            {/* Never disabled for balance. A dead button tells the player
                nothing — it looks broken, and they cannot find out why. It
                stays clickable and takes them where the currency is topped up,
                the same as the main action above. */}
            {onBot && isDiamonds && entryFee > 0 && (
              <button
                onClick={insufficient ? () => navigate(topUpRoute(betCurrency)) : commit(onBot)}
                className={SMALL_BTN}
              >
                {insufficient
                  ? <span className="inline-flex items-center gap-1">Insufficient <DiamondIcon /> — Get More</span>
                  : <span className="inline-flex items-center gap-1">Bet vs Bot — {fmtFee(entryFee)} <DiamondIcon /></span>}
              </button>
            )}
            <div className="flex gap-2 sm:gap-2">
              {onBotFree && (
                <button onClick={commit(onBotFree)} className={SMALL_BTN}>
                  {botLabel || 'Play vs Bot'}
                </button>
              )}
              {onCreatePrivate && (
                <button onClick={() => setPrivateMode('join')} className={SMALL_BTN}>
                  Join Game
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Private Match modals ── */}
        {onCreatePrivate && (
          <>
            <CreateRoomModal
              open={privateMode === 'create'}
              onClose={() => setPrivateMode(null)}
              gameType={inviteTypeFor(gameType)}
              entryFee={entryFee}
              currency={betCurrency}
              onCreateCode={() => onCreatePrivate(entryFee, betCurrency)}
            />

            <JoinRoomModal
              open={privateMode === 'join'}
              onClose={() => setPrivateMode(null)}
              onJoin={(code) => onJoinPrivate(code)}
              authenticated={authenticated}
            />
          </>
        )}
        </>
        )}
      </div>

      {statusMsg && (
        <p className="text-center text-sm sm:text-base text-muted mt-2 sm:mt-4 animate-fade-in">{statusMsg}</p>
      )}
      {session && !authenticated && (
        <div className="flex items-center justify-center gap-2 text-xs sm:text-sm text-muted mt-1.5 sm:mt-3">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          Connecting...
          <button onClick={doAuth} className="text-primary underline">Retry</button>
        </div>
      )}
    </div>
  );
}

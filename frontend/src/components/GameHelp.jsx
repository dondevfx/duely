import { useState, useEffect } from 'react';
import GameIcon from './GameIcon';

// A small "?" in the corner of a live game, and the rules behind it.
//
// The betting screen explains the game, but that screen is gone by the time
// anyone is confused — and in a paid match the alternative to remembering is
// losing the stake. This puts the rules one tap away without leaving the board.
//
// It pauses BOT matches only. A bot match is a private simulation, so stopping
// the clock costs nobody anything. A PvP match is a shared clock: pausing one
// side would either freeze an opponent who did nothing wrong, or hand the reader
// free thinking time in a race. So in PvP the game runs on behind the panel,
// which is also why the panel is deliberately small and to one side.
const HELP = {
  tower: {
    title: 'Tower',
    how: [
      'A block slides in from one side. Tap, click or press space to drop it.',
      'Anything hanging over the edge is sliced off, and the block gets narrower.',
      'Land one dead centre and you keep the full width — and get a little back.',
      'Miss the tower completely and the run is over.',
    ],
    win: 'The taller tower wins. If your opponent finishes first you get 15 seconds to beat their height.',
  },
  carDash: {
    title: 'Rush Hour',
    how: [
      'Steer left and right to weave through traffic.',
      'Both players drive the exact same road, so it is a fair race.',
      'The longer you survive, the faster it gets.',
    ],
    win: 'Highest score wins, with time survived breaking a tie. If your opponent crashes first you get 15 seconds to beat their score.',
  },
  colorRush: {
    title: 'Color Rush',
    how: [
      'Tap anywhere (or press space) to fly upward.',
      'You can only pass through the part of a ring that matches your color.',
      'The small four-color circles between rings change what color you are.',
      'Grab the white diamonds — each one is a point.',
    ],
    win: 'Most diamonds wins, with time survived breaking a tie. If your opponent dies first you get 15 seconds to beat their score.',
  },
  blockBlast: {
    title: 'Block Burst',
    how: [
      'Drag blocks from the tray onto the grid.',
      'Fill a full row or column to clear it and score.',
      'Chain clears together for more points.',
      'It ends when none of your three blocks fit anywhere.',
    ],
    win: 'Highest score when both players are finished.',
  },
  scrabble: {
    title: 'Word VS',
    how: [
      'Guess the five-letter word in six tries.',
      'Green means the letter is right and in the right place.',
      'Orange means the letter is in the word but somewhere else.',
      'Both players get the same word at the same time.',
    ],
    win: 'First to solve it wins. If neither solves it, fewest guesses used takes it.',
  },
  blackjack: {
    title: 'Blackjack',
    how: [
      'Get closer to 21 than your opponent without going over.',
      'HIT takes another card, STAND ends your turn.',
      'Both players act at the same time — nobody waits.',
      'Two matching cards can be split into two hands.',
    ],
    win: 'Closest to 21 without busting. Bust and you lose the hand.',
  },
  'coin-flip': {
    title: 'Coin Flip',
    how: [
      'Pick heads or tails before the match.',
      'You are matched with someone who picked the other side.',
      'The coin is flipped on the server — neither player can influence it.',
    ],
    win: 'The side the coin lands on takes the pot.',
  },
};

// WHERE the button sits, per game.
//
// It was floated at top-right on all six, and every single one has something
// there: the opponent's tower height, the opponent's score, the opponent's
// guess count, the lap timer, the turn timer. So it covered the one number the
// player most needs mid-match.
//
// Every placement is a corner. What keeps the button off the HUD is not the
// corner it picks but the space the game's own layout sets aside for it: the
// header games pad their score row (pl-12 / padding-left 60px) so the row
// starts to the RIGHT of the button. Remove that padding and the button lands
// straight back on the player's own score — measured, not assumed. So a new
// game using 'top-left' must reserve the room too.
//
//   'top-left'    — games with a header row, which reserves space for it.
//   'bottom-left' — full-bleed canvas games, whose HUD is along the top.
//   'top-right'   — only where the corner is genuinely empty (Coin Flip).
const PLACEMENT = {
  'bottom-left': 'absolute bottom-3 left-3 z-30',
  'top-right':   'absolute top-3 right-3 z-30',
  'top-left':    'absolute top-3 left-3 z-30',
};

export default function GameHelp({ gameType, onPauseChange, canPause = false, placement = 'top-right' }) {
  const [open, setOpen] = useState(false);
  const info = HELP[gameType];

  // Tell the game when it is paused, and make sure it is never left paused
  // because the component went away with the panel open.
  useEffect(() => {
    if (!canPause) return;
    onPauseChange?.(open);
    return () => onPauseChange?.(false);
  }, [open, canPause]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes it, because it covers the board.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!info) return null;

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        // Stops the tap reaching the board underneath — in Tower that would
        // drop a block, which is a bad way to open the instructions.
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        aria-label="How to play"
        className={`${PLACEMENT[placement] ?? PLACEMENT['top-right']} shrink-0
                   w-9 h-9 rounded-full bg-black/55 border border-white/25
                   text-white/80 hover:text-white hover:border-white/60 text-base font-bold
                   flex items-center justify-center backdrop-blur-sm transition-all`}
      >
        ?
      </button>

      {open && (
        // fixed, not absolute. The button sits inside a positioned header row,
        // and an absolute overlay would then be sized to that row rather than
        // to the screen.
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 overflow-y-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
        >
          <div
            className="w-full max-w-sm bg-surface border border-surfaceLight rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="text-lg font-black text-white flex items-center gap-2">
                <GameIcon game={gameType} size={22} />{info.title}
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="shrink-0 w-9 h-9 -mt-1 -mr-1 rounded-lg text-muted hover:text-white
                           hover:bg-surfaceLight text-lg font-bold flex items-center justify-center transition-all"
              >
                ✕
              </button>
            </div>

            <div className="text-xs font-bold uppercase tracking-widest text-primary mb-1.5">How to play</div>
            <ul className="space-y-1.5 mb-4">
              {info.how.map((line, i) => (
                <li key={i} className="text-sm text-white/85 leading-snug flex gap-2">
                  <span className="text-primary font-bold shrink-0">{i + 1}.</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <div className="text-xs font-bold uppercase tracking-widest text-primary mb-1.5">How you win</div>
            <p className="text-sm text-white/85 leading-snug mb-4">{info.win}</p>

            <p className="text-[11px] text-muted mb-4">
              {canPause
                ? 'Your game is paused while this is open.'
                : 'This is a live match — the game is still running.'}
            </p>

            <button
              onClick={() => setOpen(false)}
              className="w-full py-3 rounded-xl bg-primary text-white font-bold hover:bg-blue-500 transition-all"
            >
              Back to the game
            </button>
          </div>
        </div>
      )}
    </>
  );
}

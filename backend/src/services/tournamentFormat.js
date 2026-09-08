/**
 * The rules of a tournament, as arithmetic.
 *
 * Everything here is pure: given the same inputs it gives the same answer, and
 * none of it touches a database, a socket or a clock it did not receive. That
 * is deliberate — the money split, the schedule and the game rotation are the
 * parts that have to be RIGHT, and they are the parts hardest to check once
 * they are tangled up with sixteen live players.
 *
 * The live half — pools, players, sockets, settlement — is built on top of
 * this and can be exercised against it.
 */

// ── Shape ───────────────────────────────────────────────────────────────────

const POOL_SIZE = 16;          // a full bracket
const ROUNDS    = 4;           // 16 -> 8 -> 4 -> 2 -> 1
const PAID_PLACES = 3;

// Blackjack and Coin Flip are out: both are decided by the deal or the flip
// rather than by play, and a tournament that can turn on a coin toss is not a
// tournament. That leaves five games for four rounds, which is what makes "no
// repeats" possible at all — with four it would be forced, and with three it
// would be impossible.
const TOURNAMENT_GAMES = ['block-blast', 'car-dash', 'color-rush', 'tower', 'scrabble'];

// ── Money ───────────────────────────────────────────────────────────────────

// The three stakes. Fixed rather than a slider: sixteen players have to agree
// on one number, and a free choice would fragment the pool into sixteen pools
// of one.
const ENTRY_FEES = [1, 5, 10];

// 5% of the pot, which covers the platform's costs the same way match rake
// does.
const FEE_RATE = 0.05;

// How the prize splits across the three paid places, in whole percent.
//
// 50/30/20 of what is left after the fee. Weighted to the winner, but second
// still returns more than three times the entry at every stake — a bracket
// where only first place beats the entry fee is one nobody enters twice.
//
// Percent rather than 0.5/0.3/0.2 because the whole calculation runs in
// integer cents. In floating point 15.2 * 0.3 is 4.5599999999999996, so
// flooring it to the cent pays second place 4.55 instead of 4.56 — the total
// still reconciles, because first place absorbs whatever is left, so nothing
// looks wrong anywhere. It is simply not the split it says it is.
const PRIZE_SPLIT_PCT = [50, 30, 20];
const PRIZE_SPLIT = PRIZE_SPLIT_PCT.map(p => p / 100);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * What each place wins, for a given entry fee.
 *
 * Rounded DOWN to the cent, with the remainder going to first. Rounding each
 * share to the nearest cent independently can pay out more than the pot — three
 * shares of a 15.2 pot each rounding up is 15.21 leaving the platform — and a
 * prize table that does not sum to the pot is a slow leak that nothing checks.
 */
function prizesFor(entryFee, poolSize = POOL_SIZE) {
  // Cents, as integers, from here down. Every intermediate in this function
  // used to be a float and the errors were small enough to hide behind the
  // reconciliation.
  const potC = Math.round(entryFee * poolSize * 100);
  const feeC = Math.round(potC * FEE_RATE);
  const netC = potC - feeC;

  // Floored, so the shares can never sum to more than the pool. The remainder
  // — at most two cents — goes to first, not into the fee.
  const lowerC = PRIZE_SPLIT_PCT.slice(1).map(pct => Math.floor((netC * pct) / 100));
  const firstC = netC - lowerC.reduce((s, v) => s + v, 0);

  const toCoins = (c) => Math.round(c) / 100;
  return {
    pot: toCoins(potC),
    fee: toCoins(feeC),
    net: toCoins(netC),
    prizes: [firstC, ...lowerC].map(toCoins),
  };
}

// ── Schedule ────────────────────────────────────────────────────────────────

const SLOT_MS        = 20 * 60 * 1000;   // one every twenty minutes
const JOIN_WINDOW_MS =  5 * 60 * 1000;   // the first five of them

/**
 * When tournaments start, and when you may enter one.
 *
 * A slot every twenty minutes on the clock — :00, :20, :40 — with the first
 * five minutes of each being the window in which pools fill. Play begins when
 * the window closes.
 *
 * The five minutes is the JOIN window, not the whole tournament. Sixteen
 * players is four rounds, and four rounds of up to three minutes is twelve —
 * which cannot happen inside five. Running to about twelve minutes from a
 * five-minute window is what makes the next slot, twenty minutes later, land
 * clear of the last one.
 *
 * Anchored to the epoch, which is aligned to the hour, so the slots fall on
 * :00/:20/:40 UTC without any date arithmetic to get wrong at a DST boundary.
 * What a player sees is their own local time for the same instant.
 */
function slotAt(now) {
  const startsAt = Math.floor(now / SLOT_MS) * SLOT_MS;
  const closesAt = startsAt + JOIN_WINDOW_MS;
  return {
    startsAt,                      // the slot opened
    closesAt,                      // entry closes, play begins
    nextStartsAt: startsAt + SLOT_MS,
    joinOpen: now < closesAt,
    msUntilClose: Math.max(0, closesAt - now),
    msUntilNextOpen: startsAt + SLOT_MS - now,
  };
}

/** The slot a player would be entering right now — this one, or the next. */
function joinableSlot(now) {
  const s = slotAt(now);
  return s.joinOpen ? s : slotAt(s.nextStartsAt);
}

// ── The bracket ─────────────────────────────────────────────────────────────

/**
 * Which games a tournament plays, in order — one per round, never repeating.
 *
 * `rng` returns [0,1) and is passed in so a tournament's rotation can be
 * reproduced from its own seed: every player has to be told the same game for
 * the same round, and a rotation drawn independently on two servers is two
 * different tournaments.
 */
function pickRoundGames(rounds = ROUNDS, rng = Math.random, pool = TOURNAMENT_GAMES) {
  if (rounds > pool.length) {
    throw new Error(`cannot fill ${rounds} rounds without repeating from ${pool.length} games`);
  }
  const bag = [...pool];
  const out = [];
  for (let i = 0; i < rounds; i++) {
    // Fisher-Yates, one draw at a time: pick from what is left, so a game
    // cannot come up twice.
    const j = Math.floor(rng() * bag.length);
    out.push(bag.splice(Math.min(j, bag.length - 1), 1)[0]);
  }
  return out;
}

/**
 * The first round's pairings.
 *
 * Straight down the seeded list — 1 plays 2, 3 plays 4 — because entry order
 * is arrival order and carries no ranking. Seeding 1v16 would imply the list
 * means something it does not.
 */
function firstRoundPairs(players) {
  const pairs = [];
  for (let i = 0; i < players.length; i += 2) {
    pairs.push([players[i], players[i + 1] ?? null]);
  }
  return pairs;
}

/**
 * An empty bracket for a pool of `size`, as rounds of match slots.
 *
 * Every slot exists from the start with its players unknown, so the screen
 * players wait on can draw the whole shape immediately rather than growing it
 * a round at a time.
 */
function emptyBracket(size = POOL_SIZE) {
  const rounds = [];
  for (let n = size; n >= 2; n = Math.floor(n / 2)) {
    rounds.push(Array.from({ length: n / 2 }, () => ({ a: null, b: null, winner: null, scores: null })));
  }
  return rounds;
}

/** Which round a match in `roundIndex` feeds into, and which slot of it. */
function advanceTo(roundIndex, matchIndex) {
  return { round: roundIndex + 1, match: Math.floor(matchIndex / 2), side: matchIndex % 2 === 0 ? 'a' : 'b' };
}

/**
 * Where each finisher placed, from the bracket.
 *
 * First and second fall out of the final. THIRD is the loser of whichever
 * semi-final was lost to the eventual champion — there is no third-place
 * playoff, so the two semi-final losers are separated by who beat them: the
 * one who lost to the winner is placed above the one who lost to the runner-up.
 * Without a rule the two are indistinguishable and third place would be
 * whichever the array happened to list first.
 */
function placings(bracket) {
  const final = bracket[bracket.length - 1]?.[0];
  if (!final?.winner) return null;
  const first  = final.winner;
  const second = final.a === first ? final.b : final.a;

  const semis = bracket[bracket.length - 2] || [];
  const losers = semis
    .filter(m => m.winner)
    .map(m => ({ loser: m.a === m.winner ? m.b : m.a, beatenBy: m.winner }))
    .filter(x => x.loser);

  const toChampion = losers.find(x => x.beatenBy === first);
  const third = toChampion ? toChampion.loser : (losers[0]?.loser ?? null);
  return { first, second, third };
}

module.exports = {
  POOL_SIZE, ROUNDS, PAID_PLACES, TOURNAMENT_GAMES, ENTRY_FEES,
  FEE_RATE, PRIZE_SPLIT, PRIZE_SPLIT_PCT, SLOT_MS, JOIN_WINDOW_MS,
  prizesFor, slotAt, joinableSlot, pickRoundGames,
  firstRoundPairs, emptyBracket, advanceTo, placings,
};

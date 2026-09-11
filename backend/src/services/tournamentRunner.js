/**
 * The part that actually plays the tournament.
 *
 * tournamentFormat says what a tournament IS, tournamentPools says who is in
 * which bracket; this is the thing that turns a bracket into games. Once a
 * round begins it creates a real room per pending match through the ordinary
 * engines, counts the players in, and waits. Results come back through
 * tournamentHook, the winner is written into the bracket, and when every match
 * in the round is decided it draws the next game and does it again.
 *
 * Three decisions are worth stating, because each replaced something that did
 * not work:
 *
 * Rounds are played on the existing engines rather than reimplemented. A
 * tournament match is a normal match with the stake set to zero — the entry
 * fee was taken on the way in and the prize is paid on the way out, so if the
 * rooms charged as well, four rounds would cost five entries. Everything the
 * five games already do — countdowns, score pings, anti-cheat, forfeits,
 * result cards — is had for free, and there is no second implementation of
 * Block Burst to keep in step with the first.
 *
 * Nothing waits forever. Every match has a deadline; a player who never
 * finishes, never loads, or closes the tab loses it. A bracket where one
 * absent player stops the round is a bracket that takes everyone's money and
 * never pays it out.
 *
 * A draw is not a result. Knockout has to knock somebody out, so a drawn match
 * is replayed at thirty seconds, and a drawn replay is settled by a coin flip
 * seeded from the room. It always ends.
 */
const F = require('./tournamentFormat');
const hook = require('./tournamentHook');
const ENGINES = require('./tournamentEngines');
const { creditCoins } = require('./walletService');
const { seededRng, THIRD_PLACE } = require('./tournamentPools');

// How long a round's game is given before it is decided on whatever is known.
// Three minutes is the spec, and it is also comfortably longer than any of the
// five games actually take.
const MATCH_MS        = 3 * 60 * 1000;
const SUDDEN_MS       = 30 * 1000;
// The draw is its own screen, and it is two things one after the other: five
// seconds counting down, then the reel picking the game. The server holds the
// round back for both, so nobody is dropped into a game while the screen that
// announces it is still running.
const COUNTDOWN_MS    = 5000;
// The reel itself takes about 2.4 seconds; the rest is the hold on the game
// it landed on, which is the moment the whole screen exists for.
const REEL_MS         = 4000;
const PICK_MS         = COUNTDOWN_MS + REEL_MS;
// Between rounds, the same sequence — a new game is drawn for every round, so
// there is the same thing to show — after a beat on the bracket to read the
// results that just landed.
const INTERMISSION_MS = 3000 + PICK_MS;
// A player who is not connected when their match starts gets this long to
// arrive before it is forfeited.
const CONNECT_GRACE_MS = 20 * 1000;

// The clock, in one place and overridable.
//
// Not for tuning — these are the spec — but because the deadline is three
// minutes long and a test that cannot reach it cannot check what happens when
// it passes. That path decides matches and pays out of them, so it is not one
// to leave unexercised.
const DEFAULT_TIMINGS = {
  match: MATCH_MS, sudden: SUDDEN_MS, pick: PICK_MS,
  intermission: INTERMISSION_MS, grace: CONNECT_GRACE_MS,
  reel: REEL_MS,
  ready: 6000, overrun: 3000,
  // The draw screen: five seconds of countdown before the sudden-death replay,
  // cut short the moment both players press to go.
  suddenIntro: 5000,
};

function createRunner({ io, supabase, pools, engines = ENGINES, log = console, timings = {} } = {}) {
  const T = { ...DEFAULT_TIMINGS, ...timings };
  /** poolId → runtime state that is not part of the bracket itself */
  const live = new Map();

  function stateOf(poolId) {
    if (!live.has(poolId)) {
      live.set(poolId, { phase: 'idle', matches: new Map(), timers: [], settled: false, startedRound: -1 });
    }
    return live.get(poolId);
  }

  const later = (poolId, fn, ms) => {
    const t = setTimeout(() => { try { fn(); } catch (e) { log.error('[tournament] timer:', e.message); } }, ms);
    if (t.unref) t.unref();
    stateOf(poolId).timers.push(t);
    return t;
  };

  // ── Talking to the people in it ──────────────────────────────────────────
  function socketsOf(userId) {
    const out = [];
    for (const [, s] of io.sockets.sockets) if (s._authenticatedUserId === userId) out.push(s);
    return out;
  }

  function toPlayer(userId, event, payload) {
    for (const s of socketsOf(userId)) s.emit(event, payload);
  }

  /** Everyone in the pool — including the ones already knocked out of it. */
  function broadcast(pool, event, payload) {
    for (const p of pool.players) if (!p.isBot) toPlayer(p.userId, event, payload);
  }

  function pushPool(pool, extra = {}) {
    const { publicPool } = require('../routes/tournaments');
    broadcast(pool, 'tournament_update', { pool: publicPool(pool), ...extra });
  }

  // ── Starting a pool ──────────────────────────────────────────────────────
  /**
   * A pool has closed its window and drawn its bracket.
   *
   * The wager is recorded here, once per paying entrant, and nowhere else. It
   * is what makes an entry count towards playthrough: the coin ledger reads
   * wagering out of the matches table, and the entry fee itself is taken with
   * deduct_coins, which writes no row at all. Without this, entering a
   * tournament would spend coins without ever playing them through — money out
   * and no obligation paid down.
   *
   * The rounds themselves are staked at zero, so they add nothing here. One
   * entry, one wager.
   */
  async function beginPool(pool) {
    const st = stateOf(pool.id);
    if (st.phase !== 'idle') return;
    setPhase(pool, 'starting');

    if (supabase && !pool.free && pool.entryFee > 0) {
      const rows = pool.players.filter(p => !p.isBot).map(p => ({
        player1_id: p.userId, player2_id: null, winner_id: null,
        game_type: 'tournament',
        entry_fee_c: pool.entryFee, prize_pool_c: 0,
      }));
      if (rows.length) {
        try {
          const { data, error } = await supabase.from('matches').insert(rows).select('id, player1_id');
          if (error) throw error;
          // Kept so the champion's row can be marked a win when it ends.
          pool.matchRows = Object.fromEntries((data || []).map(r => [r.player1_id, r.id]));
        } catch (e) {
          log.error('[tournament] wager rows failed:', e.message);
        }
      }
    }

    pushPool(pool, { started: true });
    scheduleRound(pool, T.pick);
  }

  /**
   * Where the pool is, written onto the pool itself.
   *
   * Every one of these moments is also announced over the socket, and the
   * socket is what makes the screen react immediately. But a client that is
   * mid-navigation when one fires never hears it, and there is no second
   * chance: a tournament entered against bots starts in the same instant the
   * player is still moving from the bet screen to the bracket, so the draw
   * they were meant to watch happens to nobody.
   *
   * So the phase lives on the pool, where /tournaments/:id reads it. The
   * socket stays the fast path; this is the one that is always true.
   */
  function setPhase(pool, phase, extra = {}) {
    const st = stateOf(pool.id);
    st.phase = phase;
    pool.phase = phase;
    pool.nextRoundAt = extra.nextRoundAt ?? null;
    pool.reelAt = extra.nextRoundAt ? extra.nextRoundAt - T.reel : null;
    return st;
  }

  function scheduleRound(pool, delay) {
    const st = setPhase(pool, 'intermission', { nextRoundAt: Date.now() + delay });
    st.nextRoundAt = Date.now() + delay;
    broadcast(pool, 'tournament_round_starting', {
      poolId: pool.id,
      round: pool.round,
      game: pool.roundGames[pool.round],
      at: st.nextRoundAt,
      // The draw screen is a countdown and then a reel. Both instants are sent
      // rather than durations, so a tab that slept through part of it lands in
      // the right place instead of restarting the sequence.
      reelAt: st.nextRoundAt - T.reel,
    });
    later(pool.id, () => startRound(pool), delay);
  }

  // ── Playing a round ──────────────────────────────────────────────────────
  function startRound(pool) {
    const st = stateOf(pool.id);
    if (pool.state !== 'running') return;
    if (st.startedRound === pool.round) return;   // never twice
    st.startedRound = pool.round;
    setPhase(pool, 'playing');

    const game = pool.roundGames[pool.round];
    const pending = pools.pendingMatches(pool);

    for (const { m, i } of pending) startMatch(pool, i, m, game);
    startSampling(pool);

    // A round with nothing left to play — every match a bye — still has to
    // move on, or the tournament stops on a round it already finished.
    if (!pending.length) later(pool.id, () => roundSettled(pool), 50);
  }

  /**
   * The prizes this pool will pay, by place.
   *
   * The pot is what was actually put in, so a pool that started short pays
   * from what it took. Bots pay nothing in and so count for nothing here.
   */
  function prizeTable(pool) {
    const paying = pool.players.filter(p => !p.isBot).length;
    return F.prizesFor(pool.entryFee, Math.max(paying, 2)).prizes;
  }

  /** What winning and losing THIS match is worth, or null. */
  function prizesForMatch(pool, index) {
    if (pool.free || !(pool.entryFee > 0)) return null;
    const isFinalRound = pool.round === pool.bracket.length - 1;
    if (!isFinalRound) return null;
    const prizes = prizeTable(pool);
    if (index === THIRD_PLACE) return { win: prizes[2] ?? 0, lose: 0 };
    return { win: prizes[0] ?? 0, lose: prizes[1] ?? 0 };
  }

  function playerOf(pool, userId) {
    return pool.players.find(p => p.userId === userId) || null;
  }

  function seatFor(pool, userId, socketId) {
    const p = playerOf(pool, userId);
    return {
      socketId,
      userId,
      username: p?.username || 'Player',
      elo: p?.elo ?? 1000,
      avatarUrl: p?.avatarUrl ?? null,
      profileColor: p?.profileColor ?? null,
      // Zero, deliberately. See the file header: the stake is the entry fee,
      // and it has already been taken.
      entryFee: 0,
      currency: 'coins',
      isBot: !!p?.isBot,
      isDemo: !!p?.isDemo,
    };
  }

  function startMatch(pool, index, match, game, { sudden = false } = {}) {
    const st = stateOf(pool.id);
    // The round is fixed HERE, not read again when a timer fires.
    //
    // Every callback below outlives the round that started it — a deadline
    // three minutes out, a grace period, a bot's pause. Reading pool.round at
    // that point gives whatever round the tournament has since reached, so a
    // timeout from round one arriving during round two would decide a round
    // two match that nobody had played yet. It is the same reason onResult
    // takes a round rather than assuming the current one.
    const round = pool.round;
    const key = `${round}:${index}${sudden ? ':sd' : ''}`;
    if (st.matches.has(key)) return;

    const a = playerOf(pool, match.a);
    const b = playerOf(pool, match.b);
    if (!a || !b) return;

    // Two bots. Nobody is watching a game that is not being played, so it is
    // decided here — after a plausible pause, so a demo bracket resolves
    // around the player over the course of the round rather than the whole
    // round completing the instant it starts.
    if (a.isBot && b.isBot) {
      const rec = { bots: true, done: false };
      st.matches.set(key, rec);
      const span = sudden ? T.sudden : T.match;
      const wait = sudden ? Math.min(4000, span) : 25000 + Math.floor(Math.random() * 45000);
      // Finishing on their own schedule, unless a real player finishes first —
      // see finishBotsSoon.
      rec.finish = () => {
        // Unlike a played match there is no engine to say it is over, so this
        // is the only thing that stops a bot result landing on a match the
        // bracket has already decided some other way — a forfeit, most often.
        if (rec.done) return;
        rec.done = true;
        const winner = Math.random() < 0.5 ? a.userId : b.userId;
        onResult({ poolId: pool.id, round, match: index, winnerId: winner, isDraw: false, sudden });
      };
      rec.timer = later(pool.id, rec.finish, Math.max(2000, Math.min(wait, span - 5000)));
      return;
    }

    // A human with no socket cannot be counted in. Rather than hold the round
    // open, they are given a grace period to appear and then forfeited —
    // which is the same outcome as leaving, and for the same reason.
    const sa = socketsOf(a.userId)[0] || null;
    const sb = socketsOf(b.userId)[0] || null;
    if ((!a.isBot && !sa) || (!b.isBot && !sb)) {
      st.matches.set(key, { waitingFor: Date.now() + T.grace });
      later(pool.id, () => {
        st.matches.delete(key);
        const stillA = a.isBot || socketsOf(a.userId).length > 0;
        const stillB = b.isBot || socketsOf(b.userId).length > 0;
        if (stillA && stillB) return startMatch(pool, index, match, game, { sudden });
        // Both gone: a coin flip is the only thing left that ends it.
        const winner = stillA ? a.userId : stillB ? b.userId : (Math.random() < 0.5 ? a.userId : b.userId);
        onResult({ poolId: pool.id, round, match: index, winnerId: winner, isDraw: false, sudden });
      }, T.grace);
      return;
    }

    const engine = engines[game];
    if (!engine) {
      log.error('[tournament] no engine for', game);
      return onResult({ poolId: pool.id, round, match: index, winnerId: a.userId, isDraw: false, sudden });
    }

    const p1 = seatFor(pool, a.userId, sa?.id || `bot_${a.userId}`);
    const p2 = seatFor(pool, b.userId, sb?.id || `bot_${b.userId}`);
    const roomId = engine.create(p1, p2);

    // A bracket room is staked at zero, and the engines read that as practice:
    // Rush Hour and Colour Rush turn a free bot game into a solo run that
    // reports a time and names no winner, which is exactly the one thing a
    // bracket cannot use. Clearing soloRun makes it a real match again.
    //
    // demoWin is the other half. It only applies to rooms that contain a bot,
    // and it is what makes tournament bots lose: they are there to fill a
    // bracket that nobody else entered, they pay nothing and take nothing, so
    // a player must never go out of a real tournament to one.
    //
    // feesDeducted, because every engine refuses to settle a room that has a
    // fee it never took. This one has no fee at all, but the flag is what says
    // so deliberately rather than by omission.
    const room = engine.room?.(roomId);
    if (room) {
      room.tournament = { poolId: pool.id, round, match: index };
      room.soloRun = false;
      if (room.isSolo) room.demoWin = true;
      room.feesDeducted = true;
    }

    hook.register(roomId, { poolId: pool.id, round, match: index, a: a.userId, b: b.userId, sudden });

    const deadline = Date.now() + (sudden ? T.sudden : T.match);
    const rec = { roomId, game, deadline, sudden, begun: false, done: false };
    st.matches.set(key, rec);

    // What this particular match pays, for the two matches where that is
    // already known.
    //
    // The final is first place against second, and the playoff is third
    // against fourth — so the moment either starts, both outcomes have a price
    // on them. Everything before that pays nothing directly; you play the next
    // round instead.
    //
    // Sent with the match rather than worked out after it, because the result
    // card appears the instant the game ends and settlement takes a moment
    // longer. Waiting for settlement is what used to leave a champion looking
    // at a result with no payout on it.
    const pays = prizesForMatch(pool, index);

    const seen = (other, isBot) => ({
      userId: other.userId, username: other.username, elo: other.elo ?? 1000,
      avatarUrl: other.avatarUrl ?? null, profileColor: other.profileColor ?? null, isBot: !!isBot,
    });

    // Told twice, on purpose. `tournament_match` is what moves the bracket
    // screen onto the game; the engine's own match_found is what the game
    // screen itself listens for, and it has to arrive AFTER that screen has
    // mounted — which is why the countdown waits for the players to report in
    // rather than starting here.
    if (sa) {
      sa.join(roomId);
      sa.emit('tournament_match', {
        poolId: pool.id, round, match: index, game, roomId,
        sudden, deadline, pays, opponent: seen(p2, false),
      });
    }
    if (sb) {
      sb.join(roomId);
      sb.emit('tournament_match', {
        poolId: pool.id, round, match: index, game, roomId,
        sudden, deadline, pays, opponent: seen(p1, false),
      });
    }

    const arrived = new Set();
    const needed = [a, b].filter(p => !p.isBot).length;
    const go = () => {
      if (rec.begun || rec.done) return;
      rec.begun = true;
      // vsBot is deliberately false even when it is one. The bots fill a
      // bracket nobody else entered and are disguised as players everywhere
      // else in it; telling the game screen otherwise makes it draw the match
      // as a practice run against Duely Bot rather than as a round.
      if (sa) sa.emit(engine.event, { roomId, opponent: seen(p2, false), entryFee: 0, currency: 'coins', vsBot: false, tournament: true });
      if (sb) sb.emit(engine.event, { roomId, opponent: seen(p1, false), entryFee: 0, currency: 'coins', vsBot: false, tournament: true });
      engine.begin(io, supabase, roomId);
    };
    rec.ready = (userId) => {
      arrived.add(userId);
      if (arrived.size >= needed) go();
    };
    // If a screen never reports in, start anyway. The deadline is the real
    // guarantee, and a player who is not there loses on it.
    later(pool.id, go, T.ready);

    later(pool.id, () => {
      if (rec.done) return;
      forceMatch(pool, round, index, key, engine, roomId, a, b, sudden);
    }, (sudden ? T.sudden : T.match) + T.overrun);
  }

  /**
   * What every match in the round currently reads.
   *
   * A knocked-out player, and anyone waiting on the round to finish, is
   * watching a bracket where nothing moves for three minutes. The scores are
   * already in the rooms — every engine tracks a running one, because it needs
   * one for its own catch-up and anti-cheat — so this samples them and sends
   * them out. Read only: nothing here can change a result.
   */
  function sampleScores(pool) {
    const st = stateOf(pool.id);
    if (st.phase !== 'playing') return null;
    const out = [];
    let latest = 0;
    let sudden = false;
    for (const [key, rec] of st.matches) {
      if (!rec.roomId || rec.done) continue;
      const engine = engines[rec.game];
      const room = engine?.room?.(rec.roomId);
      if (!room || !engine.score) continue;
      const index = Number(key.split(':')[1]);
      const m = pools.matchAt(pool, pool.round, index);
      if (!m) continue;
      const of = (uid) => {
        const p = (room.players || []).find(x => x.userId === uid);
        return p ? engine.score(room, p.socketId) : null;
      };
      out.push({ match: index, game: rec.game, a: of(m.a), b: of(m.b) });
      if (rec.deadline) latest = Math.max(latest, rec.deadline);
      if (rec.sudden) sudden = true;
    }
    if (!out.length) return null;
    // Carried on the array rather than wrapped in an object, so every existing
    // reader of `scores` keeps working unchanged.
    out.endsAt = latest || null;
    out.sudden = sudden;
    return out;
  }

  function startSampling(pool) {
    const st = stateOf(pool.id);
    if (st.sampler) return;
    st.sampler = setInterval(() => {
      const scores = sampleScores(pool);
      if (!scores) return stopSampling(pool);
      broadcast(pool, 'tournament_scores', {
        poolId: pool.id, round: pool.round, scores,
        // When the round's clock runs out, and whether what is being played is
        // a sudden-death replay. Everyone waiting on the bracket sees the same
        // countdown as the players in it — otherwise a bracket in the middle
        // of a three-minute game looks like a bracket that has stopped.
        endsAt: scores.endsAt,
        sudden: scores.sudden,
      });
    }, 1500);
    if (st.sampler.unref) st.sampler.unref();
  }

  function stopSampling(pool) {
    const st = stateOf(pool.id);
    if (st.sampler) { clearInterval(st.sampler); st.sampler = null; }
  }

  /**
   * A player's last socket has gone.
   *
   * In a running tournament that is the end of it for them, wherever they were
   * standing — mid-game, between rounds, or watching the bracket. Refreshing,
   * closing the tab or losing the connection all look the same from here, and
   * a bracket cannot hold fifteen people while one of them decides whether to
   * come back.
   *
   * Their current match is forfeited and the opponent goes through; that is
   * pools.leave's rule and it is the same one that applies to leaving on
   * purpose. Their ticket is already spent — it was spent when the bracket
   * started — so nothing is given back.
   *
   * A pool still FILLING is the other case, and it is not a forfeit: nothing
   * has started, so the seat is freed and the entry refunded, exactly as if
   * they had pressed leave.
   */
  function playerGone(userId, onRefund) {
    for (const pool of pools.pools.values()) {
      if (pool.state !== 'running' && pool.state !== 'filling') continue;
      if (!pool.players.some(p => p.userId === userId && !p.isBot)) continue;

      const wasRunning = pool.state === 'running';
      const result = pools.leave(pool.id, userId);
      if (!result.ok) continue;

      if (result.refund && onRefund) onRefund(pool, userId, result.entryFee);
      if (!wasRunning) continue;

      // Marked so the bracket cannot be opened again. They are out, and a
      // screen that lets them keep watching reads as though they might still
      // be in it.
      (pool.kicked ||= new Set()).add(userId);
      broadcast(pool, 'tournament_update', { pool: require('../routes/tournaments').publicPool(pool) });
      if (result.forfeited) {
        onResult({
          poolId: pool.id, round: pool.round, match: result.forfeited.match,
          winnerId: result.forfeited.winner, isDraw: false,
        });
      } else if (pools.pendingMatches(pool).length === 0) {
        roundSettled(pool);
      }
    }
  }

  /** Somebody's game screen has loaded and is listening. */
  function ready(poolId, roomId, userId) {
    const st = live.get(poolId);
    if (!st) return;
    for (const m of st.matches.values()) if (m.roomId === roomId && m.ready) m.ready(userId);
  }

  /**
   * The deadline passed with no result.
   *
   * Decided on whatever the room knows — the engines keep a running score for
   * exactly this reason — and on a draw when it knows nothing, which sends it
   * to sudden death like any other draw.
   */
  function forceMatch(pool, round, index, key, engine, roomId, a, b, sudden) {
    let winner = null;
    try {
      const room = engine.room?.(roomId);
      if (room) {
        // The engine's own reading, not a guess at where it keeps it. Every
        // game stores a running score somewhere different, and reaching past
        // the adapter for two of the five field names is how this silently
        // returned zero for the other three.
        const score = (uid) => {
          const p = (room.players || []).find(x => x.userId === uid);
          if (!p) return -1;
          return engine.score ? engine.score(room, p.socketId) : 0;
        };
        const sa = score(a.userId), sb = score(b.userId);
        if (sa > sb) winner = a.userId;
        else if (sb > sa) winner = b.userId;
      }
    } catch (e) { log.error('[tournament] force read:', e.message); }
    // A bot is never half of a draw — it goes out, whatever the scores read.
    //
    // The engines pin a bot's score just behind the player's, but only when
    // the game ENDS. A room cut off at the deadline never reached that, so a
    // player who had not finished read level with the bot, the draw sent them
    // to sudden death they never saw, and the replay's own deadline decided it
    // on scores that were never pinned at all — which is how a demo account
    // was told it had lost to a bot.
    winner = humanOverBot(a, b) || winner;

    hook.forget(roomId);
    try { engine.del?.(roomId); } catch { /* the room may already be gone */ }
    io.to(roomId).emit('tournament_match_expired', { roomId });
    onResult({
      poolId: pool.id, round, match: index,
      winnerId: winner, isDraw: !winner, sudden, forced: true,
    });
  }

  // ── Results ──────────────────────────────────────────────────────────────
  function onResult({ poolId, round, match, winnerId, isDraw, sudden = false, forced = false }) {
    const pool = pools.get(poolId);
    if (!pool || pool.state !== 'running') return;

    const st = stateOf(poolId);
    const rec = st.matches.get(`${round}:${match}${sudden ? ':sd' : ''}`);
    if (rec) rec.done = true;

    const m = pools.matchAt(pool, round, match);
    if (!m || m.winner) return;

    // A demo account is shown sudden death once.
    //
    // A demo bracket is the player against bots, and a bot is never half of a
    // draw — so without this a demo could never see the draw screen, which is
    // the one part of a tournament that most needs showing. The player's first
    // match against a bot is turned into a draw, whoever the game said won, and
    // goes to sudden death exactly as a real one would. The replay is still
    // against a bot, so it still goes to the player. Once per tournament: the
    // point is to show it, not to make every round a coin toss.
    // Whether the game reported a win OR a tie. A tie against a bot is the
    // natural way a demo reaches this, and it used to fall through to the
    // bot rule below: the player was put straight through, no sudden death
    // was announced, and the card sat on a draw screen with nothing behind it.
    if (pool.demo && !pool.demoDrawn && !sudden) {
      const pa = playerOf(pool, m.a), pb = playerOf(pool, m.b);
      if (humanOverBot(pa, pb)) {
        pool.demoDrawn = true;
        return announceSuddenDeath(pool, round, match, m);
      }
    }

    if (isDraw || !winnerId) {
      // Against a bot there is no draw to replay — see humanOverBot.
      const human = humanOverBot(playerOf(pool, m.a), playerOf(pool, m.b));
      if (human) {
        winnerId = human;
      } else if (!sudden) {
        // Sudden death: the same game, thirty seconds, best score takes it.
        //
        // Held back behind the draw screen rather than started at once. It used
        // to start in the same instant the draw was reported, while both
        // players were still on their result card — which does not listen for
        // a new match — so the replay began with nobody in it and its deadline
        // settled it on scores of zero.
        return announceSuddenDeath(pool, round, match, m);
      } else {
        // A drawn replay: nothing else is left that can separate them. Seeded
        // from the match, so every server and every reload agrees on it.
        const rng = seededRng(`${poolId}:${round}:${match}`);
        winnerId = rng() < 0.5 ? m.a : m.b;
      }
    }

    const res = pools.reportResult(poolId, round, match, winnerId, forced ? { forced: true } : null);
    if (!res) return;

    broadcast(pool, 'tournament_result', { poolId, round, match, winnerId });
    // A real player has just finished theirs. Everyone else left in the round
    // is a bot on a timer of its own, and a player watching an empty bracket
    // tick for another minute is a player who thinks it has hung — so the rest
    // of the round comes in behind them.
    if (!rec?.bots) finishBotsSoon(pool);
    pushPool(pool);

    if (pools.pendingMatches(pool).length === 0) roundSettled(pool);
  }

  /** The human, when exactly one side of a match is a bot. */
  function humanOverBot(a, b) {
    if (!a || !b || !!a.isBot === !!b.isBot) return null;
    return a.isBot ? b.userId : a.userId;
  }

  /**
   * The draw screen, then the replay.
   *
   * Both players are told the replay starts in five seconds and are shown a
   * button to go now. It starts when both have pressed it or when the five
   * seconds are up, whichever comes first — a player who has walked away
   * cannot hold the other one on a countdown forever.
   */
  function announceSuddenDeath(pool, round, match, m) {
    const st = stateOf(pool.id);
    const key = `${round}:${match}`;
    if (st.suddenPending?.has(key)) return;
    (st.suddenPending ||= new Map());

    const startsAt = Date.now() + T.suddenIntro;
    const pending = { round, match, players: [m.a, m.b], pressed: new Set(), started: false };
    pending.start = () => {
      if (pending.started) return;
      pending.started = true;
      st.suddenPending.delete(key);
      // Only if nothing else has decided it in the meantime — a forfeit, most
      // likely, from someone who closed the tab on the draw screen.
      const live = pools.matchAt(pool, round, match);
      if (pool.state !== 'running' || !live || live.winner) return;
      startMatch(pool, match, live, pool.roundGames[round], { sudden: true });
    };
    st.suddenPending.set(key, pending);

    broadcast(pool, 'tournament_sudden_death', {
      poolId: pool.id, round, match,
      game: pool.roundGames[round],
      seconds: Math.round(T.sudden / 1000),
      startsAt,
      players: [m.a, m.b],
    });
    later(pool.id, pending.start, T.suddenIntro);
  }

  /** A player pressed "Play sudden death" on the draw screen. */
  function suddenReady(poolId, userId) {
    const st = live.get(poolId);
    if (!st?.suddenPending) return;
    const pool = pools.get(poolId);
    for (const pending of st.suddenPending.values()) {
      if (!pending.players.includes(userId)) continue;
      pending.pressed.add(userId);
      const humans = pending.players.filter(uid => !playerOf(pool, uid)?.isBot);
      if (humans.every(uid => pending.pressed.has(uid))) pending.start();
    }
  }

  /**
   * Bring the round's remaining bot matches in, 2-7 seconds apart.
   *
   * Only bot matches, and only once a played one has finished. Staggered
   * rather than resolved together: eight results landing in the same frame
   * reads as the bracket being filled in by a script, which for a demo
   * account is precisely the impression to avoid.
   */
  function finishBotsSoon(pool) {
    const st = stateOf(pool.id);
    for (const rec of st.matches.values()) {
      if (!rec.bots || rec.done || rec.hurried) continue;
      rec.hurried = true;
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = later(pool.id, rec.finish, 2000 + Math.floor(Math.random() * 5000));
    }
  }

  function roundSettled(pool) {
    const st = stateOf(pool.id);
    stopSampling(pool);
    const moved = pools.advanceRound(pool);
    if (moved) {
      st.matches.clear();
      return scheduleRound(pool, T.intermission);
    }
    if (pool.state === 'complete') settle(pool);
  }

  // ── Paying out ───────────────────────────────────────────────────────────
  function settle(pool) {
    const st = stateOf(pool.id);
    // The same promise, not a silent no-op. Settlement is reached from the
    // last result of the last round and from anything else that notices the
    // pool is complete; a second caller has to be able to wait for the first
    // one's payouts rather than be told they are done when they are not.
    if (!st.settling) st.settling = _settle(pool).catch(e => { log.error('[tournament] settle:', e.message); });
    return st.settling;
  }

  async function _settle(pool) {
    const st = stateOf(pool.id);
    if (st.settled) return;
    st.settled = true;
    setPhase(pool, 'complete');
    stopSampling(pool);
    for (const t of st.timers) clearTimeout(t);

    // placings() names them; the prize table is ordered. Lined up here once,
    // rather than indexing an object by accident.
    const named = F.placings(pool.bracket, pool.thirdPlace);
    const places = [named.first, named.second, named.third];
    const paying = pool.players.filter(p => !p.isBot);
    const prizes = prizeTable(pool);

    const awards = [];
    for (let i = 0; i < places.length && i < prizes.length; i++) {
      const uid = places[i];
      if (!uid) continue;
      const p = playerOf(pool, uid);
      if (!p || p.isBot) continue;      // a bot placing pays nobody
      awards.push({ userId: uid, place: i + 1, amount: prizes[i], username: p.username });
    }

    // A free bracket — a bot tournament, or a demo account's — pays nothing,
    // because nothing was taken. It still finishes, and still says who won.
    if (!pool.free && pool.entryFee > 0 && supabase) {
      for (const a of awards) {
        try {
          await creditCoins(supabase, a.userId, a.amount);
          await supabase.from('transactions').insert({
            user_id: a.userId, type: 'match_win',
            amount_c: a.amount, stake_c: pool.entryFee, status: 'confirmed',
            notes: `Tournament — ${ordinal(a.place)} of ${paying.length}`,
          });
        } catch (e) {
          // Loud: this is money that was won and not received.
          log.error(`[tournament] PRIZE FAILED ${a.userId} ${a.amount} coins:`, e.message);
        }
      }
      // Everyone else played their entry and lost it. The row is what the P&L
      // reads; the coins themselves left when the entry was taken, which is
      // also why this is not counted as a debit by the coin ledger.
      const paid = new Set(awards.map(a => a.userId));
      const losers = paying.filter(p => !paid.has(p.userId));
      if (losers.length) {
        try {
          await supabase.from('transactions').insert(losers.map(p => ({
            user_id: p.userId, type: 'match_loss', amount_c: pool.entryFee,
            status: 'confirmed', notes: 'Tournament entry',
          })));
        } catch (e) { log.error('[tournament] loss rows:', e.message); }
      }
      // The champion's wager row becomes their tournament win — which is what
      // the leaderboard and the profile count.
      const champ = awards.find(a => a.place === 1);
      const rowId = champ && pool.matchRows?.[champ.userId];
      if (rowId) {
        try {
          await supabase.from('matches').update({
            winner_id: champ.userId,
            prize_pool_c: prizes.reduce((s, v) => s + v, 0),
          }).eq('id', rowId);
        } catch (e) { log.error('[tournament] champion row:', e.message); }
      }
    }

    // Kept on the pool as well as announced, because the result card is
    // mounting at the same moment this fires and a card that missed it had
    // nothing to show. Same reason the phase lives on the pool.
    pool.awards = awards.map(a => ({
      userId: a.userId, username: a.username, place: a.place,
      amount: pool.free ? 0 : a.amount,
    }));

    broadcast(pool, 'tournament_over', {
      poolId: pool.id,
      placings: places,
      awards: pool.awards,
      free: !!pool.free,
    });
    pushPool(pool, { finished: true });
    // Kept around briefly so a player who was on the result screen can still
    // load the bracket they just played.
    later(pool.id, () => { pools.pools.delete(pool.id); live.delete(pool.id); }, 5 * 60 * 1000);
  }

  // ── The clock ────────────────────────────────────────────────────────────
  /**
   * Called once a second. Everything time-driven starts here rather than on a
   * timer per pool, so a pool created between ticks is still picked up.
   */
  function tick(onRefund) {
    const now = Date.now();

    // Entry closing does not start anything. A pool that filled has already
    // started — that is the only thing that starts one — and a pool that has
    // not filled by the time the window shuts never will.
    const { refunded } = pools.closeWindow(now);
    for (const pool of refunded) {
      broadcast(pool, 'tournament_cancelled', {
        poolId: pool.id,
        reason: 'The bracket did not fill in time — your entry has been returned.',
      });
      if (onRefund) onRefund(pool);
    }

    // The full ones, picked up here rather than from the seat that filled them,
    // so a pool is started by one thing whether it filled from the route, from
    // a demo account's bots, or from a test.
    for (const pool of pools.pools.values()) {
      if (pool.state === 'running' && stateOf(pool.id).phase === 'idle') {
        beginPool(pool).catch(e => log.error('[tournament] begin:', e.message));
      }
    }
  }

  hook.onSettled(({ poolId, round, match, winnerId, isDraw, sudden }) => {
    onResult({ poolId, round, match, winnerId, isDraw, sudden });
  });

  return {
    tick, ready, suddenReady, onResult, beginPool, startRound, settle, sampleScores, playerGone,
    _live: live,
    timings: T,
  };
}

function ordinal(n) {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

module.exports = {
  createRunner,
  MATCH_MS, SUDDEN_MS, INTERMISSION_MS, PICK_MS, CONNECT_GRACE_MS,
  COUNTDOWN_MS, REEL_MS,
};

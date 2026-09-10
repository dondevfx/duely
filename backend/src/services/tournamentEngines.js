/**
 * The five games a tournament can draw, wired to the engines that already
 * play them.
 *
 * A tournament match is a normal match. Everything below is the same call
 * handlers.js makes for a private match — create a room for two players,
 * tell them it exists, count them in — collected in one place so the runner
 * does not carry a switch statement per round.
 *
 * Each entry also knows how to read a live score out of its own room. The
 * bracket shows those between rounds, and every engine keeps them somewhere
 * different — a token-bucketed ping score, a clamped diamond count, a list of
 * guesses — so the knowledge of which is which belongs here with the rest of
 * the per-game wiring rather than in the runner.
 *
 * The entry fee on these rooms is ZERO, always. The stake was taken when the
 * player entered the tournament and the prize is paid when it ends; if the
 * rooms carried a fee as well, every round would settle a second wager the
 * player never made, and four rounds would cost them five entries.
 */
const bb  = require('./blockBlastEngine');
const cd  = require('./carDashEngine');
const cr  = require('./colorRushEngine');
const tw  = require('./towerEngine');
const wd  = require('./wordleEngine');

const ENGINES = {
  'block-blast': {
    event: 'block_blast_match_found',
    create: (p1, p2) => bb.createDirectBlockBlastRoom(p1, p2).roomId,
    room:   bb.getBlockBlastRoom,
    // The server-tracked ping score, which is the authoritative one — the
    // submitted value is never trusted.
    score:  (room, sid) => room.scores?.[sid] ?? room.pingScores?.[sid] ?? 0,
    del:    bb.deleteBlockBlastRoom,
    begin:  (io, supabase, roomId) => bb.startBlockBlastCountdown(io, supabase, roomId),
  },
  'car-dash': {
    event: 'car_dash_match_found',
    create: (p1, p2) => cd.createDirectCarDashRoom(p1, p2).roomId,
    room:   cd.getCarDashRoom,
    score:  (room, sid) => room.scores?.[sid] ?? 0,
    del:    cd.deleteCarDashRoom,
    begin:  (io, supabase, roomId) => cd.startCarDashCountdown(io, supabase, roomId),
  },
  'color-rush': {
    event: 'color_rush_match_found',
    create: (p1, p2) => cr.createDirectColorRushRoom(p1, p2).roomId,
    room:   cr.getColorRushRoom,
    score:  (room, sid) => room.scores?.[sid] ?? 0,
    del:    cr.deleteColorRushRoom,
    begin:  (io, supabase, roomId) => cr.startColorRushCountdown(io, supabase, roomId),
  },
  tower: {
    event: 'tower_match_found',
    create: (p1, p2) => tw.createDirectTowerRoom(p1, p2).roomId,
    room:   tw.getTowerRoom,
    score:  (room, sid) => room.scores?.[sid] ?? room.pingScores?.[sid] ?? 0,
    del:    tw.deleteTowerRoom,
    begin:  (io, supabase, roomId) => tw.startTowerCountdown(io, supabase, roomId),
  },
  // Word VS has no countdown helper of its own — handlers.js counts it in by
  // hand before starting the round, and so does this.
  scrabble: {
    event: 'scrabble_match_found',
    create: (p1, p2) => wd.createDirectWordleRoom(p1, p2).roomId,
    room:   wd.getWordleRoom,
    // Word VS has no running score. Guesses used is the only thing moving
    // while it is played, and it is what a watcher wants to see.
    score:  (room, sid) => room.pstate?.[sid]?.guesses?.length ?? 0,
    del:    wd.deleteWordleRoom,
    begin:  (io, supabase, roomId) => {
      io.to(roomId).emit('scrabble_countdown', { count: 3 });
      setTimeout(() => io.to(roomId).emit('scrabble_countdown', { count: 2 }), 1000);
      setTimeout(() => io.to(roomId).emit('scrabble_countdown', { count: 1 }), 2000);
      setTimeout(() => wd.startWordleGame(io, supabase, roomId), 3000);
    },
  },
};

module.exports = ENGINES;

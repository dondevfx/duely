/**
 * The five games a tournament can draw, wired to the engines that already
 * play them.
 *
 * A tournament match is a normal match. Everything below is the same call
 * handlers.js makes for a private match — create a room for two players,
 * tell them it exists, count them in — collected in one place so the runner
 * does not carry a switch statement per round.
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
    del:    bb.deleteBlockBlastRoom,
    begin:  (io, supabase, roomId) => bb.startBlockBlastCountdown(io, supabase, roomId),
  },
  'car-dash': {
    event: 'car_dash_match_found',
    create: (p1, p2) => cd.createDirectCarDashRoom(p1, p2).roomId,
    room:   cd.getCarDashRoom,
    del:    cd.deleteCarDashRoom,
    begin:  (io, supabase, roomId) => cd.startCarDashCountdown(io, supabase, roomId),
  },
  'color-rush': {
    event: 'color_rush_match_found',
    create: (p1, p2) => cr.createDirectColorRushRoom(p1, p2).roomId,
    room:   cr.getColorRushRoom,
    del:    cr.deleteColorRushRoom,
    begin:  (io, supabase, roomId) => cr.startColorRushCountdown(io, supabase, roomId),
  },
  tower: {
    event: 'tower_match_found',
    create: (p1, p2) => tw.createDirectTowerRoom(p1, p2).roomId,
    room:   tw.getTowerRoom,
    del:    tw.deleteTowerRoom,
    begin:  (io, supabase, roomId) => tw.startTowerCountdown(io, supabase, roomId),
  },
  // Word VS has no countdown helper of its own — handlers.js counts it in by
  // hand before starting the round, and so does this.
  scrabble: {
    event: 'scrabble_match_found',
    create: (p1, p2) => wd.createDirectWordleRoom(p1, p2).roomId,
    room:   wd.getWordleRoom,
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

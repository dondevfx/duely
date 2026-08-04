const { v4: uuidv4 } = require('uuid');
const { isValidWord } = require('./wordValidator');
const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { unlockUser } = require('./lockService');
const { updateHighscore } = require('./highscoreService');
const gameEvents = require('./gameEvents');

const MAX_GUESSES  = 6;
const WORD_LENGTH  = 5;
const FAIL_TIMER_MS = 60 * 1000;

// ── Answer word list ─────────────────────────────────────────────────────────
// Curated common 5-letter English words used as the secret answer.
// Guess validation uses the full 173k dictionary (isValidWord) so players
// can guess any real word, but only these appear as answers.
const ANSWERS = [
  'ABOUT','ABOVE','ABUSE','ACUTE','ADMIT','ADOPT','ADULT','AFTER','AGAIN','AGENT',
  'AGREE','AHEAD','ALARM','ALBUM','ALERT','ALIEN','ALIVE','ALLEY','ALLOW','ALONE',
  'ALONG','ALTER','ANGEL','ANGER','ANGLE','ANGRY','ANKLE','APPLE','APPLY','ARENA',
  'ARGUE','ARISE','ARMOR','AROMA','ARRAY','ASSET','ATLAS','ATTIC','AUDIO','AUDIT',
  'AVOID','AWAKE','AWARD','AWARE','AWFUL','ABBEY','ABIDE','AMAZE','AMBER','AMPLE',
  'BADGE','BAKER','BEACH','BEARD','BEAST','BELLY','BENCH','BERRY','BLACK','BLADE',
  'BLAME','BLANK','BLAST','BLAZE','BLEED','BLEND','BLESS','BLIND','BLOCK','BLOOD',
  'BLOOM','BLOWN','BLUNT','BLUSH','BOARD','BONUS','BOOST','BOOTH','BOXER','BRAVE',
  'BREAD','BREAK','BREED','BRICK','BRIDE','BRIEF','BRING','BRISK','BROTH','BROWN',
  'BRUSH','BUDDY','BUILD','BUILT','BULGE','BUNCH','BURST','BUYER','BRACE','BRAID',
  'BRASH','BRAWN','BUMPY','BUSHY','CABLE','CANDY','CARRY','CATCH','CAUSE','CEASE',
  'CHAOS','CHARM','CHASE','CHEAP','CHEAT','CHECK','CHEEK','CHESS','CHEST','CHIEF',
  'CHILD','CHILL','CHOIR','CIVIL','CLAIM','CLASH','CLASS','CLEAN','CLEAR','CLERK',
  'CLICK','CLIFF','CLIMB','CLING','CLOCK','CLOSE','CLOUD','COACH','COAST','COLOR',
  'CORAL','COUCH','COUNT','COURT','COVER','CRACK','CRAFT','CRANE','CRASH','CRAZY',
  'CREAM','CREEK','CREST','CRIME','CRISP','CROSS','CROWD','CROWN','CRUEL','CRUSH',
  'CRUST','CURVE','CYCLE','CACHE','CAMEL','CARGO','CEDAR','CHAMP','CHEWY','CHIMP',
  'CHOMP','CLAMP','CLEAT','CLONE','COBRA','COMET','COVET','CREAK','CREEP','CRIMP',
  'DAILY','DANCE','DEATH','DECAY','DELAY','DEMON','DEPTH','DERBY','DIRTY','DISCO',
  'DITCH','DIZZY','DODGE','DOUBT','DOUGH','DRAFT','DRAIN','DRAMA','DRANK','DRAWN',
  'DREAD','DREAM','DRESS','DRIFT','DRINK','DRIVE','DRONE','DROVE','DRUNK','DAISY',
  'DANDY','DAZED','DECOY','DELTA','DEPOT','DOWDY','DRAWL','DROOL','DUCHY','DUSTY',
  'EAGER','EAGLE','EARLY','EARTH','EERIE','EIGHT','ELITE','EMPTY','ENJOY','ENTER',
  'EQUAL','ERROR','EVERY','EXACT','EXIST','EXTRA','EBONY','ELBOW','ELDER','EVADE',
  'FABLE','FAITH','FALSE','FANCY','FATAL','FAULT','FEAST','FETCH','FEVER','FIBER',
  'FIFTH','FIFTY','FIGHT','FINAL','FLAME','FLASH','FLESH','FLICK','FLOAT','FLOCK',
  'FLOOD','FLOOR','FLOUR','FLUID','FOCUS','FORCE','FORGE','FOUND','FRAME','FRANK',
  'FRAUD','FREAK','FRESH','FRONT','FROST','FRUIT','FULLY','FUNNY','FADED','FAINT',
  'FLAKY','FLANK','FLARE','FLASK','FLINT','FLUTE','FOGGY','FOYER','FRAIL','FROTH',
  'GIANT','GIVEN','GLARE','GLASS','GLEAM','GLOBE','GLOOM','GLOSS','GLOVE','GOING',
  'GRACE','GRADE','GRAND','GRANT','GRAPE','GRASP','GRASS','GRAVE','GREAT','GREED',
  'GREET','GRIND','GROAN','GROSS','GROUP','GROVE','GROWL','GROWN','GUARD','GUESS',
  'GUEST','GUIDE','GUILT','GUSTO','GAVEL','GIDDY','GIRTH','GLAND','GLEAN','GLIDE',
  'GLOAT','GNOME','GORGE','GOUGE','GRAVY','GRAZE','GRIEF','GRIME','GROOM','GRUEL',
  'GRUFF','GUAVA','GULCH','GUILE','GUISE','GUMMY','GUTSY','GRILL','GROUT','GROWL',
  'HABIT','HAPPY','HARSH','HAVEN','HEART','HEAVY','HEDGE','HEIST','HENCE','HERBS',
  'HERON','HINGE','HOIST','HONEY','HONOR','HORSE','HOTEL','HOUSE','HOVER','HUMAN',
  'HUMOR','HURRY','HAIKU','HAUNT','HEFTY','HELIX','HIPPO','HOMER','HORDE','HUSKY',
  'IDEAL','IMAGE','IMPLY','INDEX','INNER','INPUT','IRONY','ISSUE','IVORY','ITCHY',
  'JEWEL','JUDGE','JUICE','JUICY','JUMBO','JAZZY','JOKER','JOUST','KAYAK','KNACK',
  'KNEEL','KNIFE','KNOCK','KNOWN','KUDOS','LABEL','LANCE','LARGE','LASER','LATER',
  'LAUGH','LAYER','LEARN','LEAST','LEGAL','LEMON','LEVEL','LIGHT','LIMIT','LINER',
  'LIVER','LOCAL','LODGE','LOGIC','LOOSE','LOWER','LOYAL','LUCKY','LADEN','LATCH',
  'LEAFY','LEERY','LEGIT','LEMUR','LINGO','LLAMA','LOATH','LOWLY','LUCID','LUSTY',
  'LYRIC','MAGIC','MAJOR','MAPLE','MARCH','MARRY','MATCH','MEANT','MERCY','MERIT',
  'METAL','MINOR','MISTY','MODEL','MONEY','MONTH','MORAL','MOUNT','MOURN','MOUSE',
  'MOUTH','MOVIE','MUSIC','MANOR','MAUVE','MELEE','MELON','MESSY','MOGUL','MOLDY',
  'MOODY','MOSSY','MOTIF','MUDDY','MUMMY','MURKY','MUSHY','MUSKY','MANOR','MEALY',
  'NERVE','NEVER','NIGHT','NOBLE','NOISE','NORTH','NOVEL','NURSE','NASTY','NAVAL',
  'NERDY','NEXUS','NIPPY','NOISY','NOTCH','NUDGE','NUTTY','NIFTY','OFFER','ORDER',
  'OUTER','OZONE','OCTET','OMEGA','ONION','OPTIC','OUTDO','OXIDE','PAINT','PANIC',
  'PANEL','PAPER','PARTY','PAUSE','PEACH','PEARL','PEDAL','PENNY','PHONE','PHOTO',
  'PILOT','PITCH','PIXEL','PLACE','PLAIN','PLANE','PLANT','PLAZA','POLAR','PORCH',
  'POWER','PRESS','PRICE','PRIDE','PRIZE','PROBE','PRONE','PROSE','PROUD','PROVE',
  'PULSE','PUNCH','PURSE','PANSY','PARKA','PENAL','PERCH','PERIL','PETTY','PIANO',
  'PLAID','PLANK','PLUCK','PLUME','POACH','POISE','POLKA','POPPY','POSIT','PROWL',
  'PRUNE','PSALM','PUPIL','PYGMY','QUEEN','QUICK','QUIET','QUOTA','QUOTE','RADAR',
  'RADIO','RAISE','RALLY','RANGE','RAPID','REACH','READY','REALM','REBEL','RIDER',
  'RISKY','RIVER','ROBOT','ROCKY','ROUGE','ROUGH','ROUND','ROYAL','RULER','RURAL',
  'RUSTY','RAINY','RAMEN','RAVEN','REEDY','REGAL','RELAY','REIGN','REPAY','REPEL',
  'RESIN','RIGID','RIPEN','RISEN','RIVET','ROBIN','RODEO','ROWDY','RUDDY','SADLY',
  'SAINT','SALAD','SAUCE','SCALE','SCENE','SCORE','SCOUT','SENSE','SEVEN','SHARD',
  'SHARE','SHARK','SHARP','SHEER','SHEET','SHELL','SHIFT','SHINE','SHIRT','SHOOT',
  'SHORT','SHOUT','SIGHT','SILLY','SINCE','SIXTH','SIXTY','SKILL','SKULL','SLAVE',
  'SLEEP','SLICE','SLIDE','SLOPE','SMART','SMELL','SMOKE','SNAKE','SOLAR','SOLVE',
  'SORRY','SPACE','SPARK','SPEAK','SPEAR','SPEND','SPICE','SPINE','SPITE','SPLIT',
  'SPOON','SPORT','STAIN','STAKE','STAND','STARE','START','STEAL','STEAM','STEEL',
  'STERN','STICK','STIFF','STILL','STOCK','STOOD','STORE','STORM','STORY','STUDY',
  'STYLE','SUGAR','SUITE','SUNNY','SUPER','SWAMP','SWEAR','SWEEP','SWEET','SWIFT',
  'SWING','SYRUP','SABER','SAVOR','SCALD','SCOFF','SCONE','SCOOP','SCRUB','SEIZE',
  'SERUM','SHADY','SHALE','SHALL','SHAME','SHANK','SHAWL','SHONE','SHOWY','SHRUB',
  'SHUNT','SIEGE','SINEW','SIREN','SKULK','SLANT','SLASH','SLEET','SLICK','SLIMY',
  'SLINK','SLOTH','SLUMP','SLURP','SMACK','SMEAR','SMELT','SNARE','SNEAK','SNEER',
  'SNIFF','SNORT','SNOUT','SNOWY','SOFTY','SOGGY','SONIC','SPAWN','SPECK','SPEED',
  'SPIKY','SPLAY','SPREE','SPRIG','SPUNK','SPURN','SQUAT','SQUID','STALK','STALL',
  'STAMP','STUMP','STUNG','STUNK','STUNT','SUAVE','SURGE','SWATH','SWILL','SWINE',
  'SWIRL','SWOOP','TABLE','TANGO','TASTE','TEETH','TEMPO','TENSE','THICK','THORN',
  'THREE','THUMB','TIGER','TIMID','TIRED','TITLE','TOAST','TOPIC','TOTAL','TOUCH',
  'TOUGH','TOWEL','TOWER','TOXIC','TRACE','TRACK','TRADE','TRAIL','TRAIN','TRAIT',
  'TRASH','TRICK','TRIED','TROOP','TROUT','TRUCK','TRULY','TRUNK','TRUST','TRUTH',
  'TWICE','TWIST','TABOO','TACKY','TAFFY','TANGY','TAPIR','TARDY','TAWNY','TEPID',
  'TIARA','TIDAL','TINGE','TIPSY','TITAN','TOKEN','TORSO','TOTEM','TRAMP','TRITE',
  'TROLL','TROMP','TROVE','TRUCE','TRUMP','TRYST','TUBBY','TUBER','TULIP','TUNER',
  'TURBO','TWEAK','TWEED','TWEET','ULTRA','UNCLE','UNDER','UNION','UNITY','UNTIL',
  'UPPER','UPSET','URBAN','USUAL','UTTER','UDDER','ULCER','UNDUE','USURP','VALID',
  'VALUE','VALVE','VIGOR','VIRAL','VIRUS','VISIT','VIVID','VOICE','VOTER','VAGUE',
  'VAPID','VAULT','VENAL','VENOM','VICAR','VISTA','VODKA','VOGUE','VOMIT','WATCH',
  'WATER','WEARY','WEAVE','WEDGE','WEIRD','WHALE','WHEAT','WHEEL','WHERE','WHICH',
  'WHILE','WHITE','WHOLE','WHOSE','WITCH','WOMAN','WORLD','WORRY','WORSE','WORST',
  'WORTH','WRECK','WRIST','WRONG','WACKY','WAGER','WALTZ','WRATH','WRING','YACHT',
  'YEARN','YIELD','YOUNG','YOUTH','ZEBRA','ZESTY','ZONAL',
];

// ── Room management ──────────────────────────────────────────────────────────
const rooms = new Map();
const queue = [];

function getRandomWord() {
  return ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
}

// Standard Wordle evaluation with correct duplicate-letter handling.
// Returns array of { letter, status } where status is 'correct'|'present'|'absent'.
function evaluateGuess(secret, guess) {
  const result   = Array(WORD_LENGTH).fill('absent');
  const secArr   = secret.split('');
  const gueArr   = guess.split('');

  // Pass 1 — exact matches
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (gueArr[i] === secArr[i]) {
      result[i]  = 'correct';
      secArr[i]  = null;
      gueArr[i]  = null;
    }
  }
  // Pass 2 — wrong position
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (gueArr[i] === null) continue;
    const j = secArr.indexOf(gueArr[i]);
    if (j !== -1) {
      result[i] = 'present';
      secArr[j] = null;
    }
  }
  return result.map((status, i) => ({ letter: guess[i], status }));
}

// Max number of 'correct' tiles in any single guess row — tiebreaker when both fail.
function bestGuessScore(guesses) {
  let best = 0;
  for (const row of guesses) {
    const n = row.filter(c => c.status === 'correct').length;
    if (n > best) best = n;
  }
  return best;
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId,
    word: getRandomWord(),
    players: [p1, p2],
    pstate: {
      [p1.socketId]: { guesses: [], finished: false, solved: false, finishedAt: null },
      [p2.socketId]: { guesses: [], finished: false, solved: false, finishedAt: null },
    },
    entryFee:    p1.entryFee || 0,
    currency:    p1.currency || 'coins',
    feesDeducted: false,
    failTimer:   null,
    settled:     false,
    startedAt:   null,
    // Demo account vs bot: demo always wins (bot never solves first).
    demoWin:     (p1.isBot || p2.isBot) && [p1, p2].some(p => p.isDemo && !p.isBot),
  };
}

// ── Public queue / room API ──────────────────────────────────────────────────
function addToWordleQueue(player) {
  const idx = queue.findIndex(p =>
    p.socketId  !== player.socketId &&
    p.entryFee  === player.entryFee &&
    p.currency  === player.currency &&
    !!p.isDemo  === !!player.isDemo
  );
  if (idx !== -1) {
    const opp    = queue.splice(idx, 1)[0];
    const roomId = 'wordle_' + uuidv4();
    rooms.set(roomId, _makeRoom(roomId, opp, player));
    return { roomId, p1: opp, p2: player };
  }
  queue.push(player);
  return null;
}

function removeFromWordleQueue(socketId) {
  const i = queue.findIndex(p => p.socketId === socketId);
  if (i !== -1) { queue.splice(i, 1); return true; }
  return false;
}

function createDirectWordleRoom(p1, p2) {
  const roomId = 'wordle_' + uuidv4();
  rooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function getWordleRoom(roomId)    { return rooms.get(roomId) || null; }
function deleteWordleRoom(roomId) { rooms.delete(roomId); }

// Returns { roomId, room } — the same shape as every other engine's lookup.
//
// This used to return the bare room. The forfeit and disconnect handlers all do
// `const { room, roomId } = getFn(socket.id)`, so for Word VS `room` came back
// undefined and the very next line — `room.state` — threw. The practical effect
// was that leaving a Word VS match never forfeited it, and the exception took
// out the rest of the disconnect sweep with it.
function getWordleRoomBySocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

// ── Game lifecycle ────────────────────────────────────────────────────────────
function startWordleGame(io, supabase, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.startedAt = Date.now();
  io.to(roomId).emit('wordle_start', {
    wordLength: WORD_LENGTH,
    maxGuesses: MAX_GUESSES,
  });
}

// ── Guess handling ────────────────────────────────────────────────────────────
async function handleWordleGuess(io, supabase, roomId, socketId, guessRaw) {
  const room = rooms.get(roomId);
  if (!room || room.settled) return;

  const guess = (guessRaw || '').toUpperCase().trim();
  if (guess.length !== WORD_LENGTH || !/^[A-Z]+$/.test(guess)) {
    io.to(socketId).emit('wordle_error', { error: 'Guess must be 5 letters' });
    return;
  }
  if (!isValidWord(guess.toLowerCase())) {
    io.to(socketId).emit('wordle_error', { error: 'Not a valid word' });
    return;
  }

  const ps = room.pstate[socketId];
  if (!ps || ps.finished || ps.guesses.length >= MAX_GUESSES) return;

  const feedback = evaluateGuess(room.word, guess);
  ps.guesses.push(feedback);

  const solved = feedback.every(c => c.status === 'correct');

  io.to(socketId).emit('wordle_guess_result', {
    guess,
    feedback,
    guessNumber: ps.guesses.length,
    solved,
  });

  // Tell opponent only how many guesses have been used — no letters leaked
  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp) {
    io.to(opp.socketId).emit('wordle_opponent_progress', {
      guessCount: ps.guesses.length,
    });
  }

  if (solved) {
    ps.finished   = true;
    ps.solved     = true;
    ps.finishedAt = Date.now();
    if (room.failTimer) { clearTimeout(room.failTimer); room.failTimer = null; }
    await _settleWordle(io, supabase, room, socketId);
    return;
  }

  if (ps.guesses.length >= MAX_GUESSES) {
    ps.finished   = true;
    ps.solved     = false;
    ps.finishedAt = Date.now();

    const oppState = opp ? room.pstate[opp.socketId] : null;
    if (!opp || !oppState || oppState.finished) {
      // Both players done — compare greens immediately
      if (room.failTimer) { clearTimeout(room.failTimer); room.failTimer = null; }
      await _settleWordle(io, supabase, room, null);
    } else {
      // Give opponent 60 seconds to finish
      io.to(opp.socketId).emit('wordle_opponent_failed', { timeLimit: 60 });
      room.failTimer = setTimeout(async () => {
        if (room.settled) return;
        await _settleWordle(io, supabase, room, null);
      }, FAIL_TIMER_MS);
    }
  }
}

// ── Settlement ────────────────────────────────────────────────────────────────
async function _settleWordle(io, supabase, room, winnerSocketId) {
  if (room.settled) return;
  room.settled = true;
  if (room.failTimer) { clearTimeout(room.failTimer); room.failTimer = null; }

  const [p1, p2]   = room.players;
  const s1          = room.pstate[p1.socketId];
  const s2          = room.pstate[p2.socketId];

  let winnerPlayer  = null;
  let loserPlayer   = null;

  if (winnerSocketId) {
    winnerPlayer = room.players.find(p => p.socketId === winnerSocketId);
    loserPlayer  = room.players.find(p => p.socketId !== winnerSocketId);
  } else {
    // Both failed — compare best guess score (most greens in any single row)
    const sc1 = bestGuessScore(s1.guesses);
    const sc2 = bestGuessScore(s2.guesses);
    if (sc1 > sc2) { winnerPlayer = p1; loserPlayer = p2; }
    else if (sc2 > sc1) { winnerPlayer = p2; loserPlayer = p1; }
    // else draw — winnerPlayer stays null
  }

  // Demo always wins vs the bot — force the demo player as winner if the bot
  // somehow solved first or the greens tiebreaker didn't favor the demo.
  if (room.demoWin) {
    const demoP = room.players.find(p => p.isDemo && !p.isBot);
    if (demoP) { winnerPlayer = demoP; loserPlayer = room.players.find(p => p !== demoP); }
  }

  const isDraw = !winnerPlayer;
  const fee      = room.entryFee || 0;
  const currency = room.currency || 'coins';
  const winner   = winnerPlayer;
  const loser    = loserPlayer;
  const hasBot   = p1.isBot || p2.isBot;
  const human    = hasBot ? room.players.find(p => !p.isBot) : null;

  // ── Financial + stat settlement ──────────────────────────────────────────
  let newWinnerElo  = winner?.elo || 1000;
  let newLoserElo   = loser?.elo  || 1000;
  let balanceChange = null;
  let winnerStreak  = 0;
  let isFirstWin    = false;

  try {
    const isFree = fee === 0;

    if (winner && loser) {
      const ratings = calculateNewRatings(winner.elo || 1000, loser.elo || 1000);
      newWinnerElo  = ratings.newWinnerElo;
      newLoserElo   = ratings.newLoserElo;
    }

    if (fee > 0 && supabase && winner && loser && !room.feesDeducted) {
      console.error(`[wordle] CRITICAL: room ${room.roomId} settled without feesDeducted — no payout issued`);
      unlockUser(winner.userId); unlockUser(loser.userId);
    } else if (fee > 0 && supabase && winner && loser) {
      try {
        if (hasBot && human) {
          const humanWon = winner && !winner.isBot;
          balanceChange = await settleBotMatch(supabase, human.userId, fee, currency, humanWon, { game: 'Word VS' });
        } else {
          const meta = { game: 'Word VS', winnerUsername: winner.username, loserUsername: loser.username };
          balanceChange = currency === 'diamonds'
            ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, fee, meta)
            : await settleMatch(supabase, winner.userId, loser.userId, fee, meta);
        }
      } catch (e) { console.error('[wordle] settle error:', e.message); }
    }

    if (supabase && winner && loser) {
      if (!winner.isBot) {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId).catch(() => {});
        await supabase.rpc('increment_win', { uid: winner.userId }).catch(() => {});
        try {
          const sd = await updateStreaks(supabase, winner.userId, loser.isBot ? null : loser.userId);
          winnerStreak = sd.winnerStreak;
          isFirstWin   = sd.isFirstWin;
        } catch {}
      }
      if (!loser.isBot) {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId).catch(() => {});
        await supabase.rpc('increment_loss', { uid: loser.userId }).catch(() => {});
      }
      if (!loser.isBot) {
        supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId).then().catch(() => {});
      }
      for (const [p, ps] of [[p1, s1], [p2, s2]]) {
        if (!p.isBot) {
          const score = ps.solved ? (MAX_GUESSES - ps.guesses.length + 1) : 0;
          await updateHighscore(supabase, p.userId, 'wordVS', score).catch(() => {});
        }
      }
      if (!p1.isBot && !p2.isBot) {
        await supabase.from('matches').insert({
          player1_id:          p1.userId,
          player2_id:          p2.userId,
          winner_id:           winner?.userId || null,
          game_type:           'scrabble',
          entry_fee_c:         currency === 'coins'    ? fee : 0,
          entry_fee_diamonds:  currency === 'diamonds' ? fee : 0,
          prize_pool_c:        currency === 'coins'    ? fee * 2 : 0,
          prize_pool_diamonds: currency === 'diamonds' ? fee * 2 : 0,
          platform_fee_c:      currency === 'coins'    ? parseFloat((fee * 2 * 0.05).toFixed(4)) : 0,
        }).then().catch(() => {});
      }
    }
  } catch (e) {
    console.error('[wordle] settlement error (game still resolved):', e.message);
  }

  // Emit result to each player with their own and opponent's full guess history
  function resultFor(me) {
    const them = room.players.find(p => p.socketId !== me.socketId);
    const iWon = winnerPlayer?.socketId === me.socketId;
    return {
      word:              room.word,
      winnerId:          winnerPlayer?.userId || null,
      winnerUsername:    winnerPlayer?.username || null,
      loserUsername:     loserPlayer?.username || null,
      isDraw,
      iWon,
      myGuesses:         room.pstate[me.socketId].guesses,
      opponentGuesses:   room.pstate[them?.socketId]?.guesses || [],
      myUsername:        me.username,
      opponentUsername:  them?.username,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      winnerStreak,
      isFirstWin,
      currency,
      entryFee:          fee,
    };
  }
  io.to(p1.socketId).emit('wordle_result', resultFor(p1));
  io.to(p2.socketId).emit('wordle_result', resultFor(p2));

  gameEvents.emit('game_ended', { socketIds: [p1.socketId, p2.socketId] });

  if (fee > 0 && winner) {
    const payout = currency === 'diamonds' ? fee * 2 * 0.95 : parseFloat((fee * 2 * 0.95).toFixed(4));
    gameEvents.emit('match_result', {
      game: 'scrabble',
      winnerId: winner.userId,
      payout,
      currency,
      roomId: room.roomId,
    });
  }

  io.emit('active_game_ended', { id: room.roomId });
  deleteWordleRoom(room.roomId);
}

// ── Bot solver ────────────────────────────────────────────────────────────────
// Filters the answer list to candidates consistent with all feedback so far,
// then returns the next guess. Uses CRANE as the opening move.
const BOT_OPENER = 'CRANE';

function _botFilterCandidates(candidates, history) {
  return candidates.filter(word => {
    for (const { guess, feedback } of history) {
      // Count how many times each letter must appear (from correct+present hits)
      const minCount = {};
      const maxCount = {};
      for (let i = 0; i < WORD_LENGTH; i++) {
        const { letter, status } = feedback[i];
        if (status === 'correct' || status === 'present') {
          minCount[letter] = (minCount[letter] || 0) + 1;
        }
      }
      // absent letters set a ceiling (equal to minCount, or 0 if never seen)
      for (let i = 0; i < WORD_LENGTH; i++) {
        const { letter, status } = feedback[i];
        if (status === 'absent') {
          maxCount[letter] = minCount[letter] || 0;
        }
      }
      // Check per-position constraints
      for (let i = 0; i < WORD_LENGTH; i++) {
        const { letter, status } = feedback[i];
        if (status === 'correct' && word[i] !== letter) return false;
        if (status === 'present' && word[i] === letter) return false;
        if (status === 'present' && !word.includes(letter)) return false;
      }
      // Check letter count constraints
      for (const [letter, min] of Object.entries(minCount)) {
        if ((word.split(letter).length - 1) < min) return false;
      }
      for (const [letter, max] of Object.entries(maxCount)) {
        if ((word.split(letter).length - 1) > max) return false;
      }
    }
    return true;
  });
}

async function scheduleBotWordleMove(io, supabase, roomId, botSocketId) {
  const room = rooms.get(roomId);
  if (!room || room.settled) return;

  let candidates = [...ANSWERS];
  const history  = [];
  let guessNum   = 0;

  while (guessNum < MAX_GUESSES) {
    const delay = 1500 + Math.floor(Math.random() * 1500);
    await new Promise(r => setTimeout(r, delay));

    const fresh = rooms.get(roomId);
    if (!fresh || fresh.settled) return;

    const ps = fresh.pstate[botSocketId];
    if (!ps || ps.finished) return;

    let guess = guessNum === 0 ? BOT_OPENER : (candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))] || candidates[0] || BOT_OPENER);
    // Demo always wins: never let the bot play the winning word — it stays a
    // little behind, guessing near-misses until the demo solves it.
    if (fresh.demoWin && guess === fresh.word) {
      const alt = candidates.find(c => c !== fresh.word) || ANSWERS.find(w => w !== fresh.word);
      guess = alt || guess;
    }
    const feedback = evaluateGuess(fresh.word, guess);
    history.push({ guess, feedback });

    // Update candidates for next turn
    candidates = _botFilterCandidates(candidates, history);

    await handleWordleGuess(io, supabase, roomId, botSocketId, guess);

    guessNum++;

    // Check if bot just solved it
    const updated = rooms.get(roomId);
    if (!updated || updated.settled) return;
    if (updated.pstate[botSocketId]?.finished) return;
  }
}

function getRandomWordleWord() {
  return ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
}

module.exports = {
  addToWordleQueue, removeFromWordleQueue,
  createDirectWordleRoom,
  getWordleRoom, deleteWordleRoom, getWordleRoomBySocket,
  startWordleGame, handleWordleGuess,
  scheduleBotWordleMove,
  evaluateGuess, MAX_GUESSES, WORD_LENGTH,
  getRandomWordleWord,
};

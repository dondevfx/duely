const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, updateStreaks } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { simulateBotTyping } = require('./botService');
const { creditRakeback } = require('./rakebackService');

// ─── 20 typing texts (4 sentences each) ────────────────────────────
const TEXTS = [
  "Technology shapes our daily lives in profound ways. Smartphones connect us to information instantly. Digital tools help us work faster and smarter. The future belongs to those who learn new skills.",
  "The ocean covers more than seventy percent of our planet. Marine life ranges from tiny plankton to massive whales. Coral reefs support thousands of unique species. Protecting our oceans is vital for all life on Earth.",
  "Running is one of the oldest forms of human movement. Even short daily runs improve cardiovascular health greatly. Setting goals makes training more effective and rewarding. Every great runner started by taking the very first step.",
  "Books open doors to worlds we could never visit alone. Reading expands vocabulary and sharpens the mind over time. Great stories stay with us for an entire lifetime. A good library is a treasure beyond any measure.",
  "Space exploration pushes the limits of human achievement. Astronauts train for years before they ever leave Earth. The cosmos holds secrets we are only beginning to unravel. One day humans may walk the surface of Mars.",
  "Music has the power to change our mood in an instant. Rhythm and melody connect people across different cultures. Learning to play an instrument rewires the brain in positive ways. Every song tells a unique story worth hearing.",
  "Cooking at home is both an art and a precise science. Fresh ingredients make a meal taste far better than processed ones. Following a recipe teaches patience and careful precision. Sharing food with others creates memories that last forever.",
  "Exercise releases chemicals that improve our mental state. Even a short walk can completely shift our perspective. Strength comes from consistent effort applied over long periods of time. The body adapts when we challenge it on a regular basis.",
  "Cities are living systems that never truly stop changing. Architecture reflects the values of the society that builds it. Public spaces bring communities together in very meaningful ways. Great urban design improves the quality of life for everyone.",
  "Photography captures moments that words alone cannot express. Light and shadow transform ordinary scenes into real works of art. Modern cameras give anyone the tools to tell compelling visual stories. The best photo is the one that makes you feel something deep.",
  "Writing clean and readable code is a highly valued skill. Debugging teaches you to think methodically under real pressure. Every programmer started out not knowing how to write a single line. Software built with care and skill can change millions of lives.",
  "Sleep is one of the most powerful tools available for health. During rest the brain processes and stores memories from the day. Lack of sleep impairs judgment and slows down reaction time. A consistent sleep schedule improves every aspect of daily life.",
  "Teamwork requires both trust and clear open communication. Every member of a great team plays a unique and important role. Disagreements that are handled well often lead to much better outcomes. Shared victories feel sweeter than those that are won completely alone.",
  "Gardening connects us to the natural cycles of growth and life. Planting a seed and watching it thrive is deeply satisfying to do. Even a small garden can produce meaningful amounts of fresh food. Working with soil is known to reduce stress and improve overall wellbeing.",
  "History teaches us patterns that tend to repeat across the centuries. Understanding the past helps us navigate the present more wisely. Great leaders study the successes and failures of those who came before. Those who ignore history are often doomed to repeat its biggest mistakes.",
  "The brain is far more adaptable than scientists once believed possible. Learning new things builds useful neural connections throughout our entire life. Challenging yourself mentally keeps the mind sharp as you grow older. Curiosity is the true engine of personal growth and meaningful discovery.",
  "Renewable energy technology is advancing much faster than expected. Individual choices add up when millions of people decide to act together. The decisions we make today will shape the world our children inherit. Bold action on energy is both necessary and increasingly affordable now.",
  "Animals communicate in ways we are only beginning to truly understand. Dolphins use complex sound patterns to coordinate their group hunts. Elephants have been observed mourning their dead and showing clear empathy. Studying animal behavior teaches us a great deal about our own human nature.",
  "Each language encodes a completely unique way of seeing and describing reality. Learning a new language makes you more creative and mentally flexible overall. The world becomes significantly larger when you can speak more than one language. Bilingual people often show advantages in attention and problem solving tasks.",
  "Kindness costs nothing but its positive impact can be truly immeasurable. Small acts of generosity create ripples that spread far beyond the moment. Research consistently shows that helping others improves our own personal wellbeing. A community built on genuine care is always stronger than one built on fear.",
  "The ocean holds secrets that humanity is only beginning to explore and understand. More than eighty percent of its depths remain unmapped and largely unknown to science.",
  "A library is one of the last truly free places remaining in modern society. Anyone can walk in and access centuries of accumulated human knowledge without paying a cent.",
  "Honey bees communicate direction and distance by performing a precise waggle dance. This remarkable behavior allows the colony to efficiently locate food sources miles away.",
  "The Great Wall of China stretches for thousands of miles across rugged northern terrain. Contrary to popular belief it cannot actually be seen from outer space with the naked eye.",
  "Humans are the only animals known to blush from emotional or social responses. This involuntary reaction is triggered by the same nervous system that controls our fight response.",
  "The average cloud weighs more than one million pounds despite appearing light and fluffy. This massive weight is spread across billions of tiny water droplets suspended in air.",
  "Cleopatra lived closer in time to the Moon landing than to the construction of the pyramids. This surprising fact reveals just how ancient the civilization of Egypt truly was.",
  "A single bolt of lightning contains enough energy to toast one hundred thousand slices of bread. The challenge is capturing that energy before it dissipates in a matter of milliseconds.",
  "Nintendo was founded in eighteen eighty nine as a playing card company in Kyoto Japan. It would take nearly a full century before the company entered the video game industry.",
  "The human brain contains approximately eighty six billion neurons connected by trillions of synapses. This network is more complex than any computing system humans have ever built.",
  "Oxford University is older than the Aztec Empire by at least two hundred years. Teaching has been recorded there since ten ninety six making it one of the oldest institutions anywhere.",
  "Antarctica is technically the world's largest desert because it receives almost no precipitation annually. The continent holds about seventy percent of all the fresh water on Earth locked in ice.",
  "The first commercial text message was sent in nineteen ninety two containing the words Merry Christmas. Today the world sends over twenty three billion text messages every single day.",
  "Sharks are older than trees as a species on this planet by over fifty million years. They have survived every major mass extinction event that has occurred throughout Earth's history.",
  "The inventor of the telephone Alexander Graham Bell refused to keep a phone in his study. He feared it would distract him from his scientific work and his constant flow of thinking.",
  "Carrots were originally purple before Dutch farmers selectively bred the orange variety we know today. The orange carrot became standard partly as a tribute to the Dutch royal family.",
  "A day on Venus is longer than a full year on Venus because of how slowly it rotates. It also spins in the opposite direction to most of the other planets in our solar system.",
  "The speed of light is approximately three hundred thousand kilometers per second through a vacuum. Nothing in the known universe is capable of traveling faster than this absolute cosmic limit.",
  "Wombats are the only animals in the world known to produce cube shaped droppings. They use this unique geometry to mark their territory in a way that stays in place on rocky surfaces.",
  "A group of flamingos is called a flamboyance which perfectly captures their vivid appearance. They get their pink color entirely from the pigments found in the algae and shrimp they consume.",
];

function getRandomText() {
  return TEXTS[Math.floor(Math.random() * TEXTS.length)];
}

// ─── Room state ─────────────────────────────────────────────────────
// typeRooms: Map<roomId, { players, text, state, progress, startTime, entryFee }>
const typeRooms = new Map();
const typeQueue = []; // [{ socketId, userId, username, elo, entryFee, isBot? }]
const typePrivateRooms = new Map(); // inviteCode -> roomId

// Bypass queue — create typing room directly (bot matches)
function createDirectTypeRoom(p1, p2) {
  const roomId = require('uuid').v4();
  const text = getRandomText();
  typeRooms.set(roomId, {
    players: [p1, p2],
    text,
    state: 'waiting',
    progress: { [p1.socketId]: 0, [p2.socketId]: 0 },
    startTime: null,
    entryFee: 0,
    currency: 'none',
    rematches: {},
  });
  return { roomId, text };
}

function addToTypeQueue(player) {
  if (typeQueue.some(p => p.socketId === player.socketId)) return null;
  typeQueue.push(player);
  return tryTypeMatch();
}

function removeFromTypeQueue(socketId) {
  const idx = typeQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) typeQueue.splice(idx, 1);
}

function tryTypeMatch() {
  if (typeQueue.length < 2) return null;
  typeQueue.sort((a, b) => a.elo - b.elo);
  const p1 = typeQueue.shift();
  const matchIdx = typeQueue.findIndex(p => p.entryFee === p1.entryFee);
  if (matchIdx === -1) { typeQueue.unshift(p1); return null; }
  const p2 = typeQueue.splice(matchIdx, 1)[0];
  const roomId = uuidv4();
  const text = getRandomText();
  typeRooms.set(roomId, {
    players: [p1, p2],
    text,
    state: 'waiting',
    progress: { [p1.socketId]: 0, [p2.socketId]: 0 },
    startTime: null,
    entryFee: p1.entryFee,
    rematches: {},
  });
  return { roomId, p1, p2, text };
}

function getTypeRoom(roomId) { return typeRooms.get(roomId); }
function deleteTypeRoom(roomId) { typeRooms.delete(roomId); }

function getTypeRoomBySocket(socketId) {
  for (const [roomId, room] of typeRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

// ─── Countdown + start ─────────────────────────────────────────────
async function startTypeCountdown(io, roomId) {
  const room = getTypeRoom(roomId);
  if (!room) return;
  room.state = 'countdown';

  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('type_countdown', { count: i });
    await sleep(1000);
  }

  const current = getTypeRoom(roomId);
  if (!current || current.state !== 'countdown') return;

  current.state = 'active';
  current.startTime = Date.now();
  io.to(roomId).emit('type_go', { text: current.text });

  // Simulate bot typing if applicable
  for (const player of current.players) {
    if (player.isBot) {
      simulateBotTyping(
        io,
        roomId,
        current.text,
        (pos) => {
          const r = getTypeRoom(roomId);
          if (!r || r.state !== 'active') return;
          r.progress[player.socketId] = pos;
          // Broadcast bot progress to human players in the room
          io.to(roomId).emit('type_opponent_progress', {
            socketId: player.socketId,
            progress: pos / r.text.length,
            position: pos,
          });
        },
        () => resolveTypeMatch(io, null, roomId, player.socketId, null, 'complete'),
      );
    }
  }
}

// ─── Progress update from a real player ────────────────────────────
function handleTypeProgress(io, roomId, socketId, position) {
  const room = getTypeRoom(roomId);
  if (!room || room.state !== 'active') return;
  room.progress[socketId] = position;
  const progress = position / room.text.length;
  // Tell the other player about this player's progress
  for (const p of room.players) {
    if (p.socketId !== socketId) {
      io.to(p.socketId).emit('type_opponent_progress', { socketId, progress, position });
    }
  }
}

// ─── A player finished typing ───────────────────────────────────────
async function resolveTypeMatch(io, supabase, roomId, winnerSocketId, loserSocketId, reason) {
  const room = getTypeRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  const winner = room.players.find(p => p.socketId === winnerSocketId);
  // loserSocketId may be null when bot triggers — derive it
  const loser = room.players.find(p => p.socketId !== winnerSocketId);
  if (!winner || !loser) return;

  const elapsed = (Date.now() - (room.startTime || Date.now())) / 60000;
  const charsTyped = room.progress[winnerSocketId] || room.text.length;
  const wpm = Math.round((charsTyped / 5) / Math.max(elapsed, 0.01));

  const { newWinnerElo, newLoserElo } = calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      const _hasBot = winner.isBot || loser.isBot;
      if (_hasBot) {
        const _humanId = winner.isBot ? loser.userId : winner.userId;
        const _humanWon = !winner.isBot;
        balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', _humanWon);
      } else {
        if (room.currency === 'diamonds') {
          balanceChange = await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee);
        } else {
          balanceChange = await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
        }
      }
    } catch (e) { console.error('Type match settle error:', e.message); }
  }

  let winnerStreak = 0;
  let isFirstWin = false;
  if (supabase && !winner.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
      await supabase.rpc('increment_win', { uid: winner.userId });
    } catch (e) { console.error('[typeGameEngine] RPC failed:', e.message); }
    try {
      ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null));
    } catch { /* streak columns may not exist yet */ }
  }
  // Always reset human loser's streak — any game, free or paid, vs bot or human
  if (supabase && !loser.isBot) {
    supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId).catch(() => {});
  }
  if (supabase && !loser.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
      await supabase.rpc('increment_loss', { uid: loser.userId });
    } catch (e) { console.error('[typeGameEngine] RPC failed:', e.message); }
  }

  if (supabase) {
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot  ? null : loser.userId,
        winner_id:  winner.isBot ? null : winner.userId,
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0,
        entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        prize_pool_c: room.entryFee * 2,
        platform_fee_c: balanceChange?.fee || 0,
        reaction_time_ms: null,
        early_click: false,
        game_type: 'type',
      });
    } catch (e) { console.error('[typeGameEngine] RPC failed:', e.message); }
  }

  // Credit rakeback for both players (skip bots — filter(Boolean) handles null)
  if (supabase && room.entryFee > 0) {
    const prizePool = room.entryFee * 2;
    const p1Id = winner.isBot ? null : winner.userId;
    const p2Id = loser.isBot  ? null : loser.userId;
    await creditRakeback(supabase, p1Id, p2Id, prizePool, room.currency || 'coins');
  }

  io.emit('active_game_ended', { id: roomId });
  io.to(roomId).emit('type_result', {
    winnerId:       winner.userId,
    loserId:        loser.userId,
    winnerUsername: winner.username,
    loserUsername:  loser.username,
    wpm,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    currency:       room.currency || 'coins',
    winnerStreak: winnerStreak ?? 0,
    isFirstWin: isFirstWin ?? false,
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  createDirectTypeRoom,
  addToTypeQueue,
  removeFromTypeQueue,
  getTypeRoom,
  deleteTypeRoom,
  getTypeRoomBySocket,
  startTypeCountdown,
  handleTypeProgress,
  resolveTypeMatch,
};


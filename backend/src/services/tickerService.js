// Shared match ticker — broadcasts the same fake/real match events to all
// connected clients so everyone sees an identical, synchronized feed.

const GAME_META = {
  block_blast: { icon: '🟦', name: 'Block Burst' },
  scrabble:    { icon: '🔤', name: 'Word VS'     },
  coin_flip:   { icon: '🟡', name: 'Coin Flip'   },
  blackjack:   { icon: '🃏', name: 'Blackjack'   },
};
const GAME_LIST    = Object.values(GAME_META);
const COIN_POOL    = [1, 5, 10];
const DIAMOND_POOL = [100, 250, 500, 50000];

// Seed: 14 initial items sent to each new connection so the ticker
// isn't empty when a user first loads the page.
const SEED_SIZE = 14;
const seed = [];
(function buildSeed() {
  let lastGame = null;
  let lastFeeKey = null;
  for (let i = 0; i < SEED_SIZE; i++) {
    const item = makeFake(lastFeeKey, lastGame);
    seed.push(item);
    lastGame   = item.game.name;
    lastFeeKey = feeKey(item);
  }
})();

function feeKey(item) {
  return `${item.fee}-${item.diamonds ? 'd' : 'c'}`;
}

function makeFake(lastFeeKey = null, lastGameName = null) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const game     = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
    if (game.name === lastGameName) continue;
    const diamonds = Math.random() < 0.4;
    const pool     = diamonds ? DIAMOND_POOL : COIN_POOL;
    const fee      = pool[Math.floor(Math.random() * pool.length)];
    const key      = `${fee}-${diamonds ? 'd' : 'c'}`;
    if (key === lastFeeKey) continue;
    const payout = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
    return { id: `f-${Date.now()}-${Math.random().toString(36).slice(2)}`, game, fee, payout, diamonds };
  }
  // Fallback (rare)
  const game     = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
  const diamonds = Math.random() < 0.4;
  const pool     = diamonds ? DIAMOND_POOL : COIN_POOL;
  const fee      = pool[Math.floor(Math.random() * pool.length)];
  const payout   = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  return { id: `f-${Date.now()}-${Math.random().toString(36).slice(2)}`, game, fee, payout, diamonds };
}

let io = null;
let supabase = null;
let lastGameName = null;
let lastFeeKey   = null;
let realPool     = [];
let timer        = null;

async function refreshRealPool() {
  try {
    const { data } = await supabase
      .from('matches')
      .select('id, game_type, entry_fee_c, entry_fee_diamonds, prize_pool_c')
      .order('played_at', { ascending: false })
      .limit(50);
    if (!Array.isArray(data)) return;
    realPool = data
      .map(m => {
        const game     = GAME_META[m.game_type];
        if (!game) return null;
        const diamonds = (m.entry_fee_diamonds ?? 0) > 0;
        const fee      = diamonds ? (m.entry_fee_diamonds ?? 0) : (m.entry_fee_c ?? 0);
        if (!fee) return null;
        const payout   = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
        return { id: `r-${m.id}`, game, fee, payout, diamonds };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('[ticker] real pool refresh error:', e.message);
  }
}

function scheduleNext() {
  const delay = 2000 + Math.random() * 3000;
  timer = setTimeout(() => {
    let item;
    if (realPool.length > 0 && Math.random() < 0.70) {
      // Pick a real item that doesn't repeat the last game
      const valid = realPool.filter(r => r.game.name !== lastGameName);
      const pool  = valid.length > 0 ? valid : realPool;
      const pick  = pool[Math.floor(Math.random() * pool.length)];
      item = { ...pick, id: `r-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    } else {
      item = makeFake(lastFeeKey, lastGameName);
    }
    lastGameName = item.game.name;
    lastFeeKey   = feeKey(item);
    io.emit('ticker_item', item);
    scheduleNext();
  }, delay);
}

module.exports = {
  init(_io, _supabase) {
    io       = _io;
    supabase = _supabase;
    refreshRealPool();
    setInterval(refreshRealPool, 60_000); // refresh real pool every minute
    scheduleNext();
  },
  // Called when a new socket connects — sends them the current seed
  sendSeed(socket) {
    socket.emit('ticker_seed', seed);
  },
  // Called by game engines when a real match ends so it appears immediately
  push(matchData) {
    const game = GAME_META[matchData.game_type];
    if (!game) return;
    const diamonds = (matchData.entry_fee_diamonds ?? 0) > 0;
    const fee      = diamonds ? (matchData.entry_fee_diamonds ?? 0) : (matchData.entry_fee_c ?? 0);
    if (!fee) return;
    const payout = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
    const item   = { id: `r-${Date.now()}`, game, fee, payout, diamonds };
    lastGameName = game.name;
    lastFeeKey   = feeKey(item);
    io.emit('ticker_item', item);
    // Also add to real pool for future picks
    realPool.unshift(item);
    if (realPool.length > 100) realPool.pop();
  },
};

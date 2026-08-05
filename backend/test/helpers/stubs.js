// Shared test doubles. Nothing here touches a real database, a real socket or
// a real payment gateway — every test in this suite runs offline and in-process.

// ── A tiny in-memory ledger standing in for the coins/diamonds RPCs ─────────
// deduct_coins mirrors the real RPC's contract: it REFUSES rather than going
// negative, which is the property the whole payment model rests on.
function makeLedger() {
  const coins = {};
  const diamonds = {};
  const feeBalance = {};
  const rows = [];

  const rpcs = {
    credit_coins:       ({ user_id, amount }) => { coins[user_id] = (coins[user_id] || 0) + amount; },
    deduct_coins:       ({ user_id, amount }) => {
      if ((coins[user_id] || 0) < amount) return { error: { message: 'Insufficient balance' } };
      coins[user_id] -= amount;
    },
    credit_diamonds:    ({ user_id, amount }) => { diamonds[user_id] = (diamonds[user_id] || 0) + amount; },
    deduct_diamonds:    ({ user_id, amount }) => {
      if ((diamonds[user_id] || 0) < amount) return { error: { message: 'Insufficient diamonds' } };
      diamonds[user_id] -= amount;
    },
    credit_fee_balance: ({ user_id, amount }) => { feeBalance[user_id] = (feeBalance[user_id] || 0) + amount; },
  };

  const supabase = {
    rpc: async (name, args) => {
      const out = rpcs[name] ? rpcs[name](args) : null;
      return { error: out?.error || null };
    },
    from: () => ({
      // eq() has to chain arbitrarily — several services do .eq().eq() — or the
      // stub throws and buries the real assertion in noise.
      select: () => {
        const chain = {
          eq:          () => chain,
          in:          async () => ({ data: [] }),
          single:      async () => ({ data: {} }),
          maybeSingle: async () => ({ data: null }),
          order:       () => chain,
          limit:       async () => ({ data: [] }),
        };
        return chain;
      },
      insert: async (row) => { rows.push(row); return { error: null }; },
      update: () => ({ eq: async () => ({ error: null }) }),
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  };

  return { coins, diamonds, feeBalance, rows, supabase };
}

// ── Socket.IO stand-in that just records what was emitted ──────────────────
function makeIo() {
  const emitted = [];
  return {
    emitted,
    to: (id) => ({ emit: (ev, d) => emitted.push({ to: id, ev, d }) }),
    emit: (ev, d) => emitted.push({ to: '*', ev, d }),
    sockets: { sockets: new Map() },
    resultsFor: (ev) => emitted.filter((e) => e.ev === ev),
    reset: () => { emitted.length = 0; },
  };
}

const player = (socketId, userId, extra = {}) => ({
  socketId, userId,
  username: userId,
  elo: 1000,
  entryFee: 0,
  currency: 'coins',
  side: 'heads',
  ...extra,
});

const botPlayer = (socketId) => player(socketId, 'bot', { username: 'Bot', isBot: true });

module.exports = { makeLedger, makeIo, player, botPlayer };

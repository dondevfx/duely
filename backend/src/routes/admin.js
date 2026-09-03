const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { creditDiamonds, creditCoins, deductCoins } = require('../services/walletService');
const { filterDemos, isDemo: isDemoAccount } = require('../services/demoAccounts');

module.exports = function adminRoutes(supabase, io) {
  const router = Router();

  function requireAdmin(req, res, next) {
    if (req.user.id !== process.env.ADMIN_USER_ID)
      return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  // ── Stats overview ────────────────────────────────────────────────────
  router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
   try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // NAMED, so a failure can be reported as "which query" rather than as a
    // silent 0. supabase-js RESOLVES with { error } instead of rejecting, so
    // the previous destructuring — which kept only count/data and dropped
    // every error — turned a renamed column or an un-migrated table into a
    // dashboard full of zeroes that looked like a real, empty platform.
    const QUERIES = [
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }).gte('played_at', todayStart.toISOString()),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo.toISOString()),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo.toISOString()),
      supabase.from('matches').select('id', { count: 'exact', head: true }).gte('played_at', sevenDaysAgo.toISOString()),
      supabase.from('matches').select('id', { count: 'exact', head: true }).gte('played_at', thirtyDaysAgo.toISOString()),
      supabase.from('profiles').select('c_coins, diamonds, fee_balance').eq('id', process.env.ADMIN_USER_ID).single(),
      supabase.from('matches').select('prize_pool_c, entry_fee_c'),
      // Was .eq('status','pending'), a status nothing ever wrote — so this read
      // zero forever while real failures went unnoticed. Counts the attention
      // queue instead, which is the number that actually needs watching.
      supabase.from('transactions').select('id', { count: 'exact', head: true })
        .in('status', ['refund_failed', 'payout_uncertain', 'pending', 'payout_failed', 'stuck', 'pending_retry']),
      supabase.from('transactions').select('amount_c').eq('type', 'fee_collection').eq('user_id', process.env.ADMIN_USER_ID),
      supabase.from('matches').select('game_type'),
      supabase.from('matches').select('player1_id, player2_id').gte('played_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('matches').select('player1_id, player2_id').gte('played_at', sevenDaysAgo.toISOString()),
      supabase.from('profiles').select('diamonds'),
    ];
    const NAMES = [
      'totalUsers', 'totalMatches', 'matchesToday', 'newUsersToday',
      'newUsers7d', 'newUsers30d', 'matches7d', 'matches30d',
      'adminProfile', 'matchData', 'pendingWithdrawals', 'feeClaimData',
      'gameTypeRows', 'activeRows24h', 'activeRows7d', 'diamondRows',
    ];
    const settled = await Promise.all(QUERIES);
    const queryErrors = [];
    settled.forEach((r, i) => {
      if (r && r.error) queryErrors.push(`${NAMES[i]}: ${r.error.message}`);
    });
    if (queryErrors.length) console.error('[admin/stats] query errors:', queryErrors.join(' | '));

    const [
      { count: totalUsers },
      { count: totalMatches },
      { count: matchesToday },
      { count: newUsersToday },
      { count: newUsers7d },
      { count: newUsers30d },
      { count: matches7d },
      { count: matches30d },
      { data: adminProfile },
      { data: matchData },
      { count: pendingWithdrawals },
      { data: feeClaimData },
      { data: gameTypeRows },
      { data: activeRows24h },
      { data: activeRows7d },
      { data: diamondRows },
    ] = settled;

    // Referral rewards earned but not yet collected. These are held back from
    // fee collection (see collect_admin_fees), so the number is shown alongside
    // fee_balance rather than left to look like a shortfall. Separate query so
    // a missing referral_rewards table before the migration degrades to 0
    // rather than breaking the whole admin dashboard.
    // What the wheels have paid out. Both currencies, because the rank wheels
    // pay diamonds and the coin slot pays coins, and "collected from wheels"
    // means different money in each case.
    //
    // Separate query with its own catch, like the referral total above: a
    // failure here must cost one tile rather than the whole dashboard.
    let wheelCoins = 0, wheelDiamonds = 0;
    try {
      const { data: spins } = await supabase
        .from('transactions').select('amount_c, crypto_amount, crypto_symbol')
        .eq('type', 'rewards_spin');
      for (const r of spins || []) {
        wheelCoins += parseFloat(r.amount_c) || 0;
        if ((r.crypto_symbol || '').toLowerCase() === 'diamonds') {
          wheelDiamonds += parseFloat(r.crypto_amount) || 0;
        }
      }
    } catch { /* one tile, not the dashboard */ }

    let referralReserved = 0;
    try {
      const { data: owed } = await supabase
        .from('referral_rewards').select('amount_c').eq('status', 'pending');
      referralReserved = (owed || []).reduce((s, r) => s + (parseFloat(r.amount_c) || 0), 0);
    } catch { /* table not migrated yet */ }

    // Sum prize_pool_c — fallback to entry_fee_c * 2 if prize_pool_c not set
    const totalWagered = (matchData || []).reduce((s, m) => {
      const pp = Number(m.prize_pool_c) || 0;
      const ef = Number(m.entry_fee_c) || 0;
      return s + (pp > 0 ? pp : ef * 2);
    }, 0);

    const totalFeesClaimed = (feeClaimData || []).reduce((s, t) => s + (Number(t.amount_c) || 0), 0);

    const matchesByGame = {};
    for (const row of (gameTypeRows || [])) {
      const gt = row.game_type || 'unknown';
      matchesByGame[gt] = (matchesByGame[gt] || 0) + 1;
    }

    function distinctPlayerCount(rows) {
      const ids = new Set();
      for (const r of (rows || [])) {
        if (r.player1_id) ids.add(r.player1_id);
        if (r.player2_id) ids.add(r.player2_id);
      }
      ids.delete(process.env.ADMIN_USER_ID);
      return ids.size;
    }

    const totalDiamonds = (diamondRows || []).reduce((s, p) => s + (Number(p.diamonds) || 0), 0);

    res.json({
      total_users:        totalUsers   ?? 0,
      total_matches:      totalMatches ?? 0,
      matches_today:      matchesToday ?? 0,
      new_users_today:    newUsersToday ?? 0,
      new_users_7d:       newUsers7d ?? 0,
      new_users_30d:      newUsers30d ?? 0,
      matches_7d:         matches7d ?? 0,
      matches_30d:        matches30d ?? 0,
      active_users_24h:   distinctPlayerCount(activeRows24h),
      active_users_7d:    distinctPlayerCount(activeRows7d),
      matches_by_game:    matchesByGame,
      total_diamonds_circulating: totalDiamonds,
      wheel_coins_paid:    parseFloat(wheelCoins.toFixed(4)),
      wheel_diamonds_paid: Math.round(wheelDiamonds),
      fees_coins:         parseFloat((adminProfile?.c_coins ?? 0).toFixed(2)),
      fees_diamonds:      adminProfile?.diamonds ?? 0,
      fee_balance:        parseFloat((adminProfile?.fee_balance ?? 0).toFixed(4)),
      // Referral rewards already earned but not yet collected. Held back from
      // fee collection, so surfaced here — otherwise collecting appears to
      // short-change you for no visible reason.
      referral_reserved:  parseFloat((referralReserved ?? 0).toFixed(4)),
      fee_balance_available: parseFloat(
        Math.max(0, (adminProfile?.fee_balance ?? 0) - (referralReserved ?? 0)).toFixed(4)),
      total_wagered:       parseFloat(totalWagered.toFixed(2)),
      total_fees_claimed:  parseFloat(totalFeesClaimed.toFixed(4)),
      // Kept under the old key so the existing dashboard tile keeps working;
      // it now means "rows needing a human" rather than a status that was
      // never written.
      pending_withdrawals: pendingWithdrawals ?? 0,
      needs_attention:     pendingWithdrawals ?? 0,
      // Non-empty means some tiles above are 0 because their query failed,
      // not because the platform is idle. The dashboard shows this.
      query_errors:        queryErrors,
    });
   } catch (e) {
     // This route runs 16 queries in one Promise.all. Any single rejection —
     // a column renamed, a table not yet migrated — threw out of the handler
     // with no catch, so Express returned a 500 and the dashboard rendered
     // completely empty. The client now degrades per-section, but the real
     // error still needs to reach somewhere a person will see it.
     console.error('[admin/stats] failed:', e.message);
     res.status(500).json({ error: `stats query failed: ${e.message}` });
   }
  });

  // ── Recent transactions ───────────────────────────────────────────────
  // Statuses that mean money is stuck and a human has to look.
  //
  // Ordered by how bad they are, which is also the order they should be worked:
  //   refund_failed     coins taken, payout failed, refund failed — money owed
  //   payout_uncertain  broadcast, but the chain could not be read. NOT refunded
  //                     on purpose: the player may already hold the crypto, so
  //                     look up the tx_hash before crediting anything back
  //   withdraw_failed   ChangeNow could not deliver a withdrawal. Coins are
  //                     deducted and DELIBERATELY not auto-refunded: their
  //                     terminal statuses do not all mean the same thing, so
  //                     check the exchange, then Refund or Money arrived
  //   payout_failed     funds may be in flight; verify on-chain before touching
  //   pending           a withdrawal in a state NOTHING in the current code
  //                     writes. Left over from an older version, so no process
  //                     will ever move it on. Either the payout happened and
  //                     the row is just wrong, or coins were deducted and never
  //                     paid — which is why it ranks above payout_failed, where
  //                     the refund already succeeded and the player is whole.
  //                     Check the tx_hash on-chain before deciding.
  //   stuck             the swap gave up after an hour
  //   pending_retry     funds still in the deposit wallet; usually self-heals
  //   converting        normal in the short term, a problem when it is hours old
  const ATTENTION_STATUSES = ['refund_failed', 'withdraw_failed', 'payout_uncertain', 'pending', 'payout_failed', 'stuck', 'pending_retry', 'converting', 'sending'];
  const ATTENTION_RANK = Object.fromEntries(ATTENTION_STATUSES.map((s, i) => [s, i]));
  // 'converting' is transient by design, so only count it once it has clearly
  // outlived a normal swap. Without this the queue is permanently full of
  // deposits that are simply in progress, and a real problem hides among them.
  const CONVERTING_STALE_MS = 60 * 60 * 1000;
  // A fiat payout in flight is NOT stale after an hour. ACH takes one to
  // three business days and a PayPal payout can sit unclaimed for a month,
  // so the same window would fill this queue with healthy payouts and bury
  // the real failures. The watcher flips anything genuinely overdue to
  // withdraw_failed or payout_uncertain, so this is only a backstop for a
  // watcher that has stopped running.
  const SENDING_STALE_MS = 5 * 24 * 60 * 60 * 1000;

  // ── Analytics over an arbitrary window ────────────────────────────────
  //
  // /stats answers "what is true right now" with a fixed set of windows —
  // today, 7d, 30d, all time. This answers "what happened between these two
  // dates, broken into buckets", which is the question a dashboard exists for
  // and the one the old page could not ask at all.
  //
  // Bucketed in JS rather than in SQL. Doing it in Postgres would be faster and
  // is where this belongs eventually, but it needs a migration and a function
  // per metric, and at these volumes pulling timestamps and counting them is
  // honest work rather than a shortcut. The row cap is what stops that being a
  // lie at ten times the size — see `truncated` in the response.
  const MAX_ROWS = 50000;

  // Buckets follow the span rather than being a required parameter: a year of
  // daily points is 365 unreadable bars, and a week of monthly points is one.
  // The client may override it; the default is the one that reads.
  function bucketFor(fromMs, toMs) {
    const days = (toMs - fromMs) / 86400000;
    if (days <= 62) return 'day';
    if (days <= 400) return 'week';
    return 'month';
  }

  // UTC throughout. A dashboard on the SERVER's timezone shifts every boundary
  // when the host moves, and "matches on the 3rd" quietly starts meaning
  // something different from what it meant last month.
  function bucketKey(d, bucket) {
    const dt = new Date(d);
    if (bucket === 'month') {
      return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-01';
    }
    if (bucket === 'week') {
      // Weeks start Monday, matching the leaderboard reset.
      const day = (dt.getUTCDay() + 6) % 7;
      const monday = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - day));
      return monday.toISOString().slice(0, 10);
    }
    return dt.toISOString().slice(0, 10);
  }

  // Every bucket in the range, including the empty ones. Without this a quiet
  // week is drawn as a straight line between the days either side of it, which
  // reads as steady activity rather than as none.
  function emptyBuckets(fromMs, toMs, bucket) {
    const keys = [];
    const cur = new Date(bucketKey(fromMs, bucket));
    const end = new Date(bucketKey(toMs, bucket));
    let guard = 0;
    while (cur <= end && guard++ < 2000) {
      keys.push(cur.toISOString().slice(0, 10));
      if (bucket === 'month') cur.setUTCMonth(cur.getUTCMonth() + 1);
      else if (bucket === 'week') cur.setUTCDate(cur.getUTCDate() + 7);
      else cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return keys;
  }

  // Paged, not capped.
  //
  // This used to be a single .limit(MAX_ROWS) with .order(ascending), and that
  // combination is what made "90 days" report zero fees while "30 days"
  // reported them correctly. PostgREST enforces its own row ceiling regardless
  // of what .limit() asks for, so a wide range came back cut — and cut from
  // the END, because ascending order puts the newest rows last. Fee
  // collections are recent, so they were exactly what fell off. The numbers
  // were not wrong by a little; whole metrics read as zero.
  //
  // Pages until a short page comes back, which is the only way to know the
  // range is exhausted rather than merely capped. The overall ceiling stays,
  // but it is now a real ceiling rather than a silent one — reaching it sets
  // `truncated`, and a page that stops early cannot be mistaken for the end.
  const PAGE = 1000;

  async function fetchRange(table, tsCol, fromIso, toIso, cols) {
    const out = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await supabase
        .from(table).select(cols)
        .gte(tsCol, fromIso).lte(tsCol, toIso)
        .order(tsCol, { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(table + ': ' + error.message);
      const rows = data || [];
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
    return out;
  }

  router.get('/analytics', requireAuth, requireAdmin, async (req, res) => {
    try {
      const toMs   = req.query.to   ? Date.parse(req.query.to)   : Date.now();
      const fromMs = req.query.from ? Date.parse(req.query.from) : toMs - 30 * 86400000;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
        return res.status(400).json({ error: 'Invalid from/to' });
      }
      const bucket = ['day', 'week', 'month'].includes(req.query.bucket)
        ? req.query.bucket
        : bucketFor(fromMs, toMs);
      const fromIso = new Date(fromMs).toISOString();
      const toIso   = new Date(toMs).toISOString();

      const [rawUsers, rawMatches, rawTxs] = await Promise.all([
        fetchRange('profiles', 'created_at', fromIso, toIso, 'id, created_at'),
        fetchRange('matches', 'played_at', fromIso, toIso,
          'played_at, entry_fee_c, entry_fee_diamonds, prize_pool_c, prize_pool_diamonds, player1_id, player2_id, game_type'),
        fetchRange('transactions', 'created_at', fromIso, toIso,
          'created_at, type, amount_c, user_id, status'),
      ]);

      // Demo accounts are excluded everywhere, not filtered in the client.
      //
      // They exist to be played with — a demo wins every bot match by design
      // and can be topped up on demand — so leaving them in makes every number
      // on this page a mixture of what happened and what was staged. A match
      // is dropped if EITHER side is a demo, because a demo's opponent did not
      // play a real match either.
      const users   = rawUsers.filter(u => !isDemoAccount(u.id));
      const matches = rawMatches.filter(m => !isDemoAccount(m.player1_id) && !isDemoAccount(m.player2_id));
      const txs     = rawTxs.filter(t => !isDemoAccount(t.user_id));

      const blank = () => ({
        new_users: 0, matches: 0, wagered: 0, fees: 0,
        deposits: 0, withdrawals: 0, players: new Set(),
      });
      const series = new Map();
      for (const k of emptyBuckets(fromMs, toMs, bucket)) series.set(k, blank());
      const at = (ts) => {
        const k = bucketKey(ts, bucket);
        if (!series.has(k)) series.set(k, blank());
        return series.get(k);
      };

      for (const u of users) at(u.created_at).new_users++;

      for (const m of matches) {
        const b = at(m.played_at);
        b.matches++;
        // prize_pool_c is what both sides staked; entry_fee_c is one player's
        // half. The fallback keeps rows written before prize_pool_c existed
        // from reading as free matches.
        b.wagered += Number(m.prize_pool_c) || (Number(m.entry_fee_c) || 0) * 2;
        if (m.player1_id) b.players.add(m.player1_id);
        if (m.player2_id) b.players.add(m.player2_id);
      }

      for (const t of txs) {
        const b = at(t.created_at);
        const amt = Number(t.amount_c) || 0;
        if (t.type === 'fee_collection') b.fees += amt;
        else if (t.type === 'deposit' && t.status === 'confirmed') b.deposits += amt;
        else if (t.type === 'withdrawal' && t.status === 'confirmed') b.withdrawals += Math.abs(amt);
      }

      const points = [...series.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([t, v]) => ({
          t,
          new_users: v.new_users,
          matches: v.matches,
          wagered: Number(v.wagered.toFixed(2)),
          fees: Number(v.fees.toFixed(4)),
          deposits: Number(v.deposits.toFixed(2)),
          withdrawals: Number(v.withdrawals.toFixed(2)),
          active_players: v.players.size,
        }));

      const sum = (k) => points.reduce((a, p) => a + p[k], 0);

      // Active players is the one total that is NOT the sum of its buckets:
      // somebody who played Monday and Tuesday is one player, not two.
      const allPlayers = new Set();
      for (const m of matches) {
        if (m.player1_id) allPlayers.add(m.player1_id);
        if (m.player2_id) allPlayers.add(m.player2_id);
      }

      // Per game, and per mode within it.
      //
      // "Matches by game" was a count and nothing else, which says which games
      // get played but not which ones earn. Rake is the platform's only income
      // from a match, and it comes off the coin prize pool at 5% — diamonds
      // pay out in full, so a game played entirely in diamonds is popular and
      // free, and the count alone cannot tell those two apart.
      //
      // Rake here is DERIVED (5% of the coin pool) rather than read from
      // fee_collection rows, because those are recorded per collection and
      // carry no game. It is the right number for comparing games against each
      // other; the Fees Collected chart above is the one to trust for what
      // actually landed in the account.
      const RAKE = 0.05;
      const byGame = {};
      const gameOf = (m) => m.game_type || 'unknown';
      for (const m of matches) {
        const g = gameOf(m);
        const b = byGame[g] || (byGame[g] = {
          matches: 0, wagered_c: 0, wagered_diamonds: 0, rake_c: 0,
          pvp: 0, vs_bot: 0, free: 0, paid: 0, coins: 0, diamonds: 0,
        });
        const poolC = Number(m.prize_pool_c) || (Number(m.entry_fee_c) || 0) * 2;
        const poolD = Number(m.prize_pool_diamonds) || (Number(m.entry_fee_diamonds) || 0) * 2;
        b.matches++;
        b.wagered_c += poolC;
        b.wagered_diamonds += poolD;
        b.rake_c += poolC * RAKE;
        // A null player id is the bot's side of the row — that is how the
        // engines record a bot match, not a missing value.
        if (m.player1_id && m.player2_id) b.pvp++; else b.vs_bot++;
        if (poolC > 0 || poolD > 0) b.paid++; else b.free++;
        if (poolC > 0) b.coins++;
        if (poolD > 0) b.diamonds++;
      }
      for (const g of Object.keys(byGame)) {
        byGame[g].wagered_c = Number(byGame[g].wagered_c.toFixed(2));
        byGame[g].wagered_diamonds = Math.round(byGame[g].wagered_diamonds);
        byGame[g].rake_c = Number(byGame[g].rake_c.toFixed(4));
      }


      res.json({
        from: fromIso, to: toIso, bucket, points,
        totals: {
          new_users:      sum('new_users'),
          matches:        sum('matches'),
          wagered:        Number(sum('wagered').toFixed(2)),
          fees:           Number(sum('fees').toFixed(4)),
          deposits:       Number(sum('deposits').toFixed(2)),
          withdrawals:    Number(sum('withdrawals').toFixed(2)),
          active_players: allPlayers.size,
        },
        by_game: byGame,
        // Said out loud rather than quietly under-reported. A capped range
        // looks exactly like a quiet one otherwise, and the difference matters
        // when the number is being used to decide something.
        // Measured on the RAW counts: the demo filter above legitimately
        // shrinks these, and a range that was truncated and then filtered
        // would otherwise stop reporting itself as truncated.
        truncated: [
          rawUsers.length   >= MAX_ROWS ? 'profiles' : null,
          rawMatches.length >= MAX_ROWS ? 'matches' : null,
          rawTxs.length     >= MAX_ROWS ? 'transactions' : null,
        ].filter(Boolean),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/transactions', requireAuth, requireAdmin, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    // Demo accounts are excluded, as they are from the leaderboards, search and
    // the ticker. Their matches move demo coins that are not real money, so
    // every demo game they play is a row of noise between the transactions that
    // actually need looking at — and the attention queue is the one list where
    // that matters most.
    let q = filterDemos(
      supabase
        .from('transactions')
        .select('*, profiles(username, profile_color, avatar_url)')
        .order('created_at', { ascending: false }),
      'user_id',
    );

    if (req.query.needsAttention === '1') {
      q = q.in('status', ATTENTION_STATUSES).limit(200);
    } else if (req.query.status) {
      q = q.eq('status', req.query.status).range(offset, offset + limit - 1);
    } else {
      q = q.range(offset, offset + limit - 1);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    if (req.query.needsAttention !== '1') return res.json(data || []);

    const now = Date.now();
    const rows = (data || [])
      .filter(t => t.status !== 'sending'
        || now - new Date(t.created_at).getTime() > SENDING_STALE_MS)
      .filter(t => t.status !== 'converting'
        || now - new Date(t.created_at).getTime() > CONVERTING_STALE_MS)
      // Worst first, then oldest — a row that has been broken for three days
      // matters more than one that broke a minute ago.
      .sort((a, b) => (ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status])
        || (new Date(a.created_at) - new Date(b.created_at)));

    res.json(rows);
  });

  // Everything an operator needs to decide what actually happened, before
  // touching anyone's balance. Guessing is how a stuck deposit becomes a double
  // credit.
  router.get('/transactions/:id/context', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data: tx } = await supabase
        .from('transactions').select('*, profiles(username)').eq('id', req.params.id).maybeSingle();
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const [{ data: profile }, { data: related }] = await Promise.all([
        supabase.from('profiles').select('c_coins, diamonds, crypto_deposited, crypto_withdrawn')
          .eq('id', tx.user_id).single(),
        // Everything around the same event: the deposit_raw marker, the swap
        // row, a manual credit already applied. This is what answers "did the
        // coins actually land" without reading the whole table.
        supabase.from('transactions')
          .select('id, type, amount_c, status, tx_hash, notes, created_at')
          .eq('user_id', tx.user_id)
          .order('created_at', { ascending: false })
          .limit(25),
      ]);

      // A credit already applied for THIS row is the single most important
      // signal — it is the difference between owing the player and having
      // already paid them.
      const alreadyCredited = (related || []).some(r =>
        r.id !== tx.id && (r.notes || '').includes(tx.id));

      res.json({
        tx,
        balance:   profile?.c_coins ?? 0,
        diamonds:  profile?.diamonds ?? 0,
        deposited: profile?.crypto_deposited ?? 0,
        withdrawn: profile?.crypto_withdrawn ?? 0,
        alreadyCredited,
        explorer: explorerUrl(tx),
        related: related || [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Best-effort explorer link, so the operator can confirm on-chain whether the
  // money actually moved rather than trusting our own row.
  function explorerUrl(tx) {
    const h = tx.tx_hash;
    if (!h) return null;
    const sym = (tx.crypto_symbol || '').toUpperCase();
    if (sym === 'BTC')  return 'https://blockstream.info/tx/' + h;
    if (sym === 'ETH')  return 'https://etherscan.io/tx/' + h;
    if (sym === 'BNB')  return 'https://bscscan.com/tx/' + h;
    if (sym === 'TRX')  return 'https://tronscan.org/#/transaction/' + h;
    if (sym === 'LTC')  return 'https://blockchair.com/litecoin/transaction/' + h;
    if (sym === 'DOGE') return 'https://blockchair.com/dogecoin/transaction/' + h;
    if (sym === 'SOL' || sym === 'USDC') return 'https://solscan.io/tx/' + h;
    return null;
  }

  // Resolve one stuck transaction.
  //
  //   credit     the player is owed — pay them and close it
  //   deduct     we already paid, and paid twice — claw it back
  //   mark_sent  the money did reach them; nothing to move, just record it
  //   decline    it never happened and never will; close with a reason
  //
  // Money never moves without an explicit action, because several of these
  // states mean the player was already paid, and a single "fix it" button that
  // always credited would pay twice.
  const ACTIONS = new Set(['credit', 'deduct', 'mark_sent', 'decline']);

  router.post('/transactions/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
    const { action, amount, note } = req.body || {};
    if (!ACTIONS.has(action)) {
      return res.status(400).json({ error: 'action must be one of: ' + [...ACTIONS].join(', ') });
    }
    const amt = parseFloat(amount) || 0;
    if ((action === 'credit' || action === 'deduct') && amt <= 0) {
      return res.status(400).json({ error: 'A positive amount is required for that action' });
    }

    try {
      const { data: tx } = await supabase
        .from('transactions').select('*').eq('id', req.params.id).maybeSingle();
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const outcome = action === 'decline' ? 'declined' : 'resolved';
      // Claim the row FIRST so two admins clicking at once cannot both move
      // money. Same ordering as every other payout path here.
      const { data: claimed } = await supabase
        .from('transactions')
        .update({
          status: outcome,
          notes: [tx.notes, action + ' by admin: ' + String(note || '').slice(0, 200)]
            .filter(Boolean).join(' | ').slice(0, 500),
        })
        .eq('id', req.params.id)
        .not('status', 'in', '("resolved","declined")')
        .select('id');
      if (!claimed?.length) return res.status(409).json({ error: 'Already resolved by someone else' });

      let moved = 0;
      try {
        if (action === 'credit') { await creditCoins(supabase, tx.user_id, amt); moved = amt; }
        if (action === 'deduct') { await deductCoins(supabase, tx.user_id, amt); moved = -amt; }
      } catch (e) {
        // Put it back in the queue rather than leaving a row that looks dealt
        // with when nothing moved.
        await supabase.from('transactions')
          .update({ status: tx.status }).eq('id', req.params.id).then().catch(() => {});
        return res.status(500).json({ error: action + ' failed: ' + e.message });
      }

      if (moved !== 0) {
        // Its own row, referencing the original, so the audit trail shows who
        // was paid what and why — and so the context view can tell next time
        // that this one has already been settled.
        await supabase.from('transactions').insert({
          user_id: tx.user_id,
          type: moved > 0 ? 'deposit' : 'withdrawal',
          amount_c: Math.abs(moved),
          status: 'confirmed',
          notes: 'admin ' + action + ' for transaction ' + tx.id + ': ' + String(note || '').slice(0, 150),
        }).then().catch(() => {});
      }

      res.json({ ok: true, action, moved });
    } catch (err) {
      console.error('[admin] resolve failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Support inbox --------------------------------------------------
  router.get('/support/tickets', requireAuth, requireAdmin, async (req, res) => {
    // Defaults to what is waiting on staff — a list of everything ever raised
    // is not a work queue.
    const status = req.query.status || 'open';
    let q = supabase
      .from('support_tickets')
      .select('*, profiles(username, profile_color, avatar_url)')
      .order('updated_at', { ascending: false })
      .limit(100);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  router.get('/support/tickets/:id', requireAuth, requireAdmin, async (req, res) => {
    const { data: ticket } = await supabase
      .from('support_tickets').select('*, profiles(username, c_coins)')
      .eq('id', req.params.id).maybeSingle();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const { data: messages } = await supabase
      .from('support_messages').select('*')
      .eq('ticket_id', ticket.id).order('created_at', { ascending: true });
    res.json({ ...ticket, messages: messages || [] });
  });

  router.post('/support/tickets/:id/reply', requireAuth, requireAdmin, async (req, res) => {
    const body = String(req.body?.body ?? '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'Message is required' });
    const { data: ticket } = await supabase
      .from('support_tickets').select('id, user_id').eq('id', req.params.id).maybeSingle();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    await supabase.from('support_messages')
      .insert({ ticket_id: ticket.id, sender_id: req.user.id, is_staff: true, body });
    // awaiting_user, not closed: the player may still need to answer, and
    // closing here would make them raise a fresh ticket to continue.
    await supabase.from('support_tickets')
      .update({ status: req.body?.close ? 'closed' : 'awaiting_user', updated_at: new Date().toISOString() })
      .eq('id', ticket.id);

    // Nudge them if they are online, so a reply is not left sitting unseen.
    if (io) {
      for (const [, sock] of io.sockets.sockets) {
        if (sock._authenticatedUserId === ticket.user_id) {
          sock.emit('support_reply', { ticketId: ticket.id });
          break;
        }
      }
    }
    res.json({ ok: true });
  });

  router.post('/support/tickets/:id/close', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase.from('support_tickets')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ── Users list ────────────────────────────────────────────────────────
  router.get('/users', requireAuth, requireAdmin, async (req, res) => {
    const { search } = req.query;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);

    // The ban columns are requested SEPARATELY, then dropped on failure.
    //
    // PostgREST rejects the entire query for one unknown column, so listing
    // `banned` inline made this route 500 outright until PENDING_SQL section
    // 17 was run — and because the client swallowed the failure, the whole
    // dashboard rendered empty rather than just the ban badges going missing.
    // That is the bug this comment's neighbour above already claimed to have
    // fixed for /users/:id but never actually implemented.
    const BASE = 'id, username, elo, wins, losses, c_coins, diamonds, created_at, profile_color';

    const run = (cols) => {
      let q = supabase
        .from('profiles')
        .select(cols)
        .neq('id', process.env.ADMIN_USER_ID)
        .order('c_coins', { ascending: false })
        .limit(limit);
      if (search) q = q.ilike('username', `%${search}%`);
      return q;
    };

    // Optional columns peeled off in groups, newest migration first — one
    // unknown column rejects the whole query.
    let { data, error } = await run(`${BASE}, banned, avatar_url, avatar_banned`);
    if (error && /avatar_url|avatar_banned/.test(error.message || '')) {
      console.warn('[admin/users] avatar columns missing — run PENDING_SQL section 18.');
      ({ data, error } = await run(`${BASE}, banned`));
    }
    if (error && /banned/.test(error.message || '')) {
      console.warn('[admin/users] profiles.banned is missing — run PENDING_SQL section 17. Serving without ban state.');
      ({ data, error } = await run(BASE));
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── One player, in full ────────────────────────────────────────────────
  //
  // Everything the player-detail panel needs from one round trip: the
  // profile, their recent transactions, and their recent matches. Kept as
  // one route rather than three so the panel does not open blank and fill in
  // piece by piece.
  // PROFILE_COLS splits the ban columns out for the same reason the socket
  // handler does: one unknown column makes PostgREST reject the whole query,
  // so before PENDING_SQL section 17 is run this route would 404 every
  // player rather than just hiding the ban controls.
  // email_confirmed_at is NOT on profiles — it lives on auth.users, and is
  // read from the JWT (req.user) everywhere else in this codebase. Selecting
  // it here made PostgREST reject the query for every player, and since the
  // fallback below reused the same column list, BOTH attempts failed and the
  // panel 404'd on every click. Fetched separately from the auth admin API
  // instead, where it actually exists.
  const PROFILE_BASE = 'id, username, elo, wins, losses, c_coins, diamonds, created_at, profile_color, kyc_status';
  // Kept OUT of PROFILE_BASE on purpose: that is the fallback list, the one
  // used when a newer migration has not run. Putting migration-dependent
  // columns in it would break the very query meant to survive without them.
  const PROFILE_AVATAR = 'avatar_url, avatar_banned';

  router.get('/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    // Same split as /users above — and the same reason. This one genuinely
    // needs it: without the fallback the panel 500s for every player, not
    // merely hides the ban controls.
    const loadProfile = async () => {
      // Newest migration peeled off first.
      let r = await supabase.from('profiles')
        .select(`${PROFILE_BASE}, banned, ban_reason, banned_at, ${PROFILE_AVATAR}`)
        .eq('id', id).single();
      if (r.error && /avatar_url|avatar_banned/.test(r.error.message || '')) {
        console.warn('[admin/users/:id] avatar columns missing — run PENDING_SQL section 18.');
        r = await supabase.from('profiles')
          .select(`${PROFILE_BASE}, banned, ban_reason, banned_at`).eq('id', id).single();
      }
      if (r.error && /banned/.test(r.error.message || '')) {
        console.warn('[admin/users/:id] ban columns missing — run PENDING_SQL section 17.');
        r = await supabase.from('profiles').select(PROFILE_BASE).eq('id', id).single();
      }
      return r;
    };

    const [{ data: profile, error: pErr }, { data: transactions }, { data: matchesAsP1 }, { data: matchesAsP2 }] = await Promise.all([
      loadProfile(),
      supabase.from('transactions')
        .select('id, type, amount_c, crypto_amount, crypto_symbol, status, tx_hash, notes, created_at')
        .eq('user_id', id).order('created_at', { ascending: false }).limit(50),
      supabase.from('matches')
        .select('id, game_type, winner_id, entry_fee_c, entry_fee_diamonds, prize_pool_c, prize_pool_diamonds, played_at, player2_id, player2:profiles!player2_id(username)')
        .eq('player1_id', id).order('played_at', { ascending: false }).limit(20),
      supabase.from('matches')
        .select('id, game_type, winner_id, entry_fee_c, entry_fee_diamonds, prize_pool_c, prize_pool_diamonds, played_at, player1_id, player1:profiles!player1_id(username)')
        .eq('player2_id', id).order('played_at', { ascending: false }).limit(20),
    ]);

    let resolvedProfile = profile;
    if (pErr && /banned|ban_reason|banned_at/.test(pErr.message || '')) {
      console.warn('[admin] profiles.banned is missing — run PENDING_SQL section 17. Showing the player without ban controls.');
      ({ data: resolvedProfile } = await supabase.from('profiles').select(PROFILE_BASE).eq('id', id).single());
    } else if (pErr) {
      return res.status(404).json({ error: 'Player not found' });
    }
    if (!resolvedProfile) return res.status(404).json({ error: 'Player not found' });

    const matches = [
      ...(matchesAsP1 || []).map(m => ({ ...m, opponent: m.player2?.username ?? (m.player2_id ? 'Unknown' : 'Bot'), won: m.winner_id === id })),
      ...(matchesAsP2 || []).map(m => ({ ...m, opponent: m.player1?.username ?? (m.player1_id ? 'Unknown' : 'Bot'), won: m.winner_id === id })),
    ].sort((a, b) => new Date(b.played_at) - new Date(a.played_at)).slice(0, 20);

    // Verified-email state, from the one place that has it. Best-effort: the
    // panel is still useful without it, so a failure here must not 404 a
    // player the way selecting a non-existent column did.
    let emailConfirmedAt = null;
    let email = null;
    try {
      const { data: u } = await supabase.auth.admin.getUserById(id);
      emailConfirmedAt = u?.user?.email_confirmed_at ?? null;
      email = u?.user?.email ?? null;
    } catch (e) {
      console.warn('[admin] could not read auth user:', e.message);
    }

    res.json({
      profile: { ...resolvedProfile, email, email_confirmed_at: emailConfirmedAt },
      transactions: transactions || [],
      matches,
    });
  });

  // ── Reports against one player ────────────────────────────────────────
  //
  // Requested separately from /users/:id rather than joined into it: the
  // player_reports table arrives with PENDING_SQL section 18, and folding it
  // into the main query would make the whole panel 404 before that runs —
  // the exact failure mode that made this panel unreachable in the first
  // place (a phantom email_confirmed_at column).
  router.get('/users/:id/reports', requireAuth, requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('player_reports')
      .select('id, reason, details, status, created_at, reviewed_at, reporter:profiles!reporter_id(username)')
      .eq('reported_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      if (/player_reports/.test(error.message || '')) {
        console.warn('[admin] player_reports missing — run PENDING_SQL section 18.');
        return res.json({ reports: [], migrated: false });
      }
      return res.status(500).json({ error: error.message });
    }
    res.json({ reports: data || [], migrated: true });
  });

  // Every open report, newest first — the queue view.
  router.get('/reports', requireAuth, requireAdmin, async (req, res) => {
    const status = ['open', 'actioned', 'dismissed'].includes(req.query.status)
      ? req.query.status : 'open';
    const { data, error } = await supabase
      .from('player_reports')
      .select('id, reason, details, status, created_at, reported_id, reporter:profiles!reporter_id(username), reported:profiles!reported_id(username, avatar_url)')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      if (/player_reports/.test(error.message || '')) return res.json({ reports: [], migrated: false });
      return res.status(500).json({ error: error.message });
    }
    res.json({ reports: data || [], migrated: true });
  });

  router.post('/reports/:id/decide', requireAuth, requireAdmin, async (req, res) => {
    const decision = String(req.body?.decision || '');
    if (decision !== 'actioned' && decision !== 'dismissed') {
      return res.status(400).json({ error: 'decision must be "actioned" or "dismissed"' });
    }
    // Claimed the same way KYC decisions are: scoping to status='open' means
    // two admins clicking at once cannot both resolve the same report.
    const { data, error } = await supabase
      .from('player_reports')
      .update({ status: decision, reviewed_at: new Date().toISOString(), reviewed_by: req.user.id })
      .eq('id', req.params.id).eq('status', 'open')
      .select('id').single();

    if (error || !data) return res.status(409).json({ error: 'That report was already reviewed.' });
    res.json({ ok: true, decision });
  });

  // ── Remove a profile picture ──────────────────────────────────────────
  //
  // Two separate things, deliberately one action: clear the image AND revoke
  // the right to upload another. Clearing alone is an invitation to re-upload
  // the same picture, which makes the button feel useless the first time
  // somebody does it. `banned` here is the avatar privilege only — it does
  // not touch the account ban.
  router.post('/users/:id/remove-avatar', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    // Default TRUE: this endpoint exists because a picture broke the rules,
    // so revoking is the expected outcome and allowing again is the exception
    // an admin has to ask for explicitly.
    const ban = req.body?.banFuture !== false;

    const { data: profile } = await supabase
      .from('profiles').select('avatar_url').eq('id', id).single();

    const { error } = await supabase
      .from('profiles')
      .update({ avatar_url: null, avatar_banned: ban })
      .eq('id', id);

    if (error) {
      if (/avatar_url|avatar_banned/.test(error.message || '')) {
        return res.status(503).json({ error: 'Run PENDING_SQL section 18 first.' });
      }
      return res.status(500).json({ error: error.message });
    }

    // Delete the object too, not just the link. A public URL that still
    // resolves is still reachable by anyone who saw it once.
    if (profile?.avatar_url) {
      const key = profile.avatar_url.split('/avatars/')[1];
      if (key) supabase.storage.from('avatars').remove([key]).then(() => {}, () => {});
    }

    res.json({ ok: true, avatar_banned: ban });
  });

  // Give the privilege back.
  router.post('/users/:id/restore-avatar', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase
      .from('profiles').update({ avatar_banned: false }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ── Ban / unban ───────────────────────────────────────────────────────
  //
  // The only ban that existed before this was chatBanned in socket/handlers.js
  // — in-memory, chat-only, gone on restart. This is a real one: it is read at
  // socket authentication (handlers.js) and in withdrawalGuards (wallet.js),
  // so a banned account cannot start a new session or move money, not just
  // post in chat.
  router.post('/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'A reason is required — it is what the player sees, and what you will see reading this back in six months.' });

    const { error } = await supabase.from('profiles')
      .update({ banned: true, ban_reason: reason, banned_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    console.log(`[admin] ${req.user.id} banned ${req.params.id}: ${reason}`);
    res.json({ success: true });
  });

  router.post('/users/:id/unban', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase.from('profiles')
      .update({ banned: false, ban_reason: null, banned_at: null })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    console.log(`[admin] ${req.user.id} unbanned ${req.params.id}`);
    res.json({ success: true });
  });

  // ── Manual balance adjustment ────────────────────────────────────────
  //
  // For refunds, compensation, and correcting a mistake — not a general
  // top-up tool. Goes through the same atomic credit/deduct RPCs every other
  // balance change in this app uses, and — this is the part that matters —
  // ALWAYS writes a transaction row. An admin-adjustable balance with no
  // record of who changed it and why is exactly the kind of gap this session
  // spent most of its time closing elsewhere; it does not get to be the
  // exception because it is convenient.
  router.post('/users/:id/adjust-balance', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const amount = Number(req.body?.amount);
    const note = String(req.body?.note || '').trim().slice(0, 300);

    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'Amount must be a non-zero number.' });
    }
    if (!note) {
      return res.status(400).json({ error: 'A note is required — this is the only record of why a balance was hand-edited.' });
    }
    if (Math.abs(amount) > 50_000) {
      return res.status(400).json({ error: 'Single adjustments are capped at 50,000 coins as a typo guard. Do it in more than one step if this is genuinely intended.' });
    }

    try {
      if (amount > 0) {
        await creditCoins(supabase, id, amount);
      } else {
        await deductCoins(supabase, id, Math.abs(amount));
      }
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Adjustment failed — the player may not have enough balance for a debit this size.' });
    }

    const { error: txErr } = await supabase.from('transactions').insert({
      user_id: id,
      type: 'admin_adjustment',
      amount_c: amount,
      status: 'confirmed',
      notes: `${note} (by ${req.user.id})`,
    });
    // The balance move already happened and cannot be silently retried — an
    // admin re-clicking on a failed insert would double it. Surface the
    // failure loudly instead of pretending the whole thing failed.
    if (txErr) console.error(`[admin] CRITICAL: balance adjusted for ${id} (${amount}) but the transaction row failed to write:`, txErr.message);

    console.log(`[admin] ${req.user.id} adjusted ${id} by ${amount}: ${note}`);
    res.json({ success: true, recorded: !txErr });
  });

  // ── KYC review queue ──────────────────────────────────────────────────
  //
  // Didit decides automatically and reports by webhook, so this is not the
  // normal path any more — it is the override. It exists for the cases Didit
  // cannot close on its own: a session stuck In Review, or a decline the player
  // disputes with support. Everything here is still a human decision.

  router.get('/kyc', requireAuth, requireAdmin, async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
      ? req.query.status : 'pending';

    const { data, error } = await supabase
      .from('kyc_submissions')
      .select('id, user_id, legal_name, date_of_birth, city, region, country, status, rejection_reason, submitted_at, reviewed_at, didit_session_id, didit_status, decision')
      .eq('status', status)
      .order('submitted_at', { ascending: true })
      .limit(200);

    if (error) return res.status(500).json({ error: error.message });

    // The usernames, so a reviewer is not looking at bare UUIDs.
    const ids = [...new Set((data || []).map(r => r.user_id))];
    let names = {};
    if (ids.length) {
      const { data: profiles } = await supabase
        .from('profiles').select('id, username, c_coins').in('id', ids);
      names = Object.fromEntries((profiles || []).map(p => [p.id, p]));
    }

    res.json((data || []).map(r => ({
      ...r,
      username: names[r.user_id]?.username ?? null,
      balance:  names[r.user_id]?.c_coins ?? null,
    })));
  });

  router.post('/kyc/:id/decide', requireAuth, requireAdmin, async (req, res) => {
    const decision = String(req.body?.decision || '');
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    }
    const reason = decision === 'rejected'
      ? String(req.body?.reason || '').trim().slice(0, 300)
      : null;
    if (decision === 'rejected' && !reason) {
      return res.status(400).json({ error: 'A rejection needs a reason — the player is shown it.' });
    }

    // Claim the row before acting on it. Scoping the update to status='pending'
    // means two admins clicking at once cannot both decide the same submission:
    // the second update matches nothing.
    const { data: claimed, error: claimErr } = await supabase
      .from('kyc_submissions')
      .update({
        status:           decision,
        rejection_reason: reason,
        reviewed_at:      new Date().toISOString(),
        reviewed_by:      req.user.id,
      })
      .eq('id', req.params.id)
      .eq('status', 'pending')
      .select('id, user_id')
      .single();

    if (claimErr || !claimed) {
      return res.status(409).json({ error: 'That submission has already been reviewed.' });
    }

    // The gate moves second. If this fails the submission is decided but the
    // player is still blocked — visible and fixable, where the other order
    // would let someone withdraw against a record that was never written.
    const { error: gateErr } = await supabase
      .from('profiles')
      .update({
        kyc_status:           decision,
        kyc_reviewed_at:      new Date().toISOString(),
        kyc_rejection_reason: reason,
      })
      .eq('id', claimed.user_id);

    if (gateErr) {
      console.error(`[admin] KYC ${decision} recorded for ${claimed.user_id} but the gate did not move:`, gateErr.message);
      return res.status(500).json({ error: 'Decision saved but the account status did not update. Retry.' });
    }

    res.json({ success: true, decision });
  });

  // ── Clear admin coins ─────────────────────────────────────────────────
  router.post('/clear-coins', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase
      .from('profiles')
      .update({ c_coins: 0 })
      .eq('id', process.env.ADMIN_USER_ID);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // ── Add 5M diamonds to admin account ─────────────────────────────────
  router.post('/add-diamonds', requireAuth, requireAdmin, async (req, res) => {
    try {
      await creditDiamonds(supabase, process.env.ADMIN_USER_ID, 5_000_000);
      const { data } = await supabase.from('profiles').select('diamonds').eq('id', process.env.ADMIN_USER_ID).single();
      res.json({ success: true, diamonds: data?.diamonds });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Set creator code on a user ────────────────────────────────────────
  // SQL required once: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_creator_code boolean DEFAULT false;
  router.post('/set-creator-code', requireAuth, requireAdmin, async (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: 'username and code are required' });

    const raw = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(raw)) return res.status(400).json({ error: 'Code must be 4-12 alphanumeric characters' });

    // Find target user
    const { data: target, error: findErr } = await supabase
      .from('profiles').select('id, username').ilike('username', username.trim()).single();
    if (findErr || !target) return res.status(404).json({ error: 'User not found' });

    // Check code not already taken by someone else
    const { data: taken } = await supabase
      .from('profiles').select('id').eq('affiliate_code', raw).single();
    if (taken && taken.id !== target.id) return res.status(400).json({ error: 'Code already in use by another user' });

    const { error: updErr } = await supabase
      .from('profiles')
      .update({ affiliate_code: raw, is_creator_code: true })
      .eq('id', target.id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    res.json({ success: true, userId: target.id, username: target.username, code: raw });
  });

  // ── Adjust admin's own ELO by delta ──────────────────────────────────
  router.post('/adjust-elo', requireAuth, requireAdmin, async (req, res) => {
    const delta = parseInt(req.body.delta, 10);
    if (!delta || isNaN(delta)) return res.status(400).json({ error: 'delta required' });

    const { data: current } = await supabase
      .from('profiles')
      .select('elo')
      .eq('id', req.user.id)
      .single();

    const newElo = Math.max(0, (current?.elo ?? 1000) + delta);

    const { error } = await supabase
      .from('profiles')
      .update({ elo: newElo })
      .eq('id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ elo: newElo, delta });
  });

  // ── Set a player's ELO by username ──────────────────────────────────
  router.post('/set-player-elo', requireAuth, requireAdmin, async (req, res) => {
    const { username, elo } = req.body;
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username required' });
    const newElo = parseInt(elo, 10);
    if (isNaN(newElo) || newElo < 0) return res.status(400).json({ error: 'elo must be a non-negative number' });

    const { data: player, error: lookupErr } = await supabase
      .from('profiles')
      .select('id, username, elo')
      .ilike('username', username.trim())
      .single();

    if (lookupErr || !player) return res.status(404).json({ error: `No player found with username "${username}"` });

    const { error } = await supabase
      .from('profiles')
      .update({ elo: newElo })
      .eq('id', player.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ username: player.username, oldElo: player.elo, newElo });
  });

  // ── Remove admin's own coin balance ──────────────────────────────────
  router.post('/remove-coins', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase
      .from('profiles')
      .update({ c_coins: 0 })
      .eq('id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  });

  // ── Collect accumulated platform fees into admin's coin balance ──────
  router.post('/collect-fees', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data: collected, error } = await supabase.rpc('collect_admin_fees', {
        admin_id: process.env.ADMIN_USER_ID,
      });
      if (error) return res.status(500).json({ error: error.message });

      const amount = parseFloat(collected ?? 0);
      if (amount > 0) {
        // Log it as a transaction for record-keeping
        await supabase.from('transactions').insert({
          user_id:  process.env.ADMIN_USER_ID,
          type:     'fee_collection',
          amount_c: amount,
          status:   'confirmed',
        }).then().catch(() => {});
      }

      // Return fresh balances
      const { data: profile } = await supabase
        .from('profiles')
        .select('c_coins, fee_balance')
        .eq('id', process.env.ADMIN_USER_ID)
        .single();

      res.json({
        success:     true,
        collected:   parseFloat(amount.toFixed(4)),
        c_coins:     parseFloat((profile?.c_coins ?? 0).toFixed(4)),
        fee_balance: parseFloat((profile?.fee_balance ?? 0).toFixed(4)),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Remove creator code from a user ──────────────────────────────────
  router.post('/remove-creator-code', requireAuth, requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const { data: target } = await supabase
      .from('profiles').select('id').ilike('username', username.trim()).single();
    if (!target) return res.status(404).json({ error: 'User not found' });

    const { error } = await supabase
      .from('profiles')
      .update({ is_creator_code: false })
      .eq('id', target.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // ── Total coins in circulation ────────────────────────────────────────
  //
  // Was summing c_coins across every row in profiles — demo accounts and the
  // admin account included. Both distort the number away from what it claims
  // to show: demo accounts play for free and their balance is not real money
  // owed to anyone, and the admin balance is collected rake, not a player
  // holding. sum_c_coins (the RPC) has the same problem at the database
  // level with no way to pass it an exclusion list, so this reads the rows
  // directly instead and filters them the same way the rest of this file
  // already excludes both — filterDemos, and .neq(admin id), matching the
  // Users list a few routes up.
  router.get('/coin-supply', requireAuth, requireAdmin, async (req, res) => {
    try {
      let query = supabase.from('profiles').select('c_coins').neq('id', process.env.ADMIN_USER_ID);
      query = filterDemos(query);
      const { data: rows, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      const total = (rows || []).reduce((sum, r) => sum + (parseFloat(r.c_coins) || 0), 0);
      res.json({ total: Math.round(total * 100) / 100, playerCount: (rows || []).length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

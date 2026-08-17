const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { creditDiamonds, creditCoins, deductCoins } = require('../services/walletService');

module.exports = function adminRoutes(supabase, io) {
  const router = Router();

  function requireAdmin(req, res, next) {
    if (req.user.id !== process.env.ADMIN_USER_ID)
      return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  // ── Stats overview ────────────────────────────────────────────────────
  router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

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
    ] = await Promise.all([
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
    ]);

    // Referral rewards earned but not yet collected. These are held back from
    // fee collection (see collect_admin_fees), so the number is shown alongside
    // fee_balance rather than left to look like a shortfall. Separate query so
    // a missing referral_rewards table before the migration degrades to 0
    // rather than breaking the whole admin dashboard.
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
    });
  });

  // ── Recent transactions ───────────────────────────────────────────────
  // Statuses that mean money is stuck and a human has to look.
  //
  // Ordered by how bad they are, which is also the order they should be worked:
  //   refund_failed     coins taken, payout failed, refund failed — money owed
  //   payout_uncertain  broadcast, but the chain could not be read. NOT refunded
  //                     on purpose: the player may already hold the crypto, so
  //                     look up the tx_hash before crediting anything back
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
  const ATTENTION_STATUSES = ['refund_failed', 'payout_uncertain', 'pending', 'payout_failed', 'stuck', 'pending_retry', 'converting'];
  const ATTENTION_RANK = Object.fromEntries(ATTENTION_STATUSES.map((s, i) => [s, i]));
  // 'converting' is transient by design, so only count it once it has clearly
  // outlived a normal swap. Without this the queue is permanently full of
  // deposits that are simply in progress, and a real problem hides among them.
  const CONVERTING_STALE_MS = 60 * 60 * 1000;

  router.get('/transactions', requireAuth, requireAdmin, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    let q = supabase
      .from('transactions')
      .select('*, profiles(username, profile_color)')
      .order('created_at', { ascending: false });

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
      .select('*, profiles(username, profile_color)')
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

    let query = supabase
      .from('profiles')
      .select('id, username, elo, wins, losses, c_coins, diamonds, created_at, profile_color')
      .neq('id', process.env.ADMIN_USER_ID)
      .order('c_coins', { ascending: false })
      .limit(limit);

    if (search) query = query.ilike('username', `%${search}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
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
  router.get('/coin-supply', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .rpc('sum_c_coins');
      if (error) {
        // fallback if RPC doesn't exist
        const { data: rows } = await supabase.from('profiles').select('c_coins');
        const total = (rows || []).reduce((sum, r) => sum + (parseFloat(r.c_coins) || 0), 0);
        return res.json({ total: Math.round(total * 100) / 100 });
      }
      res.json({ total: Math.round((data || 0) * 100) / 100 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

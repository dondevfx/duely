const { Router } = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { isDemo, DEMO_IDS } = require('../services/demoAccounts');
const gameEvents = require('../services/gameEvents');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = function authRoutes(supabase) {
  const router = Router();

  // Fire-and-forget: the request is already saved, so a failure to look up the
  // sender's name must never turn a successful add into an error response.
  async function _notifyFriendRequest(db, fromId, toUserId) {
    try {
      // The picture and the id come along so the toast can show a face and
      // accept or decline in place — it used to carry only a name, which is
      // why it could do nothing but point at the friends list.
      const { data } = await db.from('profiles')
        .select('username, avatar_url, profile_color').eq('id', fromId).single();
      gameEvents.emit('friend_request', {
        toUserId,
        fromUserId:   fromId,
        fromUsername: data?.username || 'Someone',
        fromAvatar:   data?.avatar_url ?? null,
        fromColor:    data?.profile_color ?? null,
      });
    } catch { /* the row is written either way */ }
  }

  // A pending inbox has a ceiling.
  //
  // Without one, a player can be buried: 500 pending rows means the friends
  // panel is unusable and every one of them has to be dealt with by hand. The
  // cap is on the RECIPIENT's pending inbox, not on how many the sender has
  // out, because it is the recipient who suffers.
  //
  // A request over the cap is refused and NOT written — "deleted" and "never
  // inserted" look the same to everyone involved, and not inserting cannot
  // leave a half-row behind if the delete fails.
  const MAX_PENDING_REQUESTS = 30;
  async function _inboxFull(db, toUserId) {
    const { count, error } = await db
      .from('friends')
      .select('id', { count: 'exact', head: true })
      .eq('addressee_id', toUserId)
      .eq('status', 'pending');
    // A failed count must not block a legitimate request — fail open, since
    // the worst case is one request over the line.
    if (error) return false;
    return (count ?? 0) >= MAX_PENDING_REQUESTS;
  }

  // Upsert profile on first login
  router.post('/profile', requireAuth, async (req, res) => {
    const { username, wallet_address } = req.body;
    const userId = req.user.id;

    if (!username || typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 20) {
      return res.status(400).json({ error: 'Username must be 3–20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      return res.status(400).json({ error: 'Username may only contain letters, numbers, and underscores' });
    }

    // Check if profile already exists (username conflict returns cleaner error)
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    let data, error;
    if (existing) {
      ({ data, error } = await supabase
        .from('profiles')
        .update({ username: username.trim(), wallet_address: wallet_address || null })
        .eq('id', userId)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('profiles')
        .insert({ id: userId, username: username.trim(), wallet_address: wallet_address || null, profile_color: '#1250B4' })
        .select()
        .single());
    }

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already taken' });
      return res.status(400).json({ error: error.message });
    }
    res.json(data);
  });

  // Get current user profile
  router.get('/me', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) return res.status(404).json({ error: 'Profile not found' });
    // is_demo travels with the profile so the client can show the demo-only
    // affordances (see Profile.jsx). The list itself is an env var and stays
    // server-side; only the answer for THIS account is sent.
    res.json({
      ...data,
      is_admin: req.user.id === process.env.ADMIN_USER_ID,
      is_demo: isDemo(req.user.id),
    });
  });

  const VALID_COLORS = new Set([
    '#1250B4','#00BFFF','#22c55e','#ef4444','#f97316',
    '#a855f7','#ec4899','#eab308','#06b6d4','#14b8a6','#f43f5e','#e2e8f0',
  ]);

  // Update username, wallet address, profile color, or privacy setting
  router.patch('/me', requireAuth, async (req, res) => {
    const { username, wallet_address, profile_color, is_private, invites_enabled } = req.body;
    const updates = {};
    if (invites_enabled !== undefined) updates.invites_enabled = !!invites_enabled;
    if (username) {
      const u = username.trim();
      if (u.length < 3 || u.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
      if (!/^[a-zA-Z0-9_]+$/.test(u)) return res.status(400).json({ error: 'Username may only contain letters, numbers, and underscores' });
      updates.username = u;
    }
    if (wallet_address !== undefined) updates.wallet_address = wallet_address;
    if (profile_color !== undefined) {
      if (!VALID_COLORS.has(profile_color)) return res.status(400).json({ error: 'Invalid color' });
      updates.profile_color = profile_color;
    }
    if (is_private !== undefined) updates.is_private = !!is_private;

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already taken' });
      return res.status(400).json({ error: error.message });
    }
    res.json(data);
  });

  // Public profile (for chat popup) — returns rank + total_wagered
  // Readable without a session.
  //
  // The leaderboard is public, and tapping a row there opens this. Behind
  // requireAuth every one of those taps answered "Player not found" for a
  // logged-out visitor — which is most people arriving from a shared link.
  // Nothing here is private: it is the same username, rank and record the
  // leaderboard row they just tapped is already showing them.
  router.get('/public/:userId', optionalAuth, async (req, res) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, elo, wins, losses, created_at, profile_color, avatar_url')
      .eq('id', userId)
      .single();

    if (!profile) return res.status(404).json({ error: 'User not found' });

    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';

    const [{ count: eloAbove }, { data: wagered }, { data: diaTxs }] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true })
        .neq('id', adminId).neq('is_private', true).gt('elo', profile.elo ?? 0),
      supabase.from('matches').select('entry_fee_c').or(`player1_id.eq.${userId},player2_id.eq.${userId}`),
      supabase.from('transactions')
        .select('amount_c, crypto_amount, type, crypto_symbol')
        .eq('user_id', userId)
        .in('type', ['match_loss', 'match_win']),
    ]);

    const rank = (eloAbove ?? 0) + 1;

    const totalWagered = parseFloat(
      ((wagered || []).reduce((s, m) => s + (Number(m.entry_fee_c) || 0), 0)).toFixed(4)
    );

    // Diamond wagered: losses = entry fee directly; wins = payout / 1.9 (reverse 95% of 2x)
    let totalWageredDiamonds = 0;
    for (const tx of (diaTxs || [])) {
      if (tx.crypto_symbol !== 'diamonds') continue;
      const amt = Number(tx.crypto_amount) || 0;
      if (tx.type === 'match_loss') totalWageredDiamonds += amt;
      else if (tx.type === 'match_win') totalWageredDiamonds += Math.round(amt / 1.9);
    }

    res.json({ ...profile, rank, total_wagered: totalWagered, total_wagered_diamonds: totalWageredDiamonds });
  });

  // Per-game stats for profile highscores section
  router.get('/game-stats', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('matches')
      .select('game_type, winner_id')
      .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
      .not('game_type', 'is', null);

    if (error) return res.status(500).json({ error: error.message });

    const stats = {};
    for (const m of (data || [])) {
      const gt = m.game_type;
      if (!stats[gt]) stats[gt] = { gameType: gt, played: 0, wins: 0 };
      stats[gt].played++;
      if (m.winner_id === userId) stats[gt].wins++;
    }

    res.json(Object.values(stats));
  });

  // Coin profit and loss over a window, reconstructed from transactions.
  // ?days=7|30|90 (default 90). Route name kept for the existing client.
  router.get('/coin-history/:userId', requireAuth, async (req, res) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
    const DAYS = Math.min(90, Math.max(1, parseInt(req.query.days) || 90));
    const startDate = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    // Respect the private-profile flag: another user's balance history is only
    // visible if it's your own or they haven't marked their profile private.
    if (userId !== req.user.id) {
      const { data: target } = await supabase.from('profiles').select('is_private').eq('id', userId).single();
      if (target?.is_private) return res.status(403).json({ error: 'This profile is private' });
    }

    // stake_c is selected if it exists and skipped if it does not, so this keeps
    // working before the migration is run — it just falls back to inferring the
    // stake. A profile page 500ing because a column is missing would be a far
    // worse outcome than an approximate curve.
    const readTxs = async (withStake) => supabase
      .from('transactions')
      .select(withStake ? 'amount_c, stake_c, type, created_at' : 'amount_c, type, created_at')
      .eq('user_id', userId)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: true });

    let [{ data: prof }, txRes] = await Promise.all([
      supabase.from('profiles').select('c_coins').eq('id', userId).single(),
      readTxs(true),
    ]);
    if (txRes.error && /stake_c/i.test(txRes.error.message || '')) txRes = await readTxs(false);
    const txs = txRes.data;

    if (!prof) return res.status(404).json({ error: 'Not found' });

    // This is a PROFIT AND LOSS curve, not a balance curve, and it had been
    // computing neither.
    //
    // Two things made every account look up. A deposit was counted as a gain,
    // so anyone who had ever funded their account started deep in profit — that
    // alone put nearly everyone in the green. And a win was added at its GROSS
    // payout, which hands back the player's own stake: a break-even player
    // banked +1.9x per win against -1x per loss and drifted upward forever.
    //
    // Only gameplay counts now. Deposits, withdrawals and tips move money in and
    // out of the account without saying anything about how the player is doing,
    // and bonuses are gifts rather than performance.
    const CREDIT = new Set(['match_win', 'match_draw']);
    const DEBIT  = new Set(['match_loss']);

    // Payouts before this shipped carry no stake, so it is inferred from the
    // payout: payout = stake * 2 * (1 - rake), giving stake = payout / 1.9 at the
    // usual 5%. Coin Flip rakes 2%, where the true stake is payout / 1.96, so an
    // old coin-flip win is understated by about 3% of the stake. Deliberately the
    // conservative direction — a P&L that flatters nobody is the point here.
    const LEGACY_PAYOUT_MULT = 1.9;

    let running = 0;
    const points = [{ date: startDate.toISOString(), balance: 0 }];
    for (const tx of (txs || [])) {
      const amt = parseFloat(tx.amount_c) || 0;
      if (amt === 0) continue; // diamond-only entries don't move the coin balance

      let signed = null;
      if (CREDIT.has(tx.type)) {
        const stake = tx.stake_c != null
          ? parseFloat(tx.stake_c) || 0
          : amt / LEGACY_PAYOUT_MULT;
        signed = amt - stake;              // winnings only, stake excluded
      } else if (DEBIT.has(tx.type)) {
        signed = -amt;                     // the stake, lost
      }
      if (signed === null) continue;       // transfers and gifts are not P&L

      running += signed;
      points.push({ date: tx.created_at, balance: parseFloat(running.toFixed(2)) });
    }

    // Cap payload size for very active accounts — keep the starting point
    // plus the most recent MAX_POINTS transactions.
    const MAX_POINTS = 800;
    const trimmed = points.length > MAX_POINTS
      ? [points[0], ...points.slice(points.length - (MAX_POINTS - 1))]
      : points;

    res.json(trimmed);
  });

  // Personal best highscores for profile page
  router.get('/highscores', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { data } = await supabase
      .from('game_highscores')
      .select('game_type, score, updated_at')
      .eq('user_id', userId)
      .order('score', { ascending: false });
    res.json(data || []);
  });

  // ── Friends ─────────────────────────────────────────────────────────

  router.get('/friends', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { data, error } = await supabase
      .from('friends')
      .select(`
        id, status, created_at,
        requester:requester_id(id, username, elo, profile_color, current_streak),
        addressee:addressee_id(id, username, elo, profile_color, current_streak)
      `)
      .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  const ADMIN_ID = process.env.ADMIN_USER_ID;

  // Send by username (from profile friends panel)
  router.post('/friend-request', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const { data: target } = await supabase.from('profiles').select('id').eq('username', username.trim()).maybeSingle();
    // Demo accounts stay invisible to real players, but they can friend EACH
    // OTHER — otherwise two people testing on demo accounts cannot connect at
    // all. The gate is therefore "is the target a demo AND am I not one",
    // rather than a blanket block on demo targets.
    if (!target || target.id === ADMIN_ID || (isDemo(target.id) && !isDemo(myId))) return res.status(404).json({ error: 'User not found' });
    if (target.id === myId) return res.status(400).json({ error: 'Cannot friend yourself' });
    const { data: existing } = await supabase.from('friends').select('id,status')
      .or(`and(requester_id.eq.${myId},addressee_id.eq.${target.id}),and(requester_id.eq.${target.id},addressee_id.eq.${myId})`)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already sent' });
    if (await _inboxFull(supabase, target.id)) {
      return res.status(429).json({ error: "That player's friend requests are full." });
    }
    const { error } = await supabase.from('friends').insert({ requester_id: myId, addressee_id: target.id });
    if (error) return res.status(400).json({ error: 'User not found' });
    _notifyFriendRequest(supabase, myId, target.id);
    res.json({ ok: true });
  });

  // Send by userId (from chat popup)
  router.post('/friend-request-by-id', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { userId } = req.body;
    if (!userId || !UUID_RE.test(userId)) return res.status(400).json({ error: 'userId required' });
    if (userId === myId) return res.status(400).json({ error: 'Cannot friend yourself' });
    // Demo accounts stay invisible to real players, but they can friend EACH
    // OTHER — otherwise two people testing on demo accounts cannot connect at
    // all. The gate is therefore "is the target a demo AND am I not one",
    // rather than a blanket block on demo targets.
    if (userId === ADMIN_ID || (isDemo(userId) && !isDemo(myId))) return res.status(404).json({ error: 'User not found' });
    const { data: existing } = await supabase.from('friends').select('id,status')
      .or(`and(requester_id.eq.${myId},addressee_id.eq.${userId}),and(requester_id.eq.${userId},addressee_id.eq.${myId})`)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already sent' });
    if (await _inboxFull(supabase, userId)) {
      return res.status(429).json({ error: "That player's friend requests are full." });
    }
    const { error } = await supabase.from('friends').insert({ requester_id: myId, addressee_id: userId });
    if (error) return res.status(400).json({ error: 'User not found' });
    _notifyFriendRequest(supabase, myId, userId);
    res.json({ ok: true });
  });

  // ── Friend invite links ─────────────────────────────────────────────
  //
  // A player shares https://<site>/add-friend/<username>. Whoever opens it and
  // is signed in becomes their friend immediately — no pending request, because
  // both sides have already consented: one published the link, the other chose
  // to open it. That is what makes a link invite different from a cold request.
  //
  // Keyed by username rather than a generated code so no migration is needed and
  // the link is readable. The trade-off is that a link breaks if the user
  // renames, which is self-explanatory to whoever opens it.

  // Public: who is behind this link? Lets a logged-out visitor see who invited
  // them before they sign up. Returns only what a profile page already shows.
  router.get('/friend-invite/:username', optionalAuth, async (req, res) => {
    const { data: p } = await supabase.from('profiles')
      .select('id, username, elo, profile_color, current_streak')
      .eq('username', String(req.params.username || '').trim())
      .maybeSingle();
    // Same rule the POST below uses: a demo is hidden from everyone EXCEPT
    // another demo. This route is public, so it read as a blanket block and the
    // two demo accounts could never use each other's invite links — the POST
    // would have accepted the request, but the preview 404'd before anyone got
    // that far. optionalAuth exists so this can tell the two callers apart
    // without closing the route to logged-out visitors.
    if (!p || p.id === ADMIN_ID || (isDemo(p.id) && !isDemo(req.user?.id))) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const { id, ...safe } = p;   // don't hand out the user id to anonymous callers
    res.json(safe);
  });

  router.post('/friend-invite/:username', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const username = String(req.params.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Invalid invite link' });

    const { data: inviter } = await supabase.from('profiles')
      .select('id, username').eq('username', username).maybeSingle();
    if (!inviter || inviter.id === ADMIN_ID || (isDemo(inviter.id) && !isDemo(myId))) {
      return res.status(404).json({ error: 'That invite link is no longer valid.' });
    }
    if (inviter.id === myId) {
      return res.status(400).json({ error: 'That is your own invite link — share it with someone else!' });
    }

    const { data: existing } = await supabase.from('friends').select('id,status')
      .or(`and(requester_id.eq.${myId},addressee_id.eq.${inviter.id}),and(requester_id.eq.${inviter.id},addressee_id.eq.${myId})`)
      .maybeSingle();

    if (existing?.status === 'accepted') {
      return res.json({ ok: true, alreadyFriends: true, username: inviter.username });
    }
    if (existing) {
      // A request was already open in one direction or the other. Opening the
      // link accepts it either way — nobody is left waiting on a second click.
      const { error } = await supabase.from('friends')
        .update({ status: 'accepted' }).eq('id', existing.id);
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, username: inviter.username });
    }

    const { error } = await supabase.from('friends')
      .insert({ requester_id: inviter.id, addressee_id: myId, status: 'accepted' });
    if (error) {
      // Two tabs opening the same link at once: the other one won, which is the
      // outcome we wanted anyway.
      const { data: now } = await supabase.from('friends').select('id')
        .or(`and(requester_id.eq.${myId},addressee_id.eq.${inviter.id}),and(requester_id.eq.${inviter.id},addressee_id.eq.${myId})`)
        .maybeSingle();
      if (now) return res.json({ ok: true, username: inviter.username });
      return res.status(400).json({ error: 'Could not add friend' });
    }
    res.json({ ok: true, username: inviter.username });
  });

  router.post('/friend-accept/:id', requireAuth, async (req, res) => {
    const { error } = await supabase.from('friends')
      .update({ status: 'accepted' })
      .eq('id', req.params.id)
      .eq('addressee_id', req.user.id)
      .eq('status', 'pending');
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  });

  // Accept or decline straight from the notification, which knows WHO asked
  // but not which row that is. Both scope the update to a pending row where I
  // am the addressee, so neither can touch a friendship I am not part of or
  // re-accept one that was already answered.
  router.post('/friend-accept-by-user', requireAuth, async (req, res) => {
    const { userId } = req.body;
    if (!userId || !UUID_RE.test(userId)) return res.status(400).json({ error: 'userId required' });
    const { data, error } = await supabase.from('friends')
      .update({ status: 'accepted' })
      .eq('requester_id', userId)
      .eq('addressee_id', req.user.id)
      .eq('status', 'pending')
      .select('id');
    if (error) return res.status(400).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'No pending request from that player.' });
    res.json({ ok: true });
  });

  router.post('/friend-decline-by-user', requireAuth, async (req, res) => {
    const { userId } = req.body;
    if (!userId || !UUID_RE.test(userId)) return res.status(400).json({ error: 'userId required' });
    const { error } = await supabase.from('friends').delete()
      .eq('requester_id', userId)
      .eq('addressee_id', req.user.id)
      .eq('status', 'pending');
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  });

  router.delete('/friend/:id', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { error } = await supabase.from('friends').delete()
      .eq('id', req.params.id)
      .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  });

  return router;
};

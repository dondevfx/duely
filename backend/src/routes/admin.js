const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { creditDiamonds } = require('../services/walletService');

module.exports = function adminRoutes(supabase) {
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

    const [
      { count: totalUsers },
      { count: totalMatches },
      { count: matchesToday },
      { count: newUsersToday },
      { data: adminProfile },
      { data: matchData },
      { count: pendingWithdrawals },
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }).gte('played_at', todayStart.toISOString()),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
      supabase.from('profiles').select('c_coins, diamonds, fee_balance').eq('id', process.env.ADMIN_USER_ID).single(),
      supabase.from('matches').select('entry_fee_c, prize_pool_c'),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('type', 'withdrawal').eq('status', 'pending'),
    ]);

    const totalWagered = (matchData || []).reduce((s, m) => s + (Number(m.entry_fee_c) || 0), 0);

    res.json({
      total_users:        totalUsers   ?? 0,
      total_matches:      totalMatches ?? 0,
      matches_today:      matchesToday ?? 0,
      new_users_today:    newUsersToday ?? 0,
      fees_coins:         parseFloat((adminProfile?.c_coins ?? 0).toFixed(2)),
      fees_diamonds:      adminProfile?.diamonds ?? 0,
      fee_balance:        parseFloat((adminProfile?.fee_balance ?? 0).toFixed(4)),
      total_wagered:      parseFloat(totalWagered.toFixed(2)),
      pending_withdrawals: pendingWithdrawals ?? 0,
    });
  });

  // ── Recent transactions ───────────────────────────────────────────────
  router.get('/transactions', requireAuth, requireAdmin, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('transactions')
      .select('*, profiles(username, profile_color)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
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
        }).catch(() => {});
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

  // ── Wallet balances (on-chain) ────────────────────────────────────────
  router.get('/wallet-balances', requireAuth, requireAdmin, async (req, res) => {
    const fetch   = require('node-fetch');
    const solWeb3 = require('@solana/web3.js');
    const splToken = require('@solana/spl-token');
    const { getAddress } = require('../services/addressService');

    const ADMIN_ID  = process.env.ADMIN_USER_ID;
    const RPC       = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const ETHERSCAN = process.env.ETHERSCAN_API_KEY || '';
    const PHANTOM   = process.env.USDC_SPL_ADDRESS;
    const USDC_MINT = new solWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    const results = [];

    try {
      // SOL balance of admin derived wallet
      const { address: solAddr } = getAddress(ADMIN_ID, 'sol');
      const connection = new solWeb3.Connection(RPC, 'confirmed');
      const solLamports = await connection.getBalance(new solWeb3.PublicKey(solAddr));
      results.push({ coin: 'SOL', label: 'SOL (deposit wallet)', address: solAddr, balance: solLamports / 1e9, unit: 'SOL' });

      // USDC balance of admin Phantom wallet
      if (PHANTOM) {
        try {
          const phantomPubkey = new solWeb3.PublicKey(PHANTOM);
          const usdcAta = splToken.getAssociatedTokenAddressSync(USDC_MINT, phantomPubkey);
          const usdcInfo = await connection.getTokenAccountBalance(usdcAta);
          results.push({ coin: 'USDC', label: 'USDC (Phantom wallet)', address: PHANTOM, balance: parseFloat(usdcInfo.value.uiAmount || 0), unit: 'USDC' });
        } catch { results.push({ coin: 'USDC', label: 'USDC (Phantom wallet)', address: PHANTOM, balance: 0, unit: 'USDC', error: 'no token account' }); }
      }

      // ETH balance
      try {
        const { address: ethAddr } = getAddress(ADMIN_ID, 'eth');
        const ethRes = await fetch(`https://api.etherscan.io/api?module=account&action=balance&address=${ethAddr}&apikey=${ETHERSCAN}`);
        const ethData = await ethRes.json();
        results.push({ coin: 'ETH', label: 'ETH (deposit wallet)', address: ethAddr, balance: parseFloat(ethData.result || 0) / 1e18, unit: 'ETH' });
      } catch {}

      // BNB balance
      try {
        const { address: bnbAddr } = getAddress(ADMIN_ID, 'bnb');
        const bnbRes = await fetch(`https://api.bscscan.com/api?module=account&action=balance&address=${bnbAddr}&apikey=${ETHERSCAN}`);
        const bnbData = await bnbRes.json();
        results.push({ coin: 'BNB', label: 'BNB (deposit wallet)', address: bnbAddr, balance: parseFloat(bnbData.result || 0) / 1e18, unit: 'BNB' });
      } catch {}

      // BTC balance
      try {
        const { address: btcAddr } = getAddress(ADMIN_ID, 'btc');
        const btcRes = await fetch(`https://blockstream.info/api/address/${btcAddr}`);
        const btcData = await btcRes.json();
        const btcSats = (btcData.chain_stats?.funded_txo_sum || 0) - (btcData.chain_stats?.spent_txo_sum || 0);
        results.push({ coin: 'BTC', label: 'BTC (deposit wallet)', address: btcAddr, balance: btcSats / 1e8, unit: 'BTC' });
      } catch {}

      // LTC balance
      try {
        const { address: ltcAddr } = getAddress(ADMIN_ID, 'ltc');
        const ltcRes = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${ltcAddr}/balance`);
        const ltcData = await ltcRes.json();
        results.push({ coin: 'LTC', label: 'LTC (deposit wallet)', address: ltcAddr, balance: (ltcData.balance || 0) / 1e8, unit: 'LTC' });
      } catch {}

      // DOGE balance
      try {
        const { address: dogeAddr } = getAddress(ADMIN_ID, 'doge');
        const dogeRes = await fetch(`https://api.blockcypher.com/v1/doge/main/addrs/${dogeAddr}/balance`);
        const dogeData = await dogeRes.json();
        results.push({ coin: 'DOGE', label: 'DOGE (deposit wallet)', address: dogeAddr, balance: (dogeData.balance || 0) / 1e8, unit: 'DOGE' });
      } catch {}

      // TRX balance
      try {
        const { address: trxAddr } = getAddress(ADMIN_ID, 'trx');
        const trxRes = await fetch(`https://api.trongrid.io/v1/accounts/${trxAddr}`);
        const trxData = await trxRes.json();
        const trxBal = trxData.data?.[0]?.balance || 0;
        results.push({ coin: 'TRX', label: 'TRX (deposit wallet)', address: trxAddr, balance: trxBal / 1e6, unit: 'TRX' });
      } catch {}

      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

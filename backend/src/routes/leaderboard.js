const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { DEMO_IDS } = require('../services/demoAccounts');

// Remove demo accounts from any array of profile objects
const stripDemos = (arr) => (arr || []).filter(p => !DEMO_IDS.includes(p.id));
// Remove demo IDs from a plain ID→value map
const stripDemoKeys = (map) => { for (const id of DEMO_IDS) delete map[id]; return map; };

// avatar_url arrives with PENDING_SQL section 18, and PostgREST rejects an
// entire query for one unknown column. A leaderboard that 500s because
// pictures are not migrated yet is worse than one without pictures, so every
// select here retries once without it.
//
// Written as a helper rather than repeated per route: this is the fourth
// place in the codebase to need this pattern, and the times it was written
// out by hand are the times it got forgotten (the socket handler, and the
// admin panel's phantom email_confirmed_at).
async function selectWithOptional(build, cols, optional) {
  let r = await build(`${cols}, ${optional}`);
  if (r.error && new RegExp(optional.split(',')[0].trim()).test(r.error.message || '')) {
    console.warn(`[leaderboard] ${optional} missing — run PENDING_SQL section 18.`);
    r = await build(cols);
  }
  return r;
}

module.exports = function leaderboardRoutes(supabase) {
  const router = Router();

  // Streak leaderboard — top 100 by current_streak
  router.get('/streak', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const { data, error } = await selectWithOptional(
      (cols) => supabase
        .from('profiles')
        .select(cols)
        .order('current_streak', { ascending: false })
        .limit(100)
        .neq('id', adminId)
        .neq('is_private', true),
      'id, username, elo, current_streak, best_streak, profile_color, wins, losses',
      'avatar_url');
    if (error) return res.status(500).json({ error: error.message });
    const players = stripDemos(data).map((p, i) => ({ rank: i + 1, ...p }));
    let userRank = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const inList = players.find(p => p.id === uid);
      userRank = inList ? inList.rank : null;
    }
    res.json({ players, userRank });
  });

  // ELO leaderboard — top 500 + optional user rank
  router.get('/', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const { data, error } = await selectWithOptional(
      (cols) => supabase
        .from('profiles')
        .select(cols)
        .order('elo', { ascending: false })
        .limit(500)
        .neq('id', adminId)
        .neq('is_private', true),
      'id, username, elo, wins, losses, streak, current_streak, best_streak, profile_color',
      'avatar_url');
    if (error) return res.status(500).json({ error: error.message });

    const players = stripDemos(data).map((p, i) => ({ rank: i + 1, ...p }));

    let userRank = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const inList = players.find(p => p.id === uid);
      if (inList) {
        userRank = inList.rank;
      } else {
        const { data: myProfile } = await supabase.from('profiles').select('elo').eq('id', uid).single();
        const userElo = myProfile?.elo ?? 0;
        const { count } = await supabase
          .from('profiles').select('id', { count: 'exact', head: true })
          .gt('elo', userElo).neq('id', adminId).neq('is_private', true);
        userRank = (count ?? 0) + 1;
      }
    }

    res.json({ players, userRank });
  });

  // Diamond balance leaderboard — top 500 by current diamond balance
  router.get('/diamonds', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const { data, error } = await selectWithOptional(
      (cols) => supabase
        .from('profiles')
        .select(cols)
        .order('diamonds', { ascending: false })
        .limit(500)
        .neq('id', adminId)
        .neq('is_private', true),
      'id, username, diamonds, wins, losses, profile_color',
      'avatar_url');
    if (error) return res.status(500).json({ error: error.message });

    const players = stripDemos(data).map((p, i) => ({ rank: i + 1, ...p }));

    let userRank = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const inList = players.find(p => p.id === uid);
      if (inList) {
        userRank = inList.rank;
      } else {
        const { data: myProfile } = await supabase.from('profiles').select('diamonds').eq('id', uid).single();
        const userDiamonds = myProfile?.diamonds ?? 0;
        const { count } = await supabase
          .from('profiles').select('id', { count: 'exact', head: true })
          .gt('diamonds', userDiamonds).neq('id', adminId).neq('is_private', true);
        userRank = (count ?? 0) + 1;
      }
    }

    res.json({ players, userRank });
  });

  // Weekly win leaderboard — top 100 by wins in the last 7 days
  router.get('/weekly', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: matchData, error } = await supabase
      .from('matches')
      .select('winner_id')
      .not('winner_id', 'is', null)
      .gte('played_at', sevenDaysAgo);

    if (error) return res.status(500).json({ error: error.message });

    // Aggregate wins per player
    const winsMap = {};
    for (const m of (matchData || [])) {
      if (!m.winner_id || m.winner_id === adminId) continue;
      winsMap[m.winner_id] = (winsMap[m.winner_id] || 0) + 1;
    }
    stripDemoKeys(winsMap);

    const sorted = Object.entries(winsMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);

    const ids = sorted.map(([id]) => id);
    const { data: profileData } = ids.length
      ? await selectWithOptional(
          (cols) => supabase.from('profiles').select(cols).in('id', ids).neq('is_private', true),
          'id, username, elo, profile_color',
          'avatar_url')
      : { data: [] };

    const profileMap = Object.fromEntries(stripDemos(profileData || []).map(p => [p.id, p]));

    const players = sorted
      .filter(([id]) => profileMap[id])
      .map(([id, weekly_wins], i) => ({
        rank: i + 1,
        id,
        username: profileMap[id]?.username ?? 'Unknown',
        elo: profileMap[id]?.elo ?? 0,
        profile_color: profileMap[id]?.profile_color ?? null,
        avatar_url: profileMap[id]?.avatar_url ?? null,
        weekly_wins,
      }));

    res.json({ players });
  });

  // Coin balance leaderboard — top 500 by current coin balance
  router.get('/coins', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const { data, error } = await selectWithOptional(
      (cols) => supabase
        .from('profiles')
        .select(cols)
        .order('c_coins', { ascending: false })
        .limit(500)
        .neq('id', adminId)
        .neq('is_private', true),
      'id, username, c_coins, wins, losses, profile_color',
      'avatar_url');
    if (error) return res.status(500).json({ error: error.message });

    const players = stripDemos(data).map((p, i) => ({ rank: i + 1, ...p }));

    let userRank = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const inList = players.find(p => p.id === uid);
      if (inList) {
        userRank = inList.rank;
      } else {
        const { data: myProfile } = await supabase.from('profiles').select('c_coins').eq('id', uid).single();
        const userCoins = myProfile?.c_coins ?? 0;
        const { count } = await supabase
          .from('profiles').select('id', { count: 'exact', head: true })
          .gt('c_coins', userCoins).neq('id', adminId).neq('is_private', true);
        userRank = (count ?? 0) + 1;
      }
    }

    res.json({ players, userRank });
  });

  // Returns the start of the current week (Monday 00:00:00 UTC)
  function weekStart() {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
    const diff = (day === 0 ? 6 : day - 1); // days since Monday
    const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
    return mon.toISOString();
  }

  // Total wagered leaderboard — current week only (resets every Monday)
  router.get('/wagered', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const { data: matchData, error } = await supabase
      .from('matches')
      .select('player1_id, player2_id, entry_fee_c')
      .not('entry_fee_c', 'is', null)
      .gt('entry_fee_c', 0)
      .gte('played_at', weekStart());
    if (error) return res.status(500).json({ error: error.message });

    const wageredMap = {};
    for (const m of matchData || []) {
      const fee = Number(m.entry_fee_c) || 0;
      if (fee <= 0) continue;
      if (m.player1_id) wageredMap[m.player1_id] = (wageredMap[m.player1_id] || 0) + fee;
      if (m.player2_id) wageredMap[m.player2_id] = (wageredMap[m.player2_id] || 0) + fee;
    }

    const sorted = Object.entries(wageredMap)
      .filter(([id]) => id !== adminId && !DEMO_IDS.includes(id))
      .sort((a, b) => b[1] - a[1]).slice(0, 500);
    const ids = sorted.map(([id]) => id);
    const { data: profileData } = ids.length
      ? await selectWithOptional(
          (cols) => supabase.from('profiles').select(cols).in('id', ids).not('is_private', 'is', true),
          'id, username, wins, losses, profile_color',
          'avatar_url')
      : { data: [] };
    const profileMap = Object.fromEntries((profileData || []).map(p => [p.id, p]));

    const players = sorted
      .filter(([id]) => profileMap[id])
      .map(([id, wagered], i) => ({
        rank: i + 1, id,
        username: profileMap[id]?.username ?? 'Unknown',
        total_wagered: parseFloat(wagered.toFixed(4)),
        wins: profileMap[id]?.wins ?? 0,
        losses: profileMap[id]?.losses ?? 0,
        profile_color: profileMap[id]?.profile_color ?? null,
        avatar_url: profileMap[id]?.avatar_url ?? null,
      }));

    let userRank = null;
    let userWagered = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const entry = players.find(p => p.id === uid);
      if (entry) {
        userRank = entry.rank;
        userWagered = entry.total_wagered;
      } else {
        const myWagered = wageredMap[uid] ?? 0;
        userWagered = parseFloat(myWagered.toFixed(4));
        if (myWagered > 0) userRank = Object.values(wageredMap).filter(w => w > myWagered).length + 1;
      }
    }

    res.json({ players, userRank, userWagered });
  });

  // Total wagered diamonds leaderboard — current week only (resets every Monday)
  router.get('/wagered-diamonds', async (req, res) => {
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
    const { data: matchData, error } = await supabase
      .from('matches')
      .select('player1_id, player2_id, entry_fee_diamonds')
      .not('entry_fee_diamonds', 'is', null)
      .gt('entry_fee_diamonds', 0)
      .gte('played_at', weekStart());
    if (error) return res.status(500).json({ error: error.message });

    const wageredMap = {};
    for (const m of matchData || []) {
      const fee = Number(m.entry_fee_diamonds) || 0;
      if (fee <= 0) continue;
      if (m.player1_id) wageredMap[m.player1_id] = (wageredMap[m.player1_id] || 0) + fee;
      if (m.player2_id) wageredMap[m.player2_id] = (wageredMap[m.player2_id] || 0) + fee;
    }

    const sorted = Object.entries(wageredMap)
      .filter(([id]) => id !== adminId && !DEMO_IDS.includes(id))
      .sort((a, b) => b[1] - a[1]).slice(0, 500);
    const ids = sorted.map(([id]) => id);
    const { data: profileData } = ids.length
      ? await selectWithOptional(
          (cols) => supabase.from('profiles').select(cols).in('id', ids).not('is_private', 'is', true),
          'id, username, wins, losses, profile_color',
          'avatar_url')
      : { data: [] };
    const profileMap = Object.fromEntries((profileData || []).map(p => [p.id, p]));

    const players = sorted
      .filter(([id]) => profileMap[id])
      .map(([id, wagered], i) => ({
        rank: i + 1, id,
        username: profileMap[id]?.username ?? 'Unknown',
        total_wagered: Math.round(wagered),
        wins: profileMap[id]?.wins ?? 0,
        losses: profileMap[id]?.losses ?? 0,
        profile_color: profileMap[id]?.profile_color ?? null,
        avatar_url: profileMap[id]?.avatar_url ?? null,
      }));

    let userRank = null;
    let userWagered = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const entry = players.find(p => p.id === uid);
      if (entry) {
        userRank = entry.rank;
        userWagered = entry.total_wagered;
      } else {
        const myWagered = wageredMap[uid] ?? 0;
        userWagered = Math.round(myWagered);
        if (myWagered > 0) userRank = Object.values(wageredMap).filter(w => w > myWagered).length + 1;
      }
    }

    res.json({ players, userRank, userWagered });
  });

  // Game-specific highscore leaderboard
  // Score-based games use game_highscores; all others use wins from matches table
  const SCORE_GAMES = new Set(['blockBlast', 'carDash', 'colorRush', 'tower', 'tetris', 'snake', 'galaga', 'asteroids', 'piano', 'twoFortyEight', 'clickRace']);
  // Games that also surface a companion stat (stored as its own game_type row)
  const COMPANION_STAT = { carDash: 'carDashMs' };

  // Frontend game-type IDs → DB game_type values (highscores table uses different keys than matches)
  const GAME_TYPE_MAP = {
    // Word VS ('scrabble') is a 1v1 game — ranked by wins from the matches table,
    // so it is intentionally NOT mapped to the 'wordVS' highscore key.
    coinFlip: 'coin_flip', // frontend sends 'coinFlip', matches stored as 'coin_flip'
  };

  router.get('/game/:gameType', async (req, res) => {
    const { gameType: rawGameType } = req.params;
    const gameType = GAME_TYPE_MAP[rawGameType] || rawGameType;
    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';

    if (SCORE_GAMES.has(gameType)) {
      // ── Score leaderboard from game_highscores ──
      const { data, error } = await supabase
        .from('game_highscores')
        .select('user_id, score')
        .eq('game_type', gameType)
        .order('score', { ascending: false })
        .limit(500);

      if (error) return res.status(500).json({ error: error.message });

      const filtered = (data || []).filter(r => r.user_id !== adminId && !DEMO_IDS.includes(r.user_id));

      // Fetch usernames in bulk
      const scoreIds = filtered.map(r => r.user_id);
      const { data: scoreProfiles } = scoreIds.length
        ? await selectWithOptional(
            (cols) => supabase.from('profiles').select(cols).in('id', scoreIds),
            'id, username, profile_color',
            'avatar_url')
        : { data: [] };
      const scoreProfileMap = Object.fromEntries((scoreProfiles || []).map(p => [p.id, p]));

      // Pull the companion stat (e.g. Rush Hour survival time) for these users
      let companionMap = {};
      const companionType = COMPANION_STAT[gameType];
      if (companionType && scoreIds.length) {
        const { data: comp } = await supabase
          .from('game_highscores')
          .select('user_id, score')
          .eq('game_type', companionType)
          .in('user_id', scoreIds);
        companionMap = Object.fromEntries((comp || []).map(c => [c.user_id, c.score]));
      }

      const players = filtered.map((r, i) => ({
          rank: i + 1,
          id: r.user_id,
          username: scoreProfileMap[r.user_id]?.username ?? 'Unknown',
          profile_color: scoreProfileMap[r.user_id]?.profile_color ?? null,
          avatar_url: scoreProfileMap[r.user_id]?.avatar_url ?? null,
          score: r.score,
          ...(companionType ? { ms: companionMap[r.user_id] ?? null } : {}),
        }));

      let userRank = null;
      if (req.query.userId) {
        const uid = req.query.userId;
        const entry = players.find(p => p.id === uid);
        if (entry) {
          userRank = { rank: entry.rank, score: entry.score };
        } else {
          // Fetch user's actual score from DB, then count how many are above it
          const { data: myRow } = await supabase
            .from('game_highscores')
            .select('score')
            .eq('game_type', gameType)
            .eq('user_id', uid)
            .single();
          const myScore = myRow?.score ?? 0;
          const { count } = await supabase
            .from('game_highscores')
            .select('user_id', { count: 'exact', head: true })
            .eq('game_type', gameType)
            .gt('score', myScore)
            .neq('user_id', adminId);
          userRank = { rank: (count ?? 0) + 1, score: myScore };
        }
      }

      return res.json({ players, userRank });
    }

    // ── Win leaderboard from matches table ──
    const { data: matchData, error: matchError } = await supabase
      .from('matches')
      .select('winner_id')
      .eq('game_type', gameType)
      .not('winner_id', 'is', null);

    if (matchError) return res.status(500).json({ error: matchError.message });

    // Count wins per user
    const winsMap = {};
    for (const m of (matchData || [])) {
      if (!m.winner_id || m.winner_id === adminId) continue;
      winsMap[m.winner_id] = (winsMap[m.winner_id] || 0) + 1;
    }
    stripDemoKeys(winsMap);

    const sorted = Object.entries(winsMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500);

    // Fetch usernames in bulk
    const ids = sorted.map(([id]) => id);
    const { data: profileData } = ids.length
      ? await selectWithOptional(
          (cols) => supabase.from('profiles').select(cols).in('id', ids),
          'id, username, profile_color',
          'avatar_url')
      : { data: [] };
    const profileMap = Object.fromEntries((profileData || []).map(p => [p.id, p]));

    const players = sorted.map(([id, wins], i) => ({
      rank: i + 1,
      id,
      username: profileMap[id]?.username ?? 'Unknown',
      profile_color: profileMap[id]?.profile_color ?? null,
      avatar_url: profileMap[id]?.avatar_url ?? null,
      score: wins,
    }));

    let userRank = null;
    if (req.query.userId) {
      const uid = req.query.userId;
      const entry = players.find(p => p.id === uid);
      if (entry) {
        userRank = { rank: entry.rank, score: entry.score };
      } else {
        const myWins = winsMap[uid] ?? 0;
        const above = Object.values(winsMap).filter(w => w > myWins).length;
        userRank = { rank: above + 1, score: myWins };
      }
    }

    return res.json({ players, userRank });
  });

  return router;
};

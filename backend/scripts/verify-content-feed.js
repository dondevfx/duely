#!/usr/bin/env node
/**
 * Cross-checks the content feed's figures against the database. READ-ONLY:
 * builds the feed with no pseudonym store (so nothing is written) and then
 * recomputes each figure with separate, simpler queries.
 *
 *   railway run node backend/scripts/verify-content-feed.js
 *
 * Prints numbers only: no names, ids or emails.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { fetchRows } = require('../src/routes/contentFeed');
const feed = require('../src/services/contentFeed');
const { DEMO_IDS } = require('../src/services/demoAccounts');

const GAME_TYPES = ['blockBlast', 'scrabble', 'coin_flip', 'blackjack', 'carDash', 'colorRush', 'tower'];

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  const log = { warn: (m) => console.log('  warn:', m), error: () => {} };
  const rows = await fetchRows(sb, null, now, log);
  const excludedIds = [...DEMO_IDS, process.env.ADMIN_USER_ID,
    ...String(process.env.CONTENT_FEED_EXCLUDE_USER_IDS || '').split(',').map(s => s.trim())].filter(Boolean);
  const f = await feed.buildFeed(rows, {
    now, demoIds: DEMO_IDS, adminId: process.env.ADMIN_USER_ID,
    testIds: excludedIds, secret: crypto.randomBytes(32).toString('hex'), store: null, log,
  });
  const P = feed.periods(now);
  const excluded = new Set(excludedIds);

  // Independent recomputation, straight from simple per-period queries.
  async function all(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }
  async function check(label, range, got) {
    const s = new Date(range.start).toISOString(), e = new Date(range.end).toISOString();
    const m = (await all(() => sb.from('matches').select('player1_id, player2_id, game_type, entry_fee_c, entry_fee_diamonds, played_at')
      .gte('played_at', s).lt('played_at', e).not('player1_id', 'is', null).not('player2_id', 'is', null).in('game_type', GAME_TYPES)))
      .filter(r => r.player1_id !== r.player2_id && !excluded.has(r.player1_id) && !excluded.has(r.player2_id));
    const w = (await all(() => sb.from('transactions').select('user_id, amount_c, notes, created_at')
      .eq('type', 'match_win').eq('status', 'confirmed').gt('amount_c', 0).gte('created_at', s).lt('created_at', e)))
      .filter(r => !excluded.has(r.user_id) && !String(r.notes || '').endsWith(' vs Bot'));
    const np = (await all(() => sb.from('profiles').select('id').gte('created_at', s).lt('created_at', e)))
      .filter(r => !excluded.has(r.id));
    const raw = {
      duels: m.length,
      active_players: new Set(m.flatMap(r => [r.player1_id, r.player2_id])).size,
      total_wagered: Math.round(m.reduce((a, r) => a + 2 * (Number(r.entry_fee_c) || 0), 0) * 100) / 100,
      paid_out: Math.round(w.reduce((a, r) => a + Number(r.amount_c), 0) * 100) / 100,
      new_players: np.length,
    };
    console.log(`\n${label}  ${s} -> ${e}`);
    for (const k of Object.keys(raw)) {
      const same = raw[k] === got[k];
      console.log(`  ${same ? 'ok  ' : 'DIFF'} ${k.padEnd(15)} feed=${got[k]}  db=${raw[k]}${same ? '' : '  (a difference here is duplicates removed by the feed)'}`);
    }
  }
  const pick = (sec) => ({ duels: sec.duels, active_players: sec.active_players, total_wagered: sec.total_wagered, paid_out: sec.paid_out, new_players: sec.new_players });
  const today = { duels: f.totals.duels_today, paid_out: f.totals.paid_out_today, new_players: f.totals.new_players_today };
  const t = feed.periodStats; void t;

  // Previous-period figures, computed by the feed's own function, for the comparison check.
  const excl = { excluded };
  const data = {
    duels: feed.validDuels(rows.matches, excl), moves: feed.coinMoves(rows.transactions, excl),
    newProfiles: rows.newProfiles.filter(p => !excluded.has(p.id)), featurable: new Set(),
  };
  const prevW = feed.periodStats(data, P.prevWeekSoFar);
  const prevM = feed.periodStats(data, P.prevMonthSoFar);

  await check('TODAY', P.today, { ...today, active_players: feed.periodStats(data, P.today).active_players, total_wagered: feed.periodStats(data, P.today).total_wagered });
  await check('THIS WEEK', P.week, pick(f.weekly));
  await check('PREVIOUS WEEK (same span)', P.prevWeekSoFar, pick(prevW));
  await check('THIS MONTH', P.month, pick(f.monthly));
  await check('PREVIOUS MONTH (same span)', P.prevMonthSoFar, pick(prevM));

  console.log('\nComparisons (feed):');
  console.log('  week ', JSON.stringify(f.comparisons.weekly_vs_previous_week));
  console.log('  month', JSON.stringify(f.comparisons.monthly_vs_previous_month));
  for (const [name, cur, prev, cmp] of [['week', f.weekly, prevW, f.comparisons.weekly_vs_previous_week], ['month', f.monthly, prevM, f.comparisons.monthly_vs_previous_month]]) {
    for (const k of ['duels', 'paid_out', 'new_players', 'active_players', 'total_wagered']) {
      const expect = feed.percentChange(cur[k], prev[k]);
      if (expect !== cmp[`${k}_percent_change`]) console.log(`  DIFF ${name} ${k}`);
    }
  }
  console.log('\nShape:', JSON.stringify({
    weekly_top_winners: f.weekly.top_winners?.length, monthly_top_winners: f.monthly.top_winners?.length,
    weekly_top_games: f.weekly.top_games, monthly_top_games: f.monthly.top_games,
    recent_winners: f.recent_winners?.length, leaderboard: f.leaderboard?.length,
    biggest_win_today: f.biggest_win && { game: f.biggest_win.game, amount: f.biggest_win.amount },
  }));
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });

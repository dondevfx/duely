// Demo accounts, numbers that have to fit, and the reset clock.
//
// The demo account is the one that gets shown to people, so its bugs are the
// ones seen first. It is also the account that exercises the disguise paths
// nothing else does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const fe = (...p) => fs.readFileSync(FE(...p), 'utf8');
const HANDLERS = be('socket', 'handlers.js');

// ── The bot's face ──────────────────────────────────────────────────────────

test('the robot face comes from the opponent, never from the mode', () => {
  // vsBot is true for a demo match too, and those bots wear a random human name
  // on purpose. Three places inferred "bot" from the mode instead of asking the
  // opponent, so the demo handed its own disguise away.
  const bad = [];
  for (const f of ['pages/BlockBlastGame.jsx', 'pages/BlackjackGame.jsx', 'components/ResultScreen.jsx']) {
    const src = fe(...f.split('/'));
    for (const m of src.matchAll(/isBot[=:]\s*\{?([^,}\n]+)/g)) {
      const expr = m[1].trim();
      if (/isSolo|vsBot|!opponentUsername/.test(expr)) bad.push(`${f}: isBot from ${expr}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('a free demo match still shows its opponent', () => {
  // A free bot game hides the opponent because the bot is plumbing, not a
  // rival. A demo match is free AND against a bot, so that rule swallowed it
  // whole and turned the demo into a solo run with nobody to play against.
  const tw = fe('pages', 'TowerGame.jsx');
  assert.match(tw, /setSoloEndless\(!!vsBot && !\(fee > 0\) && !!opp\?\.isBot\)/,
    'Tower still decides solo from the mode alone');
  for (const p of ['CarDashGame.jsx', 'ColorRushGame.jsx']) {
    assert.match(fe('pages', p), /!\(lastModeRef\.current === 'bot_free' && opponent\.isBot\)/,
      `${p} still hides a disguised opponent`);
  }
});

// ── The demo queue ──────────────────────────────────────────────────────────

test('a demo account waits 1.75s for a real opponent, in every game', () => {
  // One constant, because seven copies of a magic number is seven chances for
  // one game to keep the old wait.
  assert.match(HANDLERS, /const DEMO_MATCH_MS = 1750;/);
  assert.equal((HANDLERS.match(/\}, DEMO_MATCH_MS\);/g) || []).length, 7,
    'every game must use the shared wait');
  assert.doesNotMatch(HANDLERS, /\}, 3000\);/, 'a game still hard-codes the old 3s wait');
});

test('the demo account knows it is one', () => {
  // The id list is an env var and stays server-side; only the answer for the
  // account asking is sent.
  const auth = be('routes', 'auth.js');
  assert.match(auth, /is_demo: isDemo\(req\.user\.id\)/);
  const profile = fe('pages', 'Profile.jsx');
  assert.match(profile, /profile\.is_demo \?/, 'the profile page never checks it');
  assert.match(profile, /const \[viewingSelf, setViewingSelf\] = useState\(false\)/);
  // Read-only: Add Friend and Report make no sense pointed at yourself.
  const at = profile.indexOf('{viewingSelf && (');
  assert.match(profile.slice(at, at + 400), /viewOnly/);
});

// ── Numbers that have to fit ────────────────────────────────────────────────

test('a stat tile shrinks its number instead of cutting it off', () => {
  const fit = fe('components', 'FitText.jsx');
  assert.match(fit, /export default function FitText/);
  // Scaled, not re-sized: a transform is outside layout, so measuring cannot be
  // disturbed by the change it triggers.
  assert.match(fit, /inner\.style\.transform = s < 1 \? `scale\(\$\{s\}\)` : 'none'/);
  assert.match(fit, /new ResizeObserver\(fit\)/, 'it must re-fit on rotate and resize');
  assert.match(fit, /Math\.max\(min, avail \/ need\)/);
  // Never scales UP — text that fits is left exactly as designed.
  assert.match(fit, /need > avail \? Math\.max/);
});

test('every tile that holds a growing number uses it', () => {
  // Balance, wagered and the invite counters all grow without bound, and all
  // three were guarded with `truncate`, which cuts the number rather than
  // fitting it — the bigger the win, the less of it you can read.
  const uses = {
    'pages/Home.jsx': 1,              // the four hero stats
    'pages/Profile.jsx': 3,           // wagered, win rate, rank
    'components/ReferralCard.jsx': 2, // players joined, ready to collect
  };
  for (const [f, n] of Object.entries(uses)) {
    const src = fe(...f.split('/'));
    const count = (src.match(/<FitText/g) || []).length;
    assert.ok(count >= n, `${f} has ${count} fitted tiles, expected at least ${n}`);
    assert.match(src, /import FitText from/, `${f} uses FitText without importing it`);
  }
});

// ── The reset clock ─────────────────────────────────────────────────────────

test('the weekly reset is Monday midnight Pacific, on both sides', () => {
  // It was Monday 00:00 UTC, which is Sunday 5pm Pacific: the board wiped seven
  // hours before the Monday the page counted down to, while people were still
  // playing for it.
  const server = be('services', 'weekReset.js');
  assert.match(server, /America\/Los_Angeles/);
  assert.match(be('routes', 'leaderboard.js'), /startOfPacificWeek\(new Date\(\)\)/);
  assert.doesNotMatch(be('routes', 'leaderboard.js'), /getUTCDay\(\)/,
    'the board still filters on a UTC week');
  const client = fe('utils', 'weekReset.js');
  assert.match(fe('pages', 'Leaderboard.jsx'), /const getNextMonday = nextPacificWeek;/);
  assert.doesNotMatch(fe('pages', 'Leaderboard.jsx'), /setUTCHours\(0, 0, 0, 0\)/);

  // The two implementations must agree to the millisecond, or the countdown
  // runs out at a different moment than the data resets.
  const load = (src) => new Function(
    `${src.replace(/^export /gm, '').replace(/module\.exports[\s\S]*$/, '')}
     ; return { startOfPacificWeek, nextPacificWeek };`)();
  const S = load(server);
  const C = load(client);
  for (let i = 0; i < 380; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i, 7, 30));
    assert.equal(+C.startOfPacificWeek(d), +S.startOfPacificWeek(d), `week start differs on ${d.toISOString()}`);
    assert.equal(+C.nextPacificWeek(d), +S.nextPacificWeek(d), `next reset differs on ${d.toISOString()}`);
  }
});

test('the reset lands on Monday 00:00 Pacific across both clock changes', () => {
  const { startOfPacificWeek, nextPacificWeek } = require('../src/services/weekReset');
  const reads = (d) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);

  // Every week of a year, including the spring-forward and fall-back weekends.
  for (let i = 0; i < 366; i += 1) {
    const now = new Date(Date.UTC(2026, 0, 1 + i, 19, 0));
    for (const d of [startOfPacificWeek(now), nextPacificWeek(now)]) {
      assert.match(reads(d), /^Mon,? 00:00$/, `${d.toISOString()} is ${reads(d)}, not Monday midnight`);
    }
  }

  // And the offset actually changes across DST — proof it is not a fixed -7.
  const summer = startOfPacificWeek(new Date('2026-07-15T12:00:00Z')).getUTCHours();
  const winter = startOfPacificWeek(new Date('2026-01-15T12:00:00Z')).getUTCHours();
  assert.equal(summer, 7, 'PDT week should start at 07:00 UTC');
  assert.equal(winter, 8, 'PST week should start at 08:00 UTC');
});

// ── Avatars ─────────────────────────────────────────────────────────────────

test('a phone photo is shrunk rather than refused', () => {
  // The limit was 3MB on the raw file, and a photo off a phone is 3-8MB — so
  // ordinary pictures were rejected with nothing the player could do about it.
  const src = fe('pages', 'Profile.jsx');
  assert.match(src, /async function shrinkForAvatar\(file\)/);
  assert.match(src, /canvas\.toDataURL\('image\/jpeg', 0\.85\)/);
  assert.match(src, /const dataUrl = await shrinkForAvatar\(file\);/);
  assert.doesNotMatch(src, /file\.size > 3 \* 1024 \* 1024/, 'the old 3MB refusal is back');
  // Cropped square, not squashed: the avatar is a circle.
  assert.match(src, /\(img\.naturalWidth - side\) \/ 2, \(img\.naturalHeight - side\) \/ 2, side, side/);
  // And it must fall back to the original rather than failing shut.
  assert.match(src, /\} catch \{\s*\n\s*return original;/);
});

// ── Money, revisited ────────────────────────────────────────────────────────

test('the referral reward cannot be farmed by re-referring one account', () => {
  const aff = be('routes', 'affiliate.js');
  // referred_by is written once and never overwritten, so applying a second
  // code cannot make the same account pay out again.
  assert.match(aff, /if \(!existing\?\.referred_by\) patch\.referred_by = owner\.id;/);
  assert.match(aff, /You cannot use your own code/);
  // The owner is pinned by id at apply time — codes are renameable, and
  // resolving the string later paid whoever held it at settlement.
  assert.match(aff, /applied_code_owner_id: owner\.id/);

  const ref = be('services', 'referralService.js');
  assert.match(ref, /if \(!referrerId \|\| referrerId === referredId\) return false;/);
  // One row per referred account, enforced by the database, not by a read.
  assert.match(ref, /if \(error\.code === '23505'\) return false;/);
  // Claim before credit, so a double tap cannot pay twice.
  const collect = ref.slice(ref.indexOf('async function collectReferralEarnings'));
  assert.ok(collect.indexOf("update({ status: 'paid'") < collect.indexOf('pay_referral_from_bank'),
    'the reward is credited before it is claimed');
  assert.match(collect, /if \(!claimed\?\.length\) continue;/);
  // Paid out of rake already collected, never minted. Comments stripped first:
  // the one mention of creditCoins here is the note explaining why it is NOT
  // used, and matching prose would have made this pass for the wrong reason.
  assert.match(collect, /pay_referral_from_bank/);
  const code = collect.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /creditCoins\(/, 'the bonus must not mint new coins');
});

test('rakeback cannot be farmed against a bot or on a demo account', () => {
  const rb = be('services', 'rakebackService.js');
  assert.match(rb, /if \(currency !== 'coins'\) return;/);
  assert.match(rb, /if \(isDemo\(player1Id\) \|\| isDemo\(player2Id\)\) return;/);
  // Only the real PvP settle paths credit it — a bot match has no second stake.
  const wallet = be('services', 'walletService.js');
  const bot = wallet.slice(wallet.indexOf('async function settleBotMatch'));
  const botBody = bot.slice(0, bot.indexOf('\nasync function', 1));
  assert.doesNotMatch(botBody, /creditRakeback/, 'a bot match credits rakeback');
  assert.doesNotMatch(botBody, /trackWager/, 'a bot match counts toward the referral bar');
  // Claims are atomic in Postgres rather than read-then-write here.
  const route = be('routes', 'rakeback.js');
  for (const kind of ['instant', 'daily', 'weekly']) {
    assert.match(route, new RegExp(`claim_rakeback_${kind}`), `${kind} claim is not the atomic RPC`);
  }
});

test('a deposit cannot be credited twice', () => {
  // The claim is an INSERT against a unique index on tx_hash, so exactly one
  // caller can win and the rest get 23505.
  const mon = be('services', 'blockchainMonitor.js');
  assert.match(mon, /if \(error\.code === '23505'\)/);
  assert.match(mon, /unique index on transactions\.tx_hash/);
  const hooks = be('routes', 'webhooks.js');
  assert.match(hooks, /invalid signature — rejecting/, 'the webhook is not authenticated');
  assert.match(hooks, /claimErr\.code === '23505'/);
});

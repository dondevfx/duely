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

// ── Demo vs demo ────────────────────────────────────────────────────────────

test('two demo accounts matched together see each other, not two fake names', () => {
  // The disguise exists so a demo is not identifiable to a REAL player. Between
  // two demos there is nobody to hide from, and the fake names made the only
  // genuine PvP either of them plays look like a bot match.
  const { shownAs } = require('../src/services/demoAccounts');
  const a = { isDemo: true, username: 'DemoOne', avatarUrl: 'a.png', profileColor: '#22c55e' };
  const b = { isDemo: true, username: 'DemoTwo', avatarUrl: 'b.png', profileColor: '#ef4444' };
  const real = { username: 'jack', avatarUrl: 'j.png', profileColor: '#1250B4' };

  assert.deepEqual(shownAs(a, b), { username: 'DemoOne', avatarUrl: 'a.png', profileColor: '#22c55e' },
    'a demo must see the other demo as itself, picture and all');
  assert.notEqual(shownAs(a, real).username, 'DemoOne', 'a real player must still see the disguise');
  assert.equal(shownAs(a, real).avatarUrl, null, 'and must not get the real picture');
  assert.deepEqual(shownAs(real, a), { username: 'jack', avatarUrl: 'j.png', profileColor: '#1250B4' });

  // Every call site must pass the viewer, or the rule cannot apply.
  const bare = [...HANDLERS.matchAll(/shownAs\(([^)]*)\)/g)].filter((m) => !m[1].includes(','));
  assert.deepEqual(bare.map((m) => m[0]), [], 'a call site is not passing the viewer');
});

test('the disguise names read like handles, not like jokes', () => {
  // They were ToiletGoblin, SirFartsALot, PoopSockSteve — every one of them
  // read as generated, which is exactly what the disguise is trying not to do.
  const { FUNNY_NAMES } = require('../src/services/demoAccounts');
  assert.ok(FUNNY_NAMES.length >= 30, 'too few names to avoid repeats in a lobby');
  const joke = /fart|poop|toilet|butt|diaper|booger|smelly|moist|soggy|crusty|gassy|thicc|chonky/i;
  const bad = FUNNY_NAMES.filter((n) => joke.test(n));
  assert.deepEqual(bad, [], `these still read as jokes: ${bad.join(', ')}`);
  // Long names break the layouts they appear in.
  const long = FUNNY_NAMES.filter((n) => n.length > 14);
  assert.deepEqual(long, [], `too long for a name slot: ${long.join(', ')}`);
});

// ── Blackjack table marks ───────────────────────────────────────────────────

test('stand, bust, draw, crown and split are drawn rather than emoji', () => {
  const ui = fe('components', 'UiIcon.jsx');
  assert.match(ui, /export function BjIcon/);
  for (const kind of ['stand', 'bust', 'crown', 'split']) {
    assert.match(ui, new RegExp(`^  ${kind}: `, 'm'), `no drawn mark for ${kind}`);
  }
  const src = fe('pages', 'BlackjackGame.jsx');
  // The draw banner reuses the scales from the result card rather than growing
  // a second drawing of the same idea.
  assert.match(src, /<OutcomeIcon kind="draw"/);
  for (const kind of ['stand', 'bust', 'crown', 'split']) {
    assert.match(src, new RegExp(`<BjIcon kind="${kind}"`), `${kind} is not used`);
  }
  // No emoji left ON THE TABLE — the in-game surface, up to where the lobby
  // starts. The lobby's "Challenge a Friend" keeps its controller: the same
  // button exists in five other files, and converting one copy would be exactly
  // the inconsistency this whole icon effort exists to remove. Card pips are
  // characters rather than emoji and stay either way.
  const felt = src.slice(0, src.indexOf('─ Lobby'));
  assert.ok(felt.length > 1000, 'could not find where the lobby starts');
  const bad = [];
  felt.split(/\r?\n/).forEach((l, i) => {
    if (/[\u{1F300}-\u{1FAFF}]/u.test(l)) bad.push(`${i + 1}: ${l.trim().slice(0, 50)}`);
  });
  assert.deepEqual(bad, [], `emoji left on the table: ${bad.join(' | ')}`);
});

// ── Tower multiplier ────────────────────────────────────────────────────────

test('consecutive perfect drops pay 2x, 3x … 10x and then hold', () => {
  const src = fe('utils', 'towerCore.js');
  assert.match(src, /export const MAX_PERFECT_MULT = 10;/);
  assert.match(src, /const mult = perfect \? Math\.min\(MAX_PERFECT_MULT, state\.perfectStreak\) : 1;/);
  assert.match(src, /state\.score \+= mult;/);
  assert.doesNotMatch(src, /state\.score\+\+;/, 'the flat +1 is still there');

  // Run the rule rather than trust the reading of it.
  const MAX = 10;
  let streak = 0, score = 0;
  const drop = (perfect) => {
    if (perfect) streak++; else streak = 0;
    const m = perfect ? Math.min(MAX, streak) : 1;
    score += m;
    return m;
  };
  // The first perfect is worth 1 — the multiplier starts on the SECOND, which
  // is where it means something.
  assert.equal(drop(true), 1, 'the first perfect must not already be 2x');
  assert.equal(drop(true), 2);
  assert.equal(drop(true), 3);
  for (let i = 0; i < 6; i++) drop(true);          // up to the 9th
  assert.equal(drop(true), 10, 'the tenth perfect is 10x');
  assert.equal(drop(true), 10, 'and it holds there');
  assert.equal(drop(false), 1, 'a miss resets it');
  assert.equal(drop(true), 1, 'and the streak starts again');
});

test('the score limit was rescaled with the multiplier', () => {
  // The bucket is in POINTS and a point is no longer a block. Left at 4/second
  // — sized when every block scored exactly 1 — a run of perfect drops would
  // have been throttled, silently capping the very play the multiplier rewards.
  const eng = be('services', 'towerEngine.js');
  const refill = Number(eng.match(/const SCORE_REFILL_PER_MS\s+=\s+([\d.]+)/)[1]);
  const burst  = Number(eng.match(/const MAX_DELTA_PER_PING\s+=\s+(\d+)/)[1]);
  const perSecond = refill * 1000;
  // Three drops a second is the physical ceiling; at 10x that is 30 points.
  assert.ok(perSecond >= 30, `${perSecond} points/second throttles legitimate perfect play`);
  assert.ok(perSecond <= 60, `${perSecond} points/second is loose enough to fabricate a run`);
  assert.ok(burst >= 10, 'a single 10x drop must fit in the burst allowance');
});

// ── The wagered tile ────────────────────────────────────────────────────────

test('the wagered tile shows the coin mark, not the word', () => {
  // "2,500.00 coins" was the longest thing any of these tiles holds, and the
  // one that overflowed. The icon says the same in a fifth of the width.
  const src = fe('pages', 'Profile.jsx');
  const at = src.indexOf("{ label: 'Wagered'");
  assert.ok(at > 0, 'the wagered tile is gone');
  const tile = src.slice(at, at + 400);
  assert.match(tile, /<CoinIcon/, 'it does not use the coin mark');
  assert.doesNotMatch(tile, /\} coins`/, 'it still spells out the word');
  // The full figure stays reachable on hover.
  assert.match(tile, /title: `\$\{fmtExact\(extraStats\.total_wagered\)\} coins wagered`/);
});

// ── Admin ───────────────────────────────────────────────────────────────────

test('demo transactions stay out of the admin lists', () => {
  // Demo matches move coins that are not real money, so every demo game is a
  // row of noise between the transactions that actually need looking at — and
  // the attention queue is the one list where that matters most.
  const src = be('routes', 'admin.js');
  const at = src.indexOf("router.get('/transactions'");
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('const { data, error } = await q;', at));
  assert.match(body, /filterDemos\(/, 'the transaction list does not exclude demo accounts');
  // Filtered on the OWNER column, not the row id — filterDemos defaults to 'id',
  // which on this table is the transaction's own id and would match nothing.
  assert.match(body, /'user_id',/, 'filtered on the wrong column');
});

// ── Not being able to afford it ─────────────────────────────────────────────



// ── The currency toggle ─────────────────────────────────────────────────────

test('the coin and diamond buttons are taller on a phone', () => {
  // One class string shared by all four betting screens, so they cannot drift.
  let seen = 0;
  for (const f of ['components/GameLobby.jsx', 'pages/QuickMatch.jsx',
                   'pages/BlackjackGame.jsx', 'pages/CoinFlipGame.jsx']) {
    const src = fe(...f.split('/'));
    const n = (src.match(/px-3 sm:px-4 py-2\.5 sm:py-2 rounded text-xs sm:text-sm font-bold/g) || []).length;
    assert.equal(n, 2, `${f} should have both currency buttons, found ${n}`);
    assert.doesNotMatch(src, /px-3 sm:px-4 py-1\.5 sm:py-2 rounded text-xs/,
      `${f} still has the shorter mobile button`);
    seen += n;
  }
  assert.equal(seen, 8);
});

// ── The Tower multiplier badge ──────────────────────────────────────────────

test('the multiplier is drawn above the tower, in white', () => {
  const src = fe('components', 'TowerCanvas.jsx');
  // Clear of the block that earned it, rather than sitting on the piece just
  // landed, which is where the eye already is.
  assert.match(src, /view\.blockPx \* 2\.6/, 'it is not lifted clear of the block');
  assert.match(src, /ctx\.fillStyle = '#FFFFFF';/);
  assert.doesNotMatch(src, /#F5C518/, 'the gold version is still there');
  // Its own style: spaced, haloed rather than outlined, with a rule under it.
  assert.match(src, /ctx\.letterSpacing = '2px'/);
  assert.match(src, /ctx\.shadowColor = 'rgba\(0,0,0,0\.75\)'/);
  // The rule under it is gone — it read as a stray mark at the size the badge
  // is now, and the halo already separates it from the tower.
  assert.doesNotMatch(src, /ctx\.fillRect\(-w \/ 2, 20, w, 1\.5\)/, 'the rule is back');
  assert.match(src, /'800 38px system-ui/, 'the badge should be the larger size');
});

// ── Not being able to afford it, part two ───────────────────────────────────

test('the betting buttons look the same whatever the balance', () => {
  // They used to rename themselves — the primary action became "Insufficient
  // Balance — Deposit" and the bot button "Insufficient — Get More". A button
  // whose label is an error still looks like the action you wanted until you
  // read it, and the screen changing shape means the control you were reaching
  // for has moved.
  const files = ['components/GameLobby.jsx', 'pages/BlackjackGame.jsx',
                 'pages/CoinFlipGame.jsx', 'pages/QuickMatch.jsx'];
  for (const f of files) {
    const src = fe(...f.split('/'));
    assert.doesNotMatch(src, /topUpLabel/, `${f} still relabels a button on a shortfall`);
    assert.doesNotMatch(src, /Insufficient <DiamondIcon \/> — Get More/,
      `${f} still has the relabelled bot button`);
    // The shortfall opens the dialog instead.
    assert.match(src, /insufficient \? \(\) => setShortfall\(true\)/,
      `${f} does not open the dialog on a shortfall`);
    assert.match(src, /<InsufficientModal currency=\{betCurrency\} open=\{shortfall\}/,
      `${f} never renders the dialog`);
    assert.match(src, /const \[shortfall, setShortfall\] = useState\(false\)/, `${f} has no state for it`);
  }
  // And the old helper is gone rather than left behind unused.
  assert.throws(() => fe('utils', 'topUpRoute.jsx'), /ENOENT/);
});

test('the dialog sends each currency where that currency comes from', () => {
  const src = fe('components', 'InsufficientModal.jsx');
  // Diamonds are earned, not bought — the wallet has nothing to sell.
  assert.match(src, /const route = isDiamonds \? '\/rewards' : '\/wallet'/);
  assert.match(src, /const cta   = isDiamonds \? 'Rewards' : 'Wallet'/);
  assert.match(src, /Collect rewards to earn more Diamonds/);
  assert.match(src, /Deposit to add more Coins/);
  assert.match(src, /Insufficient balance/);
  // Dismissable without going anywhere.
  assert.match(src, /Not now/);
  assert.match(src, /onClick=\{onClose\}/);
});

// ── Tipping ─────────────────────────────────────────────────────────────────

test('tipping a demo account answers as though the name does not exist', () => {
  // Demo accounts are kept out of the leaderboards, search and the ticker so
  // they are not identifiable. A distinct error handed that back one username
  // at a time.
  const src = be('routes', 'wallet.js');
  const at = src.indexOf("if (isDemo(recipient.id))");
  assert.ok(at > 0, 'the demo recipient guard is gone');
  const line = src.slice(at, src.indexOf('\n', at));
  assert.match(line, /404/, 'it must answer with the same status a real miss gets');
  assert.match(line, /User not found/);
  assert.doesNotMatch(line, /[Dd]emo accounts cannot/, 'it still names the reason');
  // The same wording as the genuine miss just above it, or the two are still
  // distinguishable.
  assert.match(src, /if \(!recipient\) return res\.status\(404\)\.json\(\{ error: 'User not found' \}\);/);
});

// ── The mobile menu ─────────────────────────────────────────────────────────

test('the drawer cannot be left open with nothing on screen', () => {
  // Every link inside it closes it, but the back button, a redirect and
  // anything navigating from elsewhere do not — so the state could sit true
  // with the overlay hidden, and the next tap closed a drawer the player could
  // not see. That reads as "I pressed it and nothing happened".
  const src = fe('components', 'Navbar.jsx');
  assert.match(src, /useEffect\(\(\) => \{ setMobileMenuOpen\(false\); \}, \[pathname\]\);/);
  // And the button sits above the nav's own blur layer, with the tap delay off.
  assert.match(src, /md:hidden relative z-10 p-2/);
  assert.match(src, /touchAction: 'manipulation'/);
});

test('a document-wide lock is always released, never restored to a captured value', () => {
  // Rush Hour and Color Rush lock html, body and touch-action deliberately, and
  // that is fine. What is not fine is CAPTURING the current values to restore
  // later: these styles are only ever set by this lock, so a second game
  // starting while the first still holds it captures 'hidden' and 'none' as the
  // state to go back to. Its cleanup then leaves the document locked, and
  // nothing on the site takes a tap or scrolls until a reload — which is what
  // the menu button that stops working looks like.
  //
  // Matched on the CAPTURE, not on the lock, and comments stripped so the note
  // recording the old shape does not read as the old shape.
  const bad = [];
  for (const f of fs.readdirSync(FE('pages'))) {
    if (!f.endsWith('.jsx')) continue;
    const src = fs.readFileSync(FE('pages', f), 'utf8')
      .split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    if (!/style\.touchAction\s*=\s*'none'/.test(src)) continue;
    // The tell: reading the live value into something that is written back.
    if (/touch:\s*\w+\.style\.touchAction/.test(src)
        || /(prev|previous)\w*\.touch/.test(src)) {
      bad.push(`${f} restores touch-action to a value captured while it may already be locked`);
    }
    if (!/UNLOCKED/.test(src)) {
      bad.push(`${f} locks the document without an unconditional release`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));

  // And the two that do lock must both carry the release.
  for (const f of ['CarDashGame.jsx', 'ColorRushGame.jsx']) {
    const src = fe('pages', f);
    assert.match(src, /const UNLOCKED = \{ main: '', body: '', html: '', touch: '' \};/,
      `${f} does not release the lock unconditionally`);
  }
});

// ── Mobile scale ────────────────────────────────────────────────────────────

test('the whole phone layout is scaled up from one value', () => {
  // The site read small on a phone: tap targets near the 44px floor rather than
  // comfortably past it, secondary labels at 10 and 11px. Raising the ROOT size
  // moves type, spacing, gaps, radii and max-widths together, because Tailwind
  // expresses all of them in rem — several hundred classes would otherwise have
  // had to move in step, and any one missed would break a proportion.
  const css = fs.readFileSync(FE('index.css'), 'utf8');
  assert.match(css, /@media \(max-width: 767\.98px\) \{\s*\n\s*html \{ font-size: 110%; \}/,
    'the mobile scale is gone');
  // Phones only — 767.98 is where the site already switches to its mobile nav.
  assert.doesNotMatch(css, /html \{ font-size: 110%; \}[\s\S]{0,40}\}\s*\n\s*@media \(min-width/,
    'the scale must not apply to desktop');
});

test('no label is left in px, where the scale cannot reach it', () => {
  // The small labels were written as arbitrary px. Left that way they would be
  // the ONLY thing that did not grow — and they are the hardest to read, which
  // is the opposite of what is wanted.
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsx')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/text-\[[0-9.]+px\]/g)) bad.push(`${e.name}: ${m[0]}`);
      }
    }
  };
  walk(FE());
  assert.deepEqual(bad, [], `these will not scale with the root size: ${bad.slice(0, 6).join(', ')}`);
});

test('the leaderboard tabs can shrink instead of running off the row', () => {
  // A flex child defaults to min-width:auto and refuses to go below its own
  // content, so five tabs plus their icons pushed past the end of the row on a
  // narrow phone even though flex-1 said they should share it.
  const src = fe('pages', 'Leaderboard.jsx');
  assert.match(src, /flex-1 min-w-0 flex items-center justify-center gap-1 py-2\.5/);
  assert.match(src, /<span className="truncate">\{\(t\.icon \|\| t\.diamondTab\)/);
  assert.match(src, /<StatIcon kind="elo" size=\{16\} className="shrink-0" \/>/);
});

// ── The stripped-back phone Home ────────────────────────────────────────────

test('the phone Home is one switch, not a sprinkling of classes', () => {
  // This is a trial the owner may want reversed, so flipping PHONE_MINIMAL to
  // false has to restore the old layout exactly, with nothing left to hunt for.
  const src = fe('pages', 'Home.jsx');
  assert.match(src, /const PHONE_MINIMAL = true;/);
  // No breakpoint in these any more: the cut applies at every width, so
  // 'hidden' outright is the correct value and 'hidden sm:block' would mean
  // the desktop had been left on the old layout.
  assert.match(src, /const PHONE_HIDE\s+= PHONE_MINIMAL \? 'hidden' : '';/);
  assert.match(src, /const PHONE_HIDE_FLEX = PHONE_MINIMAL \? 'hidden' : 'flex';/);
  assert.match(src, /const PHONE_HIDE_LG\s+= PHONE_MINIMAL \? 'hidden' : 'hidden lg:block';/);

  // Everything that goes must go through the switch — a literal breakpoint
  // class anywhere in this file would survive the flag being turned off.
  // `hidden lg:block` is in the pattern because two sections were hidden that
  // way and so were NOT reached when the cut was extended to every width.
  const strays = [...src.matchAll(/className="[^"]*\bhidden (sm:block|sm:flex|lg:block)\b[^"]*"/g)];
  assert.deepEqual(strays.map((m) => m[0]), [],
    'a section is hidden by a literal class instead of the switch');

  // The pieces that come off the phone, the Games heading among them: with the
  // hero stripped back the cards sit directly under the title and the label was
  // just a word in the way.
  assert.equal((src.match(/\$\{PHONE_HIDE\}/g) || []).length, 6, 'expected six PHONE_HIDE wrappers');
  assert.match(src, /<h2 className=\{`\$\{PHONE_HIDE\} text-xl md:text-2xl[^`]*`\}>Games<\/h2>/,
    'the Games heading must be hidden on phones');

  // And the gap it left has to be closed, or the cards float below a blank
  // stretch where the heading used to be. The hero's bottom padding is now the
  // ENTIRE distance between the title and the first card — at every width, not
  // just on a phone, which is why the md: values are gone rather than kept.
  // They were chosen for a hero that still had content under the title.
  assert.match(src, /pt-3 pb-2 px-4/,
    'the hero still has its old bottom padding, so the cards sit too far down');
  // Comments stripped: the note above that padding explains why md:pt-14 and
  // md:pb-10 were removed and therefore names both. This is the third time a
  // check in this suite has matched its own explanation — prose is not code,
  // and a test that reads it passes when someone deletes the code and keeps
  // the note.
  const homeCode = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(homeCode, /md:pt-14|md:pb-10/,
    'a desktop-only padding pads an empty space now');
  assert.match(src, /<div className=\{PHONE_HIDE\}>/, 'the diamond bonus wrapper');
  assert.equal((src.match(/\$\{PHONE_HIDE_FLEX\}/g) || []).length, 1, 'the hero button row');

  // The How Duely Works card stays, so it must NOT be hidden.
  //
  // It is its own component in the games grid now rather than a block inside
  // the column that gets hidden, so the check is that the component carries no
  // wrapper at all — the old "look 400 characters back for PHONE_HIDE" was
  // reading whatever happened to precede it in the file.
  const how = src.slice(src.indexOf('function HowDuelyWorks()'), src.indexOf('function DailySpinWidget'));
  assert.ok(how.length > 0, 'HowDuelyWorks is gone');
  assert.doesNotMatch(how, /PHONE_HIDE/, 'How Duely Works was hidden along with the rest');
  assert.match(src, /<HowDuelyWorks \/>/, 'and it has to actually be rendered');
});

test('the Home cut applies at every width, and Games is gone from the nav', () => {
  // This used to assert the opposite: the stripped-back layout was phone-only,
  // cut at sm so an iPad mini (744px, below md) kept the full page. Having
  // lived with it, the answer to "does a desktop need the extra sections" was
  // no — so the breakpoint went rather than being widened, because a layout
  // that is right on one screen and merely tolerated on another is two
  // layouts to keep working.
  const src = fe('pages', 'Home.jsx');
  assert.match(src, /PHONE_MINIMAL \? 'hidden' : ''/);
  assert.doesNotMatch(src, /'hidden sm:block'/, 'a breakpoint leaves the desktop on the old layout');

  // Games leaves BOTH navigations now — Home is the games list, so a Games
  // page was the same screen reached a second way. The route still exists.
  assert.doesNotMatch(fe('components', 'Navbar.jsx'), /label: 'Games'/);
  assert.doesNotMatch(fe('components', 'LeftSidebar.jsx'), /label: 'Games'/);
});

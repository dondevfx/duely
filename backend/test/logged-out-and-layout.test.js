// The logged-out site, the game viewport, and where an icon sits on a line.
//
// The theme is a visitor who arrives from a shared link with no account. Most
// of these were places that assumed a session existed and failed in a way that
// looked like the site was broken rather than like a login prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const fe = (...p) => fs.readFileSync(FE(...p), 'utf8');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsx')) out.push(p);
  }
  return out;
};
const GAME_PAGES = ['BlackjackGame', 'BlockBlastGame', 'CarDashGame', 'CoinFlipGame',
                    'ColorRushGame', 'TowerGame', 'WordleGame'];

// ── The game opens on the game ──────────────────────────────────────────────

test('every game pins the page for its countdown and its match', () => {
  // Rush Hour and Color Rush were left out when the lock was added to the
  // other five: scroll the lobby, hit play, and the match opened halfway down
  // the board with the top of the track off-screen.
  for (const page of GAME_PAGES) {
    const src = fe('pages', `${page}.jsx`);
    assert.match(src, /useGameScrollLock\(/, `${page} never locks the viewport`);
  }
});

test('the top of the page is re-asserted, not set once', () => {
  // The lobby is still mounted on the frame the countdown starts. Setting
  // scrollTop once there is undone when the browser restores the scroll
  // position after the taller lobby is swapped for the shorter board.
  const src = fe('hooks', 'useGameScrollLock.js');
  assert.match(src, /requestAnimationFrame\(toTop\)/);
  assert.match(src, /cancelAnimationFrame\(raf\)/, 'the frame loop must be cancelled on unmount');
});

// ── The logged-out visitor ──────────────────────────────────────────────────

test('a public profile can be read without a session', () => {
  // The leaderboard is public and a row opens this card. Behind requireAuth
  // every tap answered "Player not found" for anyone not signed in.
  const src = be('routes', 'auth.js');
  const at = src.indexOf("router.get('/public/:userId'");
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 120), /optionalAuth/,
    'the public profile still demands a session');
  // And it must not then read req.user, which optionalAuth leaves undefined.
  const body = src.slice(at, src.indexOf("router.get('/game-stats'"));
  assert.doesNotMatch(body, /req\.user\./, 'the handler assumes a signed-in caller');
});

test('the profile card offers no action a signed-out visitor cannot take', () => {
  const src = fe('components', 'ChatSidebar.jsx');
  assert.match(src, /const canAct = !!myProfile && !isOwn && !isBot;/);
  // Tip, add friend, report and spectate all go through it.
  assert.ok((src.match(/\{canAct &&/g) || []).length >= 3,
    'an action block still renders on its own gate');
});

test('Quick Match does not report "Connecting" to someone who is signed out', () => {
  const src = fe('pages', 'QuickMatch.jsx');
  assert.match(src, /\{session && !authenticated && \(/,
    'the socket status is only meaningful once there is a session');
});

test('the Quick Match pool is listed from the pool, not typed out', () => {
  // The written-out list was three games out of date, and could not drop Coin
  // Flip on a diamond bet the way the actual pool does.
  const src = fe('pages', 'QuickMatch.jsx');
  assert.match(src, /Pool: \{activePool\.map\(g => g\.name\)\.join\(' · '\)\}/);
  assert.doesNotMatch(src, /Pool: Block Burst/, 'the hand-typed list is still there');
  assert.match(src, /const activePool\s+= isDiamonds \? POOL\.filter\(g => !g\.coinsOnly\) : POOL;/);
});

test('signing in reloads the app rather than navigating into it', () => {
  const login = fe('pages', 'Login.jsx');
  assert.match(login, /function enterApp\(navigate, target\)/);
  assert.match(login, /window\.location\.assign\(target\?\.route \|\| '\/'\)/);
  // The one exception: a pending challenge carries its join code in router
  // state, which a reload would drop.
  assert.match(login, /if \(target\?\.state\) \{ navigate\(target\.route/);
  assert.equal((login.match(/enterApp\(navigate, postLoginTarget\(\)\);/g) || []).length, 4,
    'every sign-in path must go through it, including the MFA one');
  assert.match(fe('pages', 'Signup.jsx'), /window\.location\.assign\(invite \? invite\.route : '\/'\)/);
});

// ── Icons ───────────────────────────────────────────────────────────────────

test('the lock is drawn everywhere it gates something', () => {
  const bad = [];
  for (const file of walk(FE())) {
    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^[ \t]*\/\/.*$/gm, '');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/\u{1F512}|\u{1F510}/u.test(line)) bad.push(`${path.basename(file)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `lock emoji left: ${bad.join(', ')}`);
  assert.match(fe('components', 'UiIcon.jsx'), /export function LockIcon/);
});

test('a game keeps its icon however the database spells its name', () => {
  // game_type comes back with underscores, so the profile's Coin Flip card
  // asked for "coin_flip" and got nothing at all.
  const src = fe('components', 'GameIcon.jsx');
  for (const k of ['coin_flip', 'block_blast', 'car_dash', 'color_rush', 'word_vs']) {
    assert.ok(src.includes(`  ${k}:`), `no alias for ${k}`);
  }
});

test('drawn icons sit on the text rather than hanging below it', () => {
  // vertical-align:middle centres on the x-height midline, ~0.1em below where
  // text reads as centred, so every icon hung low beside its label.
  const ui = fe('components', 'UiIcon.jsx');
  assert.match(ui, /export const ICON_ALIGN = \{ verticalAlign: '-0\.15em' \}/);
  for (const f of ['UiIcon.jsx', 'GameIcon.jsx', 'RankIcon.jsx']) {
    const src = fe('components', f);
    assert.doesNotMatch(src, /inline-block shrink-0 align-middle/,
      `${f} still centres on the x-height`);
    assert.match(src, /style=\{ICON_ALIGN\}/, `${f} does not apply the shared alignment`);
  }
});

test('the logged-out pages are drawn, not emoji', () => {
  for (const [page, name] of [['Profile', 'profile'], ['Wallet', 'wallet'], ['Tip', 'tip'], ['Rewards', 'rewards']]) {
    assert.match(fe('pages', `${page}.jsx`), new RegExp(`<UiIcon name="${name}"`),
      `${page}'s signed-out screen still has its emoji`);
  }
});

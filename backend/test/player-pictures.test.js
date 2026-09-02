// Player pictures, friend requests, and the leaderboard's profile card.
//
// The theme: a player uploads a picture and then has to be able to SEE it, and
// see other people's, in the places where you actually look at another player
// — the countdown, the board, the result card, the notifications. That data
// has to travel from the server, so most of these check the payload as well as
// the render.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const fe = (...p) => fs.readFileSync(FE(...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const HANDLERS = strip(be('socket', 'handlers.js'));
const GAME_PAGES = ['BlackjackGame', 'BlockBlastGame', 'CarDashGame', 'CoinFlipGame',
                    'ColorRushGame', 'TowerGame', 'WordleGame'];

// ── The picture reaches the client ──────────────────────────────────────────

test('every opponent payload carries the picture', () => {
  // Missing it on one path is a game where the opponent is a letter in a
  // circle while every other game shows their face.
  const payloads = HANDLERS.match(/opponent: \{ userId:[^}]*\}/g) || [];
  assert.ok(payloads.length >= 40, `expected the full set, found ${payloads.length}`);
  // The KEY, not just the name appearing somewhere in the object — matching
  // loosely also matched the value expression `p2.avatarUrl`, so a payload
  // that had lost its key still passed.
  const bare = payloads.filter(p => !/\bavatarUrl:/.test(p));
  assert.equal(bare.length, 0, `${bare.length} opponent payloads have no picture`);
});

test('the profile reads that build a player fetch the picture', () => {
  // The payload can only carry what the query selected. These two selects are
  // what every player object in the socket layer is built from.
  const selects = HANDLERS.match(/\.select\('[^']*username[^']*'\)/g) || [];
  const forPlayers = selects.filter(s => /c_coins|elo/.test(s));
  const missing = forPlayers.filter(s => !/avatar_url/.test(s));
  assert.deepEqual(missing, [], `these player reads skip the picture: ${missing.join(', ')}`);
});

test('the bot has a picture of its own rather than a fallback letter', () => {
  assert.match(be('services', 'botService.js'), /avatarUrl:\s*null/,
    'the bot sends the same shape as a player');
  assert.match(fe('components', 'UiIcon.jsx'), /export function BotAvatar/);
  // And the shared Avatar draws it instead of the emoji it used to.
  const av = fe('components', 'Avatar.jsx');
  assert.match(av, /<BotAvatar/);
  assert.doesNotMatch(av, /'🤖'/, 'the emoji robot is gone');
});

// ── The picture is actually shown ───────────────────────────────────────────

test('every game shows the opponent on the countdown', () => {
  for (const page of GAME_PAGES) {
    const src = fe('pages', `${page}.jsx`);
    if (!/vs \{opponent/.test(src) && !/vs <PlayerName/.test(src)) continue;  // no countdown line
    assert.match(src, /<PlayerName[\s\S]{0,200}?avatarUrl=\{opponent/,
      `${page} still shows the opponent's name with no picture`);
  }
});

test('every result card can draw both players', () => {
  // A page with two or three cards must wire them all — one unwired card is a
  // win screen with no faces while the loss screen has them.
  for (const page of GAME_PAGES) {
    const src = fe('pages', `${page}.jsx`);
    const cards = (src.match(/<ResultScreen/g) || []).length;
    const wired = (src.match(/opponent=\{opponent\}/g) || []).length;
    assert.equal(wired, cards, `${page} has ${cards} result cards but ${wired} wired`);
    // And the page must actually HAVE an opponent to pass — two pages were
    // passing a variable that only existed inside a socket handler, which is a
    // crash at render rather than a build error.
    if (cards > 0) {
      assert.match(src, /const \[opponent,\s*setOpponent\]\s*=\s*useState/,
        `${page} passes an opponent it never declared`);
    }
  }
});

test('the result card resolves a picture by name', () => {
  // The card is told who won and lost by USERNAME and does not otherwise know
  // which side is which, so it has to work that out.
  const src = fe('components', 'ResultScreen.jsx');
  assert.match(src, /const who = \(name\)/);
  assert.match(src, /name === profile\.username/, 'me is matched by name');
  assert.match(src, /opponent\?\.avatarUrl/, 'anything else is the opponent');
});

// ── Friend requests ─────────────────────────────────────────────────────────

test('a pending inbox is capped, and the request over the cap is never written', () => {
  const src = be('routes', 'auth.js');
  assert.match(src, /MAX_PENDING_REQUESTS = 30/);
  assert.match(src, /async function _inboxFull/);
  // The cap is on the RECIPIENT — it is the recipient who gets buried.
  const fn = src.slice(src.indexOf('async function _inboxFull'), src.indexOf('\n  }', src.indexOf('async function _inboxFull')));
  assert.match(fn, /\.eq\('addressee_id', toUserId\)/);
  assert.match(fn, /\.eq\('status', 'pending'\)/);
  // Both send paths check, and both check BEFORE inserting.
  const checks = (src.match(/_inboxFull\(supabase, \w+(?:\.\w+)?\)/g) || []).length;
  assert.equal(checks, 2, `expected both send paths to check, found ${checks}`);
  for (const m of src.matchAll(/_inboxFull\(supabase, (\w+(?:\.\w+)?)\)/g)) {
    const after = src.slice(m.index, m.index + 500);
    assert.match(after, /friends'\)\.insert/, 'the check must sit before the insert');
  }
});

test('a friend request can be answered from the notification', () => {
  const auth = be('routes', 'auth.js');
  for (const route of ['friend-accept-by-user', 'friend-decline-by-user']) {
    assert.ok(auth.includes(route), `missing ${route}`);
  }
  // Both must scope to a PENDING row where I am the addressee, or one player
  // could answer a friendship they are not part of.
  const accept = auth.slice(auth.indexOf("'/friend-accept-by-user'"), auth.indexOf("'/friend-decline-by-user'"));
  assert.match(accept, /\.eq\('addressee_id', req\.user\.id\)/);
  assert.match(accept, /\.eq\('status', 'pending'\)/);

  // The notification carries who asked, and their face.
  assert.match(auth, /fromUserId:\s*fromId/);
  assert.match(auth, /fromAvatar:\s*data\?\.avatar_url/);
  assert.match(HANDLERS, /sock\.emit\('friend_request', \{ fromUserId/);

  const toast = fe('components', 'InviteToasts.jsx');
  assert.match(toast, /friend-accept-by-user/);
  assert.match(toast, /friend-decline-by-user/);
  assert.match(toast, /avatarUrl=\{inv\.fromAvatar\}/, 'the toast shows who is asking');
});

// ── Leaderboard ─────────────────────────────────────────────────────────────

test('every leaderboard returns the picture, not just three of them', () => {
  // Six of the eight boards selected their own column list and never asked for
  // avatar_url, so pictures appeared on one tab and nowhere else.
  const src = be('routes', 'leaderboard.js');
  const profileReads = src.match(/from\('profiles'\)[\s\S]{0,220}?\)/g) || [];
  const listReads = profileReads.filter(r => /username/.test(r) && !/count:/.test(r));
  const missing = listReads.filter(r => !/avatar_url/.test(r));
  assert.deepEqual(missing.map(m => m.slice(0, 60)), [],
    'a leaderboard is still fetching players without their picture');
});

test('the whole row opens the profile, not only the name', () => {
  const src = fe('pages', 'Leaderboard.jsx');
  const rows = (src.match(/onClick=\{\(\) => setViewing\(player\)\}/g) || []).length;
  assert.equal(rows, 2, `both tables must be clickable, found ${rows}`);
  assert.match(src, /onKeyDown=\{\(e\) =>[\s\S]{0,120}?setViewing\(player\)/,
    'keyboard users need the same route in');
  // And the name itself must no longer be its own button, or the click lands
  // twice or not at all depending on where you hit.
  assert.doesNotMatch(src.slice(src.indexOf('function PlayerTag'), src.indexOf('function RankBadge')),
    /<button/, 'the name must not be a nested button any more');
});

test('the profile card shows ELO the way the profile page does', () => {
  const src = fe('components', 'ChatSidebar.jsx');
  // getDisplayRank, not getRank: same rule, but an account that has not
  // completed placement is Unranked rather than Bronze — getRank on a raw
  // rating cannot know the player has never played.
  assert.match(src, /getDisplayRank\(data\)/, 'ELO must carry its rank');
  assert.match(src, /<RankIcon rank=\{s\.rank\}/, 'with the badge');
  assert.match(src, /color: s\.rank\.color/, "and the rank's own colour");
});

test('the P&L chart accepts both date shapes instead of printing Invalid Date', () => {
  // The API sends a full ISO timestamp per point. Appending T12:00:00 to that
  // gives "...000ZT12:00:00", which parses to Invalid Date — every label on
  // the chart read "Invalid Date".
  for (const f of [['components', 'ChatSidebar.jsx'], ['pages', 'Profile.jsx']]) {
    const src = fe(...f);
    assert.match(src, /function toDate\(dateStr\)/, `${f[1]} needs the tolerant parser`);
    assert.match(src, /Number\.isNaN\(d\.getTime\(\)\) \? null : d/,
      `${f[1]} must return null rather than an Invalid Date`);
    assert.doesNotMatch(src, /new Date\(dateStr \+ 'T12:00:00'\)\.toLocale/,
      `${f[1]} still blindly appends a time`);
  }
});

// ── The ticker ──────────────────────────────────────────────────────────────

test('the ticker asks for its seed again after coming back to the app', () => {
  // It renders nothing with no items and only ever gets items from a seed it
  // asks for. Asking once on mount meant an app switch emptied it until a
  // reload.
  const src = fe('components', 'MatchTicker.jsx');
  assert.match(src, /socket\.on\('connect', ask\)/,        'after a reconnect');
  assert.match(src, /visibilitychange', onVisible/,        'when the tab comes back');
  assert.match(src, /pageshow', ask/,                      'and out of the bfcache');
  assert.match(src, /if \(socket\.connected\) socket\.emit\('request_ticker_seed'\)/,
    'asking on a dead socket does nothing, so it must check first');
});

// ── Admin ───────────────────────────────────────────────────────────────────

test('the admin dashboard reports what the wheels have paid out', () => {
  const src = be('routes', 'admin.js');
  assert.match(src, /wheel_coins_paid/);
  assert.match(src, /wheel_diamonds_paid/);
  assert.match(src, /\.eq\('type', 'rewards_spin'\)/, 'counted from the wheel transactions');
  // Its own try/catch, like the referral total — one tile must not be able to
  // take the whole dashboard down.
  const at = src.indexOf("let wheelCoins");
  assert.match(src.slice(at, at + 700), /try \{[\s\S]*?\} catch/);
  assert.match(fe('pages', 'Admin.jsx'), /Coins Paid by Wheels/);
});

// ── The bot's face ──────────────────────────────────────────────────────────

test('the opponent payload says whether it is the Duely Bot', () => {
  // Without this the client's isBot prop is always false, so the drawn robot
  // face never appeared anywhere — every bot rendered as a letter avatar.
  const payloads = HANDLERS.match(/opponent: \{ userId:[^}]*\}/g) || [];
  const bare = payloads.filter(p => !/\bisBot:/.test(p));
  assert.equal(bare.length, 0, `${bare.length} opponent payloads do not say if it is a bot`);
});

test('only the openly named bot is flagged, not the disguised queue bots', () => {
  // The free and casual queues fill with bots carrying random human names on
  // purpose. Flagging those would hand the disguise away in the avatar.
  const src = be('socket', 'handlers.js');
  assert.match(src, /const isDuelyBot = \(p\) =>/);
  assert.match(src, /p\?\.isBot === true && p\.username === 'Duely Bot'/);
  assert.equal((HANDLERS.match(/isBot: \w+(?:\.\w+)?\.isBot/g) || []).length, 0,
    'a payload is passing isBot straight through instead of through the helper');
});

test('the chat draws the bot rather than an emoji robot', () => {
  const src = fe('components', 'ChatSidebar.jsx');
  assert.doesNotMatch(src, /\u{1F916}/u, 'the emoji robot is still in the chat');
  // All three places it appears: both message lists and the profile card.
  assert.equal((src.match(/<BotAvatar/g) || []).length, 3,
    'every bot face in the chat must be the drawn one');
});

test('a bot countdown names the bot beside its face, not as bare text', () => {
  for (const page of GAME_PAGES) {
    const src = fe('pages', `${page}.jsx`);
    assert.deepEqual(src.match(/>vs Duely Bot</g) || [], [],
      `${page} shows "vs Duely Bot" as plain text`);
  }
});

// ── Result headers ──────────────────────────────────────────────────────────

test('the four result headers are drawn, not emoji', () => {
  const ui = fe('components', 'UiIcon.jsx');
  for (const kind of ['win', 'loss', 'draw', 'disconnect']) {
    assert.match(ui, new RegExp(`^  ${kind}: `, 'm'), `no drawn header for ${kind}`);
  }
  const res = fe('components', 'ResultScreen.jsx');
  assert.match(res, /<OutcomeIcon kind=\{isDraw \? 'draw' : isWinner \? 'win' : 'loss'\}/);
  assert.doesNotMatch(res, /\u{1F3C6}|\u{1F480}|\u{1F91D}/u, 'an emoji header survived');
  assert.match(fe('components', 'ForfeitToast.jsx'), /<OutcomeIcon kind="disconnect"/);
});

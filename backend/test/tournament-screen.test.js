// The tournament bet screen.
//
// It has to look like every other bet screen — same panel, same slider, same
// button — while showing three payouts instead of one. The interesting part is
// how easily it drifts into being its own thing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');
const strip = (s) => s
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const SCREEN = read('pages', 'Tournaments.jsx');
const CODE = strip(SCREEN);
const SLIDER = read('components', 'BetSlider.jsx');
const AUTH = read('context', 'AuthContext.jsx');
const HELP = read('components', 'GameHelp.jsx');
const BRACKET = read('pages', 'TournamentBracket.jsx');

// ── The bug that made the screen unusable ──────────────────────────────────

test('the screen reads the field AuthContext actually provides', () => {
  // It read `user`, which AuthContext has never exposed. Undefined is falsy,
  // so a signed-in player was shown "Login to Play" and the bot button sent
  // them to the login page — the two things reported as broken, from one
  // misremembered field name.
  const provided = AUTH.slice(AUTH.indexOf('<AuthContext.Provider value={{'),
                              AUTH.indexOf('{children}'));
  assert.ok(!/^\s*user,/m.test(provided), 'AuthContext now provides `user` — this test is stale');
  assert.match(provided, /session, profile/, 'AuthContext no longer provides session');

  assert.match(CODE, /const \{ session, profile \} = useAuth\(\)/,
    'the screen must read session, not a field that does not exist');
  assert.ok(!/\buser\b/.test(CODE),
    'something still reads `user` from the auth context, which is always undefined');
});

test('signed in, the button plays rather than offering to log in', () => {
  assert.match(CODE, /!session \? 'Login to Play'/,
    'the login prompt must hang off session, not off a missing field');
  assert.match(CODE, /if \(!session\) return navigate\('\/login'\)/,
    'entering must check session — otherwise every click goes to the login page');
});

// ── It is the same screen as the others ────────────────────────────────────

test('it uses the shared slider, not one of its own', () => {
  // BetSlider exists because the bet sections had drifted apart between games.
  // A tournament-shaped copy here would be that happening again.
  assert.match(CODE, /import BetSlider from '\.\.\/components\/BetSlider'/);
  assert.match(CODE, /<BetSlider/);
  assert.ok(!/type="range"/.test(CODE), 'a second slider implementation');
  assert.ok(!/onPointerDown/.test(CODE), 'the screen is handling its own drag');
});

test('the three stakes are the slider stops, from the server', () => {
  assert.match(CODE, /schedule\?\.stakes\.map\(s => s\.entryFee\)/,
    'the stops must come from the schedule, not be written out here');
  assert.match(CODE, /fees=\{fees\}/);
});

test('the panel is the same one every other bet screen uses', () => {
  const LOBBY = read('components', 'GameLobby.jsx');
  for (const cls of ['bg-surface border border-border rounded-2xl', 'Your Bet']) {
    assert.ok(LOBBY.includes(cls), `GameLobby no longer uses "${cls}" — this test is stale`);
    assert.ok(SCREEN.includes(cls), `the tournament panel does not match the others: ${cls}`);
  }
});

// ── Three payouts, one slider ──────────────────────────────────────────────

test('the slider can show something other than a single figure', () => {
  // Three places are paid, so one "You win" number cannot say what is at
  // stake. The slot is what keeps this on the one slider.
  assert.match(SLIDER, /payout = null/, 'BetSlider has no way to show anything else');
  assert.match(SLIDER, /payout !== null \?/, 'the slot is declared but never used');
  // And the default is untouched, so no other screen moves.
  assert.match(SLIDER, /: entryFee > 0 && \(/,
    'the single-figure default must still render when no slot is given');
});

test('all three prizes come from the server, not from arithmetic here', () => {
  // A split written out in the frontend can disagree with the one actually
  // paid, and nobody notices until the split changes.
  assert.match(CODE, /stake\.prizes\[p\.i\]/, 'the prizes must be read from the stake');
  // Multiplication by a share, not the bare numbers — 0.55 is an opacity and
  // gap-0.5 is a class name, and matching those made this fail on its own
  // styling rather than on anything to do with prizes.
  assert.ok(!/\*\s*0\.[532]/.test(CODE),
    'a prize share is being multiplied out in the frontend');
  assert.ok(!/\*\s*16/.test(CODE), 'the pot is being computed here');
  assert.ok(!/0\.95/.test(CODE), 'the fee is being applied here');
});

test('all three places are labelled and shown', () => {
  for (const p of ['1st', '2nd', '3rd']) {
    assert.ok(CODE.includes(p), `${p} place is not shown`);
  }
});

// ── The clock ──────────────────────────────────────────────────────────────

test('the countdown is type at the top, not another panel', () => {
  const top = CODE.slice(0, CODE.indexOf('<h1'));
  assert.ok(/text-4xl|text-5xl/.test(top), 'the timer is not large text');
  assert.ok(!/bg-surface/.test(top),
    'the timer is in a panel again — it should be type, above the title');
  assert.ok(top.indexOf('font-mono') > 0, 'a countdown that is not monospaced jitters as it ticks');
});

test('there is room above the title', () => {
  assert.match(CODE, /pt-4 sm:pt-6/, 'the screen still starts flush against the bar');
});

test('the countdown counts to an instant the server sent', () => {
  // Not "four minutes from now". A tab that slept would otherwise resume the
  // countdown from wherever it left off.
  assert.match(CODE, /schedule\.slot\.closesAt/);
  assert.match(CODE, /schedule\.slot\.nextStartsAt/);
  assert.match(CODE, /Math\.ceil\(\(countdownTo - now\)/);
});

// ── Bots and demo ──────────────────────────────────────────────────────────

test('the bot button asks for bots', () => {
  assert.match(CODE, /enter\(true\)/, 'the bot button does not request a bot tournament');
  assert.match(CODE, /vsBot: !!vsBot/, 'the flag never reaches the server');
});

test('entering navigates to the bracket that was created', () => {
  // It returned a pool id and went nowhere for a while — the button worked and
  // looked like it had not.
  assert.match(CODE, /navigate\(`\/tournaments\/\$\{data\.poolId\}`\)/);
  const APP = read('App.jsx');
  assert.match(APP, /path="\/tournaments\/:id"/, 'nothing renders that route');
});

// ── The podium ─────────────────────────────────────────────────────────────

test('the places are shown in podium order, not 1-2-3', () => {
  // Second, first, third — the way they stand on one. Listed in rank order it
  // reads as a table; this reads as a result, and puts the number most people
  // are looking at where the eye lands.
  const order = [...CODE.matchAll(/label: '(\dnd|\dst|\drd)'/g)].map(m => m[1]);
  assert.deepEqual(order, ['2nd', '1st', '3rd'], 'the podium is in the wrong order');
});

test('first place is bigger than the other two', () => {
  const at = CODE.indexOf('const PODIUM');
  const podium = CODE.slice(at, CODE.indexOf('];', at) + 2);
  assert.match(podium, /label: '1st'[^}]*big: true/, 'first place is not marked as the large one');
  assert.ok(!/label: '2nd'[^}]*big: true/.test(podium), 'second place is drawn large');
});

test('each place still reads its own prize, in rank order', () => {
  // The display is reordered; the server's array is not. Reading prizes[0] for
  // whatever sits leftmost would pay first place's figure to second.
  const at = CODE.indexOf('const PODIUM');
  const podium = CODE.slice(at, CODE.indexOf('];', at) + 2);
  assert.match(podium, /label: '2nd'[^}]*i: 1/);
  assert.match(podium, /label: '1st'[^}]*i: 0/);
  assert.match(podium, /label: '3rd'[^}]*i: 2/);
  assert.match(CODE, /stake\.prizes\[p\.i\]/, 'the prize is not looked up by the place');
});

test('the pot and fee line is gone', () => {
  assert.ok(!/pot/.test(CODE), 'the pot line is back under the stake');
  assert.ok(!/feeRate/.test(CODE), 'the fee line is back under the stake');
});

// ── The slider keeps up ────────────────────────────────────────────────────

test('the value follows the thumb while it is dragged', () => {
  // The three payouts are React-rendered, so without this they only change on
  // release — the slider moves and the numbers sit still.
  assert.match(CODE, /^\s*live$/m, 'the tournament slider does not ask for live values');
  assert.match(SLIDER, /live = false/, 'live is not opt-in — every other screen would re-render on drag');
  const move = SLIDER.slice(SLIDER.indexOf('function onMove'), SLIDER.indexOf('function onUp'));
  assert.match(move, /d\.setEntryFee\(d\.fees\[snapped\]\)/, 'the drag never reports a value');
  assert.match(move, /if \(snapped === d\.lastLive\) return/,
    'it would report on every pixel rather than on every stop');
});

// ── Not started yet ────────────────────────────────────────────────────────

test('a tournament that has not started keeps the player here', () => {
  assert.match(CODE, /if \(data\.started\) \{/, 'it navigates regardless of whether anything started');
  assert.match(CODE, /setEntered\(data\)/, 'nothing records that a seat was taken');
  assert.match(CODE, /You are in/, 'the player is not told they are in');
});

test('and can still go and watch if they want to', () => {
  assert.match(CODE, /Watch the bracket/, 'there is no way through to the bracket');
});

// ── The help panel ─────────────────────────────────────────────────────────

test('the help does not talk about a match that is not running', () => {
  // It is opened from the bet screen now, before anything has started. It used
  // to warn that "this is a live match", and offer to go "back to the game".
  const code = strip(HELP);
  assert.ok(!/live match/i.test(code), 'the panel still warns about a running match');
  assert.ok(!/Back to the game/i.test(code), 'the way out still points at a game not begun');
});

test('tournaments have a help entry of their own', () => {
  // Without one the panel opens empty on the only screen whose ? is not a game.
  assert.match(HELP, /^\s{2}tournament: \{/m, 'no help entry for tournaments');
  const entry = HELP.slice(HELP.indexOf('  tournament: {'), HELP.indexOf('  tower: {'));
  assert.match(entry, /how: \[/);
  assert.match(entry, /win:/);
});

// ── The bracket screen ─────────────────────────────────────────────────────

test('the bracket asks the backend, not the site that served the page', () => {
  // VITE_API_URL points the app at the backend's own host. A hardcoded
  // "/api/..." asks whoever served the HTML, which has no such route — that is
  // the whole of "Lost contact with the tournament".
  const code = strip(BRACKET);
  assert.match(code, /import \{ api \} from '\.\.\/utils\/api'/);
  assert.match(code, /api\.get\(`\/tournaments\/\$\{id\}`\)/);
  assert.ok(!/fetch\(`\/api\//.test(code), 'a bare relative fetch will hit the wrong host');
});

test('a finished tournament is not reported as a network failure', () => {
  const code = strip(BRACKET);
  assert.match(code, /status === 404/, 'every failure reads as lost contact');
});

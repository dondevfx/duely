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
  assert.match(CODE, /stake\.prizes\[i\]/, 'the prizes must be read from the stake');
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

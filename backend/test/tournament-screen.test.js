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

test('the countdown is type under the title, not another panel', () => {
  // It sits with the name rather than in a panel further down competing with
  // the stake — it is the one fact that decides whether to enter now or come
  // back. Large, monospaced, and not boxed.
  const titleAt = CODE.indexOf('<h1');
  const clockAt = CODE.indexOf('Entry closes in');
  assert.ok(titleAt > 0 && clockAt > titleAt,
    'the clock is above the title again');

  // Scoped to the clock's OWN wrapper. A window of a few hundred characters
  // either side reaches into the stake panel below it, whose bg-surface then
  // reads as the clock being boxed.
  const wrapAt = CODE.indexOf('text-center -mt-1');
  assert.ok(wrapAt > 0, 'the clock has no wrapper of its own');
  const openTag = CODE.slice(CODE.lastIndexOf('<div', wrapAt), CODE.indexOf('>', wrapAt));
  assert.ok(!/bg-surface|border/.test(openTag), `the timer is in a panel again: ${openTag}`);

  const clock = CODE.slice(wrapAt, CODE.indexOf('Your Bet', wrapAt));
  assert.ok(/text-4xl|text-5xl/.test(clock), 'the timer is not large text');
  assert.ok(/font-mono/.test(clock), 'a countdown that is not monospaced jitters as it ticks');
});

test('the clock rolls over to the next slot without a reload', () => {
  // The schedule names ONE slot with fixed instants in it. Left alone the
  // countdown reaches 0:00 and stays there: the window has closed, the next
  // tournament has opened, and the screen still describes the old one.
  assert.match(CODE, /const \[epoch, setEpoch\] = useState\(0\)/,
    'nothing triggers a refetch');
  assert.match(CODE, /\}, \[epoch\]\);/, 'the schedule is still fetched once, on mount');
  assert.match(CODE, /if \(now < schedule\.slot\.nextStartsAt\) return;/,
    'nothing notices the slot has passed');
  assert.match(CODE, /setEpoch\(e => e \+ 1\)/);
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

test('entering takes you to the bracket, started or not', () => {
  // It used to keep the player here with a panel saying they were in and a
  // link to go and look — a second click to reach the screen they had just
  // asked for. The bracket's own waiting state is the better version of that
  // panel: the same seats-taken count, the faces as they arrive, and it turns
  // into the tournament without moving anybody.
  assert.match(CODE, /navigate\(`\/tournaments\/\$\{data\.poolId\}`\)/,
    'entering does not go to the bracket');
  assert.ok(!/if \(data\.started\)/.test(CODE),
    'it still decides whether to leave based on what started');
  assert.ok(!/Watch the bracket/.test(CODE), 'the second click is still there');
  assert.ok(!/You are in/.test(CODE), 'the panel it replaced is still rendered');
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

// ── The round clock ────────────────────────────────────────────────────────

test('the round clock sits below the bar, not across the balance', () => {
  // The navbar is fixed at the top, 3.5rem tall, at z-50. The clock started
  // above it, which put it straight over the balance — the one number on the
  // page nobody wants covered. Below it, the centre of every game's top strip
  // is free: all five put their scores at the left and right of that row.
  const fs = require('node:fs');
  const path = require('node:path');
  const clock = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'TournamentClock.jsx'), 'utf8');

  assert.match(clock, /3\.5rem/, 'the clock does not clear the bar');
  assert.match(clock, /zIndex: 40/, 'the clock is not below the bar');
  assert.ok(!/zIndex: (5[0-9]|[6-9][0-9])/.test(clock), 'the clock can still cover the bar');

  // Two homes. Block Burst and Word VS leave the centre of the top strip
  // empty; the other three fill it, so on those it goes to the bottom left.
  assert.match(clock, /TOP_CENTRE = new Set\(\['block-blast', 'scrabble'\]\)/,
    'the two games with a free top centre are not the ones using it');
  assert.match(clock, /bottom: 'calc\(env\(safe-area-inset-bottom/,
    'there is no bottom placement for the games whose top strip is full');

  // And only while a game is on screen. Leaving a tournament sends no event
  // that ends the match, so the clock used to count down over the lobby.
  assert.match(clock, /pathname\?\.startsWith\('\/game\/'\)/,
    'the clock does not check whether a game is being played');
  assert.match(clock, /if \(!match \|\| !game\) return null;/,
    'the clock renders off a game screen');

  // Driven by the socket, not by route state: a reloaded game screen has no
  // navigation state and the clock silently never appeared.
  assert.match(clock, /socket\.on\('tournament_match'/, 'the clock only learns from navigation');
  assert.match(clock, /socket\.on\('tournament_result'/, 'nothing stops it counting after the match');
});

test('no game prints its own name over the board', () => {
  // A second heading for a screen with one job, and it is exactly where the
  // tournament clock sits.
  const fs = require('node:fs');
  const path = require('node:path');
  const pages = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages');
  for (const [file, label] of [['BlockBlastGame.jsx', 'Score Race'], ['WordleGame.jsx', 'Word Race']]) {
    const code = fs.readFileSync(path.join(pages, file), 'utf8');
    const rendered = code.split(/\r?\n/).filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    assert.ok(!rendered.includes(`>${label}<`), `${file} still prints "${label}" over the board`);
  }
});

test('every result card names whose number is whose', () => {
  // "20 — 2" on one line reads as a scoreline in some other order the moment
  // the numbers are close or one of them is small. Rush Hour, Colour Rush and
  // Word VS all named theirs; Block Burst and Tower did not.
  const fs = require('node:fs');
  const path = require('node:path');
  const pages = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages');

  for (const [file, mine, theirs] of [
    ['BlockBlastGame.jsx', 'Your Score',  'Opponent Score'],
    ['TowerGame.jsx',      'Your Blocks', 'Opponent Blocks'],
    ['CarDashGame.jsx',    'Your Time',   'Opponent Time'],
    ['ColorRushGame.jsx',  'Your Diamonds', 'Opponent Diamonds'],
    ['WordleGame.jsx',     'Your guesses',  'Their guesses'],
  ]) {
    const code = fs.readFileSync(path.join(pages, file), 'utf8');
    assert.ok(code.includes(mine), `${file} does not label your own number`);
    assert.ok(code.includes(theirs), `${file} does not label the opponent's`);
  }
});

test('the tournament payout is the colour of money, not of a button', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const card = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'ResultScreen.jsx'), 'utf8');
  const finish = card.slice(card.indexOf('function TournamentFinish'));
  assert.match(finish, /text-success/, 'the payout is not green');
  assert.ok(!/grid-cols-3/.test(finish),
    'the podium is still repeated under a card that already shows the result');
});

// ── On a desktop ───────────────────────────────────────────────────────────

test('the tournament screens are not shrunk the way ordinary pages are', () => {
  // tv-scale applies a CSS zoom to every ordinary page on a large monitor —
  // 0.92 at 1080p and less above that. Every other bet screen lives under
  // /game/ and is exempt, so the tournament one was the only bet screen in the
  // app being shrunk, sitting at a different size from the seven it is meant
  // to match.
  //
  // The bracket and the draw are exempt with it: the draw is a fixed
  // full-screen layer, and a zoomed ancestor is what breaks the geometry of
  // those.
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf8');

  const decl = app.slice(app.indexOf('const isGamePage'), app.indexOf('// When MFA is pending'));
  assert.match(decl, /startsWith\('\/tournaments'\)/,
    'the tournament screens are still being scaled with ordinary pages');
  assert.match(decl, /startsWith\('\/game\/'\)/, 'the game pages lost their exemption');
  assert.match(app, /isGamePage \? '' : 'tv-scale'/, 'the exemption is no longer what applies tv-scale');
});

test('every game clip has a poster, and none is older than its clip', () => {
  // The card shows the poster until the clip loads and then the clip covers
  // it, both with the same object-position — so a poster from an older cut of
  // the clip is a still that jumps the moment the video takes over, and a
  // missing one leaves the card on its fallback icon.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'frontend', 'public', 'game-clips');

  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.mp4'))) {
    const jpg = path.join(dir, file.replace(/\.mp4$/, '.jpg'));
    assert.ok(fs.existsSync(jpg), `${file} has no poster`);
    assert.ok(fs.statSync(jpg).mtimeMs >= fs.statSync(path.join(dir, file)).mtimeMs,
      `${file} is newer than its poster — the still is from an older cut`);
    assert.ok(fs.statSync(jpg).size > 1024, `${jpg} is too small to be a real frame`);
  }
});

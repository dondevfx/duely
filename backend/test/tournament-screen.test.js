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
  // More than a bet screen with game art behind it, because this one has none
  // and the name sat directly under the bar.
  assert.match(CODE, /pt-8 sm:pt-12/, 'the screen still starts flush against the bar');
});

test('the countdown counts to an instant the server sent', () => {
  // Not "four minutes from now". A tab that slept would otherwise resume the
  // countdown from wherever it left off.
  assert.match(CODE, /schedule\.slot\.closesAt/);
  assert.match(CODE, /schedule\.slot\.nextStartsAt/);
  assert.match(CODE, /Math\.ceil\(\(countdownTo - now\)/);
});

// ── Bots and demo ──────────────────────────────────────────────────────────

test('there is one way in, and it is a real tournament', () => {
  // The bot bracket was a labelled testing route on the live screen: free,
  // paying nothing, sixteen bots. It is gone. Demo accounts still fill their
  // own bracket with bots — that is what makes a demo a demo — but a real
  // account has one button and it enters a real tournament.
  assert.ok(!/enter\(true\)/.test(CODE), 'the bot bracket can still be entered');
  assert.ok(!/vsBot/.test(CODE), 'the screen still asks the server for bots');
  assert.ok(!/Play vs Bots/.test(CODE), 'the button is still on the screen');
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
  const card = read('components', 'ResultScreen.jsx');
  const row = card.slice(card.indexOf('tour?.pays != null'));
  assert.match(row.slice(0, 1200), /text-success/, 'the payout is not green');
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

// ── Leaving, and coming back to nothing ────────────────────────────────────

test('a refresh while waiting lands on the lobby, not the waiting room', () => {
  // Refreshing while a bracket fills takes the seat back and refunds the
  // entry — a refresh is indistinguishable from leaving. What used to happen
  // next is that the screen reloaded, found the pool still filling with other
  // people in it, and showed the waiting room as though the seat were held.
  const bracket = read('pages', 'TournamentBracket.jsx');
  assert.match(bracket, /p\.state === 'filling' && !p\.players\.some\(x => x\.userId === me\)/,
    'the screen does not notice the seat is gone');
  assert.match(bracket, /navRef\.current\('\/tournaments', \{ replace: true \}\)/);
});

test('a refresh mid-round lands on the tournaments page', () => {
  // Reloading loses the navigation state that says this was a tournament
  // round, and the server has already taken the player out for disconnecting —
  // so what came back was an ordinary game lobby offering to queue, with no
  // sign a tournament had been walked out of.
  const fs = require('node:fs');
  const path = require('node:path');
  const hook = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'hooks', 'useTournamentRound.js'), 'utf8');

  assert.match(hook, /sessionStorage\.setItem\(KEY, poolId\)/,
    'nothing survives the reload to say a round was being played');
  assert.match(hook, /navigate\('\/tournaments', \{ replace: true \}\)/);
  // And it is cleared on every ordinary ending, or the next visit to any game
  // would bounce.
  assert.match(hook, /removeItem\('tournamentRound'\)/);
});

test('the tournament ends in one place, not two', () => {
  // The result card shows where they came and what they won. The bracket used
  // to show the podium again one screen later — two endings for one
  // tournament, and the second arrived after they had stopped reading.
  const bracket = read('pages', 'TournamentBracket.jsx');
  assert.ok(!/function Podium/.test(bracket), 'the bracket still has a results screen');
  assert.match(bracket, /const onOver = \(p\) => \{[\s\S]*?navRef\.current\('\/tournaments'/,
    'the end of a tournament does not send anyone anywhere');

  const card = read('components', 'ResultScreen.jsx');
  assert.match(card, /tour\?\.pays != null/, 'the card no longer shows what was won');
  assert.match(card, /\{tour\.settled && <ResultTimer/,
    'the card can still leave before it knows whether anything was won');
});

test('the last two matches show their payout on the result card', () => {
  // Second place is a payout too, so the row does not ask who won — it asks
  // what this outcome was worth.
  const card = read('components', 'ResultScreen.jsx');
  assert.match(card, /tour\?\.pays != null/, 'the card ignores what the match pays');
  assert.match(card, /isWinner \? tour\.pays\.win : tour\.pays\.lose/,
    'the loser of a final is not shown their second-place prize');
  assert.match(card, /text-success/, 'the payout is not green');
});

test('a shortfall is a dialog, not a relabelled button', () => {
  // Every betting screen answers this the same way: the buttons keep their
  // shape whatever the balance, and pressing one you cannot cover opens the
  // dialog. The tournament screen was rewriting its own button instead.
  assert.match(SCREEN, /InsufficientModal/, 'there is no dialog to open');
  assert.match(SCREEN, /if \(!canAfford\) return setShortfall\(true\)/,
    'the button does not open it');
  assert.ok(!/Need \$\{entryFee\} coins/.test(SCREEN),
    'the button still relabels itself when short');
  assert.ok(!/session && !canAfford/.test(SCREEN),
    'the button is still disabled by the balance');
});

test('what the server sends about a match reaches the screen that shows it', () => {
  // The bug this exists for: the bracket hand-listed the fields it copied into
  // the game screen's navigation state, so every field the server added had to
  // be added here too. The first one that was not was `pays` — what the final
  // and the playoff are worth. The server sent it, the bracket dropped it, and
  // the result card had nothing to show a champion.
  //
  // Asserting the two ends carry it is what the earlier tests did, and both
  // passed while the middle threw it away. This asserts the middle.
  const bracket = read('pages', 'TournamentBracket.jsx');
  const onMatch = bracket.slice(bracket.indexOf('const onMatch'), bracket.indexOf('socket.on(\'tournament_update\''));

  assert.match(onMatch, /tournament: \{ \.\.\.m/,
    'the bracket picks fields out of the match instead of forwarding it');
  assert.ok(!/roomId: m\.roomId, round: m\.round/.test(onMatch),
    'the hand-written field list is back — the next field added will be dropped');

  // And the card can find it without the route, because a reload loses that.
  const hook = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'hooks', 'useTournamentResult.js'), 'utf8');
  assert.match(hook, /socket\.on\('tournament_match', onMatch\)/,
    'the payout is only ever read from navigation state');
  assert.match(hook, /m\.pays !== undefined/);
});

// ── The home card's clock ──────────────────────────────────────────────────

test('the tournament card carries the real clock, in two states', () => {
  // Blue and breathing while entry is open, plain white while it is not. One
  // of those two states is something a player can act on right now, and it
  // should be the one that catches the eye — but slowly: this sits beside a
  // looping clip, and a fast blink reads as an alert rather than as a clock.
  const home = read('pages', 'Home.jsx');
  assert.match(home, /useTournamentClock/, 'the card has no clock');
  assert.match(home, /game\.slug === 'tournament' \? <TournamentCountdown/,
    'the clock is on the wrong card, or on all of them');
  assert.match(home, /clock\.joinOpen \? 'text-primary' : 'text-white'/);
  assert.match(home, /animation: 'tourPulse/);

  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'index.css'), 'utf8');
  assert.match(css, /@keyframes tourPulse/, 'the animation does not exist');
  assert.match(css, /prefers-reduced-motion[\s\S]*?tourPulse[\s\S]*?animation: none/,
    'the pulse ignores a reduced-motion preference');

  // Counting to an instant the server sent, not down from a number a sleeping
  // tab would resume from.
  const hook = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'hooks', 'useTournamentClock.js'), 'utf8');
  assert.match(hook, /schedule\.slot\.closesAt/);
  assert.match(hook, /schedule\.slot\.nextStartsAt/);
  assert.match(hook, /setEpoch\(e => e \+ 1\)/, 'the clock stops at zero when the slot passes');
  assert.match(hook, /if \(!schedule\) return null/,
    'a failed fetch would render a placeholder instead of nothing');
});

test('the tournament is not shown its payout twice', () => {
  // The card already says who won and what it paid. A second panel under it
  // said "You won the tournament" and printed the same number again — the one
  // screen where the number is the point, showing it twice.
  const card = read('components', 'ResultScreen.jsx');
  assert.ok(!/TournamentFinish/.test(card), 'the second payout panel is back');
  assert.match(card, /tour\?\.pays != null/, 'the payout row itself has gone with it');
});

test('the bracket is pinned, so a game does not start half scrolled', () => {
  // The bracket is where a player waits, and waiting means scrolling. Whatever
  // offset they left it at was still there when the round dropped them into a
  // game, so the board arrived part way off the screen.
  const bracket = read('pages', 'TournamentBracket.jsx');
  assert.match(bracket, /useGameScrollLock\(true,/, 'the bracket still scrolls');
  assert.match(bracket, /pool\?\.state[\s\S]{0,60}pool\?\.round/,
    're-pinning does not follow the phase, so it fires once and never again');
});

test('the bet screens sit where they should under the bar', () => {
  // Tournaments has no game art behind the title, so it needs more air above
  // it than a bet screen that does. Coin Flip had the opposite problem: its
  // lobby was centred in a full-height column, which floated the title in the
  // middle of a desktop page.
  assert.match(SCREEN, /animate-slide-up pt-8 sm:pt-12/, 'the tournament title is still crowded');

  const coin = read('pages', 'CoinFlipGame.jsx');
  assert.match(coin, /phase === 'lobby' \? 'justify-start pt-3 sm:pt-5' : 'justify-center'/,
    'the coin flip lobby is still centred vertically');
});

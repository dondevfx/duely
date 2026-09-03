// The stripped-back Home at every width, and the words on the buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fe = (...p) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const HOME    = fe('pages', 'Home.jsx');
const LOBBY   = fe('components', 'GameLobby.jsx');
const CREATE  = fe('components', 'CreateRoomModal.jsx');
const LINKBOX = fe('components', 'ChallengeLinkBox.jsx');
const SIDEBAR = fe('components', 'LeftSidebar.jsx');
const NAVBAR  = fe('components', 'Navbar.jsx');
const WALLET  = fe('pages', 'Wallet.jsx');

test('the cut sections are hidden at every width, not just on phones', () => {
  const code = strip(HOME);
  assert.match(code, /const PHONE_HIDE\s+= PHONE_MINIMAL \? 'hidden' : ''/);
  assert.match(code, /const PHONE_HIDE_FLEX = PHONE_MINIMAL \? 'hidden' : 'flex'/);
  assert.ok(!/PHONE_MINIMAL \? 'hidden sm:/.test(code),
    'a breakpoint here means the desktop keeps the old layout');
});

test('the two blocks that were desktop-only on their own are on the switch too', () => {
  // The hero spin wheel and the referral card were `hidden lg:block` rather
  // than wired to PHONE_MINIMAL, so they survived the cut on a wide screen —
  // which is the argument for one switch instead of a breakpoint per section.
  const code = strip(HOME);
  assert.match(code, /const PHONE_HIDE_LG\s+= PHONE_MINIMAL \? 'hidden' : 'hidden lg:block'/);
  assert.ok(!/className="hidden lg:block/.test(code),
    'a section still gated on its own breakpoint is a section the switch does not reach');
});

test('the hero uses one set of spacing, not a desktop set as well', () => {
  // The desktop padding was chosen for a hero that still had content under
  // the title; keeping it would pad an empty space.
  const code = strip(HOME);
  assert.match(code, /<section className="relative pt-3 pb-2 px-4 overflow-hidden">/);
  assert.ok(!/md:pt-14|md:pb-10/.test(code));
});

test('PHONE_MINIMAL still restores everything', () => {
  // It is the switch, not a leftover — the sections are hidden, never deleted.
  const code = strip(HOME);
  // Whitespace flattened rather than matched: the declarations are
  // column-aligned, so the gap before the `=` is several spaces, not one.
  const flat = code.replace(/\s+/g, ' ');
  for (const c of ['PHONE_HIDE', 'PHONE_HIDE_FLEX', 'PHONE_HIDE_LG']) {
    assert.ok(flat.includes(`${c} = PHONE_MINIMAL ?`), `${c} must stay conditional`);
  }
  assert.ok(code.includes('<DailySpinWidget'), 'the widget is hidden, not removed');
  assert.ok(code.includes('<ReferralCard'), 'the card is hidden, not removed');
});

test('Games is gone from both navigations', () => {
  // Home IS the games list now, so a Games page was the same screen reached a
  // second way. The route still exists.
  for (const [name, src] of [['LeftSidebar', SIDEBAR], ['Navbar', NAVBAR]]) {
    assert.ok(!/label: 'Games'/.test(src), `${name} still lists a Games tab`);
  }
});

test('the primary lobby action says Play', () => {
  assert.match(LOBBY, /: 'Play'\}/);
  assert.ok(!/'Find Opponent'/.test(LOBBY));
  for (const page of ['CoinFlipGame.jsx', 'BlackjackGame.jsx']) {
    assert.ok(!/Find Opponent/.test(strip(fe('pages', page))), `${page} still says Find Opponent`);
  }
});

test('the invite dialog is a title, a link, and who can take it', () => {
  const code = strip(CREATE);
  assert.match(code, /<div className="text-lg font-black text-white mb-4">Invite<\/div>/);
  assert.match(code, /<UiIcon name="share" size=\{18\} \/>Invite Link/);
  // The sentence under the title explained what a link is, which the button
  // below already says — on a dialog this short that is most of the dialog.
  assert.ok(!/Get a link to send anyone/.test(code));
  assert.ok(!/Or invite an online friend/.test(code));
  // An empty space where a list would be reads as something that failed to
  // load. A state is worth naming.
  assert.match(code, /onlineFriends\.length === 0 && \(/);
  assert.match(code, />No friends online</);
});

test('the shared link is called an Invite Link', () => {
  assert.match(LINKBOX, /noun="Invite Link"/);
});

test('the wallet shows its balance in the bar instead of twice', () => {
  const code = strip(WALLET);
  assert.ok(!/Coin Balance/.test(code), 'the card duplicated the navbar and pushed Deposit below the fold');
  assert.match(code, /useEffect\(\(\) => \{ setDisplayCurrency\('coins'\); \}, \[setDisplayCurrency\]\)/);
  // Deliberately not restored on the way out: the bet screens set this
  // deliberately and expect it to stick.
  assert.ok(!/return \(\) => setDisplayCurrency/.test(code));
});

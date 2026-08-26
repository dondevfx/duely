// A player uploaded a picture, saw it on their profile, and nowhere else.
//
// The same avatar circle was hand-written in a dozen places — navbar,
// sidebar, chat messages, the chat profile popup, leaderboard podium and
// rows, admin lists and panel, profile header — and only two of them learned
// to render a picture. Worse, most of the BACKEND queries feeding those
// places never selected avatar_url at all, so even a correct component would
// have had nothing to show.
//
// These tests exist because "did every copy get updated?" is exactly the
// question that is easy to answer wrongly by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

// ── The data has to arrive ──────────────────────────────────────────────

test('every profile query that feeds an avatar selects avatar_url', () => {
  const sources = [
    ['leaderboard.js',   be('routes', 'leaderboard.js')],
    ['auth.js',          be('routes', 'auth.js')],
    ['admin.js',         be('routes', 'admin.js')],
    ['socket/handlers',  be('socket', 'handlers.js')],
  ];
  for (const [name, src] of sources) {
    assert.match(src, /avatar_url/,
      `${name} never selects avatar_url — the component would render a picture that was never sent`);
  }
});

test('admin transaction joins include the avatar', () => {
  // These are .select('*, profiles(...)') joins. The * covers the
  // transaction, not the joined profile, so the columns must be listed.
  const src = be('routes', 'admin.js');
  const joins = [...src.matchAll(/profiles\(([^)]*)\)/g)].map(m => m[1]);
  const withUsername = joins.filter(j => j.includes('username'));
  assert.ok(withUsername.length > 0, 'expected profile joins to exist');
  for (const j of withUsername) {
    // A join used only for a name (support tickets) does not need it; the
    // ones that also pull profile_color are the ones rendering an avatar.
    if (j.includes('profile_color')) {
      assert.match(j, /avatar_url/,
        `a join rendering an avatar omits avatar_url: profiles(${j})`);
    }
  }
});

test('chat messages carry the sender avatar', () => {
  // Chat renders from the socket payload, not from a profile fetch, so the
  // URL has to travel with the message itself.
  const src = strip(be('socket', 'handlers.js'));
  const emit = src.slice(src.indexOf("io.emit('chat_message'"), src.indexOf("io.emit('chat_message'") + 500);
  assert.match(emit, /avatarUrl/, 'chat_message must include the sender avatar');
});

// ── Missing migrations must not break anything ──────────────────────────

test('the socket auth query degrades instead of failing every login', () => {
  // PostgREST rejects the WHOLE query for one unknown column. Adding
  // avatar_url to the socket profile select without a fallback would have
  // meant "Profile not found" for every player before section 18 ran —
  // which is exactly what a previous change here already caused once.
  const src = strip(be('socket', 'handlers.js'));
  assert.match(src, /CORE_COLS/, 'core columns must be separable from optional ones');
  assert.match(src, /OPTIONAL/, 'optional column groups must be declared');
  assert.match(src, /avatar_url/, 'avatar_url must be one of the optional groups');
  // The loop peels groups off rather than giving up on the first failure.
  assert.match(src, /for \(let drop = 0; drop <= OPTIONAL\.length; drop\+\+\)/);
});

test('the leaderboard retries without avatar_url rather than 500ing', () => {
  const src = strip(be('routes', 'leaderboard.js'));
  assert.match(src, /async function selectWithOptional/,
    'a shared retry helper must exist — this pattern was forgotten twice when written by hand');
  const uses = (src.match(/selectWithOptional\(/g) || []).length;
  // One definition + three leaderboards.
  assert.ok(uses >= 4, `expected every leaderboard query to use it, found ${uses}`);
});

test('the admin fallback column list has no migration-dependent columns in it', () => {
  // PROFILE_BASE is what the panel falls back TO. Putting avatar_url in it
  // would break the very query meant to survive without avatar_url.
  const src = be('routes', 'admin.js');
  const line = src.slice(src.indexOf('const PROFILE_BASE'), src.indexOf('\n', src.indexOf('const PROFILE_BASE')));
  assert.ok(!/avatar_url|avatar_banned|banned/.test(line),
    `PROFILE_BASE must stay safe to query on an un-migrated database: ${line}`);
});

// ── Every render site shows it ──────────────────────────────────────────

test('there is a shared Avatar component', () => {
  const src = fe('components', 'Avatar.jsx');
  assert.match(src, /export default function Avatar/);
  assert.match(src, /object-cover/, 'a non-square upload must fill the circle, not letterbox inside it');
  assert.match(src, /username\?\.\[0\]\?\.toUpperCase\(\)/,
    'the coloured initial stays the default when there is no picture');
});

test('no avatar render site shows only an initial', () => {
  // Catches the actual bug: a circle that renders username[0] and nothing
  // else. Every occurrence must sit on the fallback side of a picture check.
  const files = [
    ['components/Navbar.jsx',      fe('components', 'Navbar.jsx')],
    ['components/LeftSidebar.jsx', fe('components', 'LeftSidebar.jsx')],
    ['components/ChatSidebar.jsx', fe('components', 'ChatSidebar.jsx')],
    ['pages/Leaderboard.jsx',      fe('pages', 'Leaderboard.jsx')],
    ['pages/Admin.jsx',            fe('pages', 'Admin.jsx')],
    ['pages/Profile.jsx',          fe('pages', 'Profile.jsx')],
  ];
  for (const [name, src] of files) {
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/username\??\.?\[0\]\??\.?toUpperCase\(\)/.test(line)) return;
      // Acceptable shapes: the fallback arm of a ternary (starts with ':'),
      // or inside the shared Avatar component.
      const isFallbackArm = /^\s*[:?]/.test(line) || /\?[^?]*:[^:]*toUpperCase/.test(line);
      const nearby = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
      const hasPictureCheck = /avatar_url|avatarUrl|<Avatar/.test(nearby);
      assert.ok(isFallbackArm || hasPictureCheck,
        `${name}:${i + 1} renders an initial with no picture check above it — an uploaded avatar would not appear here`);
    });
  }
});

test('the shared component is actually used, not just defined', () => {
  for (const [name, src] of [
    ['Navbar.jsx',      fe('components', 'Navbar.jsx')],
    ['LeftSidebar.jsx', fe('components', 'LeftSidebar.jsx')],
  ]) {
    assert.match(src, /<Avatar\b/, `${name} should use the shared component`);
    assert.match(src, /import Avatar from/, `${name} is missing the import`);
  }
});

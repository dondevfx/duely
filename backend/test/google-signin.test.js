// Signing in with Google.
//
// Google does not distinguish signing up from signing in, and neither does
// this: the same button on both pages, and an account arriving for the first
// time gets a profile made for it on the way back through /auth/callback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const fe = (...p) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');

// ── The client half ───────────────────────────────────────────────────────

test('OAuth uses the implicit flow, because PKCE cannot work here', () => {
  // PKCE stashes a code verifier before leaving for Google and reads it back
  // on return — but persistSession:false leaves supabase-js with in-memory
  // storage, which does not survive leaving the page. Every sign-in would
  // fail to exchange.
  const src = fe('utils', 'supabase.js');
  assert.match(src, /flowType: 'implicit'/);
  assert.match(src, /persistSession: false/);
});

test('the token never stays in the address bar', () => {
  // An access token in the fragment is a token in browser history, in the tab
  // title, and in anything the user pastes when asking for help. Cleared
  // before anything else can fail.
  const cb = fe('pages', 'AuthCallback.jsx');
  const clear = cb.indexOf("window.history.replaceState(null, '', '/auth/callback')");
  const read = cb.indexOf("params.get('access_token')");
  assert.ok(clear > 0, 'the fragment is never cleared');
  assert.ok(read > clear, 'the fragment must be cleared before the tokens are used');
});

test('the callback survives React running the effect twice', () => {
  // StrictMode runs effects twice in development, and adopting one-time tokens
  // twice is not something to discover in production.
  const cb = fe('pages', 'AuthCallback.jsx');
  assert.match(cb, /const started = useRef\(false\)/);
  assert.match(cb, /if \(started\.current\) return;/);
});

test('a cancelled Google window is not a crash', () => {
  const cb = fe('pages', 'AuthCallback.jsx');
  assert.match(cb, /params\.get\('error_description'\) \|\| params\.get\('error'\)/);
  assert.match(cb, /navigate\('\/login', \{ replace: true \}\)/);
});

test('the Google button is off both pages while verification is pending', () => {
  // Taken off the front end, not deleted. Google's OAuth branding check has
  // not passed for duely.us, and a button that sends people to a consent
  // screen Google flags as unverified is worse than no button.
  //
  // Everything behind it is intact — the component, /auth/callback,
  // signInWithGoogle, and POST /auth/oauth-profile all still work and are
  // still covered by the tests around this one. Putting it back is one import
  // and one <GoogleSignInButton /> per page.
  for (const page of ['Login.jsx', 'Signup.jsx']) {
    const src = fe('pages', page);
    assert.doesNotMatch(src, /<GoogleSignInButton \/>/, `${page} still renders it`);
    assert.doesNotMatch(src, /import GoogleSignInButton/, `${page} still imports it`);
  }
});

test('the machinery behind the button is still there to switch back on', () => {
  // The point of removing only the button: none of this has to be rebuilt.
  assert.match(fe('components', 'GoogleSignInButton.jsx'), /signInWithGoogle/);
  assert.match(fe('App.jsx'), /path="\/auth\/callback"/);
  const ctx = fe('context', 'AuthContext.jsx');
  assert.match(ctx, /signInWithGoogle/);
  assert.match(ctx, /completeOAuthLogin/);
});

test('the profile is created before it is fetched', () => {
  // On a first sign-in there is no profile to fetch — the call that creates it
  // has to come first, or the app lands with a session and no username.
  const ctx = fe('context', 'AuthContext.jsx');
  const post = ctx.indexOf("api.post('/auth/oauth-profile'");
  assert.ok(post > 0, 'the profile is never created');
  const fetchP = ctx.indexOf('await fetchProfile();', post);
  assert.ok(fetchP > post, 'fetchProfile runs before the profile exists');
});

test('the home page says something without JavaScript', () => {
  // Google's OAuth branding check fetches the home page and does not run JS.
  // An empty page reads as an unresponsive site to it, and it rejected
  // verification on exactly that. Link previews and search crawlers read the
  // page the same way.
  //
  // The visible splash is now just the wordmark, so the text lives in
  // <noscript> — served to everyone, shown only to a reader with no
  // JavaScript, who is precisely the audience it is written for. That is the
  // honest way to do it: nothing is hidden from anyone, and no text is served
  // to crawlers that a person could not also see by turning JS off.
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/);
  assert.ok(noscript, 'nothing is served to a reader without JavaScript');
  const text = noscript[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(text.length > 200, `only ${text.length} characters render without JS`);
  assert.match(text, /Duely/);
});

test('the splash a person sees is the wordmark and nothing else', () => {
  // Asked for directly: no copy on the loading screen. The description moved
  // to <noscript> rather than being deleted, so this must not quietly grow
  // text back into the visible half.
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  // Comments stripped FIRST. The comment above the splash quotes the literal
  // string <div id="root"></div> while explaining the bug, so matching before
  // stripping finds the one inside the comment.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const root = markup.match(/<div id="root">([\s\S]*?)<noscript>/);
  assert.ok(root, 'the splash markup is gone');
  const visible = root[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(visible, 'Duely',
    `the splash shows "${visible}" — it should be the wordmark alone`);
});

test('the splash says what the product actually is', () => {
  // It is the first thing a person sees on a slow connection AND the
  // description Google reads back when deciding whether the app matches its
  // stated purpose, so it has to be true on both counts.
  //
  // The first version got two things wrong: it ruled out chance entirely while
  // listing two games that turn on it, and it named a game by its internal
  // route rather than the name players see.
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const root = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/);
  assert.ok(root, 'no #root, or nothing between it and the app script');
  const text = root[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Checked against the real list, so the copy cannot drift from the product.
  const games = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'data', 'games.js'), 'utf8');
  const titles = [...games.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1])
    .filter((t) => t !== 'Quick Match');   // a mode, not a game
  assert.ok(titles.length >= 7, `only found ${titles.length} games to check against`);
  for (const t of titles) {
    assert.ok(text.includes(t), `the splash does not mention ${t}`);
  }

  // 'car-dash' is the route; players see Rush Hour.
  assert.doesNotMatch(text, /Car Dash/, 'that is a route slug, not a name any player sees');

  // Chance cannot be ruled out while Coin Flip and Blackjack are on the list.
  assert.doesNotMatch(text, /never on chance|not on chance|no element of chance/i,
    'Coin Flip and Blackjack turn on chance — this cannot be denied outright');

  // A skill claim is fine, and true of five of the seven — but it has to be
  // qualified. "Matches are decided on skill" is a claim about all of them.
  if (/skill/i.test(text)) {
    assert.match(text, /\b(most|many|some|five)\b[^.]*skill/i,
      'an unqualified skill claim covers Coin Flip and Blackjack too, and is false of both');
  }
});

test('the splash reads as a loading screen, not a failed page', () => {
  // React replaces it on mount, but on a phone on mobile data that is a second
  // or two of real screen time — long enough that a left-aligned wall of
  // marketing copy reads as the site having failed to load.
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  assert.match(html, /class="boot"/);
  // The spinner is gone — the splash is the wordmark alone, as asked. The
  // pulsing dot is what now says "working", and it is the same dot the navbar
  // carries, so the splash reads as the app starting rather than as a
  // different page that then changes.
  assert.match(html, /class="boot-dot"/, 'nothing on screen says the page is doing anything');
  assert.match(html, /boot-pulse/, 'the dot does not move');
  assert.match(html, /prefers-reduced-motion/, 'the animation must respect reduced motion');
  assert.match(html, /#1250B4/, 'the wordmark must carry the brand colour, not a default');
  // The app's stylesheet has not loaded at this point, so the reset has to be
  // here — without it the default 8px body margin made the splash 876px
  // against an 812px viewport and it scrolled.
  assert.match(html, /html, body \{ margin: 0/, 'without this the splash scrolls');
});

test('robots.txt is a robots file, not the app', () => {
  // Every unmatched path rewrites to index.html, so without a real file at
  // this path a crawler asking for robots.txt is handed the SPA's HTML.
  const robots = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'public', 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent:/m);
  assert.doesNotMatch(robots, /<html|<!DOCTYPE/i);
});

// ── The server half ───────────────────────────────────────────────────────

// A profiles table that answers the three things the route asks it: does this
// id have a row, is this username taken, and insert one.
function boot(profiles) {
  const rows = [...profiles];
  const app = express();
  app.use(express.json());
  const supabase = {
    from: () => {
      const q = { filters: [] };
      const api = {
        select: () => api,
        insert: (row) => { q.insert = row; return api; },
        eq: (col, val) => { q.filters.push([col, val]); return api; },
        ilike: (col, val) => { q.filters.push(['ilike:' + col, String(val).toLowerCase()]); return api; },
        single: async () => {
          if (q.insert) {
            if (rows.some(r => String(r.username).toLowerCase() === String(q.insert.username).toLowerCase())) {
              return { data: null, error: { message: 'duplicate key' } };
            }
            rows.push(q.insert);
            return { data: q.insert, error: null };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          let found = rows;
          for (const [col, val] of q.filters) {
            found = col.startsWith('ilike:')
              ? found.filter(r => String(r[col.slice(6)]).toLowerCase() === val)
              : found.filter(r => r[col] === val);
          }
          return { data: found[0] || null, error: null };
        },
      };
      return api;
    },
  };
  // requireAuth is stubbed at the module, not wrapped around the router.
  //
  // Mounting a middleware that sets req.user does nothing: the route carries
  // its own requireAuth, which validates a bearer token against Supabase and
  // answers 401 long before the handler runs. Replacing the module is what
  // lets a test say who is signed in — and the routes are re-required
  // afterwards so the stub is the one they close over.
  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = {
    ...realAuth,
    requireAuth: (req, _res, next) => { req.user = app.locals.user; next(); },
  };
  delete require.cache[require.resolve('../src/routes/auth')];
  const routes = require('../src/routes/auth');
  app.use('/api/auth', routes(supabase));
  // Put the real one back, so nothing after this file sees the stub.
  require.cache[authPath].exports = realAuth;
  delete require.cache[require.resolve('../src/routes/auth')];
  const server = app.listen(0);
  return { server, port: server.address().port, app, rows };
}

async function ensure(port, app, user) {
  app.locals.user = user;
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/oauth-profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return { status: res.status, body: await res.json() };
}

test('a Google account gets a username derived from its name', async () => {
  const { server, port, app } = boot([]);
  try {
    const { body } = await ensure(port, app, {
      id: 'g1', email: 'ada@example.com', user_metadata: { full_name: 'Ada Lovelace' },
    });
    // Spaces become underscores rather than vanishing: Ada_Lovelace reads as a
    // name, AdaLovelace reads as a typo.
    assert.equal(body.username, 'Ada_Lovelace');
  } finally { server.close(); }
});

test('a taken username is stepped past, not randomised', async () => {
  // A common first name will already be taken, and a random tail on every
  // account would make them all look like bot names.
  const { server, port, app } = boot([{ id: 'x', username: 'Ada_Lovelace' }]);
  try {
    const { body } = await ensure(port, app, {
      id: 'g2', email: 'ada2@example.com', user_metadata: { full_name: 'Ada Lovelace' },
    });
    assert.equal(body.username, 'Ada_Lovelace2');
  } finally { server.close(); }
});

test('the derived name obeys the same rule as a chosen one', async () => {
  // /profile enforces letters, numbers and underscores, 3-20 characters. A
  // derived name that could not have been typed is a name nobody can edit
  // back to.
  const { server, port, app } = boot([]);
  try {
    const messy = 'Ana-María O' + String.fromCharCode(39) + 'Brien \u{1F3AE}';
    const { body } = await ensure(port, app, {
      id: 'g3', email: 'x@example.com', user_metadata: { full_name: messy },
    });
    assert.match(body.username, /^[a-zA-Z0-9_]{3,20}$/, `got ${body.username}`);
  } finally { server.close(); }
});

test('an account with nothing usable still gets a name', async () => {
  const { server, port, app } = boot([]);
  try {
    const { body } = await ensure(port, app, { id: 'g4', email: '', user_metadata: {} });
    assert.match(body.username, /^[a-zA-Z0-9_]{3,20}$/);
  } finally { server.close(); }
});

test('signing in again returns the existing profile untouched', async () => {
  // Idempotent, so a rename on the profile page is never undone by a later
  // sign-in.
  const { server, port, app, rows } = boot([{ id: 'g5', username: 'ChosenName', elo: 1400 }]);
  try {
    const { body } = await ensure(port, app, {
      id: 'g5', email: 'a@b.c', user_metadata: { full_name: 'Something Else' },
    });
    assert.equal(body.username, 'ChosenName');
    assert.equal(body.elo, 1400);
    assert.equal(rows.length, 1, 'a second profile was created');
  } finally { server.close(); }
});

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

test('the button is on both pages, under Create Account', () => {
  for (const page of ['Login.jsx', 'Signup.jsx']) {
    const src = fe('pages', page);
    assert.match(src, /<GoogleSignInButton \/>/, `${page} has no Google button`);
    assert.match(src, /import GoogleSignInButton from '\.\.\/components\/GoogleSignInButton'/);
    const create = src.indexOf('Create Account');
    const google = src.indexOf('<GoogleSignInButton />');
    assert.ok(create > 0 && google > create, `${page} puts Google above Create Account`);
  }
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
  // An empty <div id="root"></div> reads as an unresponsive site to it, and it
  // rejected verification on exactly that. Link previews and search crawlers
  // read the page the same way.
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const root = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/);
  assert.ok(root, 'no #root, or nothing between it and the app script');
  const text = root[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(text.length > 200, `only ${text.length} characters render without JS`);
  assert.match(text, /Duely/);
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

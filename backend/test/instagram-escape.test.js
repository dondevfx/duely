// The Instagram bio link.
//
// Instagram opens links in its own webview, which has its own cookie jar — a
// player who signs in there is signed out everywhere else, and taps through
// from a story landing logged out is the bug that prompted this. /go tries to
// hand the visitor to their real browser, and loads the site anyway when it
// cannot. It is never a destination: nobody should ever be left looking at it.
//
// Tested against real user-agent strings rather than the regex in isolation,
// because the failure that matters is not "the regex is wrong", it is "Chrome
// is treated as Instagram and every visitor gets an interstitial".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'public', 'go.html'), 'utf8');

// Pull the live expressions out of the page so these can never drift from it.
const rx = (name) => {
  const m = PAGE.match(new RegExp(`var ${name}\\s*=\\s*(/.+?/i)\\.test\\(ua\\)`));
  assert.ok(m, `could not find the ${name} test in go.html`);
  // eslint-disable-next-line no-eval
  return eval(m[1]);
};

const UA = {
  instagramIOS:   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.32.98 (iPhone14,3; iOS 17_5; en_US)',
  instagramAndro: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Instagram 335.1.0.32.98 Android',
  facebookIOS:    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/468.0.0.35.107;FBBV/622449862]',
  tiktok:         'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 TikTok 34.5.0',
  safariIOS:      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  chromeDesktop:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  firefoxDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
  safariMac:      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

test('the in-app browsers are caught', () => {
  const inApp = rx('inApp');
  for (const k of ['instagramIOS', 'instagramAndro', 'facebookIOS', 'tiktok']) {
    assert.ok(inApp.test(UA[k]), `${k} was not detected as an in-app browser`);
  }
});

test('a real browser is never held up', () => {
  // The expensive mistake: showing every visitor an interstitial. Anyone not in
  // an in-app browser must be replaced straight through to the site.
  const inApp = rx('inApp');
  for (const k of ['safariIOS', 'chromeAndroid', 'chromeDesktop', 'firefoxDesktop', 'safariMac']) {
    assert.ok(!inApp.test(UA[k]), `${k} was wrongly treated as an in-app browser`);
  }
  assert.match(PAGE, /if \(!inApp\) \{ window\.location\.replace\(target\); return; \}/);
  // replace, not assign — otherwise this page sits in history between the
  // visitor and the app, and Back bounces them through it again.
  assert.doesNotMatch(PAGE, /if \(!inApp\)[\s\S]{0,80}location\.href/);
});

test('Instagram on Android is Android, not iOS', () => {
  // Instagram's Android agent contains "iPhone"-free but plenty of Apple words
  // (AppleWebKit, Safari). Getting this backwards sends Android visitors an
  // iOS-only scheme that silently does nothing.
  const isIOS = rx('isIOS');
  assert.ok(!isIOS.test(UA.instagramAndro), 'Instagram Android was read as iOS');
  assert.ok(isIOS.test(UA.instagramIOS));
});

test('each platform gets the escape that exists for it', () => {
  // Android: documented intent scheme, with a fallback URL so a device without
  // Chrome still lands on the site instead of an error page.
  assert.match(PAGE, /intent:\/\/'/);
  assert.match(PAGE, /package=com\.android\.chrome/);
  assert.match(PAGE, /S\.browser_fallback_url=' \+ encodeURIComponent\(target\)/);
  // iOS: the undocumented one.
  assert.match(PAGE, /instagram:\/\/extbrowser\/\?url='/);
});

test('nobody is ever left sitting on this page', () => {
  // The interstitial is gone: no button, no instructions, nothing to read. That
  // makes the fallback the only thing standing between a failed escape and a
  // dead end, so it has to be unconditional.
  assert.doesNotMatch(PAGE, /id="open"|id="copy"|Open in your browser/,
    'the interstitial is back');
  assert.match(PAGE, /setTimeout\(function \(\) \{[\s\S]{0,200}?window\.location\.replace\(target\);[\s\S]{0,40}?\}, 1200\);/,
    'a failed escape must still end on the site');
  // Fires once. A retry loop in a webview that ignores the scheme just makes
  // the page unusable.
  assert.equal((PAGE.match(/setTimeout\(/g) || []).length, 1);
});

test('the fallback stands down when the escape actually worked', () => {
  // Neither scheme reports success, so the signal is that the webview went to
  // the background. Without the check, the fallback drags the abandoned webview
  // to the home page behind the browser that just opened — leaving a stale
  // signed-out Duely inside Instagram to be found later.
  assert.match(PAGE, /if \(left \|\| document\.hidden\) return;/);
  for (const ev of ['visibilitychange', 'pagehide', 'blur']) {
    assert.ok(PAGE.includes(ev), `nothing listens for ${ev}`);
  }
});

test('an in-app browser with no escape goes straight to the site', () => {
  // Recognised as stuck, but neither Android nor iOS — there is nothing to try,
  // so it must not wait out the timer first.
  const fn = PAGE.slice(PAGE.indexOf('function attempt()'), PAGE.indexOf('// Did the hand-off work?'));
  assert.match(fn, /Nothing to try\.\s*\n\s*window\.location\.replace\(target\);/,
    'the no-escape path does not fall through to the site');
});

test('the hop carries a referral through but cannot be pointed elsewhere', () => {
  // Query and hash survive, so an invite or affiliate link still works after
  // the redirect. The PATH deliberately does not: taking a destination from
  // the URL is how a bio link becomes an open redirect for someone else.
  assert.match(PAGE, /var target = SITE \+ window\.location\.search \+ window\.location\.hash;/);
  assert.match(PAGE, /var SITE = 'https:\/\/www\.duely\.us';/);
});

test('the page is reachable at /go and is not indexed', () => {
  const vercel = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'vercel.json'), 'utf8'));
  const [first] = vercel.rewrites;
  // Must sit BEFORE the SPA catch-all or /go is rewritten to index.html.
  assert.deepEqual(first, { source: '/go', destination: '/go.html' });
  assert.match(PAGE, /<meta name="robots" content="noindex"/);
});

test('it depends on nothing it would have to fetch', () => {
  // An in-app webview on a bad connection is the worst place to discover that
  // the escape page itself needs a CDN.
  assert.doesNotMatch(PAGE, /<script[^>]+src=/, 'external script');
  assert.doesNotMatch(PAGE, /<link[^>]+stylesheet/, 'external stylesheet');
  assert.doesNotMatch(PAGE, /fonts\.googleapis|cdn\./, 'external asset');
});

// In-app browsers — the webview you get when a link is opened from inside
// Instagram, TikTok, Snapchat, Facebook, etc. rather than in Safari or Chrome.
//
// These matter for invite links specifically, because that is exactly how they
// travel. Inside one of these webviews:
//   - the clipboard is often blocked, so "copy link" silently fails
//   - the session is sandboxed per app, so signing in here does not sign you in
//     in the real browser, and you land back here logged out next time
//   - OAuth/social sign-in is refused outright by some providers
//   - the site cannot be installed to the home screen
//
// IMPORTANT — there is no web API that can force a link into someone's default
// browser. A page cannot choose its own browser; the host app owns navigation.
// What exists is two platform-specific escape hatches, both best-effort:
//
//   Android — an `intent://` URL asks the OS to hand the link to whichever app
//             is registered for it, which is the user's default browser.
//   iOS     — the `x-safari-https://` scheme opens Safari. It is undocumented,
//             Apple has never committed to it, and it opens SAFARI rather than
//             a chosen default. It fails silently where unsupported.
//
// So the reliable path is always the manual one: tell the user to use the host
// app's own "Open in browser" menu item. Treat the buttons as a shortcut that
// often works, and never as a guarantee.

// Order matters. Messenger must be tested before Facebook: its iOS user agent
// is FBAN/MessengerForiOS, so the generic FBAN check claims it otherwise and the
// user is told to look for a menu item that app does not have.
const PATTERNS = [
  [/Instagram/i,                 'Instagram'],
  [/Messenger|MessengerForiOS|MessengerLite/i, 'Messenger'],
  [/FBAN|FBAV|FB_IAB/i,          'Facebook'],
  [/BytedanceWebview|TikTok|musical_ly/i, 'TikTok'],
  [/Snapchat/i,                  'Snapchat'],
  [/Twitter/i,                   'X'],
  [/LinkedInApp/i,               'LinkedIn'],
  [/Pinterest/i,                 'Pinterest'],
  [/Line\//i,                    'LINE'],
  [/KAKAOTALK/i,                 'KakaoTalk'],
];

/** Name of the in-app browser we're inside, or null for a real browser. */
export function detectInAppBrowser(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  if (!ua) return null;
  for (const [re, name] of PATTERNS) if (re.test(ua)) return name;
  return null;
}

export function isIOS(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return /iPhone|iPad|iPod/i.test(ua);
}

export function isAndroid(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return /Android/i.test(ua);
}

/**
 * Best-effort escape to a real browser. Returns true if we had something to
 * try — NOT that it worked, which is not observable from in here.
 */
export function openInDefaultBrowser(url = window.location.href) {
  if (isAndroid()) {
    // Strip the scheme: intent:// carries it in the #Intent fragment instead.
    const bare = url.replace(/^https?:\/\//, '');
    window.location.href =
      `intent://${bare}#Intent;scheme=https;action=android.intent.action.VIEW;end`;
    return true;
  }
  if (isIOS()) {
    window.location.href = url.replace(/^https?:\/\//, 'x-safari-https://');
    return true;
  }
  return false;
}

/** How to do it by hand — the instruction that actually always works. */
export function manualEscapeHint(app) {
  if (isIOS()) {
    return app === 'Instagram' || app === 'Facebook' || app === 'Messenger'
      ? 'Tap ••• at the top right, then "Open in external browser".'
      : 'Tap the ••• or share icon, then "Open in browser".';
  }
  return 'Tap ⋮ at the top right, then "Open in browser".';
}

import { useState } from 'react';
import {
  detectInAppBrowser, openInDefaultBrowser, manualEscapeHint,
} from '../utils/inAppBrowser';

// Shown on invite landing pages when we're inside an app's built-in browser
// (Instagram, TikTok, Snapchat…) rather than a real one. Invite links travel
// through exactly those apps, and signing in inside their webview does not
// carry over to the user's actual browser — so they sign up, close the app, and
// find themselves logged out.
//
// The button is a shortcut that often works; the written instruction below it
// is the part that always does. See utils/inAppBrowser for why a page cannot
// simply force this.
export default function InAppBrowserNotice() {
  const [app] = useState(() => detectInAppBrowser());
  const [tried, setTried] = useState(false);
  if (!app) return null;

  return (
    <div className="mb-5 text-left bg-warning/10 border border-warning/30 rounded-xl p-3">
      <p className="text-xs font-bold text-warning mb-1">
        You're in {app}'s built-in browser
      </p>
      <p className="text-[11px] text-muted mb-2.5">
        Open this in your normal browser so you stay signed in.
      </p>

      <button
        onClick={() => { setTried(true); openInDefaultBrowser(); }}
        className="w-full py-2 rounded-lg bg-warning/20 border border-warning/40 text-warning text-xs font-black hover:bg-warning/30 transition-all"
      >
        Open in browser
      </button>

      {/* Revealed after the shortcut is tried, because if it had worked the
          user would be gone — still being here means it didn't. */}
      {tried && (
        <p className="text-[11px] text-muted mt-2">
          Still here? {manualEscapeHint(app)}
        </p>
      )}
    </div>
  );
}

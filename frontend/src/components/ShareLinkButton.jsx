import { useState } from 'react';

// Share a link through the device's own share sheet.
//
// navigator.share opens the native sheet — Messages, WhatsApp, Instagram, AirDrop,
// whatever the user actually has installed. We can't enumerate those targets
// ourselves and shouldn't try; the OS owns that list. It only exists on mobile
// (and requires HTTPS + a real user gesture), so desktop falls back to copying.
//
// The button label reflects which one you'll get, because "Share" that silently
// copies is worse than a button that says Copy.
const canNativeShare = () =>
  typeof navigator !== 'undefined' && typeof navigator.share === 'function';

export default function ShareLinkButton({
  link,
  title = 'Add me on Duely',
  text,
  className = '',
  label,
}) {
  const [state, setState] = useState(null);   // 'copied' | 'failed' | null

  async function share() {
    if (canNativeShare()) {
      try {
        await navigator.share({ title, text, url: link });
        return;
      } catch (err) {
        // AbortError = the user dismissed the sheet. That is a normal outcome,
        // not a failure, and must not fall through to copying behind their back.
        if (err?.name === 'AbortError') return;
        // Anything else (no matching app, permission denied) — fall through.
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
    } catch {
      // Clipboard is blocked on insecure origins and in some in-app browsers.
      // The link is on screen next to this button, so say so rather than
      // pretending it worked.
      setState('failed');
    }
    setTimeout(() => setState(null), 2200);
  }

  const defaultLabel = canNativeShare() ? '📤 Share Invite Link' : '📋 Copy Invite Link';

  return (
    <button
      onClick={share}
      className={`w-full bg-primary hover:bg-blue-500 text-white font-black py-4 rounded-xl transition-all text-base ${className}`}
    >
      {state === 'copied' ? '✓ Link Copied!'
        : state === 'failed' ? 'Copy failed — select the link below'
        : (label || defaultLabel)}
    </button>
  );
}

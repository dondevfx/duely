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
  title = 'Duely',
  text,
  className = '',
  noun = 'Invite Link',
  label,
}) {
  const [state, setState] = useState(null);   // 'copied' | 'failed' | null

  async function share() {
    if (canNativeShare()) {
      try {
        // No `text` field, deliberately.
        //
        // The Web Share spec lets the target app use any SUBSET of these
        // fields. Passing the link in both `text` and `url` guaranteed it
        // survived, but any app honouring both then pasted the URL twice.
        //
        // So the message rides in `title` and the link lives only in `url` —
        // one link, always. Every share target understands a `url`; it is the
        // one field an OS share sheet is built around, and apps that want text
        // fall back to the URL itself rather than dropping it.
        await navigator.share({ title: text || title, url: link });
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
      // Reveal the link so it can still be selected by hand — otherwise this
      // button is the only route to it and the user is stuck.
      setState('failed');
      return;   // stays revealed; no timeout, or the link vanishes mid-select
    }
    setTimeout(() => setState(null), 2200);
  }

  const defaultLabel = canNativeShare() ? `📤 Share ${noun}` : `📋 Copy ${noun}`;

  return (
    <>
      <button
        onClick={share}
        className={`w-full bg-primary hover:bg-blue-500 text-white font-black py-4 rounded-xl transition-all text-base ${className}`}
      >
        {state === 'copied' ? '✓ Link Copied!'
          : state === 'failed' ? 'Copy blocked — select it below'
          : (label || defaultLabel)}
      </button>

      {state === 'failed' && (
        <code className="block select-all text-[9px] leading-tight font-mono text-muted break-all bg-bg border border-border rounded-lg px-2 py-1.5 mt-1.5">
          {link}
        </code>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';

/**
 * A full-screen lock while the browser's developer tools are open.
 *
 * Presentation only, not security. Everything that matters — balances, bets,
 * payouts, results — is decided on the server, and a determined person can
 * undock the tools, use another browser, or skip the page entirely. What this
 * does is keep the site from being poked at casually: while the tools are open
 * the page is covered by the Duely wordmark and nothing underneath can be
 * clicked or typed into. Close them and it lifts, on the same page, with
 * nothing reloaded.
 *
 * Detection is the window-size gap a docked panel leaves: the inside of the
 * window shrinks on ONE side while the outside does not. Browser zoom shrinks
 * both sides together, and phones and tablets have no docked tools, so neither
 * locks anyone out.
 */
const SIDE_GAP   = 200;  // px of width lost to a panel docked left/right
const BOTTOM_GAP = 300;  // px of height lost to a panel docked at the bottom
const NORMAL_H   = 200;  // tabs, address bar, bookmarks: height any window loses
const NORMAL_W   = 100;

function toolsOpen() {
  const w = window.outerWidth - window.innerWidth;
  const h = window.outerHeight - window.innerHeight;
  return (w > SIDE_GAP && h < NORMAL_H) || (h > BOTTOM_GAP && w < NORMAL_W);
}

// F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+U (view source).
function isToolsShortcut(e) {
  const k = (e.key || '').toLowerCase();
  if (k === 'f12') return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) return true;
  if (mod && k === 'u') return true;
  return false;
}

export default function InspectLock() {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    // Desktop only: a mouse and a real pointer. Phones and tablets are never checked.
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return undefined;

    const check = () => setLocked(toolsOpen());
    const onKey = (e) => { if (isToolsShortcut(e)) { e.preventDefault(); e.stopPropagation(); } };
    const onContext = (e) => e.preventDefault();

    check();
    const id = setInterval(check, 500);
    window.addEventListener('resize', check);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onContext);
    return () => {
      clearInterval(id);
      window.removeEventListener('resize', check);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onContext);
    };
  }, []);

  // While locked, swallow every key so nothing on the page can be typed into.
  useEffect(() => {
    if (!locked) return undefined;
    const block = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('keydown', block, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', block, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [locked]);

  if (!locked) return null;
  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black select-none"
      style={{ cursor: 'default' }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-6xl sm:text-7xl font-black tracking-tight text-primary"
        style={{ textShadow: '0 0 40px rgba(18,80,180,0.7)' }}>
        Duely
      </span>
    </div>
  );
}

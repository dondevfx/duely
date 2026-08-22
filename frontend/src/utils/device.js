// Is this a touch device, as opposed to something with a mouse?
//
// Used to decide whether a form may focus itself on load. On a desktop that is
// a convenience — the caret is where you were going to click anyway. On a phone
// it throws the on-screen keyboard up over half the screen before the person
// has even read the page, and on Login it hides the "Sign up instead" link
// underneath it.
//
// The media query, not the user agent: it asks the question we actually care
// about (is there a pointer that can hover) and stays correct on tablets with
// keyboards and on touchscreen laptops.
export function isTouchDevice() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

// Evaluated once at module load rather than per render: it cannot change
// without a new page, and autoFocus is only ever read on mount.
export const AUTOFOCUS = !isTouchDevice();

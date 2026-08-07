// A short, deliberate pause on balance refreshes.
//
// The server settles a match the moment it decides the result, which is correct
// — money should not wait on an animation that a client could stall or skip.
// But BalanceSync listens for `balance_changed` and refreshes within a second,
// so on Coin Flip the balance in the navbar moved while the coin was still in
// the air. That both spoils the reveal and tells the player the outcome early.
//
// So the money is settled immediately as before, and only the DISPLAY is held
// back until the reveal finishes. Nothing here touches a balance; it only
// decides when the client is allowed to go and re-read one.

let holds = 0;
const listeners = new Set();

/**
 * Hold balance refreshes until the returned function is called.
 *
 * Always released by a safety timer as well, because a hold that leaks would
 * freeze the displayed balance across the whole site until reload — a much
 * worse bug than the one this fixes.
 *
 * @param {number} maxMs hard ceiling on the hold
 * @returns {() => void} release, safe to call more than once
 */
export function holdBalance(maxMs = 12_000) {
  holds++;
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    holds = Math.max(0, holds - 1);
    if (holds === 0) listeners.forEach((fn) => { try { fn(); } catch {} });
  };
  const timer = setTimeout(release, maxMs);
  return release;
}

export function isBalanceHeld() {
  return holds > 0;
}

/** Called when the last hold is released, so a deferred refresh can run. */
export function onBalanceRelease(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

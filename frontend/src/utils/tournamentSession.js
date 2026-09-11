/**
 * "This tab is inside a tournament" — and whether it has just been refreshed.
 *
 * A refresh on any tournament screen after pressing Play is leaving the
 * tournament: before it starts that is a refund, once it is running it is a
 * forfeit. The server alone could not tell: it gives a dropped connection a
 * short grace so a phone switching networks is not knocked out, and a refresh
 * reconnects well inside it — so a refreshed player stayed in, and the bracket
 * screen simply reloaded as though nothing had happened.
 *
 * The tab knows. A marker in sessionStorage survives the reload (and only in
 * that tab), and the browser reports that the load was a reload. Both are read
 * HERE, when this module is first evaluated — before any screen mounts — because
 * the tournaments page clears the marker when it is opened normally, and it
 * would otherwise clear it before anything could act on it.
 */
const KEY = 'tournamentRound';

export function markInTournament(poolId) {
  if (!poolId) return;
  try { sessionStorage.setItem(KEY, poolId); } catch { /* private mode */ }
}

export function clearTournamentMark() {
  try { sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}

function readMark() {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

function wasReload() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    if (nav) return nav.type === 'reload';
    // Older Safari.
    return performance.navigation?.type === 1;
  } catch { return false; }
}

/** The tournament this tab was refreshed out of, or null. Read once, at load. */
export const RELOADED_OUT_OF = (typeof window !== 'undefined' && wasReload()) ? readMark() : null;

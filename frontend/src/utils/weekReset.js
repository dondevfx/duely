/**
 * When the weekly leaderboards roll over — the page's copy of the rule.
 *
 * The countdown above the board and the query that filters the board have to
 * agree. They did not: both said Monday 00:00 UTC, which is Sunday 5pm Pacific,
 * so the board wiped seven hours before the Monday the page was counting down
 * to — mid-Sunday-evening, while people were still playing for it.
 *
 * Deliberately a copy rather than an API field: the countdown must keep ticking
 * between requests and on a slow connection, and a header that says "resets in
 * 2 hours" only after a round-trip is worse than one that is simply right.
 * backend/src/services/weekReset.js is the same computation, and a test
 * compares the two across a year including both daylight-saving switches.
 */

const ZONE = 'America/Los_Angeles';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, weekday: 'short',
});

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function wallClock(date) {
  const p = {};
  for (const { type, value } of PARTS.formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: DAY_INDEX[p.weekday],
  };
}

function offsetAt(date) {
  const w = wallClock(date);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Solved twice — the offset depends on the instant, and the instant is what we
// are solving for. The second pass is what makes the two weekends a year when
// the clocks change land on the right hour.
function instantOf(y, m, d, hh = 0, mm = 0, ss = 0) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = new Date(naive - offsetAt(new Date(naive)));
  guess = new Date(naive - offsetAt(guess));
  return guess;
}

/** Monday 00:00 Pacific, at or before `now`. */
export function startOfPacificWeek(now = new Date()) {
  const w = wallClock(now);
  const sinceMonday = (w.weekday + 6) % 7;
  return instantOf(w.year, w.month, w.day - sinceMonday);
}

/** The next Monday 00:00 Pacific strictly after `now`. */
export function nextPacificWeek(now = new Date()) {
  const w = wallClock(startOfPacificWeek(now));
  return instantOf(w.year, w.month, w.day + 7);
}

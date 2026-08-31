/**
 * When the weekly leaderboards roll over.
 *
 * They used to roll at Monday 00:00 UTC, which is Sunday 5pm in Pacific — so
 * the board wiped seven hours before the Monday the page was counting down to,
 * mid-Sunday-evening, while people were still playing for it.
 *
 * The reset is Monday 00:00 America/Los_Angeles, which is where the platform is
 * run from and therefore the midnight the countdown means. Computed through
 * Intl rather than a fixed -7, because a hard-coded offset is wrong for half
 * the year and would move the reset by an hour at each daylight-saving switch.
 *
 * Lives in one file, used by the query that filters the board and by the
 * countdown shown above it — the two disagreeing is how you get a page that
 * says "2 hours remaining" over data that already reset.
 */

const ZONE = 'America/Los_Angeles';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, weekday: 'short',
});

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The zone's wall-clock reading of an instant.
function wallClock(date) {
  const p = {};
  for (const { type, value } of PARTS.formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    // Intl gives hour 24 for midnight under hour12:false in some engines.
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: DAY_INDEX[p.weekday],
  };
}

// How far the zone is from UTC at this instant, in milliseconds.
function offsetAt(date) {
  const w = wallClock(date);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The instant at which a given wall-clock time occurs in the zone.
//
// Solved twice: the offset depends on the instant, and the instant is what we
// are looking for. The first pass uses the offset in force now, the second uses
// the offset at the answer — which is what makes the reset land correctly on
// the two weekends a year when the clocks change between now and then.
function instantOf(y, m, d, hh = 0, mm = 0, ss = 0) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = new Date(naive - offsetAt(new Date(naive)));
  guess = new Date(naive - offsetAt(guess));
  return guess;
}

/** Monday 00:00 Pacific, at or before `now`. */
function startOfPacificWeek(now = new Date()) {
  const w = wallClock(now);
  const sinceMonday = (w.weekday + 6) % 7;          // Mon 0 … Sun 6
  return instantOf(w.year, w.month, w.day - sinceMonday);
}

/** The next Monday 00:00 Pacific strictly after `now`. */
function nextPacificWeek(now = new Date()) {
  const start = startOfPacificWeek(now);
  const w = wallClock(start);
  return instantOf(w.year, w.month, w.day + 7);
}

module.exports = { ZONE, startOfPacificWeek, nextPacificWeek };

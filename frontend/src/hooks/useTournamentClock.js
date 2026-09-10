import { useEffect, useState } from 'react';
import { api } from '../utils/api';

/**
 * The tournament clock, for anywhere outside the tournament screens.
 *
 * The same two facts the bet screen shows — how long entry is open for, and
 * how long until it opens again — so a card on the home page can say when the
 * next one is without anybody having to go and look.
 *
 * Counts to instants the server sent rather than counting down from a number,
 * because a tab that slept would otherwise resume from wherever it left off.
 * When the slot passes it fetches the next one; the schedule describes ONE
 * slot, so left alone the countdown reaches zero and stays there.
 *
 * Returns null until it knows, so a caller can render nothing rather than a
 * placeholder that flashes into a real value.
 */
export default function useTournamentClock() {
  const [schedule, setSchedule] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    api.get('/tournaments/schedule')
      .then(d => { if (alive) setSchedule(d); })
      .catch(() => { if (alive) setSchedule(null); });
    return () => { alive = false; };
  }, [epoch]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!schedule) return;
    if (now < schedule.slot.nextStartsAt) return;
    setEpoch(e => e + 1);
  }, [now, schedule]);

  if (!schedule) return null;

  const joinOpen = now < schedule.slot.closesAt;
  const target = joinOpen ? schedule.slot.closesAt : schedule.slot.nextStartsAt;
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));

  return {
    joinOpen,
    seconds,
    label: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
  };
}

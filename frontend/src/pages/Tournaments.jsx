import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useShowBottomBar } from '../components/BottomNav';
import GameTitle from '../components/GameTitle';
import GameHelp from '../components/GameHelp';
import CoinIcon from '../components/CoinIcon';
import { api } from '../utils/api';

/**
 * The tournament bet screen.
 *
 * Three fixed stakes rather than a slider: sixteen players have to agree on
 * one number, and a free choice would split the queue into sixteen pools of
 * one. Picking a stake shows what each of the three paid places wins at it.
 *
 * Every figure comes from the server, from the same module that pays the
 * prizes out. Writing the split here as well would be a prize table that can
 * disagree with the one actually paid — a support ticket per tournament, and
 * nobody would notice until the split changed.
 */
export default function Tournaments() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  useShowBottomBar(true);

  const [schedule, setSchedule] = useState(null);
  const [entryFee, setEntryFee] = useState(1);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    api.get('/tournaments/schedule')
      .then(d => { if (alive) setSchedule(d); })
      .catch(() => { if (alive) setError('Could not load the tournament schedule.'); });
    return () => { alive = false; };
  }, []);

  // One ticking clock for the whole screen. The countdown is derived from an
  // absolute instant the server sent, so a tab that slept catches up on its
  // next tick rather than counting down from wherever it left off.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const stake = useMemo(
    () => schedule?.stakes.find(s => s.entryFee === entryFee) || null,
    [schedule, entryFee]);

  const joinOpen = schedule ? now < schedule.slot.closesAt : false;
  const countdownTo = schedule
    ? (joinOpen ? schedule.slot.closesAt : schedule.slot.nextStartsAt)
    : 0;
  const secondsLeft = Math.max(0, Math.ceil((countdownTo - now) / 1000));

  async function enter(vsBot) {
    if (!user) return navigate('/login');
    setBusy(true);
    setError(null);
    try {
      const data = await api.post('/tournaments/join', { entryFee, vsBot: !!vsBot });
      navigate(`/tournaments/${data.poolId}`);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'Could not enter the tournament.');
      setBusy(false);
    }
  }

  const balance = parseFloat(profile?.c_coins) || 0;
  const canAfford = balance >= entryFee;

  return (
    <div className="w-full max-w-md animate-slide-up">
      <div className="relative">
        <div className="absolute top-0 right-0 z-10">
          <GameHelp gameType="tournament" placement="top-right" />
        </div>
        <h1 className="text-4xl sm:text-6xl font-black text-white text-center mb-4 sm:mb-6 leading-tight px-10 flex items-center justify-center">
          <GameTitle slug="tournament" title="Tournaments" />
        </h1>
      </div>

      {/* ── The stake ── */}
      <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl p-2.5 sm:p-5">
        <div className="flex items-center justify-between mb-2 sm:mb-4">
          <span className="text-base font-bold text-white">Entry</span>
          <span className="text-xs text-muted">
            {schedule ? `${schedule.poolSize} players · ${schedule.rounds} rounds` : ' '}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3 sm:mb-4">
          {(schedule?.stakes || [{ entryFee: 1 }, { entryFee: 5 }, { entryFee: 10 }]).map(s => (
            <button
              key={s.entryFee}
              onClick={() => setEntryFee(s.entryFee)}
              aria-pressed={entryFee === s.entryFee}
              className={`py-2.5 rounded-xl font-black text-lg border transition-all inline-flex items-center justify-center gap-1.5 ${
                entryFee === s.entryFee
                  ? 'bg-primary border-primary text-white shadow-glow'
                  : 'bg-bg border-border text-muted hover:text-white hover:border-primary/50'
              }`}
            >
              {s.entryFee} <CoinIcon size="0.8em" />
            </button>
          ))}
        </div>

        {/* What the three paid places win, at the chosen stake. */}
        <div className="rounded-xl bg-bg border border-border overflow-hidden">
          {['1st', '2nd', '3rd'].map((place, i) => (
            <div
              key={place}
              className={`flex items-center justify-between px-3 py-2 text-sm ${
                i > 0 ? 'border-t border-border' : ''
              }`}
            >
              <span className={`font-bold ${
                i === 0 ? 'text-[#FFD147]' : i === 1 ? 'text-[#C0C6CF]' : 'text-[#C07800]'
              }`}>{place}</span>
              <span className="font-mono font-bold text-white inline-flex items-center gap-1">
                {stake ? stake.prizes[i].toFixed(2) : '—'} <CoinIcon size="0.75em" />
              </span>
            </div>
          ))}
        </div>
        {stake && (
          <p className="mt-2 text-center text-[0.6875rem] text-muted">
            {stake.pot.toFixed(2)} pot · {(schedule.feeRate * 100).toFixed(0)}% fee
          </p>
        )}
      </div>

      {/* ── When ── */}
      <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl px-3 py-2.5 text-center">
        {!schedule ? (
          <span className="text-sm text-muted">Loading…</span>
        ) : joinOpen ? (
          <span className="text-sm text-white">
            Entry closes in{' '}
            <span className="font-mono font-bold text-primary">{fmt(secondsLeft)}</span>
          </span>
        ) : (
          <span className="text-sm text-muted">
            Next tournament in{' '}
            <span className="font-mono font-bold text-white">{fmt(secondsLeft)}</span>
          </span>
        )}
      </div>

      {error && (
        <p className="mb-2 text-center text-sm text-danger">{error}</p>
      )}

      <button
        onClick={() => enter(false)}
        disabled={busy || (user && !canAfford)}
        className="w-full py-3.5 rounded-xl bg-primary hover:bg-blue-500 text-white font-black text-lg
                   shadow-glow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {!user ? 'Login to Play'
          : !canAfford ? `Need ${entryFee} coins`
          : busy ? 'Entering…'
          : 'Play'}
      </button>

      {/* Testing only, and labelled as such rather than hidden behind a flag
          nobody remembers: the bots always lose and the tournament pays
          nothing out, so it is a way to walk the bracket end to end without
          sixteen people or any money moving. */}
      <button
        onClick={() => enter(true)}
        disabled={busy}
        className="mt-2 w-full py-2.5 rounded-xl border border-border bg-surface
                   text-muted hover:text-white hover:border-primary/50 text-sm font-bold transition-all
                   disabled:opacity-50"
      >
        Play vs Bots — free, no payout
      </button>
    </div>
  );
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

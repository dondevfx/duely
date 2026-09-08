import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useShowBottomBar } from '../components/BottomNav';
import GameTitle from '../components/GameTitle';
import GameHelp from '../components/GameHelp';
import CoinIcon from '../components/CoinIcon';
import BetSlider from '../components/BetSlider';
import { api } from '../utils/api';

/**
 * The tournament bet screen.
 *
 * Built out of the same pieces as every other bet screen — the shared
 * BetSlider, the same panel, the same button — so it does not read as a
 * different product. The one difference is what it has to show: three places
 * are paid, so a single "You win" figure cannot say what is at stake. That is
 * what BetSlider's `payout` slot is for; growing a second slider here is the
 * exact thing that component exists to prevent.
 *
 * Three stops on the slider rather than a free range: sixteen players have to
 * agree on one number, and a free choice would split the queue into sixteen
 * pools of one.
 *
 * Every figure comes from the server, from the same module that pays the
 * prizes out. Writing the split here as well would be a prize table that can
 * disagree with the one actually paid.
 */
export default function Tournaments() {
  const navigate = useNavigate();
  // `session`, not `user`. AuthContext has never exposed a `user` — reading
  // one gave undefined, so the screen showed "Login to Play" to a signed-in
  // player and the bot button sent them to the login page.
  const { session, profile } = useAuth();
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

  // One ticking clock. The countdown is derived from an absolute instant the
  // server sent, so a tab that slept catches up on its next tick rather than
  // resuming from wherever it left off.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fees = useMemo(() => schedule?.stakes.map(s => s.entryFee) || [1, 5, 10], [schedule]);
  const stake = useMemo(
    () => schedule?.stakes.find(s => s.entryFee === entryFee) || null,
    [schedule, entryFee]);

  const joinOpen = schedule ? now < schedule.slot.closesAt : false;
  const countdownTo = schedule
    ? (joinOpen ? schedule.slot.closesAt : schedule.slot.nextStartsAt)
    : 0;
  const secondsLeft = Math.max(0, Math.ceil((countdownTo - now) / 1000));

  async function enter(vsBot) {
    if (!session) return navigate('/login');
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

  const PLACES = [
    { label: '1st', color: '#FFD147' },
    { label: '2nd', color: '#C0C6CF' },
    { label: '3rd', color: '#C07800' },
  ];

  return (
    <div className="w-full max-w-md animate-slide-up pt-4 sm:pt-6">
      {/* The clock, as the first thing on the screen and as type rather than a
          panel. It is the one fact that decides whether to enter now or come
          back, so it reads before the title rather than sitting in a box below
          the stake competing with it. */}
      <div className="text-center mb-2 sm:mb-3">
        <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold">
          {!schedule ? ' ' : joinOpen ? 'Entry closes in' : 'Next tournament in'}
        </div>
        <div
          className={`font-mono font-black leading-none text-4xl sm:text-5xl ${
            joinOpen ? 'text-primary' : 'text-white'
          }`}
          style={joinOpen ? { textShadow: '0 0 18px rgba(18,80,180,0.55)' } : undefined}
        >
          {schedule ? fmt(secondsLeft) : '—:—'}
        </div>
      </div>

      <div className="relative">
        <div className="absolute top-0 right-0 z-10">
          <GameHelp gameType="tournament" placement="top-right" />
        </div>
        <h1 className="text-4xl sm:text-6xl font-black text-white text-center mb-4 sm:mb-6 leading-tight px-10 flex items-center justify-center">
          <GameTitle slug="tournament" title="Tournaments" />
        </h1>
      </div>

      {/* ── Entry ── the same panel every other bet screen uses */}
      <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl p-2.5 sm:p-5">
        <div className="flex items-center justify-between mb-1.5 sm:mb-4">
          <span className="text-base font-bold text-white">Your Bet</span>
          <span className="text-xs text-muted">
            {schedule ? `${schedule.poolSize} players · ${schedule.rounds} rounds` : ' '}
          </span>
        </div>

        <BetSlider
          fees={fees}
          entryFee={entryFee}
          setEntryFee={setEntryFee}
          currLabel={<CoinIcon size="0.9em" />}
          payout={
            <div>
              <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold text-center">
                You win
              </div>
              <div className="grid grid-cols-3 gap-1.5 sm:gap-2 mt-0.5">
                {PLACES.map((p, i) => (
                  <div key={p.label} className="text-center">
                    <div className="text-[0.625rem] sm:text-xs font-bold" style={{ color: p.color }}>
                      {p.label}
                    </div>
                    <div className="text-lg sm:text-2xl font-black text-success inline-flex items-center gap-0.5 leading-none"
                         style={{ textShadow: '0 0 14px rgba(34,197,94,0.4)' }}>
                      {stake ? fmtCoins(stake.prizes[i]) : '—'}
                      <CoinIcon size="0.6em" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          }
        />

        {stake && (
          <p className="mt-1.5 sm:mt-2 text-center text-[0.6875rem] text-muted">
            {fmtCoins(stake.pot)} pot · {(schedule.feeRate * 100).toFixed(0)}% fee
          </p>
        )}
      </div>

      {error && <p className="mb-2 text-center text-sm text-danger">{error}</p>}

      <button
        onClick={() => enter(false)}
        disabled={busy || (session && !canAfford)}
        className="w-full py-3.5 rounded-xl bg-primary hover:bg-blue-500 text-white font-black text-lg
                   shadow-glow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {!session ? 'Login to Play'
          : !canAfford ? `Need ${entryFee} coins`
          : busy ? 'Entering…'
          : 'Play'}
      </button>

      {/* Testing, and labelled rather than hidden behind a flag nobody
          remembers: the bots always lose and nothing is paid out, so the
          bracket can be walked end to end without sixteen people or any money
          moving. */}
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

// Whole numbers stay whole: "76" rather than "76.00", which is how every other
// figure on the site is written.
function fmtCoins(n) {
  const v = Number(n) || 0;
  return v % 1 === 0 ? v.toLocaleString() : v.toFixed(2);
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

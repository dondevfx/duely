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
  // Set once a seat is taken in a tournament that has not started yet.
  // Two goes per tournament, spent when a bracket you are in actually starts.
  // Held here as {left, per} so the button can say so before it is pressed
  // rather than refusing afterwards.
  const [tickets, setTickets] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Refetched whenever the slot it describes has passed, not once on mount.
  //
  // The schedule names one slot with fixed instants in it. Left alone the
  // countdown reaches 0:00 and stays there — the window has closed, the next
  // tournament has opened, and the screen still describes the old one until
  // somebody reloads. `epoch` bumps when the clock crosses the boundary, which
  // re-runs this.
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let alive = true;
    api.get('/tournaments/schedule')
      .then(d => { if (alive) { setSchedule(d); setError(null); } })
      .catch(() => { if (alive) setError('Could not load the tournament schedule.'); });
    return () => { alive = false; };
  }, [epoch]);

  // One place decides the schedule is stale: the moment the tick passes the
  // end of the slot it was describing.
  useEffect(() => {
    if (!schedule) return;
    if (now < schedule.slot.nextStartsAt) return;
    setEpoch(e => e + 1);
  }, [now, schedule]);

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

  // Derived from the tick, so it flips at the boundary without a reload.
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

      // Straight to the bracket, whether it has started or not.
      //
      // This used to keep the player here with a panel saying they were in and
      // a link to go and look — a second click to reach the screen they had
      // just asked for. The bracket's own waiting state is the better version
      // of that panel: the same seats-taken count, the faces as they arrive,
      // and it becomes the tournament without moving anybody.
      navigate(`/tournaments/${data.poolId}`);
    } catch (e) {
      // Already in one: the useful thing is the way back to it, not the
      // refusal. Their stake was not taken and nothing has been lost.
      if (e?.data?.inProgress && e?.data?.poolId) {
        navigate(`/tournaments/${e.data.poolId}`);
        return;
      }
      setError(e?.data?.error || e?.message || 'Could not enter the tournament.');
      setBusy(false);
    }
  }

  // Read on load and again whenever the slot rolls over, because that is
  // exactly when they come back.
  useEffect(() => {
    if (!session) { setTickets(null); return; }
    let alive = true;
    api.get('/tournaments/me')
      .then(d => { if (alive && d?.tickets != null) setTickets({ left: d.tickets, per: d.ticketsPerSlot ?? 2 }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [session, epoch]);

  const balance = parseFloat(profile?.c_coins) || 0;
  const canAfford = balance >= entryFee;

  // Podium order: second, first, third — the way they stand on one. Listing
  // them 1-2-3 reads as a table; this reads as a result, and puts the number
  // most people are looking at in the middle where the eye lands.
  //
  // `i` is the index into the server's prizes array, which stays 1st-2nd-3rd.
  const PODIUM = [
    { label: '2nd', color: '#C0C6CF', i: 1, big: false },
    { label: '1st', color: '#FFD147', i: 0, big: true  },
    { label: '3rd', color: '#C07800', i: 2, big: false },
  ];

  return (
    <div className="w-full max-w-md animate-slide-up pt-4 sm:pt-6">
      <div className="relative">
        <div className="absolute top-0 right-0 z-10">
          <GameHelp gameType="tournament" placement="top-right" />
        </div>
        <h1 className="text-4xl sm:text-6xl font-black text-white text-center mb-4 sm:mb-6 leading-tight px-10 flex items-center justify-center">
          <GameTitle slug="tournament" title="Tournaments" />
        </h1>
      </div>

      {/* The clock, directly under the name.
          It is the one fact that decides whether to enter now or come back, so
          it sits with the title rather than in a panel further down competing
          with the stake. */}
      <div className="text-center -mt-1 mb-3 sm:mb-5">
        <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold">
          {/* Both halves of the clock are about ENTRY. It never counts down
              to a tournament starting, because nothing schedules that: a
              tournament starts when its bracket fills. */}
          {!schedule ? ' ' : joinOpen ? 'Entry closes in' : 'Entry opens in'}
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
          // The three payouts are React-rendered, so they need the value as the
          // thumb moves rather than on release.
          live
          payout={
            <div>
              <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold text-center">
                You win
              </div>
              <div className="grid grid-cols-3 gap-1 sm:gap-2 mt-1 items-end">
                {PODIUM.map((p) => (
                  <div key={p.label} className="text-center">
                    <div className={`font-bold ${p.big ? 'text-xs sm:text-sm' : 'text-[0.6875rem] sm:text-xs'}`}
                         style={{ color: p.color }}>
                      {p.label}
                    </div>
                    <div
                      className={`font-black text-success inline-flex items-center gap-0.5 leading-none ${
                        p.big ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'
                      }`}
                      style={{ textShadow: '0 0 16px rgba(34,197,94,0.45)' }}
                    >
                      {stake ? fmtCoins(stake.prizes[p.i]) : '—'}
                      <CoinIcon size="0.55em" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          }
        />

      </div>

      {error && <p className="mb-2 text-center text-sm text-danger">{error}</p>}

      <button
        onClick={() => enter(false)}
        disabled={busy || (session && !canAfford) || (tickets && tickets.left <= 0)}
        className="w-full py-3.5 rounded-xl bg-primary hover:bg-blue-500 text-white font-black text-lg
                   shadow-glow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {!session ? 'Login to Play'
          : tickets && tickets.left <= 0 ? 'No tickets left'
          : !canAfford ? `Need ${entryFee} coins`
          : busy ? 'Entering…'
          : 'Play'}
      </button>

      {/* What is left, under the button that spends it.
          A go is spent when a bracket you entered STARTS, not when you join
          one — a tournament that never fills is refunded and never played, and
          charging for it would take away a go at something that did not
          happen. */}
      {session && tickets && (
        <p className="mt-1.5 text-center text-xs text-muted">
          {tickets.left > 0
            ? <><span className="font-bold text-white">{tickets.left}</span>
                {' '}ticket{tickets.left === 1 ? '' : 's'} remaining this tournament</>
            : 'No tickets left — the next tournament resets them'}
        </p>
      )}

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

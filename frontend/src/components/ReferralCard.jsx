import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import ShareLinkButton from './ShareLinkButton';
import CoinIcon from './CoinIcon';

// Referral rewards on the Rewards page.
//
// The progress bars are the point. A flat "invite friends" pitch converts
// badly; showing that a specific person is 60% of the way to paying out is what
// makes someone nudge them. So each referred player gets their own row with
// deposit and wager progress rather than a single aggregate count.
export default function ReferralCard({ myCode }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/rewards/referrals').then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  const { people = [], earned = 0, pending = 0,
          rewardCoins = 2, minDeposit = 10, minWagered = 50, holdDays = 7 } = data;

  // Falls back to the plain site link when the user has not set a code yet —
  // better than showing a link that refers nobody.
  const link = myCode
    ? `${window.location.origin}/?ref=${encodeURIComponent(myCode)}`
    : window.location.origin;

  const qualified = people.filter(p => p.status !== 'in_progress').length;

  return (
    <div className="bg-surface border border-surfaceLight rounded-2xl p-5 mb-5">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-base font-black text-white">👥 Invite Friends</h2>
        <span className="text-xs text-muted">{qualified}/{people.length || 0} qualified</span>
      </div>

      <p className="text-sm text-muted mb-4">
        Get <span className="text-primary font-black inline-flex items-center gap-0.5">
          {rewardCoins} <CoinIcon size="0.85em" />
        </span>{' '}
        for every person you invite who deposits ${minDeposit} and plays.
      </p>

      <ShareLinkButton
        link={link}
        noun="Invite Link"
        title="Play me on Duely"
        text="Come 1v1 me on Duely 🎮"
        className="!py-2.5 !text-xs"
      />

      {(earned > 0 || pending > 0) && (
        <div className="flex gap-2 mt-3">
          <div className="flex-1 bg-bg border border-border rounded-xl px-3 py-2 text-center">
            <div className="text-sm font-black text-success inline-flex items-center gap-1">
              {earned} <CoinIcon size="0.8em" />
            </div>
            <div className="text-[10px] text-muted">Earned</div>
          </div>
          <div className="flex-1 bg-bg border border-border rounded-xl px-3 py-2 text-center">
            <div className="text-sm font-black text-warning inline-flex items-center gap-1">
              {pending} <CoinIcon size="0.8em" />
            </div>
            <div className="text-[10px] text-muted">Pending ({holdDays}d)</div>
          </div>
        </div>
      )}

      {people.length > 0 && (
        <div className="mt-4 space-y-2.5">
          {people.map((p, i) => {
            const depPct = Math.min(100, (p.deposited / minDeposit) * 100);
            const wagPct = Math.min(100, (p.wagered / minWagered) * 100);
            const done = p.status === 'paid' || p.status === 'pending';
            return (
              <div key={i} className="bg-bg border border-border rounded-xl px-3 py-2">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-white truncate">{p.username}</span>
                  <span className={`text-[10px] font-bold ${
                    p.status === 'paid' ? 'text-success'
                      : p.status === 'pending' ? 'text-warning'
                      : 'text-muted'
                  }`}>
                    {p.status === 'paid' ? '✓ Paid'
                      : p.status === 'pending' ? `Held ${holdDays}d`
                      : 'In progress'}
                  </span>
                </div>
                {!done && (
                  <div className="space-y-1">
                    <Bar label={`Deposit $${p.deposited.toFixed(0)}/$${minDeposit}`} pct={depPct} />
                    <Bar label={`Wagered $${p.wagered.toFixed(0)}/$${minWagered}`} pct={wagPct} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {people.length === 0 && (
        <p className="text-[11px] text-muted mt-3 text-center">
          Share your link — you'll see their progress here.
        </p>
      )}
    </div>
  );
}

function Bar({ label, pct }) {
  return (
    <div>
      <div className="flex justify-between text-[9px] text-muted mb-0.5">
        <span>{label}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="w-full h-1 bg-surfaceLight rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #1250B4, #00ccff)' }}
        />
      </div>
    </div>
  );
}

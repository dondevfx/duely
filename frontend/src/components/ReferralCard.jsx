import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import ShareLinkButton from './ShareLinkButton';
import CoinIcon from './CoinIcon';

// Referral rewards on the Rewards page.
//
// Deliberately shows no thresholds and no progress. A referral only appears here
// once it has already qualified, so there is nothing partial to report — and
// framing the offer as "invite someone and earn" reads far better than a list of
// conditions the referrer cannot influence anyway. The requirements still exist
// server-side; they are just not the referrer's problem.
export default function ReferralCard({ myCode }) {
  const [data, setData] = useState(null);
  const [collecting, setCollecting] = useState(false);
  const [justGot, setJustGot] = useState(0);

  useEffect(() => {
    api.get('/rewards/referrals').then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  const { qualified = 0, collectable = 0, holding = 0, rewardCoins = 2 } = data;

  // Falls back to the plain site link when no code is set, rather than sharing
  // a link that refers nobody.
  const link = myCode
    ? `${window.location.origin}/?ref=${encodeURIComponent(myCode)}`
    : window.location.origin;

  async function collect() {
    if (collecting || collectable <= 0) return;
    setCollecting(true);
    try {
      const res = await api.post('/rewards/referrals/collect');
      setJustGot(res.collected || 0);
      setData(res);                       // server returns fresh stats
      setTimeout(() => setJustGot(0), 3000);
    } catch { /* leave the button as-is; nothing was collected */ }
    finally { setCollecting(false); }
  }

  return (
    <div className="bg-surface border border-surfaceLight rounded-2xl p-5 mb-5">
      <h2 className="text-base font-black text-white mb-1">👥 Invite Players</h2>
      <p className="text-sm text-muted mb-4">
        Get{' '}
        <span className="text-primary font-black inline-flex items-center gap-0.5">
          {rewardCoins} <CoinIcon size="0.85em" />
        </span>{' '}
        when a player you invite signs up and plays.
      </p>

      <ShareLinkButton
        link={link}
        noun="Invite Link"
        title="Play me on Duely"
        text="Come 1v1 me on Duely 🎮"
      />

      <div className="flex gap-2 mt-3">
        <div className="flex-1 bg-bg border border-border rounded-xl px-3 py-2.5 text-center">
          <div className="text-lg font-black text-white">{qualified}</div>
          <div className="text-[10px] text-muted">Players joined</div>
        </div>
        <div className="flex-1 bg-bg border border-border rounded-xl px-3 py-2.5 text-center">
          <div className="text-lg font-black text-success inline-flex items-center gap-1">
            {collectable} <CoinIcon size="0.75em" />
          </div>
          <div className="text-[10px] text-muted">Ready to collect</div>
        </div>
      </div>

      <button
        onClick={collect}
        disabled={collecting || collectable <= 0}
        className={`w-full mt-3 py-3 rounded-xl font-black text-sm transition-all ${
          collectable > 0
            ? 'bg-primary text-white hover:bg-blue-500'
            : 'bg-bg border border-border text-muted cursor-default'
        }`}
        style={collectable > 0 ? { boxShadow: '0 0 18px rgba(18,80,180,0.35)' } : {}}
      >
        {justGot > 0 ? `✓ Collected ${justGot} coins`
          : collecting ? 'Collecting…'
          : collectable > 0 ? `Collect ${collectable} Coins`
          : 'Nothing to collect yet'}
      </button>

      {/* Only surfaced when something is actually waiting, so it reads as a
          status rather than a condition being imposed on them. */}
      {holding > 0 && (
        <p className="text-[10px] text-muted mt-2 text-center">
          {holding} more clearing — collectable in a few days.
        </p>
      )}
    </div>
  );
}

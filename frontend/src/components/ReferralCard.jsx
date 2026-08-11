import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import ShareLinkButton from './ShareLinkButton';
import CoinIcon from './CoinIcon';

// Referral offer. Two variants:
//   full    — Rewards page: offer, link, counts, collect button
//   compact — Home sidebar: offer and link only
//
// The offer text and the share button NEVER wait on the network. The card used
// to return null until /rewards/referrals answered, so a slow or failed request
// made the whole thing vanish — which read as "sometimes it doesn't load". The
// pitch does not depend on any data, so it renders immediately and the stats
// fill in behind it.
//
// The code comes from the server, which issues one if the account has never had
// a code. It is nullable in the schema and was only ever set manually, so most
// accounts had none and their link referred nobody.
export default function ReferralCard({ variant = 'full' }) {
  const [data, setData] = useState(null);
  const [collecting, setCollecting] = useState(false);
  const [justGot, setJustGot] = useState(0);
  const compact = variant === 'compact';

  useEffect(() => {
    let alive = true;
    api.get('/rewards/referrals')
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ failed: true }); });
    return () => { alive = false; };
  }, []);

  const rewardCoins = data?.rewardCoins ?? 2;
  const qualified   = data?.qualified ?? 0;
  const collectable = data?.collectable ?? 0;
  const holding     = data?.holding ?? 0;

  // Falls back to the bare origin only if the server could not issue a code.
  // That link still works as a site link; it just does not attribute.
  const link = data?.code
    ? `${window.location.origin}/?ref=${encodeURIComponent(data.code)}`
    : window.location.origin;

  async function collect() {
    if (collecting || collectable <= 0) return;
    setCollecting(true);
    try {
      const res = await api.post('/rewards/referrals/collect');
      setJustGot(res.collected || 0);
      setData(res);
      setTimeout(() => setJustGot(0), 3000);
    } catch { /* nothing collected; button stays as it was */ }
    finally { setCollecting(false); }
  }

  return (
    <div className={`bg-surface border rounded-2xl ${compact ? 'p-4' : 'p-5 mb-5'} ${
      compact ? 'border-surfaceLight' : 'border-primary/40'
    }`}>
      {/* The offer, sized to be the thing you actually notice. */}
      <div className={compact ? 'mb-3' : 'mb-4'}>
        <h2 className={`font-black text-white leading-tight ${compact ? 'text-base mb-1' : 'text-xl sm:text-2xl mb-1.5'}`}>
          Invite friends, earn{' '}
          <span className="text-primary inline-flex items-center gap-1">
            {rewardCoins} <CoinIcon size="0.9em" />
          </span>
        </h2>
        <p className={`text-muted leading-snug ${compact ? 'text-xs' : 'text-sm sm:text-base'}`}>
          Get{' '}
          <span className="text-white font-bold inline-flex items-center gap-0.5">
            {rewardCoins} <CoinIcon size="0.85em" />
          </span>{' '}
          every time a player you invite signs up and plays.
        </p>
      </div>

      <ShareLinkButton
        link={link}
        noun="Invite Link"
        title="Play me on Duely"
        text="Come 1v1 me on Duely 🎮"
        className={compact ? '!py-2.5 !text-xs' : ''}
      />

      {!compact && (
        <>
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

          {holding > 0 && (
            <p className="text-[10px] text-muted mt-2 text-center">
              {holding} more clearing — collectable in a few days.
            </p>
          )}
        </>
      )}
    </div>
  );
}

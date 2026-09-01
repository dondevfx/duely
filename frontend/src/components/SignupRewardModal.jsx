import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import GlowButton from './GlowButton';
import DiamondIcon from './DiamondIcon';
import { GiftIcon } from './UiIcon';

/**
 * The welcome gift, shown once to a brand-new account the first time it loads
 * the site.
 *
 * The server owns whether there is anything to claim — this asks
 * /bonus/signup-status rather than deciding from anything local. A flag in
 * localStorage would be wrong in both directions: cleared or opened on a
 * second device it offers a gift that was already taken, and set by a claim
 * whose credit failed it hides one that was never given. The column in the
 * database is the only thing that knows, so it is the only thing asked.
 *
 * Renders nothing at all until that answer comes back, so an existing account
 * never sees a flash of a gift it cannot have.
 */
export default function SignupRewardModal() {
  const { session, refreshProfile } = useAuth();

  const [amount, setAmount]     = useState(null);   // null = nothing to show
  const [claiming, setClaiming] = useState(false);
  const [error, setError]       = useState(null);
  const [closed, setClosed]     = useState(false);

  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    api.get('/bonus/signup-status')
      .then(d => { if (alive && d?.canClaim) setAmount(d.bonusAmount); })
      // Silent: a status call that fails means we do not know there is a gift,
      // and the right move is to show nothing rather than an error over a page
      // the player did not ask anything of. It is offered again next load.
      .catch(() => {});
    return () => { alive = false; };
  }, [session]);

  async function claim() {
    setClaiming(true);
    setError(null);
    try {
      await api.post('/bonus/signup-claim');
      // Straight to the site. There was a second panel here confirming the
      // claim, and it was a step for its own sake — the balance in the navbar
      // updates behind this the moment it closes, which says the same thing
      // without another button to press.
      setClosed(true);
      refreshProfile();
    } catch (e) {
      setError(e.message || 'Could not claim. Please try again.');
      setClaiming(false);
    }
  }

  if (!session || amount === null || closed) return null;

  return (
    // z-50 matches the ToS modal rather than beating it. App.jsx holds this
    // back until the ToS is accepted, so the two never stack — the ordering is
    // decided there, where both are known, instead of by a z-index race here.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-7 shadow-2xl text-center animate-scale-in">
        <div className="flex justify-center mb-4">
          <GiftIcon size={76} className="animate-gift-bob" />
        </div>

        <h2 className="text-2xl font-black text-white mb-2">Thank You for Signing Up</h2>
        <p className="text-muted text-sm mb-6">
          Here is a welcome gift to get you started.
        </p>
        <div className="flex items-center justify-center gap-2 text-3xl font-black text-white mb-6">
          <DiamondIcon size="0.9em" />
          {amount.toLocaleString()}
        </div>
        <GlowButton onClick={claim} variant="primary" size="lg" className="w-full" disabled={claiming}>
          {claiming ? 'Claiming…' : 'Claim'}
        </GlowButton>
        {error && <p className="text-danger text-sm mt-3">{error}</p>}
      </div>
    </div>
  );
}

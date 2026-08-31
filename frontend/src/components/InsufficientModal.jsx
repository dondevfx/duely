import { useNavigate } from 'react-router-dom';
import CoinIcon from './CoinIcon';
import DiamondIcon from './DiamondIcon';
import GlowButton from './GlowButton';

/**
 * "You cannot afford that bet" — as a dialog, not as a changed button.
 *
 * Every betting screen used to answer a shortfall by rewriting the buttons:
 * the primary action turned into "Insufficient Balance — Deposit" and the
 * bet-vs-bot button into "Insufficient — Get More". Two problems with that.
 * The screen changed shape depending on your balance, so the thing you were
 * reaching for was not where it had been a moment ago; and a button whose LABEL
 * is an error still looks like the action you wanted until you read it.
 *
 * The buttons look the same whatever the balance now. Pressing one when you
 * cannot cover it opens this instead, which says what is wrong once and offers
 * the one thing that fixes it — the wallet for coins, rewards for diamonds,
 * because diamonds are earned rather than bought and sending a diamond
 * shortfall to the wallet is a dead end.
 */
export default function InsufficientModal({ currency, open, onClose }) {
  const navigate = useNavigate();
  if (!open) return null;

  const isDiamonds = currency === 'diamonds';
  const mark  = isDiamonds ? <DiamondIcon /> : <CoinIcon size="0.9em" />;
  const route = isDiamonds ? '/rewards' : '/wallet';
  const cta   = isDiamonds ? 'Rewards' : 'Wallet';
  const line  = isDiamonds
    ? 'Collect rewards to earn more Diamonds.'
    : 'Deposit to add more Coins.';

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      // Tapping the backdrop dismisses, the same as every other modal here.
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-xs bg-surface border border-surfaceLight rounded-2xl p-6 text-center animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-3xl mb-3 flex justify-center">{mark}</div>
        <h2 className="text-lg font-black text-white mb-1">Insufficient balance</h2>
        <p className="text-sm text-muted mb-5">{line}</p>

        <GlowButton
          onClick={() => { onClose(); navigate(route); }}
          variant="primary"
          size="lg"
          className="w-full"
        >
          {cta}
        </GlowButton>

        <button
          onClick={onClose}
          className="mt-2 w-full py-2.5 text-sm font-bold text-muted hover:text-white transition-colors"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

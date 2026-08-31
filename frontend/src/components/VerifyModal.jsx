import { useState } from 'react';
import { api } from '../utils/api';
import GlowButton from './GlowButton';

// Shown at the moment a player tries to withdraw to a bank and is not verified.
//
// Deliberately not a page in Settings. Verification costs real money past the
// free monthly allowance, so nobody should be nudged into one they do not need:
// a player who only ever withdraws crypto never sees this, and a player who
// does see it is one payout away from needing it. Once, and never again.

const VIEW = {
  unverified: {
    icon: '🪪',
    title: 'Verify to withdraw to your bank',
    body: 'Bank withdrawals need a quick identity check — a photo of your ID and a selfie. It takes about two minutes, and you only ever do it once.',
    cta:  'Start verification',
  },
  rejected: {
    icon: '⚠️',
    title: 'Verification was not approved',
    body: 'Something did not check out. You can try again with a clearer photo or a different document.',
    cta:  'Try again',
  },
  pending: {
    icon: '⏳',
    title: 'Verification in progress',
    body: 'We are waiting on the result. This is usually quick, but it can take longer if a person needs to look at it. You can pick up where you left off below.',
    cta:  'Continue verification',
  },
};

export default function VerifyModal({ status = 'unverified', rejectionReason, configured = true, onClose }) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const view = VIEW[status] ?? VIEW.unverified;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post('/kyc/session', {});
      // Replace, not a new tab: Didit's flow uses the camera, and a popup that
      // a browser blocks or a phone buries behind the app is a dead end. The
      // player comes back to the wallet when they are done.
      window.location.href = url;
    } catch (e) {
      setError(e.message || 'Could not start verification.');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-surface border border-surfaceLight rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl leading-none" aria-hidden="true">{view.icon}</span>
            <div className="text-base font-black text-white leading-snug">{view.title}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-8 h-8 -mt-1 -mr-1 rounded-lg text-muted hover:text-white hover:bg-surfaceLight text-lg font-bold flex items-center justify-center transition-all"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-white/80 leading-snug mb-3">{view.body}</p>

        {status === 'rejected' && rejectionReason && (
          <p className="text-xs text-danger mb-3">
            <span className="font-bold">Reason:</span> {rejectionReason}
          </p>
        )}

        <p className="text-[0.6875rem] text-muted mb-4">
          Crypto withdrawals do not need this — only bank transfers do.
        </p>

        {!configured ? (
          <p className="text-xs text-warning">
            Identity verification is not switched on yet. Withdraw to crypto for now.
          </p>
        ) : (
          <>
            {error && <p className="text-xs text-danger mb-3">{error}</p>}
            <GlowButton variant="primary" className="w-full" onClick={start} disabled={busy}>
              {busy ? 'Starting…' : view.cta}
            </GlowButton>
          </>
        )}
      </div>
    </div>
  );
}

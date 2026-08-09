import { useState } from 'react';
import { Link } from 'react-router-dom';
import GlowButton from './GlowButton';

const TOS_KEY = 'tos_v1_accepted';

export function useTosAccepted() {
  return localStorage.getItem(TOS_KEY) === 'true';
}

export default function AgeToSModal({ onAccept }) {
  const [age, setAge]   = useState(false);
  const [tos, setTos]   = useState(false);

  function accept() {
    if (!age || !tos) return;
    localStorage.setItem(TOS_KEY, 'true');
    onAccept();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl p-8 shadow-2xl">
        <div className="text-center mb-6">
          <div className="text-5xl mb-3">⚖️</div>
          <h2 className="text-2xl font-black text-white mb-2">Before You Play</h2>
          <p className="text-muted text-sm">This platform involves real-money wagering. Please confirm the following.</p>
        </div>

        <div className="flex flex-col gap-4 mb-8">
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={age}
              onChange={e => setAge(e.target.checked)}
              className="mt-0.5 w-5 h-5 accent-primary cursor-pointer"
            />
            <span className="text-sm text-white leading-relaxed">
              I confirm that I am <span className="font-bold text-primary">18 years of age or older</span> and that real-money gambling is legal in my jurisdiction.
            </span>
          </label>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={tos}
              onChange={e => setTos(e.target.checked)}
              className="mt-0.5 w-5 h-5 accent-primary cursor-pointer"
            />
            <span className="text-sm text-white leading-relaxed">
              I agree to the{' '}
              <Link to="/tos" target="_blank" className="font-bold text-primary hover:underline">Terms of Service</Link>
              {' '}and{' '}
              <Link to="/privacy" target="_blank" className="font-bold text-primary hover:underline">Privacy Policy</Link>
              , and understand that all wagers are final, no chargebacks, and the platform takes a 5% fee on coin matches.
            </span>
          </label>
        </div>

        <GlowButton
          onClick={accept}
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!age || !tos}
        >
          I Confirm — Let Me Play
        </GlowButton>

        <p className="text-center text-xs text-muted mt-4">
          By continuing you accept all terms. This confirmation is saved on this device.
        </p>
      </div>
    </div>
  );
}

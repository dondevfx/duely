import { useEffect, useState } from 'react';
import GlowButton from './GlowButton';
import { api } from '../utils/api';
import { TOS_SECTIONS, PRIVACY_SECTIONS } from '../data/legal';

const TOS_KEY = 'tos_v1_accepted';

/**
 * Has THIS ACCOUNT agreed to the age check and the terms?
 *
 * It used to be one localStorage key, which made acceptance a property of the
 * browser rather than of the person agreeing. A second account signing up on a
 * device that had already accepted was never asked — so there was no record
 * that they agreed to anything — and the same person on a new phone was asked
 * twice. The answer now comes from the account's own row.
 *
 * Three states, not two. `null` means not known yet, and the caller must show
 * nothing while it holds: defaulting to "not accepted" flashes a full-screen
 * legal modal at every returning player on every page load, and defaulting to
 * "accepted" lets a new account through without ever being asked.
 *
 * The local key survives as the fallback for exactly one case — the server
 * answering `accepted: null`, which is what it says while PENDING_SQL section
 * 20 has not been run. Behaviour then is what it was before this change.
 */
export function useTosAccepted(session) {
  const [accepted, setAccepted] = useState(null);

  useEffect(() => {
    if (!session) { setAccepted(null); return undefined; }
    let alive = true;
    api.get('/auth/tos-status')
      .then(d => {
        if (!alive) return;
        if (d?.accepted === null || d?.accepted === undefined) {
          setAccepted(localStorage.getItem(TOS_KEY) === 'true');
        } else {
          setAccepted(!!d.accepted);
        }
      })
      // A failed check must not lock someone out of the site behind a modal
      // whose accept button would fail the same way. Fall back to the local
      // flag, same as an un-migrated server.
      .catch(() => { if (alive) setAccepted(localStorage.getItem(TOS_KEY) === 'true'); });
    return () => { alive = false; };
  }, [session]);

  return accepted;
}

export default function AgeToSModal({ onAccept }) {
  const [age, setAge]   = useState(false);
  const [tos, setTos]   = useState(false);
  // null, 'tos' or 'privacy' — which document is open over the top.
  const [doc, setDoc]   = useState(null);

  function accept() {
    if (!age || !tos) return;
    // Optimistic: the modal closes on the click. A slow or failed write must
    // not leave someone staring at a legal wall they already agreed to — the
    // status check runs again next load, so an unrecorded acceptance costs one
    // repeat of this dialog rather than a locked-out account.
    localStorage.setItem(TOS_KEY, 'true');
    api.post('/auth/tos-accept').catch(() => {});
    onAccept();
  }

  // The document, read in place.
  //
  // These used to be <Link target="_blank"> to /tos and /privacy, and on a
  // phone they opened nothing — a new tab from inside a full-screen gate that
  // blocks navigation, in a webview that may not have tabs at all. So the one
  // thing someone is being asked to agree to was the one thing they could not
  // read. It is shown here instead, scrollable, over the top of this modal.
  //
  // The text comes from data/legal, the same source the /tos and /privacy
  // pages render. Two copies of a legal document is one that quietly stops
  // matching what people actually agreed to.
  if (doc) {
    const [title, sections] = doc === 'tos'
      ? ['Terms of Service', TOS_SECTIONS]
      : ['Privacy Policy', PRIVACY_SECTIONS];
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4 py-6">
        <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-full">
          {/* Header and footer are shrink-0 so the middle is the only thing
              that scrolls — on a short phone in landscape the whole panel
              would otherwise scroll the Back button off the bottom. */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <h2 className="text-lg font-black text-white">{title}</h2>
            <button
              onClick={() => setDoc(null)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-white hover:bg-surfaceLight transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="overflow-y-auto px-5 py-4 min-h-0" style={{ WebkitOverflowScrolling: 'touch' }}>
            {sections.map(({ title: t, body }) => (
              <div key={t} className="mb-5 last:mb-0">
                <h3 className="text-sm font-bold text-white mb-1.5">{t}</h3>
                <p className="text-muted text-xs leading-relaxed">{body}</p>
              </div>
            ))}
          </div>

          <div className="px-5 py-4 border-t border-border shrink-0">
            <GlowButton onClick={() => setDoc(null)} variant="primary" size="lg" className="w-full">
              Back
            </GlowButton>
          </div>
        </div>
      </div>
    );
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

          {/* The text sits OUTSIDE the label on purpose.
              A click on any descendant of a <label> activates its control, so
              the two buttons would be unreachable: tapping "Terms of Service"
              would just toggle the checkbox. The label now wraps only the
              checkbox, and the sentence is a sibling — so the buttons work and
              the box is still hit-target sized. */}
          <div className="flex items-start gap-3">
            <label className="cursor-pointer shrink-0 p-1 -m-1">
              <input
                type="checkbox"
                checked={tos}
                onChange={e => setTos(e.target.checked)}
                className="mt-0.5 w-5 h-5 accent-primary cursor-pointer"
              />
            </label>
            <span className="text-sm text-white leading-relaxed">
              I agree to the{' '}
              <button type="button" onClick={() => setDoc('tos')}
                className="font-bold text-primary underline underline-offset-2">Terms of Service</button>
              {' '}and{' '}
              <button type="button" onClick={() => setDoc('privacy')}
                className="font-bold text-primary underline underline-offset-2">Privacy Policy</button>
              , and understand that all wagers are final and there are no chargebacks.
            </span>
          </div>
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
          By continuing you accept all terms.
        </p>
      </div>
    </div>
  );
}

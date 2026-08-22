import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../utils/api';
import { usePageReady } from '../hooks/usePageReady';
import GlowButton from '../components/GlowButton';

// Identity verification.
//
// Every withdrawal is gated on this, so the page has one job: tell the player
// exactly where they stand and, if there is something to do, let them do it
// without leaving. Arriving here from a blocked withdrawal carries ?from=wallet,
// which is why the copy leads with the withdrawal rather than with paperwork.
//
// No ID upload, no SSN. See routes/kyc.js for why: a real provider collects
// those behind their own compliance, and holding them here would be a liability
// for data we cannot protect properly.

const COUNTRIES = [
  ['US', 'United States'], ['CA', 'Canada'],    ['GB', 'United Kingdom'],
  ['AU', 'Australia'],     ['IE', 'Ireland'],   ['NZ', 'New Zealand'],
  ['DE', 'Germany'],       ['FR', 'France'],    ['ES', 'Spain'],
  ['IT', 'Italy'],         ['NL', 'Netherlands'], ['SE', 'Sweden'],
  ['NO', 'Norway'],        ['DK', 'Denmark'],   ['FI', 'Finland'],
  ['PL', 'Poland'],        ['PT', 'Portugal'],  ['MX', 'Mexico'],
  ['BR', 'Brazil'],        ['JP', 'Japan'],     ['ZA', 'South Africa'],
];

const STATUS_VIEW = {
  approved: {
    icon: '✅', title: 'You are verified',
    body: 'Your identity has been confirmed. Withdrawals are open.',
    cls:  'text-success border-success/40 bg-success/10',
  },
  pending: {
    icon: '⏳', title: 'Under review',
    body: 'We have your details and are checking them. This is a manual review, so it can take a little while. You can update your details below if something was wrong.',
    cls:  'text-warning border-warning/40 bg-warning/10',
  },
  rejected: {
    icon: '⚠️', title: 'We could not verify you',
    body: 'Check the reason below, correct your details and submit again.',
    cls:  'text-danger border-danger/40 bg-danger/10',
  },
  unverified: {
    icon: '🪪', title: 'Verify your identity',
    body: 'We need to know who you are before you can withdraw. It takes a minute.',
    cls:  'text-muted border-surfaceLight bg-surface',
  },
};

const FIELD = 'w-full bg-bg border border-surfaceLight rounded-lg px-3 py-2.5 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors';
const LABEL = 'block text-xs text-muted mb-1';

export default function Kyc() {
  const ready    = usePageReady();
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromWithdrawal = new URLSearchParams(location.search).get('from') === 'wallet';

  const [status, setStatus]   = useState(null);   // null = still loading
  const [reason, setReason]   = useState(null);
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState(null);
  const [done,   setDone]     = useState(false);

  const [form, setForm] = useState({
    legalName: '', dateOfBirth: '', addressLine1: '', addressLine2: '',
    city: '', region: '', postalCode: '', country: 'US',
  });
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    let alive = true;
    api.get('/kyc/status')
      .then(d => { if (!alive) return; setStatus(d.status); setReason(d.rejectionReason); })
      .catch(() => { if (alive) setStatus('unverified'); });
    return () => { alive = false; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/kyc/submit', form);
      setStatus(res.status);
      setReason(null);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not submit. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!ready || status === null) {
    return <div className="max-w-lg mx-auto px-4 py-12 text-muted text-sm">Loading…</div>;
  }

  const view = STATUS_VIEW[status] ?? STATUS_VIEW.unverified;
  // Approved is the one state with nothing to do. Pending still shows the form
  // so a wrong detail can be corrected rather than waiting for a rejection.
  const showForm = status !== 'approved';

  return (
    <div className="max-w-lg mx-auto px-4 py-10">
      <h1 className="text-3xl font-black text-white mb-1">Verification</h1>
      <p className="text-muted text-sm mb-6">
        {cameFromWithdrawal && status !== 'approved'
          ? 'Your withdrawal is waiting on this.'
          : 'Required before you can withdraw.'}
      </p>

      <div className={`border rounded-2xl p-4 mb-6 ${view.cls}`}>
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none" aria-hidden="true">{view.icon}</span>
          <div>
            <div className="font-black text-white text-sm">{view.title}</div>
            <p className="text-xs mt-1 opacity-90">{view.body}</p>
            {status === 'rejected' && reason && (
              <p className="text-xs mt-2 text-white/90">
                <span className="font-bold">Reason:</span> {reason}
              </p>
            )}
          </div>
        </div>
      </div>

      {status === 'approved' && (
        <GlowButton variant="primary" className="w-full" onClick={() => navigate('/wallet')}>
          Back to wallet
        </GlowButton>
      )}

      {done && status === 'pending' && (
        <p className="text-xs text-success mb-4">
          Submitted. We will review it and let you know.
        </p>
      )}

      {showForm && (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className={LABEL} htmlFor="kyc-name">Full legal name</label>
            <input id="kyc-name" className={FIELD} value={form.legalName} onChange={set('legalName')}
              placeholder="As it appears on your ID" autoComplete="name" required />
          </div>

          <div>
            <label className={LABEL} htmlFor="kyc-dob">Date of birth</label>
            <input id="kyc-dob" type="date" className={FIELD} value={form.dateOfBirth}
              onChange={set('dateOfBirth')} autoComplete="bday" required />
            <p className="text-[11px] text-muted mt-1">You must be 18 or over to withdraw.</p>
          </div>

          <div>
            <label className={LABEL} htmlFor="kyc-addr1">Street address</label>
            <input id="kyc-addr1" className={FIELD} value={form.addressLine1} onChange={set('addressLine1')}
              placeholder="123 Main St" autoComplete="address-line1" required />
          </div>

          <div>
            <label className={LABEL} htmlFor="kyc-addr2">Apartment, suite (optional)</label>
            <input id="kyc-addr2" className={FIELD} value={form.addressLine2} onChange={set('addressLine2')}
              autoComplete="address-line2" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="kyc-city">City</label>
              <input id="kyc-city" className={FIELD} value={form.city} onChange={set('city')}
                autoComplete="address-level2" required />
            </div>
            <div>
              <label className={LABEL} htmlFor="kyc-region">State / region</label>
              <input id="kyc-region" className={FIELD} value={form.region} onChange={set('region')}
                autoComplete="address-level1" required />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="kyc-postal">Postal code</label>
              <input id="kyc-postal" className={FIELD} value={form.postalCode} onChange={set('postalCode')}
                autoComplete="postal-code" required />
            </div>
            <div>
              <label className={LABEL} htmlFor="kyc-country">Country</label>
              <select id="kyc-country" className={FIELD} value={form.country} onChange={set('country')}
                autoComplete="country" required>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <GlowButton type="submit" variant="primary" className="w-full" disabled={saving}>
            {saving ? 'Submitting…' : status === 'pending' ? 'Update my details' : 'Submit for verification'}
          </GlowButton>

          <p className="text-[11px] text-muted text-center">
            We use this only to verify who you are. We do not ask for your ID document
            or social security number.
          </p>
        </form>
      )}
    </div>
  );
}

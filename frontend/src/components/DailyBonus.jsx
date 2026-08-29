import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import DiamondIcon from './DiamondIcon';
import { useAuth } from '../context/AuthContext';
import GlowButton from './GlowButton';

function formatCountdown(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export default function DailyBonus() {
  const { refreshProfile } = useAuth();

  const [status, setStatus] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [message, setMessage] = useState(null);
  const [remaining, setRemaining] = useState(0);

  // Both numbers come from the server. They were written out by hand in three
  // places here, so changing the offer meant remembering all three — and any
  // one missed advertises a bonus the server will not give.
  const amount = status?.bonusAmount;
  const period = (() => {
    const ms = status?.cooldownMs;
    if (!ms) return null;
    const mins = Math.round(ms / 60000);
    if (mins >= 60) { const h = Math.round(mins / 60); return h === 1 ? 'hour' : h + ' hours'; }
    return mins === 1 ? 'minute' : mins + ' minutes';
  })();

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.get('/bonus/diamond-status');
      setStatus(data);
      if (data.nextClaimAt) setRemaining(new Date(data.nextClaimAt).getTime() - Date.now());
    } catch {
      setStatus({ canClaim: true, bonusAmount: null });
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (!status?.nextClaimAt) return;
    const interval = setInterval(() => {
      const r = new Date(status.nextClaimAt).getTime() - Date.now();
      if (r <= 0) { fetchStatus(); clearInterval(interval); }
      else setRemaining(r);
    }, 1000);
    return () => clearInterval(interval);
  }, [status, fetchStatus]);

  async function handleClaim() {
    setClaiming(true);
    setMessage(null);
    try {
      const data = await api.post('/bonus/diamond-claim', {});
      setMessage({ type: 'success', text: <span className="inline-flex items-center gap-1">+{data.credited} <DiamondIcon /> claimed!</span> });
      await refreshProfile();
      await fetchStatus();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setClaiming(false);
    }
  }

  if (!status) return null;

  return (
    <div className="flex flex-col items-center gap-3 p-5 bg-surface border border-surfaceLight rounded-2xl">
      <div className="text-2xl"><DiamondIcon /></div>
      <div className="text-center">
        <div className="font-bold text-white">Diamond Bonus</div>
        <div className="text-sm text-muted">
          {amount && period ? `Claim ${amount.toLocaleString()} Diamonds every ${period}` : 'Free diamonds'}
        </div>
      </div>

      {status.canClaim ? (
        <GlowButton variant="success" onClick={handleClaim} disabled={claiming} className="w-full">
          {claiming ? 'Claiming...' : <span className="inline-flex items-center gap-1.5">Claim <DiamondIcon /> {amount ? amount.toLocaleString() : ''}</span>}
        </GlowButton>
      ) : (
        <div className="text-center">
          <div className="text-xs text-muted mb-1">Next bonus in</div>
          <div className="font-mono text-accent text-lg font-bold">
            {remaining > 0 ? formatCountdown(remaining) : '...'}
          </div>
        </div>
      )}

      {message && (
        <p className={`text-sm font-medium ${message.type === 'success' ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

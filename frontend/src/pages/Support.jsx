import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { usePageReady } from '../hooks/usePageReady';
import GlowButton from '../components/GlowButton';

// Player support. A ticket is a thread — staff reply, the player writes back —
// so a problem that takes a few exchanges to sort out stays in one place
// instead of becoming three disconnected reports.
//
// Reached with ?tx=<id> from the wallet, which attaches the transaction so
// "where is my withdrawal" arrives already pointing at the row.
const STATUS_LABEL = {
  open:          { text: 'Waiting on us',   cls: 'text-warning border-warning/40 bg-warning/10' },
  awaiting_user: { text: 'Your reply',      cls: 'text-primary border-primary/40 bg-primary/10' },
  closed:        { text: 'Closed',          cls: 'text-muted border-border' },
};

export default function Support() {
  const ready = usePageReady();
  const { session } = useAuth();
  const location = useLocation();
  const txId = new URLSearchParams(location.search).get('tx');

  const [tickets, setTickets] = useState([]);
  const [open, setOpen] = useState(null);        // the thread being viewed
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => api.get('/support/tickets').then(setTickets).catch(() => {});
  useEffect(() => { if (session) load(); }, [session]);

  async function create() {
    if (!subject.trim() || !body.trim() || busy) return;
    setBusy(true); setMsg('');
    try {
      await api.post('/support/tickets', { subject, body, transactionId: txId || undefined });
      setSubject(''); setBody('');
      setMsg('Sent — we\'ll reply here.');
      await load();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  async function openTicket(id) {
    try { setOpen(await api.get(`/support/tickets/${id}`)); } catch { /* ignore */ }
  }

  async function sendReply() {
    if (!reply.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/support/tickets/${open.id}/reply`, { body: reply });
      setReply('');
      await openTicket(open.id);
      await load();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  if (!session) {
    return (
      <div className="min-h-[calc(100vh-56px)] flex items-center justify-center px-4">
        <p className="text-muted">Sign in to contact support.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg px-4 py-8"
         style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-black text-white mb-1">Support</h1>
        <p className="text-sm text-muted mb-6">
          Deposits, withdrawals, matches — anything that looks wrong.
        </p>

        {open ? (
          <div className="bg-surface border border-surfaceLight rounded-2xl p-5">
            <button onClick={() => setOpen(null)}
              className="text-xs text-muted hover:text-white mb-3">← All tickets</button>
            <h2 className="text-lg font-black text-white mb-3">{open.subject}</h2>

            <div className="space-y-3 mb-4 max-h-[50vh] overflow-y-auto">
              {open.messages.map(m => (
                <div key={m.id}
                  className={`rounded-xl px-3 py-2 ${m.is_staff
                    ? 'bg-primary/10 border border-primary/30'
                    : 'bg-bg border border-border'}`}>
                  <div className="text-[0.625rem] font-bold mb-1"
                       style={{ color: m.is_staff ? '#4DA3FF' : '#64748b' }}>
                    {m.is_staff ? 'Duely Support' : 'You'} · {new Date(m.created_at).toLocaleString()}
                  </div>
                  <p className="text-sm text-white whitespace-pre-wrap break-words">{m.body}</p>
                </div>
              ))}
            </div>

            <textarea
              value={reply} onChange={e => setReply(e.target.value)}
              placeholder="Write a reply…" rows={3}
              className="w-full bg-bg border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary mb-2"
            />
            <GlowButton onClick={sendReply} variant="primary" className="w-full" disabled={busy || !reply.trim()}>
              {busy ? 'Sending…' : 'Send Reply'}
            </GlowButton>
          </div>
        ) : (
          <>
            <div className="bg-surface border border-surfaceLight rounded-2xl p-5 mb-5">
              <h2 className="text-base font-black text-white mb-3">New ticket</h2>
              {txId && (
                <p className="text-xs text-primary mb-2">
                  Linked to transaction {txId.slice(0, 8)}… — we'll see it with your message.
                </p>
              )}
              <input
                value={subject} onChange={e => setSubject(e.target.value)}
                placeholder="Subject" maxLength={120}
                className="w-full bg-bg border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary mb-2"
              />
              <textarea
                value={body} onChange={e => setBody(e.target.value)}
                placeholder="What happened? Include amounts and time stamps if you can." rows={4}
                className="w-full bg-bg border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-muted focus:outline-none focus:border-primary mb-2"
              />
              {msg && <p className="text-xs text-muted mb-2">{msg}</p>}
              <GlowButton onClick={create} variant="primary" className="w-full"
                disabled={busy || !subject.trim() || !body.trim()}>
                {busy ? 'Sending…' : 'Send'}
              </GlowButton>
            </div>

            {tickets.length > 0 && (
              <div className="space-y-2">
                {tickets.map(t => {
                  const s = STATUS_LABEL[t.status] || STATUS_LABEL.closed;
                  return (
                    <button key={t.id} onClick={() => openTicket(t.id)}
                      className="w-full text-left bg-surface border border-surfaceLight rounded-xl px-4 py-3 hover:border-primary transition-all">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white truncate flex-1">{t.subject}</span>
                        <span className={`text-[0.625rem] font-bold px-2 py-0.5 rounded-full border shrink-0 ${s.cls}`}>
                          {s.text}
                        </span>
                      </div>
                      <div className="text-[0.625rem] text-muted mt-0.5">
                        {new Date(t.updated_at).toLocaleString()}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

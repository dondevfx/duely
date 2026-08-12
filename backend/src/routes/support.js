const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

// Player-facing support tickets.
//
// A ticket is a thread, not a form submission: staff reply, the player writes
// back, and the whole exchange stays in one place. `status` tracks whose turn it
// is rather than just open/closed, so the admin inbox can show what is actually
// waiting on staff instead of everything ever raised.

const MAX_SUBJECT = 120;
const MAX_BODY    = 4000;
// Enough to stop someone papering the inbox, loose enough that a person with a
// genuine problem is never blocked from describing it.
const MAX_OPEN_TICKETS = 5;

module.exports = function supportRoutes(supabase, io) {
  const router = Router();

  const clean = (v, max) => String(v ?? '').trim().slice(0, max);

  // ── The caller's tickets ────────────────────────────────────────────
  router.get('/tickets', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, subject, status, transaction_id, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── One thread ──────────────────────────────────────────────────────
  router.get('/tickets/:id', requireAuth, async (req, res) => {
    // Ownership is checked here rather than relying on RLS, because this route
    // runs on the service key, which bypasses it.
    const { data: ticket } = await supabase
      .from('support_tickets').select('*')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { data: messages } = await supabase
      .from('support_messages')
      .select('id, sender_id, is_staff, body, created_at')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: true });

    res.json({ ...ticket, messages: messages || [] });
  });

  // ── Raise a ticket ──────────────────────────────────────────────────
  router.post('/tickets', requireAuth, async (req, res) => {
    const subject = clean(req.body?.subject, MAX_SUBJECT);
    const body    = clean(req.body?.body, MAX_BODY);
    if (!subject || !body) return res.status(400).json({ error: 'Subject and message are required' });

    const { count } = await supabase
      .from('support_tickets').select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id).neq('status', 'closed');
    if ((count ?? 0) >= MAX_OPEN_TICKETS) {
      return res.status(429).json({
        error: 'You already have several open tickets — please reply on one of those instead.',
      });
    }

    // Only accept a transaction id that belongs to the caller. Without this
    // check anyone could attach their ticket to someone else's withdrawal and
    // read its details back through the admin view.
    let transaction_id = null;
    if (req.body?.transactionId) {
      const { data: tx } = await supabase
        .from('transactions').select('id')
        .eq('id', req.body.transactionId).eq('user_id', req.user.id).maybeSingle();
      transaction_id = tx?.id || null;
    }

    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .insert({ user_id: req.user.id, subject, transaction_id, status: 'open' })
      .select('id').single();
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('support_messages')
      .insert({ ticket_id: ticket.id, sender_id: req.user.id, is_staff: false, body });

    res.json({ ok: true, id: ticket.id });
  });

  // ── Player replies ──────────────────────────────────────────────────
  router.post('/tickets/:id/reply', requireAuth, async (req, res) => {
    const body = clean(req.body?.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Message is required' });

    const { data: ticket } = await supabase
      .from('support_tickets').select('id, status')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    await supabase.from('support_messages')
      .insert({ ticket_id: ticket.id, sender_id: req.user.id, is_staff: false, body });

    // Replying reopens a closed ticket. Otherwise a player whose problem was
    // not actually fixed has to raise a second one and lose the history.
    await supabase.from('support_tickets')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', ticket.id);

    res.json({ ok: true });
  });

  return router;
};

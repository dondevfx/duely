/**
 * escrowService.js
 *
 * Crash safety net for paid matches.
 *
 * Entry fees are deducted at match start, but rooms live in memory — so if the
 * process restarts mid-match (deploy, crash, OOM) the room is gone and nobody is
 * ever paid. That silently eats real player money, which is exactly the kind of
 * thing that makes people leave.
 *
 * So: record an escrow row when fees are taken, delete it when the match
 * settles, and on boot refund anything still open (by definition abandoned,
 * since every in-memory room died with the old process).
 *
 * Every function here is failure-tolerant and never throws — if escrow is
 * unavailable (e.g. the table hasn't been created yet) settlement behaves
 * exactly as it did before. This is purely additive insurance.
 */

let _tableMissing = false;

function _warnOnce(err) {
  if (_tableMissing) return;
  if (/relation .*match_escrow.* does not exist|could not find the table/i.test(err?.message || '')) {
    _tableMissing = true;
    console.warn('[escrow] match_escrow table not found — crash-refund protection is OFF. Run the migration to enable it.');
  }
}

// Record that both players have paid into a match.
async function openEscrow(supabase, p1Id, p2Id, entryFee, currency) {
  if (_tableMissing || !supabase || !p1Id || !p2Id) return;
  const fee = parseFloat(entryFee);
  if (!fee || fee <= 0) return;
  try {
    const { error } = await supabase.from('match_escrow').insert({
      p1_id: p1Id, p2_id: p2Id, entry_fee: fee, currency: currency || 'coins',
    });
    if (error) _warnOnce(error);
  } catch (e) { _warnOnce(e); }
}

// Match settled normally — the money has been paid out, drop the escrow.
async function closeEscrow(supabase, p1Id, p2Id) {
  if (_tableMissing || !supabase || !p1Id || !p2Id) return;
  try {
    const { error } = await supabase
      .from('match_escrow')
      .delete()
      .or(`and(p1_id.eq.${p1Id},p2_id.eq.${p2Id}),and(p1_id.eq.${p2Id},p2_id.eq.${p1Id})`);
    if (error) _warnOnce(error);
  } catch (e) { _warnOnce(e); }
}

// On boot: every open escrow belongs to a match whose room died with the old
// process, so refund both players their entry fee and clear the row.
async function refundAbandonedEscrows(supabase) {
  if (!supabase) return;
  try {
    const { data: rows, error } = await supabase.from('match_escrow').select('*');
    if (error) { _warnOnce(error); return; }
    if (!rows?.length) return;

    console.log(`[escrow] refunding ${rows.length} abandoned match(es) from a previous run`);
    for (const r of rows) {
      const fee = parseFloat(r.entry_fee);
      const isDiamonds = r.currency === 'diamonds';
      for (const uid of [r.p1_id, r.p2_id]) {
        try {
          if (isDiamonds) {
            await supabase.rpc('credit_diamonds', { user_id: uid, amount: Math.floor(fee) });
          } else {
            await supabase.rpc('credit_coins', { user_id: uid, amount: fee });
          }
          await supabase.from('transactions').insert({
            user_id: uid,
            type: 'match_refund',
            amount_c: isDiamonds ? 0 : fee,
            ...(isDiamonds ? { crypto_amount: Math.floor(fee), crypto_symbol: 'diamonds' } : {}),
            status: 'confirmed',
            notes: 'Refund — match interrupted',
          }).then().catch(() => {});
          console.log(`[escrow] refunded ${fee} ${r.currency} to ${uid}`);
        } catch (e) {
          console.error(`[escrow] REFUND FAILED user=${uid} amount=${fee} ${r.currency}:`, e.message);
        }
      }
      await supabase.from('match_escrow').delete().eq('id', r.id).then().catch(() => {});
    }
  } catch (e) {
    console.error('[escrow] startup refund sweep failed:', e.message);
  }
}

module.exports = { openEscrow, closeEscrow, refundAbandonedEscrows };

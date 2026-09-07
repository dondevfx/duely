/**
 * Money that arrives on the right address but the wrong chain.
 *
 * An ETH deposit address is the same 0x address on every EVM network, so a
 * player withdrawing from an app that defaults to an L2 sends real funds to a
 * real address of ours — and the monitor, which only ever looks at Ethereum
 * mainnet, sees nothing. The player sees nothing either. That is how $8.13 of
 * ETH sat unnoticed on Robinhood Chain: the send succeeded, the address was
 * correct, and every part of this system was quietly looking somewhere else.
 *
 * Robinhood is the case that prompted this and the one most likely to recur:
 * withdrawing ETH there defaults to Robinhood Chain, not mainnet, so anyone
 * funding an account from Robinhood hits it without doing anything unusual.
 *
 * This DETECTS and REPORTS. It does not credit and does not forward, both
 * deliberately:
 *
 *  - Forwarding is impossible. The deposit sweep converts to USDC through
 *    ChangeNow, which has no Robinhood Chain support, and sendEth signs for
 *    mainnet. There is no path from here to the exchange.
 *  - Crediting would therefore be unbacked — real coins issued against ETH that
 *    cannot be moved or sold until somebody bridges it by hand. One $8 deposit
 *    is nothing; a policy of it is a solvency hole.
 *
 * So the money becomes visible and a person decides. Being seen is the part
 * that was missing; the funds themselves were never at risk, since the address
 * derives from WALLET_MASTER_SECRET and we can spend it on any EVM chain.
 */

// Chains an ETH withdrawal plausibly lands on by accident, cheapest first to
// check. Each is a public RPC — no key, and one eth_getBalance per address.
const L2_CHAINS = [
  { name: 'Robinhood Chain', chainId: 4663,  rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  { name: 'Base',            chainId: 8453,  rpc: 'https://base-rpc.publicnode.com' },
  { name: 'Arbitrum',        chainId: 42161, rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  { name: 'Optimism',        chainId: 10,    rpc: 'https://optimism-rpc.publicnode.com' },
];

// Dust is not a deposit. Below this it is not worth a person's attention, and
// bridging it would cost more than it is worth.
const MIN_REPORT_ETH = 0.0005;

async function rpc(url, method, params, ms = 10_000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(ms),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

/**
 * Balances of our ETH deposit addresses on chains we do not watch.
 * Returns [{ chain, chainId, userId, address, eth }], only above MIN_REPORT_ETH.
 */
async function findStranded(supabase, { minEth = MIN_REPORT_ETH } = {}) {
  const { data } = await supabase
    .from('deposit_addresses').select('user_id, address').ilike('coin', 'eth');
  const addrs = data || [];
  if (!addrs.length) return [];

  const found = [];
  for (const chain of L2_CHAINS) {
    for (const a of addrs) {
      try {
        const wei = BigInt(await rpc(chain.rpc, 'eth_getBalance', [a.address, 'latest']));
        const eth = Number(wei) / 1e18;
        if (eth >= minEth) {
          found.push({ chain: chain.name, chainId: chain.chainId,
                       userId: a.user_id, address: a.address, eth });
        }
      } catch {
        // A public RPC being down is not a finding. The next pass asks again.
      }
    }
  }
  return found;
}

// Report, once per (chain, address, rounded amount). The same stranded balance
// sits there until a person moves it, and re-reporting it every pass is how a
// real finding gets scrolled past.
const _reported = new Set();

async function sweep(supabase) {
  let found;
  try {
    found = await findStranded(supabase);
  } catch (e) {
    console.error('[l2watch] sweep failed:', e.message);
    return [];
  }

  for (const f of found) {
    const key = `${f.chainId}:${f.address}:${f.eth.toFixed(6)}`;
    if (_reported.has(key)) continue;
    _reported.add(key);
    console.warn(
      `[l2watch] ${f.eth} ETH sat on ${f.chain} (chain ${f.chainId}) at ${f.address} ` +
      `— user ${f.userId}. Sent to the right address on the wrong network: not credited, ` +
      `not forwardable, recoverable by hand from WALLET_MASTER_SECRET.`);
    try {
      const { Sentry, enabled } = require('../instrument');
      if (enabled) Sentry.captureMessage('deposit stranded on an unwatched chain',
        { level: 'warning', extra: f });
    } catch { /* monitoring must never break the sweep */ }
  }
  return found;
}

module.exports = { findStranded, sweep, L2_CHAINS, MIN_REPORT_ETH };

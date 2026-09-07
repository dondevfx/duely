#!/usr/bin/env node
/**
 * Move ETH out of a deposit address on any EVM chain.
 *
 * Written for money that arrived on the right address but the wrong network —
 * a player withdrawing from an app that defaults to an L2 sends to a real
 * address of ours on a chain the monitor does not watch, and the normal deposit
 * path cannot help: it forwards to ChangeNow, which has no L2 support, and
 * sendEth signs for mainnet.
 *
 * The funds are never at risk. The address derives from WALLET_MASTER_SECRET,
 * so we hold the key on every EVM chain at once; they only need a transaction
 * signed for the right chain id. That is all this does.
 *
 * It refuses to do anything by default. Run it, read what it says it would do,
 * and run it again with --send.
 *
 * Usage:
 *   node scripts/recover-evm.js --user <uuid> --chain robinhood --to 0xABC...
 *   node scripts/recover-evm.js --user <uuid> --chain robinhood --to 0xABC... --send
 *
 * WALLET_MASTER_SECRET must be set. It is not in the local .env, so this runs
 * on the server (Railway: `railway run node scripts/recover-evm.js ...`).
 */
require('dotenv').config();
const ethers = require('ethers');
const { getAddress } = require('../src/services/addressService');

const CHAINS = {
  robinhood: { name: 'Robinhood Chain', chainId: 4663,  rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  base:      { name: 'Base',            chainId: 8453,  rpc: 'https://base-rpc.publicnode.com' },
  arbitrum:  { name: 'Arbitrum One',    chainId: 42161, rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  optimism:  { name: 'Optimism',        chainId: 10,    rpc: 'https://optimism-rpc.publicnode.com' },
  mainnet:   { name: 'Ethereum',        chainId: 1,     rpc: process.env.ALCHEMY_ETH_RPC || 'https://ethereum-rpc.publicnode.com' },
};

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}
const SEND = process.argv.includes('--send');

function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }

(async () => {
  const userId = arg('user');
  const chainKey = (arg('chain') || '').toLowerCase();
  const to = arg('to');
  const coin = (arg('coin') || 'eth').toLowerCase();

  if (!userId || !chainKey || !to) {
    die('usage: --user <uuid> --chain <' + Object.keys(CHAINS).join('|') + '> --to <0x address> [--send]');
  }
  const chain = CHAINS[chainKey];
  if (!chain) die(`unknown chain "${chainKey}" — one of: ${Object.keys(CHAINS).join(', ')}`);
  if (!ethers.isAddress(to)) die(`"${to}" is not a valid address`);
  if (!process.env.WALLET_MASTER_SECRET) {
    die('WALLET_MASTER_SECRET is not set. This has to run where the secret lives ' +
        '(Railway: `railway run node scripts/recover-evm.js ...`).');
  }

  const { address, privKey } = getAddress(userId, coin);
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const wallet = new ethers.Wallet('0x' + privKey.toString('hex'), provider);

  // Check the derived address against the one actually ISSUED to this player.
  //
  // Comparing the derived address to the derived key proves nothing — both come
  // from the same secret, so they always agree. The question worth asking is
  // whether this secret is the one that issued the address the player was
  // given: if WALLET_MASTER_SECRET were ever rotated, every derivation would
  // silently move to a different address and this would sign for a wallet that
  // holds nothing while the real funds sat where they are.
  //
  // The stored row is the record of what the player was actually told to send
  // to, so that is what it is checked against.
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    die('SUPABASE_URL / SUPABASE_SERVICE_KEY are needed to confirm the derived ' +
        'address is the one this player was issued');
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: issued, error: issuedErr } = await supabase
    .from('deposit_addresses').select('address')
    .eq('user_id', userId).ilike('coin', coin).maybeSingle();
  if (issuedErr) die(`could not read the issued address: ${issuedErr.message}`);
  if (!issued) die(`no ${coin.toUpperCase()} deposit address was ever issued to ${userId}`);
  if (issued.address.toLowerCase() !== wallet.address.toLowerCase()) {
    die(`the key derives ${wallet.address} but ${userId} was issued ${issued.address} — ` +
        'WALLET_MASTER_SECRET is not the secret that issued this address. Stopping: ' +
        'signing here would move nothing and prove nothing.');
  }

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== chain.chainId) {
    die(`${chain.rpc} reports chain ${net.chainId}, expected ${chain.chainId}`);
  }

  const balance = await provider.getBalance(address);
  if (balance === 0n) die(`${address} holds nothing on ${chain.name}`);

  // Leave exactly the gas, send the rest. A plain transfer is 21000 gas; the
  // fee data is padded because a fee that rises between estimating and sending
  // makes the transaction unminable, and there is no second attempt once the
  // balance is spent.
  const fee = await provider.getFeeData();
  const gasPrice = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n;
  const gasCost = gasPrice * 21000n;
  if (balance <= gasCost) {
    die(`${ethers.formatEther(balance)} ETH will not cover ${ethers.formatEther(gasCost)} ETH of gas`);
  }
  const value = balance - gasCost;

  console.log(`
  chain     ${chain.name} (${chain.chainId})
  from      ${address}
  to        ${to}
  balance   ${ethers.formatEther(balance)} ETH
  gas       ${ethers.formatEther(gasCost)} ETH  (21000 @ ${ethers.formatUnits(gasPrice, 'gwei')} gwei, padded 2x)
  sending   ${ethers.formatEther(value)} ETH
`);

  if (!SEND) {
    console.log('  Nothing sent. Re-run with --send to do it.\n');
    return;
  }

  const tx = await wallet.sendTransaction({ to, value, gasLimit: 21000n });
  console.log(`  broadcast ${tx.hash}\n  waiting for a confirmation...`);
  const rc = await tx.wait(1);
  console.log(rc.status === 1
    ? `  confirmed in block ${rc.blockNumber}\n`
    : `  REVERTED — the funds are still at ${address}\n`);
})().catch((e) => die(e.message));

/**
 * sweep.js
 * Sends stuck SOL from deposit address — tries Jupiter first, falls back to direct send.
 *
 * Usage (PowerShell):
 *   $env:WALLET_MASTER_SECRET="xxx"
 *   $env:USDC_SPL_ADDRESS="xxx"
 *   $env:SOLANA_RPC="https://mainnet.helius-rpc.com/?api-key=xxx"
 *   node sweep.js
 */

require('dotenv').config();

const USER_ID = '423d2b0c-1dae-4947-8340-b07575954383';
const COIN    = 'sol';
const AMOUNT  = 0.066757677;
const GAS_RES = 0.000005;

async function main() {
  const { getAddress }    = require('./src/services/addressService');
  const { sendCrypto }    = require('./src/services/chainSend');
  const { swapSolToUsdc } = require('./src/services/jupiterService');

  const adminWallet = process.env.USDC_SPL_ADDRESS;
  if (!adminWallet) throw new Error('USDC_SPL_ADDRESS not set');

  const netAmount = AMOUNT - GAS_RES;
  const { privKey, address } = getAddress(USER_ID, COIN);
  console.log(`From: ${address}`);
  console.log(`Amount: ${netAmount} SOL`);

  // Try Jupiter swap first
  try {
    console.log('Trying Jupiter swap...');
    const txHash = await swapSolToUsdc(privKey, netAmount, adminWallet);
    console.log(`✓ Jupiter swap done! tx=${txHash}`);
    console.log('USDC will appear in your Phantom wallet shortly.');
    return;
  } catch (e) {
    console.warn(`Jupiter failed: ${e.message}`);
    console.log('Falling back to direct SOL send...');
  }

  // Fallback: send SOL directly to Phantom
  const txHash = await sendCrypto({ coin: COIN, privKey, toAddress: adminWallet, amount: netAmount });
  console.log(`✓ Sent ${netAmount} SOL directly to Phantom. tx=${txHash}`);
  console.log('Swap manually in Phantom.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

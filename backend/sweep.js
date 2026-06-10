/**
 * sweep.js
 * One-time script to forward stuck SOL from a deposit address using Jupiter.
 *
 * Usage (PowerShell):
 *   $env:WALLET_MASTER_SECRET="xxx"
 *   $env:USDC_SPL_ADDRESS="xxx"
 *   node sweep.js
 */

require('dotenv').config();

const USER_ID = '423d2b0c-1dae-4947-8340-b07575954383';
const COIN    = 'sol';
const AMOUNT  = 0.04592;
const GAS_RES = 0.000005;

async function main() {
  const { getAddress }    = require('./src/services/addressService');
  const { swapSolToUsdc } = require('./src/services/jupiterService');

  const usdcAddress = process.env.USDC_SPL_ADDRESS;
  if (!usdcAddress) throw new Error('USDC_SPL_ADDRESS not set');

  const netAmount = AMOUNT - GAS_RES;
  const { privKey, address } = getAddress(USER_ID, COIN);

  console.log(`Sweeping ${netAmount} SOL from ${address} via Jupiter → USDC → ${usdcAddress}`);

  const txHash = await swapSolToUsdc(privKey, netAmount, usdcAddress);
  console.log(`✓ Done! tx=${txHash}`);
  console.log(`USDC will appear in your Phantom wallet shortly.`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

/**
 * sweep.js
 * One-time script to forward stuck SOL from a deposit address to SimpleSwap → USDC → Phantom.
 *
 * Usage:
 *   WALLET_MASTER_SECRET=xxx SIMPLESWAP_API_KEY=xxx USDC_SPL_ADDRESS=xxx node sweep.js
 */

require('dotenv').config();

const USER_ID  = '423d2b0c-1dae-4947-8340-b07575954383';
const COIN     = 'sol';
const AMOUNT   = 0.03104;  // amount received in deposit
const GAS_RES  = 0.000005; // SOL gas reserve

async function main() {
  const { getAddress }        = require('./src/services/addressService');
  const { sendCrypto }        = require('./src/services/chainSend');
  const { createDepositSwap } = require('./src/services/simpleSwapService');

  const usdcAddress = process.env.USDC_SPL_ADDRESS;
  if (!usdcAddress) throw new Error('USDC_SPL_ADDRESS not set');

  const netAmount = AMOUNT - GAS_RES;
  console.log(`Sweeping ${netAmount} ${COIN} → SimpleSwap → USDC → ${usdcAddress}`);


  const { privKey, address } = getAddress(USER_ID, COIN);
  console.log(`From address: ${address}`);

  // Create ChangeNow exchange
  const swap = await createDepositSwap({
    coin:             COIN,
    amount:           netAmount,
    ourStableAddress: usdcAddress,
    refundAddress:    '',
  });
  console.log(`SimpleSwap exchange created: ${swap.exchangeId}`);
  console.log(`Sending to SimpleSwap deposit address: ${swap.depositAddress}`);

  // Send SOL to SimpleSwap
  const txHash = await sendCrypto({
    coin:      COIN,
    privKey,
    toAddress: swap.depositAddress,
    amount:    netAmount,
  });

  console.log(`✓ Done! Sent tx: ${txHash}`);
  console.log(`Exchange ID: ${swap.exchangeId}`);
  console.log(`USDC will arrive in your Phantom wallet in ~5-10 minutes.`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

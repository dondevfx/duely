/**
 * check-minimums.js
 * Checks ChangeNow minimum amounts and fees for all supported coins.
 *
 * Usage:
 *   $env:CHANGENOW_API_KEY="xxx"
 *   node check-minimums.js
 */

require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.CHANGENOW_API_KEY;
const coins   = ['btc', 'eth', 'sol', 'ltc', 'trx', 'doge', 'bnbbsc'];
const TO      = 'usdcsol';

async function main() {
  console.log('Checking ChangeNow minimums for each coin → USDC...\n');
  for (const coin of coins) {
    try {
      const res  = await fetch(`https://api.changenow.io/v1/min-amount/${coin}_${TO}?api_key=${API_KEY}`);
      const data = await res.json();
      const min  = parseFloat(data.minAmount || 0);

      // Get estimated output for min amount
      const estRes  = await fetch(`https://api.changenow.io/v1/exchange-amount/${min}/${coin}_${TO}/?api_key=${API_KEY}`);
      const estData = await estRes.json();
      const out     = parseFloat(estData.estimatedAmount || 0);

      console.log(`${coin.padEnd(8)} min=${min} → ~$${out.toFixed(2)} USDC`);
    } catch (e) {
      console.log(`${coin.padEnd(8)} error: ${e.message}`);
    }
  }
}

main().catch(console.error);

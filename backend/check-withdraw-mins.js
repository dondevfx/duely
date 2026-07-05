require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.CHANGENOW_API_KEY;
const coins   = ['btc', 'eth', 'sol', 'ltc', 'trx', 'doge', 'bnbbsc'];

async function main() {
  console.log('Checking ChangeNow minimums for USDC → each coin (withdrawal)...\n');
  for (const coin of coins) {
    try {
      const res  = await fetch(`https://api.changenow.io/v1/min-amount/usdcsol_${coin}?api_key=${API_KEY}`);
      const data = await res.json();
      const min  = parseFloat(data.minAmount || 0);

      // min is in USDC since we're sending USDC
      console.log(`${coin.padEnd(8)} min = $${min.toFixed(2)} USDC`);
    } catch (e) {
      console.log(`${coin.padEnd(8)} error: ${e.message}`);
    }
  }
}

main().catch(console.error);

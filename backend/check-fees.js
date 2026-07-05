require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.CHANGENOW_API_KEY;

async function checkFee(coin, amountUsd, priceUsd) {
  const coinAmount = amountUsd / priceUsd;
  const res  = await fetch(`https://api.changenow.io/v1/exchange-amount/${coinAmount}/${coin}_usdcsol/?api_key=${API_KEY}`);
  const data = await res.json();
  const out  = parseFloat(data.estimatedAmount || 0);
  const fee  = ((amountUsd - out) / amountUsd * 100).toFixed(1);
  console.log(`  $${amountUsd.toString().padEnd(6)} → $${out.toFixed(2).padEnd(7)} USDC  (fee: ${fee}%)`);
}

async function main() {
  console.log('\nSOL fees at different amounts:');
  const solPrice = 62.7;
  for (const usd of [2, 5, 10, 20, 50, 100]) {
    await checkFee('sol', usd, solPrice);
  }

  console.log('\nBTC fees at different amounts:');
  const btcPrice = 44000;
  for (const usd of [5, 10, 20, 50, 100]) {
    await checkFee('btc', usd, btcPrice);
  }
}

main().catch(console.error);

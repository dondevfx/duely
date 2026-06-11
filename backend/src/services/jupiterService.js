/**
 * jupiterService.js
 *
 * Swaps SOL → USDC on-chain using Jupiter DEX aggregator.
 * No minimum, ~0.3% fee, instant settlement on Solana.
 *
 * Flow:
 *   1. Get quote from Jupiter API
 *   2. Get unsigned swap transaction
 *   3. Sign with deposit address keypair
 *   4. USDC lands directly in admin Phantom wallet
 */

const fetch   = require('node-fetch');
const solWeb3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

// Try newer lite API first, fall back to standard
const JUPITER_API = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = new solWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * Swap SOL → USDC using Jupiter.
 * @param {Buffer} privKey       - 32-byte private key of the deposit address
 * @param {number} amountSol     - amount of SOL to swap
 * @param {string} adminAddress  - admin Phantom wallet address (USDC goes here)
 * @returns {string} transaction hash
 */
async function swapSolToUsdc(privKey, amountSol, adminAddress) {
  const rpc        = process.env.SOLANA_RPC || 'https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || '');
  const connection = new solWeb3.Connection(rpc, 'confirmed');
  const keypair    = solWeb3.Keypair.fromSeed(new Uint8Array(privKey));
  const lamports   = Math.floor(amountSol * solWeb3.LAMPORTS_PER_SOL);

  // Step 1 — get quote
  const quoteUrl = `${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT.toBase58()}&amount=${lamports}&slippageBps=50`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter quote HTTP ${quoteRes.status}`);
  const quote    = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  // Step 2 — get admin's USDC associated token account (output destination)
  const adminPubkey  = new solWeb3.PublicKey(adminAddress);
  const adminUsdcAta = splToken.getAssociatedTokenAddressSync(USDC_MINT, adminPubkey);

  // Step 3 — get swap transaction
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      quoteResponse:           quote,
      userPublicKey:           keypair.publicKey.toBase58(),
      destinationTokenAccount: adminUsdcAta.toBase58(),
      wrapAndUnwrapSol:        true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap HTTP ${swapRes.status}`);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Jupiter swap error: ${swapData.error}`);

  // Step 4 — deserialize, sign, send
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx    = solWeb3.VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight:       false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(txHash, 'confirmed');

  // outAmount is USDC in micro-units (6 decimals)
  const usdcReceived = parseFloat(quote.outAmount) / 1e6;

  console.log(`[jupiter] swapped ${amountSol} SOL → ${usdcReceived} USDC, tx=${txHash}`);
  return { txHash, usdcReceived };
}

/**
 * Swap USDC → SOL using Jupiter, signed by the admin Phantom wallet.
 * Used for SOL withdrawals — much cheaper than ChangeNow (~0.3% vs 5-7%).
 * @param {Buffer} adminPrivKey  - 32-byte seed of admin Phantom wallet
 * @param {number} amountUsdc   - USDC amount to swap
 * @param {string} playerAddress - SOL wallet address to send SOL to
 * @returns {{ txHash, solReceived }}
 */
async function swapUsdcToSol(adminPrivKey, amountUsdc, playerAddress) {
  const rpc        = process.env.SOLANA_RPC || 'https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || '');
  const connection = new solWeb3.Connection(rpc, 'confirmed');
  const keypair    = solWeb3.Keypair.fromSeed(new Uint8Array(adminPrivKey));
  const usdcUnits  = Math.floor(amountUsdc * 1_000_000);   // USDC 6 decimals

  // Step 1 — get quote USDC → SOL
  const quoteUrl = `${JUPITER_API}/quote?inputMint=${USDC_MINT.toBase58()}&outputMint=${SOL_MINT}&amount=${usdcUnits}&slippageBps=50`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter quote HTTP ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  const solReceived = parseFloat(quote.outAmount) / solWeb3.LAMPORTS_PER_SOL;
  console.log(`[jupiter] USDC→SOL quote: ${amountUsdc} USDC → ${solReceived} SOL for ${playerAddress}`);

  // Step 2 — get swap transaction, output SOL goes to player's wallet directly
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      quoteResponse:    quote,
      userPublicKey:    keypair.publicKey.toBase58(),
      // No destinationTokenAccount — SOL unwraps to player's native wallet
      destinationWallet: playerAddress,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap HTTP ${swapRes.status}`);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Jupiter swap error: ${swapData.error}`);

  // Step 3 — sign and send
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx    = solWeb3.VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight:       false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(txHash, 'confirmed');

  console.log(`[jupiter] swapped ${amountUsdc} USDC → ${solReceived} SOL → ${playerAddress}, tx=${txHash}`);
  return { txHash, solReceived };
}

module.exports = { swapSolToUsdc, swapUsdcToSol };

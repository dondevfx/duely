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
const USDT_MINT   = new solWeb3.PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

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

  // Step 1 — get quote USDC → SOL (150 bps slippage to avoid SlippageToleranceExceeded)
  const quoteUrl = `${JUPITER_API}/quote?inputMint=${USDC_MINT.toBase58()}&outputMint=${SOL_MINT}&amount=${usdcUnits}&slippageBps=150`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter quote HTTP ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  const solReceived = parseFloat(quote.outAmount) / solWeb3.LAMPORTS_PER_SOL;
  console.log(`[jupiter] USDC→SOL quote: ${amountUsdc} USDC → ${solReceived} SOL for ${playerAddress}`);

  // Step 2 — get swap transaction
  // Jupiter sends SOL to admin wallet (userPublicKey) with wrapAndUnwrapSol
  // We then forward it to the player in a second tx
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      quoteResponse:    quote,
      userPublicKey:    keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap HTTP ${swapRes.status}`);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Jupiter swap error: ${swapData.error}`);

  // Step 3 — sign and send swap tx
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx    = solWeb3.VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const swapTxHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight:       false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(swapTxHash, 'confirmed');
  console.log(`[jupiter] swapped ${amountUsdc} USDC → ${solReceived} SOL in admin wallet, tx=${swapTxHash}`);

  // Step 4 — send SOL from admin wallet to player
  // Keep a tiny reserve for tx fee, send the rest
  const FEE_RESERVE_LAMPORTS = 5_000;   // 0.000005 SOL for tx fee
  const sendLamports = Math.floor(solReceived * solWeb3.LAMPORTS_PER_SOL) - FEE_RESERVE_LAMPORTS;
  if (sendLamports <= 0) throw new Error('SOL amount too small after fee reserve');

  const playerPubkey = new solWeb3.PublicKey(playerAddress);
  const sendTx = new solWeb3.Transaction().add(
    solWeb3.SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey:   playerPubkey,
      lamports:   sendLamports,
    })
  );
  // The leg that actually pays the player. sendAndVerify carries the signature
  // on failure, so a confirmation timeout can be checked against the chain
  // instead of being refunded blind — see chainSend.
  const { sendAndVerify } = require('./chainSend');
  const sendTxHash = await sendAndVerify(connection, sendTx, [keypair]);
  const solSent = sendLamports / solWeb3.LAMPORTS_PER_SOL;

  console.log(`[jupiter] sent ${solSent} SOL → ${playerAddress}, tx=${sendTxHash}`);
  return { txHash: sendTxHash, solReceived: solSent };
}

/**
 * Swap USDC → USDT in the admin wallet, for a USDT withdrawal.
 *
 * Both are dollar stablecoins on the same chain, so this is the cheapest swap
 * on the site — deep liquidity, near-1:1, and no second chain to wait for.
 * ChangeNow would charge several percent and add two confirmation waits for
 * what Jupiter does in one transaction.
 *
 * The output lands in the ADMIN wallet's own USDT account, not the player's.
 * Sending it on is a separate step through sendSplToken, which creates the
 * recipient's token account if they have never held USDT — Jupiter cannot be
 * relied on to do that for an arbitrary destination, and a swap that lands
 * nowhere is worse than one more transaction.
 *
 * Slippage is 50bps rather than the 150 used for USDC → SOL. A stablecoin pair
 * does not move like a volatile one, and a loose tolerance here would just be
 * accepting a worse price than the market is offering.
 *
 * @param {Buffer} adminPrivKey - 32-byte seed of the admin wallet
 * @param {number} amountUsdc   - USDC to swap
 * @returns {{ txHash, usdtReceived }}
 */
async function swapUsdcToUsdt(adminPrivKey, amountUsdc) {
  const rpc        = process.env.SOLANA_RPC || 'https://mainnet.helius-rpc.com/?api-key=' + (process.env.HELIUS_API_KEY || '');
  const connection = new solWeb3.Connection(rpc, 'confirmed');
  const keypair    = solWeb3.Keypair.fromSeed(new Uint8Array(adminPrivKey));
  const usdcUnits  = Math.floor(amountUsdc * 1_000_000);   // both are 6 decimals

  const quoteUrl = `${JUPITER_API}/quote?inputMint=${USDC_MINT.toBase58()}` +
                   `&outputMint=${USDT_MINT.toBase58()}&amount=${usdcUnits}&slippageBps=50`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter quote HTTP ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: false,   // neither side of this pair is native SOL
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap HTTP ${swapRes.status}`);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error(`Jupiter swap error: ${swapData.error}`);

  const tx = solWeb3.VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([keypair]);
  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(txHash, 'confirmed');

  const usdtReceived = parseFloat(quote.outAmount) / 1e6;
  console.log(`[jupiter] swapped ${amountUsdc} USDC → ${usdtReceived} USDT, tx=${txHash}`);
  return { txHash, usdtReceived };
}

module.exports = { swapSolToUsdc, swapUsdcToSol, swapUsdcToUsdt };

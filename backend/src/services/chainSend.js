/**
 * chainSend.js
 *
 * Sends crypto from one of our self-hosted derived addresses to an external address.
 * Used to forward received deposits to SimpleSwap's deposit address.
 */

const ethers  = require('ethers');
const solWeb3 = require('@solana/web3.js');
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('tiny-secp256k1');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const bs58    = require('bs58');

bitcoin.initEccLib(ecc);

const USDC_MINT = new solWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// ── Sending money is not the same as failing to confirm it ───────────────────
//
// sendAndConfirmTransaction broadcasts FIRST and waits SECOND. When the wait
// times out — congestion, a slow RPC, a dropped socket — it throws, and the
// caller sees a failed payout. The transaction may well have landed anyway.
//
// That mattered because the withdrawal handler refunds on any payout error. A
// timeout therefore paid the player on-chain AND put their coins back: a real
// double-spend, and one anybody could fish for by retrying withdrawals during
// congestion until a confirmation happened to time out.
//
// So the signature is captured at BROADCAST time and carried on the error. A
// caller that is about to refund can then ask the chain what actually happened
// instead of assuming the worst.
class PayoutError extends Error {
  constructor(message, signature) {
    super(message);
    this.name = 'PayoutError';
    this.signature = signature || null;   // null = never broadcast, safe to refund
  }
}

// Broadcast, then confirm. Any failure after the broadcast carries the signature.
async function sendAndVerify(connection, tx, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  // Nothing has been broadcast yet, so a failure here is unambiguous.
  let signature;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e) {
    throw new PayoutError(e.message, null);
  }

  try {
    const res = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight }, 'confirmed');
    // Landed but reverted. The money did not move, so this is safe to refund —
    // but it still gets the signature, so the caller's own check agrees.
    if (res?.value?.err) {
      throw new PayoutError(`transaction failed on chain: ${JSON.stringify(res.value.err)}`, signature);
    }
  } catch (e) {
    if (e instanceof PayoutError) throw e;
    throw new PayoutError(`could not confirm: ${e.message}`, signature);
  }
  return signature;
}

// What actually happened to a signature. Called before refunding.
//
//   'confirmed' — it landed and succeeded. Do NOT refund.
//   'failed'    — it landed and reverted. The money is still ours; refund.
//   'missing'   — the chain has no record and the blockhash can no longer be
//                 revived. Refund.
//   'unknown'   — we could not find out. Refund NOTHING and escalate; guessing
//                 here is how you either rob a player or pay them twice.
async function checkSolanaSignature(signature, { attempts = 5, delayMs = 3000 } = {}) {
  if (!signature) return 'missing';
  const connection = new solWeb3.Connection(
    process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');

  let sawRpc = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      sawRpc = true;
      const st = value?.[0];
      if (st) {
        if (st.err) return 'failed';
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
      }
    } catch { /* try again — an RPC that is down is not an answer */ }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  // The RPC answered every time and never heard of it. A transaction that has
  // not landed within this window cannot land later: its blockhash has expired.
  if (sawRpc) return 'missing';
  return 'unknown';
}

// Actual network fee reserves (realistic)
const GAS_RESERVE = {
  btc:  0.00002,   // ~$1.30 at $65k — covers typical tx fee
  eth:  0.0004,    // ~$1.20 at $3k  — covers ERC-20 transfer gas
  bnb:  0.0005,    // ~$0.30          — covers BSC transfer gas
  sol:  0.000005,  // ~$0.001         — Solana fees nearly zero
  ltc:  0.001,     // ~$0.08
  trx:  5,         // ~$0.75          — TRX bandwidth
  doge: 1,         // ~$0.12
  usdc: 0.000005,  // SOL fee for USDC SPL transfer
};

// ── DER-encode a raw 64-byte secp256k1 signature ──────────────────────────────
function derEncode(rawSig) {
  let r = Buffer.from(rawSig.slice(0, 32));
  let s = Buffer.from(rawSig.slice(32, 64));
  // strip leading zeros; prepend 0x00 if high bit set (prevent negative interpretation)
  while (r.length > 1 && r[0] === 0) r = r.slice(1);
  if (r[0] & 0x80) r = Buffer.concat([Buffer.from([0x00]), r]);
  while (s.length > 1 && s[0] === 0) s = s.slice(1);
  if (s[0] & 0x80) s = Buffer.concat([Buffer.from([0x00]), s]);
  const seq = Buffer.concat([
    Buffer.from([0x02, r.length]), r,
    Buffer.from([0x02, s.length]), s,
  ]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

// ── base58check helper ────────────────────────────────────────────────────────
function b58encode(buf) {
  return (bs58.default?.encode ?? bs58.encode)(buf);
}

// ── ETH ───────────────────────────────────────────────────────────────────────

async function sendEth(privKey, toAddress, amount) {
  const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_ETH_RPC);
  const wallet   = new ethers.Wallet('0x' + privKey.toString('hex'), provider);
  const tx       = await wallet.sendTransaction({
    to:    toAddress,
    value: ethers.parseEther(String(amount)),
  });
  await tx.wait(1);
  return tx.hash;
}

// ── BNB (BSC) ─────────────────────────────────────────────────────────────────

async function sendBnb(privKey, toAddress, amount) {
  const provider = new ethers.JsonRpcProvider(
    process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/'
  );
  const wallet = new ethers.Wallet('0x' + privKey.toString('hex'), provider);
  const tx     = await wallet.sendTransaction({
    to:    toAddress,
    value: ethers.parseEther(String(amount)),
  });
  await tx.wait(1);
  return tx.hash;
}

// ── SOL ───────────────────────────────────────────────────────────────────────

async function sendSol(privKey, toAddress, amount) {
  const connection = new solWeb3.Connection(
    process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );
  const keypair  = solWeb3.Keypair.fromSeed(new Uint8Array(privKey));
  const toPubkey = new solWeb3.PublicKey(toAddress);
  const lamports = Math.floor(amount * solWeb3.LAMPORTS_PER_SOL);
  const tx = new solWeb3.Transaction().add(
    solWeb3.SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey, lamports })
  );
  return solWeb3.sendAndConfirmTransaction(connection, tx, [keypair]);
}

// ── USDC SPL ──────────────────────────────────────────────────────────────────

async function sendUsdcSpl(privKey, toAddress, amount) {
  const splToken   = require('@solana/spl-token');
  const rpc        = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new solWeb3.Connection(rpc, 'confirmed');
  const keypair    = solWeb3.Keypair.fromSeed(new Uint8Array(privKey));
  const usdcMint   = USDC_MINT;
  const units      = Math.floor(amount * 1_000_000);   // USDC = 6 decimals

  // Source is always the admin keypair's own USDC ATA, derived from its pubkey.
  //
  // This used to read ADMIN_USDC_ATA with a hardcoded fallback, which is a trap:
  // the transfer below signs with `keypair` as the OWNER of the source account,
  // so any address other than this keypair's ATA is rejected by the token program.
  // The env var could never hold a legitimately different value — all it could do
  // is go stale. It did: rotating ADMIN_PHANTOM_PRIVATE_KEY and USDC_SPL_ADDRESS
  // left the fallback pointing at the previous wallet's token account, and every
  // withdrawal failed on an owner mismatch. Deriving it cannot drift.
  const fromAta = splToken.getAssociatedTokenAddressSync(usdcMint, keypair.publicKey);

  // Check admin wallet has enough SOL for fees + ATA creation (~0.003 SOL minimum)
  const solBalance = await connection.getBalance(keypair.publicKey);
  if (solBalance < 3_000_000) {   // 0.003 SOL in lamports
    throw new Error(
      `Admin wallet has insufficient SOL for fees (${solBalance / 1e9} SOL). ` +
      `Send at least 0.05 SOL to ${keypair.publicKey.toBase58()}`
    );
  }

  // Source balance. Without this the token program fails with an opaque custom
  // error, and the payout path only surfaces `err.message` to the admin queue —
  // so an empty payout wallet looked identical to a broken key.
  let fromBal = 0;
  try {
    fromBal = Number((await splToken.getAccount(connection, fromAta)).amount);
  } catch {
    throw new Error(
      `Admin USDC token account ${fromAta.toBase58()} does not exist. ` +
      `Send any amount of USDC to ${keypair.publicKey.toBase58()} to create it.`
    );
  }
  if (fromBal < units) {
    throw new Error(
      `Admin wallet USDC balance too low: has ${fromBal / 1e6}, needs ${amount}.`
    );
  }

  // Recipient ATA — create if it doesn't exist (costs ~0.002 SOL from admin wallet)
  const toPubkey = new solWeb3.PublicKey(toAddress);
  const toAtaAccount = await splToken.getOrCreateAssociatedTokenAccount(
    connection, keypair, usdcMint, toPubkey
  );
  const toAta = toAtaAccount.address;

  console.log(`[chainSend] USDC transfer: ${fromAta.toBase58()} → ${toAta.toBase58()} (${units} units)`);
  // Built explicitly rather than via splToken.transfer, which is a wrapper over
  // sendAndConfirmTransaction and throws away the signature when confirmation
  // fails — leaving no way to find out whether the money actually moved.
  const tx = new solWeb3.Transaction().add(
    splToken.createTransferInstruction(fromAta, toAta, keypair.publicKey, units)
  );
  return sendAndVerify(connection, tx, [keypair]);
}

// ── TRX ───────────────────────────────────────────────────────────────────────

async function sendTrx(privKey, toAddress, amount) {
  const TronWebModule = require('tronweb');
  // Handle both default export and named export across tronweb versions
  const TronWeb = TronWebModule.TronWeb || TronWebModule.default || TronWebModule;
  const privKeyHex = privKey.toString('hex');
  const tronWeb = new TronWeb({
    fullHost:   'https://api.trongrid.io',
    privateKey: privKeyHex,
  });
  const sun         = Math.floor(amount * 1_000_000);
  const fromAddress = tronWeb.defaultAddress.base58;
  const tx          = await tronWeb.transactionBuilder.sendTrx(toAddress, sun, fromAddress);
  const signed      = await tronWeb.trx.sign(tx, privKeyHex);
  const receipt     = await tronWeb.trx.sendRawTransaction(signed);
  if (receipt.code && receipt.code !== 'SUCCESS') {
    throw new Error(`TRX send failed: ${receipt.code} ${receipt.message || ''}`);
  }
  return receipt.txid || signed.txID;
}

// ── BTC / LTC / DOGE (via BlockCypher) ───────────────────────────────────────

const BLOCKCYPHER_CHAINS = {
  btc:  'btc/main',
  ltc:  'ltc/main',
  doge: 'doge/main',
};

const P2PKH_VERSION = { btc: 0x00, ltc: 0x30, doge: 0x1e };

async function sendUtxoCoin(coin, privKey, toAddress, amount) {
  // Derive compressed public key and P2PKH from address
  const signingKey    = new ethers.SigningKey('0x' + privKey.toString('hex'));
  const compressedPub = Buffer.from(signingKey.compressedPublicKey.slice(2), 'hex');
  const sha256        = crypto.createHash('sha256').update(compressedPub).digest();
  const hash160       = crypto.createHash('ripemd160').update(sha256).digest();
  const version       = P2PKH_VERSION[coin];
  const versioned     = Buffer.concat([Buffer.from([version]), hash160]);
  const checksum      = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(versioned).digest())
    .digest().slice(0, 4);
  const fromAddress = b58encode(Buffer.concat([versioned, checksum]));

  const satoshis = Math.floor(amount * 1e8);
  const chain    = BLOCKCYPHER_CHAINS[coin];
  const token    = process.env.BLOCKCYPHER_TOKEN || '';
  const apiBase  = `https://api.blockcypher.com/v1/${chain}`;
  const qs       = token ? `?token=${token}` : '';

  // Step 1: build unsigned transaction skeleton
  const skelRes = await fetch(`${apiBase}/txs/new${qs}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      inputs:  [{ addresses: [fromAddress] }],
      outputs: [{ addresses: [toAddress], value: satoshis }],
    }),
  });
  const skel = await skelRes.json();
  if (skel.errors?.length) throw new Error(`BlockCypher skeleton: ${JSON.stringify(skel.errors)}`);

  // Step 2: sign each hash with DER-encoded secp256k1 signature + SIGHASH_ALL (0x01)
  const pubkeyHex = compressedPub.toString('hex');
  skel.pubkeys    = skel.tosign.map(() => pubkeyHex);
  skel.signatures = skel.tosign.map(hexHash => {
    const hash   = Buffer.from(hexHash, 'hex');
    const rawSig = ecc.sign(hash, privKey);          // 64-byte raw r||s
    const der    = derEncode(Buffer.from(rawSig));   // DER-encoded
    return der.toString('hex') + '01';               // + SIGHASH_ALL byte
  });

  // Step 3: broadcast
  const sendRes = await fetch(`${apiBase}/txs/send${qs}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(skel),
  });
  const sent = await sendRes.json();
  if (sent.errors?.length) throw new Error(`BlockCypher broadcast: ${JSON.stringify(sent.errors)}`);
  return sent.tx?.hash;
}

// ── USDC sweep ────────────────────────────────────────────────────────────────

/**
 * Moves the entire USDC balance of one derived deposit address into the admin
 * payout wallet.
 *
 * Every other coin forwards on arrival; USDC never did, so deposits accumulated
 * in per-user addresses while the payout wallet only ever drained.
 *
 * Deposit addresses hold no SOL and so cannot pay their own transaction fee.
 * Rather than dusting every address with SOL, the admin wallet signs as fee
 * payer while the deposit address signs only as the transfer authority — two
 * signatures, one transaction. Both keys are ours.
 *
 * Sweeps the whole balance rather than the amount of any single deposit, so one
 * run also collects whatever earlier deposits stranded. Returns null when there
 * is nothing to move, which makes it safe to call on every deposit and safe to
 * re-run after a failure.
 */
async function sweepUsdc(fromPrivKey) {
  const splToken   = require('@solana/spl-token');
  const rpc        = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new solWeb3.Connection(rpc, 'confirmed');

  const adminAddress = process.env.USDC_SPL_ADDRESS;
  const adminSecret  = process.env.ADMIN_PHANTOM_PRIVATE_KEY;
  if (!adminAddress) throw new Error('USDC_SPL_ADDRESS not set');
  if (!adminSecret)  throw new Error('ADMIN_PHANTOM_PRIVATE_KEY not set');

  const decoded  = (bs58.default?.decode ?? bs58.decode)(adminSecret);
  const adminKp  = solWeb3.Keypair.fromSeed(Buffer.from(decoded).slice(0, 32));
  const adminPub = new solWeb3.PublicKey(adminAddress);

  // These two are set independently and nothing else checks they agree. If they
  // disagree the sweep would pay a fee from one wallet to fund a different one,
  // so fail loudly instead — a rotation that only updates one is the likely
  // cause, and that is worth an alert rather than a silent misdirection.
  if (!adminKp.publicKey.equals(adminPub)) {
    throw new Error(
      `ADMIN_PHANTOM_PRIVATE_KEY controls ${adminKp.publicKey.toBase58()} but ` +
      `USDC_SPL_ADDRESS is ${adminAddress} — refusing to sweep.`
    );
  }

  const fromKp  = solWeb3.Keypair.fromSeed(new Uint8Array(fromPrivKey));
  const fromAta = splToken.getAssociatedTokenAddressSync(USDC_MINT, fromKp.publicKey);
  const toAta   = splToken.getAssociatedTokenAddressSync(USDC_MINT, adminPub);

  let units;
  try {
    units = (await splToken.getAccount(connection, fromAta)).amount;
  } catch {
    return null;   // no token account here — nothing was ever received
  }
  if (units <= 0n) return null;

  const tx = new solWeb3.Transaction();
  if (!(await connection.getAccountInfo(toAta))) {
    tx.add(splToken.createAssociatedTokenAccountInstruction(
      adminKp.publicKey, toAta, adminPub, USDC_MINT
    ));
  }
  tx.add(splToken.createTransferInstruction(fromAta, toAta, fromKp.publicKey, units));
  tx.feePayer = adminKp.publicKey;

  const txHash = await solWeb3.sendAndConfirmTransaction(connection, tx, [adminKp, fromKp]);
  const amount = Number(units) / 1e6;
  console.log(`[chainSend] swept ${amount} USDC ${fromKp.publicKey.toBase58()} → ${adminAddress} tx=${txHash}`);
  return { txHash, amount };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function sendCrypto({ coin, privKey, toAddress, amount }) {
  console.log(`[chainSend] sending ${amount} ${coin} → ${toAddress}`);
  switch (coin.toLowerCase()) {
    case 'eth':  return sendEth(privKey, toAddress, amount);
    case 'bnb':  return sendBnb(privKey, toAddress, amount);
    case 'sol':  return sendSol(privKey, toAddress, amount);
    case 'usdc': return sendUsdcSpl(privKey, toAddress, amount);
    case 'trx':  return sendTrx(privKey, toAddress, amount);
    case 'btc':
    case 'ltc':
    case 'doge': return sendUtxoCoin(coin, privKey, toAddress, amount);
    default:     throw new Error(`chainSend: unsupported coin ${coin}`);
  }
}

module.exports = { sendCrypto, sweepUsdc, GAS_RESERVE, PayoutError, checkSolanaSignature, sendAndVerify };

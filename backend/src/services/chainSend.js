/**
 * chainSend.js
 *
 * Sends crypto from one of our self-hosted derived addresses to an external address.
 * Used to forward received deposits to SimpleSwap's deposit address.
 *
 * Each chain uses its own broadcast mechanism:
 *   ETH / SHIB  — ethers.js + Alchemy RPC
 *   SOL         — @solana/web3.js + public Solana RPC
 *   TRX / USDT  — TronWeb + TronGrid
 *   BTC/LTC/DOGE— bitcoinjs-lib + BlockCypher
 */

const ethers   = require('ethers');
const solWeb3  = require('@solana/web3.js');
const bitcoin  = require('bitcoinjs-lib');
const ecc      = require('tiny-secp256k1');
const fetch    = require('node-fetch');
const crypto   = require('crypto');
const bs58     = require('bs58');

bitcoin.initEccLib(ecc);

// ── Constants ────────────────────────────────────────────────────────────────

// (no token contracts needed — BNB and XRP are native coins)

// Actual network fee reserves (realistic, not inflated)
const GAS_RESERVE = {
  btc:  0.00002,   // ~$1.30 at $65k BTC — covers typical tx fee
  eth:  0.0004,    // ~$1.20 at $3k ETH — covers ERC-20 transfer gas
  sol:  0.000005,  // ~$0.001 — Solana fees are nearly zero
  ltc:  0.001,     // ~$0.08 — LTC fees are tiny
  trx:  5,         // ~$0.75 — TRX bandwidth/energy for TRC-20 transfer
  doge: 1,         // ~$0.12 — DOGE fees
};

// ── ETH / SHIB ────────────────────────────────────────────────────────────────

async function sendEth(privKey, toAddress, amount) {
  const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_ETH_RPC);
  const wallet   = new ethers.Wallet('0x' + privKey.toString('hex'), provider);
  const value    = ethers.parseEther(String(amount));
  const tx       = await wallet.sendTransaction({ to: toAddress, value });
  await tx.wait(1);
  return tx.hash;
}

async function sendBnb(privKey, toAddress, amount) {
  const provider = new ethers.JsonRpcProvider(
    process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/'
  );
  const wallet = new ethers.Wallet('0x' + privKey.toString('hex'), provider);
  const value  = ethers.parseEther(String(amount));
  const tx     = await wallet.sendTransaction({ to: toAddress, value });
  await tx.wait(1);
  return tx.hash;
}

async function sendUsdcSpl(privKey, toAddress, amount) {
  const splToken = require('@solana/spl-token');
  const connection = new solWeb3.Connection(
    process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );
  const keypair   = solWeb3.Keypair.fromSeed(new Uint8Array(privKey));
  const toPubkey  = new solWeb3.PublicKey(toAddress);
  const usdcMint  = new solWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const decimals  = 6;   // USDC has 6 decimal places
  const units     = Math.floor(amount * 10 ** decimals);

  // Get or create associated token accounts for sender and receiver
  const fromAta = await splToken.getOrCreateAssociatedTokenAccount(
    connection, keypair, usdcMint, keypair.publicKey
  );
  const toAta = await splToken.getOrCreateAssociatedTokenAccount(
    connection, keypair, usdcMint, toPubkey
  );

  const sig = await splToken.transfer(
    connection, keypair, fromAta.address, toAta.address, keypair, units
  );
  return sig;
}

// ── SOL ───────────────────────────────────────────────────────────────────────

async function sendSol(privKey, toAddress, amount) {
  const connection = new solWeb3.Connection(
    process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );
  const keypair    = solWeb3.Keypair.fromSeed(new Uint8Array(privKey));
  const toPubkey   = new solWeb3.PublicKey(toAddress);
  const lamports   = Math.floor(amount * solWeb3.LAMPORTS_PER_SOL);

  const tx = new solWeb3.Transaction().add(
    solWeb3.SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey, lamports })
  );
  const sig = await solWeb3.sendAndConfirmTransaction(connection, tx, [keypair]);
  return sig;
}

// ── TRX ───────────────────────────────────────────────────────────────────────

async function sendTrx(privKey, toAddress, amount) {
  const TronWeb = require('tronweb');
  const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });
  tronWeb.setPrivateKey(privKey.toString('hex'));
  const sun = Math.floor(amount * 1_000_000);
  const tx  = await tronWeb.trx.sendTransaction(toAddress, sun);
  return tx.txid;
}

async function sendUsdtTrc20(privKey, toAddress, amount) {
  const TronWeb = require('tronweb');
  const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });
  tronWeb.setPrivateKey(privKey.toString('hex'));
  const contract = await tronWeb.contract().at(USDT_TRC20_CONTRACT);
  const units    = Math.floor(amount * 1_000_000);   // USDT has 6 decimals
  const tx       = await contract.transfer(toAddress, units).send();
  return tx;
}

// ── BTC / LTC / DOGE (via BlockCypher) ───────────────────────────────────────

const BLOCKCYPHER_CHAINS = {
  btc:  { chain: 'btc/main', network: bitcoin.networks.bitcoin },
  ltc:  { chain: 'ltc/main', network: { ...bitcoin.networks.bitcoin, pubKeyHash: 0x30, scriptHash: 0x32 } },
  doge: { chain: 'doge/main', network: { ...bitcoin.networks.bitcoin, pubKeyHash: 0x1e, scriptHash: 0x16 } },
};

async function sendUtxoCoin(coin, privKey, toAddress, amount) {
  const { chain, network } = BLOCKCYPHER_CHAINS[coin];
  const signingKey = new ethers.SigningKey('0x' + privKey.toString('hex'));
  const compressedPub = Buffer.from(signingKey.compressedPublicKey.slice(2), 'hex');

  // Derive fromAddress from private key
  const sha256  = crypto.createHash('sha256').update(compressedPub).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha256).digest();
  const version = coin === 'ltc' ? 0x30 : coin === 'doge' ? 0x1e : 0x00;
  const bs58enc = (typeof bs58.default?.encode === 'function') ? bs58.default.encode : bs58.encode;

  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(Buffer.concat([Buffer.from([version]), hash160])).digest())
    .digest().slice(0, 4);
  const fromAddress = bs58enc(Buffer.concat([Buffer.from([version]), hash160, checksum]));

  const satoshis = Math.floor(amount * 1e8);
  const bcKey    = process.env.BLOCKCYPHER_TOKEN || '';
  const apiBase  = `https://api.blockcypher.com/v1/${chain}`;

  // Step 1: new transaction skeleton
  const newTxRes = await fetch(`${apiBase}/txs/new?token=${bcKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs:  [{ addresses: [fromAddress] }],
      outputs: [{ addresses: [toAddress], value: satoshis }],
    }),
  });
  const newTx = await newTxRes.json();
  if (newTx.errors) throw new Error('BlockCypher new tx error: ' + JSON.stringify(newTx.errors));

  // Step 2: sign each to_sign hash
  const ECPair = bitcoin.ECPair ?? require('bitcoinjs-lib').ECPair;
  const keyPair = bitcoin.ECPair
    ? bitcoin.ECPair.fromPrivateKey(privKey, { network, compressed: true })
    : { sign: (hash) => Buffer.from(ecc.sign(hash, privKey)) };

  newTx.pubkeys   = [];
  newTx.signatures = newTx.tosign.map(hexHash => {
    const hash = Buffer.from(hexHash, 'hex');
    const sig  = Buffer.from(ecc.sign(hash, privKey));
    const derSig = bitcoin.script.signature.encode(sig, bitcoin.Transaction.SIGHASH_ALL);
    newTx.pubkeys.push(compressedPub.toString('hex'));
    return derSig.toString('hex');
  });

  // Step 3: send signed transaction
  const sendRes = await fetch(`${apiBase}/txs/send?token=${bcKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newTx),
  });
  const sent = await sendRes.json();
  if (sent.errors) throw new Error('BlockCypher send error: ' + JSON.stringify(sent.errors));
  return sent.tx?.hash;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Send `amount` of `coin` from our derived address (identified by privKey)
 * to `toAddress`. Returns the transaction hash.
 */
async function sendCrypto({ coin, privKey, toAddress, amount }) {
  console.log(`[chainSend] sending ${amount} ${coin} → ${toAddress}`);
  switch (coin.toLowerCase()) {
    case 'eth':  return sendEth(privKey, toAddress, amount);
    case 'bnb':  return sendBnb(privKey, toAddress, amount);
    case 'sol':  return sendSol(privKey, toAddress, amount);
    case 'trx':  return sendTrx(privKey, toAddress, amount);
    case 'usdc': return sendUsdcSpl(privKey, toAddress, amount);
    case 'btc':
    case 'ltc':
    case 'doge': return sendUtxoCoin(coin, privKey, toAddress, amount);
    default:     throw new Error(`chainSend: unsupported coin ${coin}`);
  }
}

module.exports = { sendCrypto, GAS_RESERVE };

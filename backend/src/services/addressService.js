/**
 * addressService.js
 *
 * Deterministic HD-style address generation.
 * For each user+coin, we derive a unique private key from the master secret:
 *   privKey = HMAC-SHA256(WALLET_MASTER_SECRET, "{userId}:{coin}")
 *
 * Same input always produces the same address — no DB needed for generation.
 * We store generated addresses in deposit_addresses table so the monitor
 * knows which addresses to watch.
 */

const crypto   = require('crypto');
const ethers   = require('ethers');
const bitcoin  = require('bitcoinjs-lib');
const ecc      = require('tiny-secp256k1');
const bs58     = require('bs58');
const solWeb3  = require('@solana/web3.js');

// initialise bitcoinjs-lib with the secp256k1 implementation
bitcoin.initEccLib(ecc);

const MASTER = process.env.WALLET_MASTER_SECRET;

// ── Key derivation ────────────────────────────────────────────────────────────
function derivePrivKey(userId, coin) {
  if (!MASTER) throw new Error('WALLET_MASTER_SECRET not set');
  return crypto
    .createHmac('sha256', Buffer.from(MASTER, 'hex'))
    .update(`${userId}:${coin.toLowerCase()}`)
    .digest();   // 32-byte Buffer
}

// ── Base58Check (for BTC/LTC/DOGE/TRX) ───────────────────────────────────────
function base58Check(payload) {
  const checksum = crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .slice(0, 4);
  return bs58.default
    ? bs58.default.encode(Buffer.concat([payload, checksum]))
    : bs58.encode(Buffer.concat([payload, checksum]));
}

// ── Address generators ────────────────────────────────────────────────────────

function ethAddress(privKey) {
  return new ethers.Wallet('0x' + privKey.toString('hex')).address;
}

// BTC P2PKH (version 0x00), LTC P2PKH (0x30), DOGE P2PKH (0x1e)
function p2pkhAddress(privKey, version) {
  const signingKey = new ethers.SigningKey('0x' + privKey.toString('hex'));
  // compressed pubkey (33 bytes, strip leading '0x04' → '02' or '03')
  const compressedPub = Buffer.from(signingKey.compressedPublicKey.slice(2), 'hex');
  const sha256  = crypto.createHash('sha256').update(compressedPub).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha256).digest();
  const versioned = Buffer.concat([Buffer.from([version]), hash160]);
  return base58Check(versioned);
}

function tronAddress(privKey) {
  // TRX address = ETH address bytes prepended with 0x41, then base58check
  const wallet  = new ethers.Wallet('0x' + privKey.toString('hex'));
  const ethHex  = wallet.address.slice(2).toLowerCase();   // 20 bytes hex, no 0x
  const payload = Buffer.from('41' + ethHex, 'hex');        // 21 bytes
  return base58Check(payload);
}

function solAddress(privKey) {
  // SOL uses Ed25519; @solana/web3.js Keypair.fromSeed() expects 32-byte seed
  const kp = solWeb3.Keypair.fromSeed(new Uint8Array(privKey));
  return kp.publicKey.toBase58();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns { address, memo, coin, privKey }
 * privKey is needed by chainSend.js to sign outgoing transactions.
 */
function getAddress(userId, coin) {
  const privKey = derivePrivKey(userId, coin);
  let address, memo = null;

  switch (coin.toLowerCase()) {
    case 'btc':
      address = p2pkhAddress(privKey, 0x00);
      break;
    case 'eth':
    case 'shib':
      address = ethAddress(privKey);
      break;
    case 'ltc':
      address = p2pkhAddress(privKey, 0x30);
      break;
    case 'doge':
      address = p2pkhAddress(privKey, 0x1e);
      break;
    case 'trx':
    case 'usdttrc20':
      address = tronAddress(privKey);
      break;
    case 'sol':
      address = solAddress(privKey);
      break;
    default:
      throw new Error(`Unsupported coin: ${coin}`);
  }

  return { address, memo, coin: coin.toLowerCase(), privKey };
}

/**
 * Get or create a deposit address for userId+coin.
 * Stores the address in `deposit_addresses` table so the monitor can watch it.
 * Returns { address, memo, coin }.
 */
async function getOrCreateAddress(userId, coin, supabase) {
  const { address, memo } = getAddress(userId, coin);

  // Upsert into deposit_addresses (unique on user_id + coin)
  await supabase
    .from('deposit_addresses')
    .upsert({ user_id: userId, coin: coin.toLowerCase(), address }, { onConflict: 'user_id,coin' });

  return { address, memo, coin: coin.toLowerCase() };
}

module.exports = { getAddress, getOrCreateAddress };

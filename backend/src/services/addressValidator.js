// Per-chain withdrawal address validation.
//
// The previous check was a single regex on character class and length, which
// accepts a Bitcoin address as a Solana destination, a truncated address, or an
// address with a typo that still looks plausible. On the Solana paths a bad
// address throws during send and the deduct-then-refund path returns the money,
// so the player sees an opaque failure. On the swap-routed coins we were relying
// entirely on the exchange to catch it.
//
// Everything here uses libraries the project already depends on, and every
// validator verifies a CHECKSUM rather than a shape — that is the part that
// catches a mistyped character, which a regex never can.

const bs58 = require('bs58');
const crypto = require('node:crypto');

const b58decode = (s) => (bs58.default?.decode ?? bs58.decode)(s);

// ── base58check: <version><payload><4-byte checksum> ────────────────────────
// Used by BTC legacy, LTC legacy, DOGE and TRON.
function base58Check(addr, expectedVersions, expectedLen = 21) {
  let raw;
  try { raw = Buffer.from(b58decode(addr)); } catch { return false; }
  if (raw.length !== expectedLen + 4) return false;

  const body = raw.subarray(0, raw.length - 4);
  const csum = raw.subarray(raw.length - 4);
  const hash = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(body).digest())
    .digest();
  if (!csum.equals(hash.subarray(0, 4))) return false;

  const version = expectedLen === 21 ? body[0] : body.readUInt8(0);
  return expectedVersions.includes(version);
}

// ── bech32 / bech32m, enough to verify the checksum and the human-readable part
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Verify(addr, expectedHrp) {
  const s = addr.toLowerCase();
  if (s !== addr && addr.toUpperCase() !== addr) return false;   // no mixed case
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length || s.length > 90) return false;
  const hrp = s.slice(0, sep);
  if (hrp !== expectedHrp) return false;

  const data = [];
  for (const ch of s.slice(sep + 1)) {
    const v = B32.indexOf(ch);
    if (v === -1) return false;
    data.push(v);
  }

  const polymod = (values) => {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
  };
  const expand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0,
                         ...[...h].map((c) => c.charCodeAt(0) & 31)];
  const res = polymod([...expand(hrp), ...data]);
  return res === 1 || res === 0x2bc830a3;   // bech32 or bech32m
}

// ── Per-chain validators ────────────────────────────────────────────────────

function isEvm(addr) {
  // ethers accepts a bare 40-hex string without the 0x prefix; the sending code
  // expects the prefixed form, so require it here rather than normalising late.
  if (!/^0x/.test(addr)) return false;
  try {
    const { isAddress } = require('ethers');
    // ethers also enforces the EIP-55 checksum when the address is mixed case,
    // which is what catches a single mistyped character.
    return isAddress(addr);
  } catch {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
  }
}

// NOTE: Solana addresses carry NO checksum — any 32 bytes is a valid public
// key. So this catches wrong-chain addresses and malformed base58, but a typo
// that still decodes to 32 bytes cannot be detected by anyone, us included.
// That is a property of the chain, not a gap here.
function isSolana(addr) {
  try {
    const { PublicKey } = require('@solana/web3.js');
    // Throws unless it decodes to exactly 32 bytes.
    // eslint-disable-next-line no-new
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

const isBtc  = (a) => base58Check(a, [0x00, 0x05]) || bech32Verify(a, 'bc');
const isLtc  = (a) => base58Check(a, [0x30, 0x32, 0x05]) || bech32Verify(a, 'ltc');
const isDoge = (a) => base58Check(a, [0x1e, 0x16]);
const isTrx  = (a) => base58Check(a, [0x41]);

const VALIDATORS = {
  btc:  isBtc,
  eth:  isEvm,
  bnb:  isEvm,          // BNB Smart Chain uses EVM addresses
  sol:  isSolana,
  usdc: isSolana,       // USDC is issued on Solana here
  ltc:  isLtc,
  doge: isDoge,
  trx:  isTrx,
};

/**
 * Is `addr` a valid destination for `coin`?
 * Unknown coins fall back to a conservative shape check rather than passing
 * blindly — a coin added to SS_TICKERS without a validator is still constrained.
 */
function isValidAddressFor(coin, addr) {
  if (!addr || typeof addr !== 'string') return false;
  const a = addr.trim();
  if (a.length < 10 || a.length > 128) return false;

  const fn = VALIDATORS[String(coin || '').toLowerCase()];
  if (!fn) return /^[a-zA-Z0-9_:.\-]{10,128}$/.test(a);
  return fn(a);
}

module.exports = { isValidAddressFor, VALIDATORS };

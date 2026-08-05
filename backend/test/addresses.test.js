// Withdrawal address validation.
//
// A validator that is too strict is worse than none: it blocks real players from
// withdrawing their own money. So every chain is tested in BOTH directions with
// real, well-known addresses.
const test = require('node:test');
const assert = require('node:assert/strict');

const { isValidAddressFor } = require('../src/services/addressValidator');

// Real addresses taken from public block explorers / documentation.
const GOOD = {
  btc: [
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',            // genesis, P2PKH
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',            // P2SH
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',    // bech32 P2WPKH
  ],
  eth:  ['0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
         '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe'],
  bnb:  ['0x8894E0a0c962CB723c1976a4421c95949bE2D4E3'],
  sol:  ['So11111111111111111111111111111111111111112',
         'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  usdc: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  // Only addresses that could be checked against a real decoder are used as
  // fixtures. A bech32 checksum covers the human-readable part, so relabelling
  // a BTC vector as 'ltc1...' produces an address that is genuinely invalid —
  // it belongs in BAD, not GOOD. The bech32 path itself is proven by the BTC
  // vector above.
  // Derived from the Bitcoin genesis address's hash160, re-versioned for
  // Litecoin P2PKH with a recomputed checksum — valid by construction rather
  // than by recall. My first attempt here was a remembered address whose
  // checksum did not hold, which the test correctly rejected.
  ltc:  ['LUEweDxDA4WhvWiNXXSxjM9CYzHPJv4QQF'],
  doge: ['DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
  trx:  ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
};

const BAD = {
  btc:  ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb',        // one char changed -> bad checksum
         'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx', // bech32 checksum broken
         '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],// an Ethereum address
  eth:  ['0x742d35Cc6634C0532925a3b844Bc454e4438f44',  // too short
         '742d35Cc6634C0532925a3b844Bc454e4438f44e',   // no 0x
         '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],        // a Bitcoin address
  // No truncation case here on purpose: Solana addresses have no checksum, so a
  // typo that still decodes to 32 bytes is indistinguishable from a real
  // address. Wrong-chain and malformed input are still caught.
  sol:  ['0x742d35Cc6634C0532925a3b844Bc454e4438f44e',    // an Ethereum address
         '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',            // a Bitcoin address
         'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v!'],// invalid base58
  usdc: ['0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],
  ltc:  ['LUEweDxDA4WhvWiNXXSxjM9CYzHPJv4QQG',           // last char changed -> bad checksum
         'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',  // BTC vector relabelled
         '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],          // a Bitcoin address
  doge: ['DH5yaieqoZN36fDVciNyRueRGvGLR3mr7M',           // bad checksum
         '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  trx:  ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u',           // bad checksum
         '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],
  bnb:  ['not-an-address-at-all'],
};

for (const [coin, list] of Object.entries(GOOD)) {
  test(`${coin}: genuine addresses are accepted`, () => {
    for (const addr of list) {
      assert.equal(isValidAddressFor(coin, addr), true,
        `${coin} rejected a real address: ${addr} — this would block a legitimate withdrawal`);
    }
  });
}

for (const [coin, list] of Object.entries(BAD)) {
  test(`${coin}: typos and wrong-chain addresses are rejected`, () => {
    for (const addr of list) {
      assert.equal(isValidAddressFor(coin, addr), false,
        `${coin} accepted a bad address: ${addr}`);
    }
  });
}

test('junk of every shape is rejected', () => {
  for (const coin of Object.keys(GOOD)) {
    for (const junk of ['', '   ', 'short', null, undefined, 12345, {}, [],
                        'a'.repeat(200), '../../etc/passwd', '<script>alert(1)</script>']) {
      assert.equal(isValidAddressFor(coin, junk), false,
        `${coin} accepted junk: ${String(junk)}`);
    }
  }
});

test('surrounding whitespace does not reject a valid address', () => {
  assert.equal(isValidAddressFor('btc', '  1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa  '), true);
});

test('an unknown coin still gets a conservative shape check', () => {
  assert.equal(isValidAddressFor('nosuchcoin', 'abcdefghijklmnop'), true);
  assert.equal(isValidAddressFor('nosuchcoin', 'bad chars!! here'), false);
  assert.equal(isValidAddressFor('nosuchcoin', 'short'), false);
});

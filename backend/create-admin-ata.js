/**
 * create-admin-ata.js
 * One-time script to create the USDC associated token account for the admin Phantom wallet.
 * After this runs, Jupiter swaps never need to pay ATA creation fees again.
 *
 * Usage (PowerShell):
 *   $env:SOLANA_RPC="https://mainnet.helius-rpc.com/?api-key=xxx"
 *   $env:ADMIN_PHANTOM_PRIVATE_KEY="xxx"
 *   node create-admin-ata.js
 */

require('dotenv').config();

const solWeb3  = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const bs58     = require('bs58');

const USDC_MINT = new solWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

async function main() {
  const rpc        = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new solWeb3.Connection(rpc, 'confirmed');

  const phantomKey = process.env.ADMIN_PHANTOM_PRIVATE_KEY;
  if (!phantomKey) throw new Error('ADMIN_PHANTOM_PRIVATE_KEY not set');

  const keypair = solWeb3.Keypair.fromSecretKey(
    (bs58.default?.decode ?? bs58.decode)(phantomKey)
  );

  console.log(`Admin wallet: ${keypair.publicKey.toBase58()}`);

  // Check if ATA already exists
  const ata = splToken.getAssociatedTokenAddressSync(USDC_MINT, keypair.publicKey);
  console.log(`USDC ATA address: ${ata.toBase58()}`);

  const info = await connection.getAccountInfo(ata);
  if (info) {
    console.log('✓ USDC token account already exists — nothing to do.');
    return;
  }

  console.log('Creating USDC token account...');
  const account = await splToken.getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    USDC_MINT,
    keypair.publicKey
  );

  console.log(`✓ Created! ATA: ${account.address.toBase58()}`);
  console.log('Jupiter swaps will now work without extra SOL for ATA creation.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

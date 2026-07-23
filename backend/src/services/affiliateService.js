const AFFILIATE_FEE_PERCENT    = 0.005; // 0.5% of prize pool to affiliate(s)
const CREATOR_FEE_PERCENT      = 0.01;  // 1% of prize pool to creator code holder
const RAKEBACK_PERCENT         = 0.005; // 0.5% of prize pool always goes to rakeback (0.25% per player)
// Admin receives what's left of the 5% fee after rakeback (0.5%) and any codes are paid
const PLATFORM_FEE_NO_AFF      = 0.045; // 4.5% to admin (5% − 0.5% rakeback)
const PLATFORM_FEE_WITH_AFF    = 0.04;  // 4.0% to admin (5% − 0.5% rakeback − 0.5% affiliate)
const PLATFORM_FEE_WITH_CREATOR = 0.035; // 3.5% to admin (5% − 0.5% rakeback − 1% creator)

const CODE_RE = /^[A-Z0-9]{4,12}$/;

function validateCode(code) {
  if (!code || typeof code !== 'string') return false;
  return CODE_RE.test(code.trim().toUpperCase());
}

// Resolve which profile IDs own valid affiliate codes for the two players.
// Returns { owner1: uuid|null, owner2: uuid|null }
async function resolveAffiliates(supabase, p1Id, p2Id) {
  const ids = [p1Id, p2Id].filter(Boolean);
  if (ids.length === 0) return { owner1: null, owner2: null };

  const now = new Date().toISOString();

  const { data: players } = await supabase
    .from('profiles')
    .select('id, applied_affiliate_code, applied_code_expires_at')
    .in('id', ids);

  if (!players || players.length === 0) return { owner1: null, owner2: null };

  const p1 = players.find(p => p.id === p1Id);
  const p2 = players.find(p => p.id === p2Id);

  function validCode(p) {
    return p?.applied_affiliate_code &&
      p?.applied_code_expires_at &&
      p.applied_code_expires_at > now
      ? p.applied_affiliate_code : null;
  }

  const code1 = validCode(p1);
  const code2 = validCode(p2);
  const uniqueCodes = [...new Set([code1, code2].filter(Boolean))];

  if (uniqueCodes.length === 0) return { owner1: null, owner2: null };

  const { data: codeOwners } = await supabase
    .from('profiles')
    .select('id, affiliate_code')
    .in('affiliate_code', uniqueCodes);

  const codeToOwner = {};
  for (const o of (codeOwners || [])) codeToOwner[o.affiliate_code] = o.id;

  return {
    owner1: code1 ? (codeToOwner[code1] || null) : null,
    owner2: code2 ? (codeToOwner[code2] || null) : null,
  };
}

// Pay affiliates and return { platformFee } — the percentage admin receives.
// prizePool = entry_fee * 2
//
// Fee rules (all come out of the 5% total fee, 0.5% always reserved for rakeback):
//   No codes:            codes = 0%,   admin = 4.5%
//   1 affiliate (0.5%):  code  = 0.5%, admin = 4.0%
//   1 creator (1%):      code  = 1%,   admin = 3.5%
//   2 codes (any combo): each  = 0.5%, admin = 3.5%  (1% total, split evenly)
async function payAffiliatesCoins(supabase, owner1, owner2, prizePool) {
  const pool = parseFloat(prizePool);
  const uniqueOwners = [...new Set([owner1, owner2].filter(Boolean))];
  if (uniqueOwners.length === 0 || pool <= 0) {
    return { platformFee: PLATFORM_FEE_NO_AFF }; // 4.5%
  }

  if (uniqueOwners.length === 2) {
    // 2 codes: always 1% total split evenly (0.5% each), admin 3.5%
    const perOwner = parseFloat((pool * CREATOR_FEE_PERCENT / 2).toFixed(4));
    await Promise.all(
      uniqueOwners.map(owner_id =>
        supabase.rpc('credit_affiliate_c', { owner_id, amount: perOwner })
          .then().catch(e => console.error('[affiliate] credit failed:', e.message))
      )
    );
    return { platformFee: PLATFORM_FEE_WITH_CREATOR }; // 3.5%
  }

  // 1 code: pay its own rate based on type
  const singleOwner = uniqueOwners[0];
  const { data: ownerProfile } = await supabase
    .from('profiles').select('is_creator_code').eq('id', singleOwner).single();
  const isCreator = !!ownerProfile?.is_creator_code;
  const pct = isCreator ? CREATOR_FEE_PERCENT : AFFILIATE_FEE_PERCENT;
  const amount = parseFloat((pool * pct).toFixed(4));
  await supabase.rpc('credit_affiliate_c', { owner_id: singleOwner, amount })
    .then().catch(e => console.error('[affiliate] credit failed:', e.message));
  return { platformFee: isCreator ? PLATFORM_FEE_WITH_CREATOR : PLATFORM_FEE_WITH_AFF }; // 3.5% or 4.0%
}

// ── Coin Flip fee profile (2% total rake) ──────────────────────────────────
// Rakeback 0.4% + codes 0.1% (max, any code type) + admin 1.5% = 2.0%.
// With no code the 0.1% rolls into admin (1.6%), so the winner's payout is a flat
// 98% of the pool regardless of referrals.
const CF_CODE_PCT          = 0.001; // 0.1% total to code owner(s), capped
const CF_ADMIN_NO_CODE     = 0.016; // 1.6% to admin when no code (absorbs the 0.1%)
const CF_ADMIN_WITH_CODE   = 0.015; // 1.5% to admin when a code is present

// Pays code owner(s) a flat 0.1% of the pool (split evenly if two), returns the
// admin platform fee. Any code — affiliate or creator — is capped at 0.1% here.
async function payCodesCoinFlip(supabase, owner1, owner2, prizePool) {
  const pool = parseFloat(prizePool);
  const uniqueOwners = [...new Set([owner1, owner2].filter(Boolean))];
  if (uniqueOwners.length === 0 || pool <= 0) {
    return { platformFee: CF_ADMIN_NO_CODE }; // 1.6%
  }
  const perOwner = parseFloat((pool * CF_CODE_PCT / uniqueOwners.length).toFixed(4));
  await Promise.all(
    uniqueOwners.map(owner_id =>
      supabase.rpc('credit_affiliate_c', { owner_id, amount: perOwner })
        .then().catch(e => console.error('[affiliate] CF credit failed:', e.message))
    )
  );
  return { platformFee: CF_ADMIN_WITH_CODE }; // 1.5%
}

async function payAffiliatesDiamonds() {
  // Diamond matches do not pay affiliate earnings — affiliates earn coins only
  return { platformFee: PLATFORM_FEE_NO_AFF };
}

module.exports = {
  validateCode,
  resolveAffiliates,
  payAffiliatesCoins,
  payCodesCoinFlip,
  payAffiliatesDiamonds,
  PLATFORM_FEE_NO_AFF,
  PLATFORM_FEE_WITH_AFF,
  AFFILIATE_FEE_PERCENT,
};

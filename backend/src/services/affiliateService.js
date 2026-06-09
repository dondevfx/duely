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
// Fee rules (all come out of the 5% total fee):
//   No codes:              admin = 4.5%  (5% - 0.5% rakeback)
//   1 normal code:         code  = 0.5%, admin = 4.0%
//   1 creator code:        code  = 1.0%, admin = 3.5%
//   2 codes (any type):    each  = 0.5%, admin = 3.5%  (total to codes always capped at 1%)
async function payAffiliatesCoins(supabase, owner1, owner2, prizePool) {
  const hasAff = owner1 || owner2;
  if (!hasAff || parseFloat(prizePool) <= 0) {
    return { platformFee: PLATFORM_FEE_NO_AFF }; // 4.5%
  }

  const bothDifferent = owner1 && owner2 && owner1 !== owner2;

  if (bothDifferent) {
    // 2 different code owners — check if either is a creator code
    const ownerIds = [owner1, owner2];
    const { data: ownerProfiles } = await supabase
      .from('profiles').select('id, is_creator_code').in('id', ownerIds);
    const creatorMap = {};
    for (const p of (ownerProfiles || [])) creatorMap[p.id] = !!p.is_creator_code;
    const anyCreator = creatorMap[owner1] || creatorMap[owner2];

    // If any creator code: 1% total (0.5% each). If both normal: 0.5% total (0.25% each).
    const totalPct  = anyCreator ? CREATOR_FEE_PERCENT : AFFILIATE_FEE_PERCENT;
    const half = parseFloat((prizePool * totalPct / 2).toFixed(4));
    await Promise.all([
      supabase.rpc('credit_affiliate_c', { owner_id: owner1, amount: half }),
      supabase.rpc('credit_affiliate_c', { owner_id: owner2, amount: half }),
    ]).catch(e => console.error('[affiliate] 2-code credit failed:', e.message));
    return { platformFee: anyCreator ? PLATFORM_FEE_WITH_CREATOR : PLATFORM_FEE_WITH_AFF }; // 3.5% or 4.0%
  }

  // Single code owner — check if creator code (1%) or normal affiliate code (0.5%)
  const singleOwner = owner1 || owner2;
  const { data: ownerProfile } = await supabase
    .from('profiles').select('is_creator_code').eq('id', singleOwner).single();
  const isCreator = !!ownerProfile?.is_creator_code;

  if (isCreator) {
    const amount = parseFloat((prizePool * CREATOR_FEE_PERCENT).toFixed(4)); // 1%
    await supabase.rpc('credit_affiliate_c', { owner_id: singleOwner, amount })
      .catch(e => console.error('[affiliate] creator credit failed:', e.message));
    return { platformFee: PLATFORM_FEE_WITH_CREATOR }; // 3.5%
  } else {
    const amount = parseFloat((prizePool * AFFILIATE_FEE_PERCENT).toFixed(4)); // 0.5%
    await supabase.rpc('credit_affiliate_c', { owner_id: singleOwner, amount })
      .catch(e => console.error('[affiliate] affiliate credit failed:', e.message));
    return { platformFee: PLATFORM_FEE_WITH_AFF }; // 4.0%
  }
}

async function payAffiliatesDiamonds() {
  // Diamond matches do not pay affiliate earnings — affiliates earn coins only
  return { platformFee: PLATFORM_FEE_NO_AFF };
}

module.exports = {
  validateCode,
  resolveAffiliates,
  payAffiliatesCoins,
  payAffiliatesDiamonds,
  PLATFORM_FEE_NO_AFF,
  PLATFORM_FEE_WITH_AFF,
  AFFILIATE_FEE_PERCENT,
};

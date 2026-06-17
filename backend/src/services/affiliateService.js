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
//   No codes:                  admin = 4.5%
//   1 affiliate (0.5%):        admin = 4.0%
//   1 creator (1%):            admin = 3.5%
//   2 affiliates (0.5% each):  admin = 3.5%
//   1 creator + 1 affiliate:   admin = 3.0%
//   2 creators (1% each):      admin = 2.5%
async function payAffiliatesCoins(supabase, owner1, owner2, prizePool) {
  const pool = parseFloat(prizePool);
  if ((!owner1 && !owner2) || pool <= 0) {
    return { platformFee: PLATFORM_FEE_NO_AFF }; // 4.5%
  }

  const ownerIds = [...new Set([owner1, owner2].filter(Boolean))];
  const { data: ownerProfiles } = await supabase
    .from('profiles').select('id, is_creator_code').in('id', ownerIds);
  const creatorMap = {};
  for (const p of (ownerProfiles || [])) creatorMap[p.id] = !!p.is_creator_code;

  // Pay each code owner their own rate independently
  let totalCodePct = 0;
  const payments = [];

  if (owner1) {
    const pct = creatorMap[owner1] ? CREATOR_FEE_PERCENT : AFFILIATE_FEE_PERCENT;
    totalCodePct += pct;
    payments.push({ owner_id: owner1, amount: parseFloat((pool * pct).toFixed(4)) });
  }
  if (owner2 && owner2 !== owner1) {
    const pct = creatorMap[owner2] ? CREATOR_FEE_PERCENT : AFFILIATE_FEE_PERCENT;
    totalCodePct += pct;
    payments.push({ owner_id: owner2, amount: parseFloat((pool * pct).toFixed(4)) });
  }

  await Promise.all(
    payments.map(({ owner_id, amount }) =>
      supabase.rpc('credit_affiliate_c', { owner_id, amount })
        .catch(e => console.error('[affiliate] credit failed:', e.message))
    )
  );

  // Admin gets 5% minus rakeback (0.5%) minus all code payouts
  const platformFee = parseFloat((0.05 - RAKEBACK_PERCENT - totalCodePct).toFixed(4));
  return { platformFee: Math.max(0, platformFee) };
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

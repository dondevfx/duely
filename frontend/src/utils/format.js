// Balance formatters that never overflow their box: exact value up to
// 999,999.99, then abbreviated (1.23M, 4.56B) so huge balances stay short.

function _trim(x) {
  // 34.50 -> "34.5", 1.00 -> "1"
  return x.toFixed(2).replace(/\.?0+$/, '');
}

// Coins (2 decimals below 1M).
export function fmtCoins(n) {
  const v = Number(n ?? 0);
  const abs = Math.abs(v);
  if (abs >= 1e12) return _trim(v / 1e12) + 'T';
  if (abs >= 1e9)  return _trim(v / 1e9) + 'B';
  if (abs >= 1e6)  return _trim(v / 1e6) + 'M';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Diamonds (whole numbers).
export function fmtDiamonds(n) {
  const v = Math.floor(Number(n ?? 0));
  const abs = Math.abs(v);
  if (abs >= 1e12) return _trim(v / 1e12) + 'T';
  if (abs >= 1e9)  return _trim(v / 1e9) + 'B';
  if (abs >= 1e6)  return _trim(v / 1e6) + 'M';
  return v.toLocaleString('en-US');
}

// Full, un-abbreviated value — use for `title` tooltips so the exact amount is
// still available on hover.
export function fmtExact(n, diamonds = false) {
  const v = Number(n ?? 0);
  return diamonds
    ? Math.floor(v).toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

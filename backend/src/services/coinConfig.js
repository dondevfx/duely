/**
 * Which coins may be deposited — one source of truth.
 *
 * This lived in routes/wallet.js, where the HTTP layer used it to decide
 * whether to hand out a deposit address. The blockchain monitor had no idea it
 * existed and polled every address row in the table, so disabling a coin
 * stopped new addresses being issued but left the poller hammering the old ones
 * forever:
 *
 *   [monitor] bnb explorer refused: ... — treating as no deposits, which may be wrong
 *   (repeating every 45 seconds, indefinitely)
 *
 * That is worse than untidy. The whole point of those warnings is that they get
 * read, and a warning nothing can act on — for a coin we deliberately turned
 * off — trains you to scroll past the ones that matter.
 *
 * A coin belongs here only if we can DETECT a deposit to it. Handing out an
 * address for a coin we cannot see is money taken and never credited, and it
 * fails silently: no error, no log, nothing until the player complains.
 *
 * BNB is out because BSC detection needs a paid Etherscan plan — the free tier
 * answers "Free API access is not supported for this chain". It stays
 * withdrawable-adjacent in no sense; it is gone from both lists.
 */
const DEPOSIT_COINS = new Set(['btc', 'eth', 'sol', 'ltc', 'trx', 'doge', 'usdc', 'usdt']);

module.exports = { DEPOSIT_COINS };

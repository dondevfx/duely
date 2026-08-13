// Where a player goes when they cannot afford a bet.
//
// The two currencies are topped up in different places: coins are bought on the
// wallet page, diamonds are earned on the rewards page. Sending a diamond
// shortfall to the wallet would be a dead end — there is nothing there to buy
// diamonds with.
//
// Shared rather than inlined because the same "Insufficient Balance" button
// exists in the shared lobby and again in the three screens that roll their own,
// and they have drifted apart before.
export const topUpRoute = (betCurrency) =>
  betCurrency === 'diamonds' ? '/rewards' : '/wallet';

// Label for the button in that state. Carries an arrow so it reads as somewhere
// to go rather than a refusal — the button stays enabled now, and an enabled
// button with a flat "Insufficient Balance" looks broken.
export const topUpLabel = (betCurrency) =>
  betCurrency === 'diamonds' ? 'Insufficient 💎 — Get More' : 'Insufficient Balance — Deposit';

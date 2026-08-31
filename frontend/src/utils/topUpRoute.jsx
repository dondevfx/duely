import DiamondIcon from '../components/DiamondIcon';

// NOTE: this file is .jsx and its importers name the extension. topUpLabel
// returns markup now, and Vite only transforms JSX in .jsx — an extensionless
// import of it resolved in the production build but 404'd in the dev server,
// which is the worst of both: it looks fine right up until someone runs it.

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

// Label for the button in that state. Says where it goes rather than just
// refusing — the button stays enabled, and an enabled button reading a flat
// "Insufficient Balance" looks broken.
//
// Returns JSX because the diamond label carries the drawn mark. It was the 💎
// emoji, the last one left on the betting screens, and it sat inside a button
// next to the drawn diamond the price above it uses — two different diamonds,
// six lines apart.
export const topUpLabel = (betCurrency) =>
  betCurrency === 'diamonds'
    ? <span className="inline-flex items-center gap-1">Insufficient <DiamondIcon /> — Get More</span>
    : 'Insufficient Balance — Deposit';

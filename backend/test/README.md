# Backend tests

```bash
npm test
```

Node's built-in runner — no extra dependencies. Everything runs offline against
stubs in `helpers/stubs.js`: no database, no sockets, no payment gateway. Safe
to run anywhere, takes a few seconds.

## Why these tests exist

Each one pins a bug that actually shipped, or a near-miss caught during review.
They are not here for coverage; they are here because this codebase moves real
money and the same mistakes kept recurring.

| File | Guards against |
|---|---|
| `payouts.test.js` | Wrong split reaching a winner. 95% standard, 98% coin flip, a draw refunding in full with no rake, a bot loss crediting nothing, and no path ever paying out more than the pot. Also the withdrawal amount validator. |
| `leaving.test.js` | The forfeit contract. `getWordleRoomBySocket` once returned a different shape from every other engine, so leaving a Word VS match threw instead of forfeiting and the opponent was left hanging. Also pins that a "finished" room is recognised whichever flag the engine uses — most set `state`, Word VS sets `settled` and has no `state` at all. |
| `integrity.test.js` | Claiming a result you did not earn: strangers acting on a match they are not in, and inflated score or survival-time claims. Also the other side of that guard — real players **and bots** must still be accepted, because bots drive the same handlers with synthetic socket ids and a slightly-too-strict check silently breaks every bot match. |
| `rushhour.test.js` | The end condition. A crash while ahead must let the opponent keep playing and overtake; a leader who goes silent must be finalised without freezing the opponent. Leaving must never beat playing. |
| `deposits.test.js` | Paying a deposit out more than once. Gateways retry, and the old check-then-act ordering issued a payout per delivery. Includes a test asserting the *old* ordering double-spends, so reintroducing that shape is loud. |

## The unique index

`deposits.test.js` contains a test named "the unique index is load-bearing".
The claim-first ordering in the Cryptomus webhook only works if the database
enforces:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_extra_id
  ON transactions (extra_id)
  WHERE extra_id IS NOT NULL;
```

Without it the claim is not atomic and concurrent deliveries double-spend again.
The test models both cases so the dependency is visible rather than folklore.

## Writing more

Prefer a test that fails for one clear reason and says why in its name. When
fixing a bug, add the test first and watch it fail — a test that has never
failed has not been shown to test anything.

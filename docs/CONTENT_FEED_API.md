# Duely Content Feed API

A single, read-only JSON feed of public Duely statistics for the external
content/video pipeline. It uses real production numbers. Players only ever
appear under **pseudonyms**, which are fake names that stay the same over time.

## Request

```
GET https://www.duely.us/api/v1/content-feed
Authorization: Bearer <CONTENT_FEED_API_KEY>
```

- **Method:** `GET` only. Any other method returns `405` and does nothing.
- **Routing:** `www.duely.us` is on Vercel. `frontend/vercel.json` passes this one
  path through to the backend's `/api/v1/content-feed`.
- **Update frequency:** built on request and cached on the server for 10 minutes.
  It is meant to be read about once a day.
- **Rate limit:** 30 requests per hour per client address. Requests with a bad
  key count too. Going over returns `429`.

## Authentication

The key goes in a Bearer header and is compared in constant time. It lives
only in the backend environment.

| Variable | Purpose |
|---|---|
| `CONTENT_FEED_API_KEY` | The read-only feed key. At least 32 characters. If it is unset or too short, every request gets `401`. |
| `CONTENT_FEED_PSEUDONYM_SECRET` | Server-only secret the pseudonyms are derived from. At least 32 characters. If it is unset, the feed returns `503`. **Never share it, and never rotate it:** changing it gives every player a new name. |
| `CONTENT_FEED_EXCLUDE_USER_IDS` | Optional. Comma-separated account ids of test accounts, which are left out of everything. |

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**What the key can do:** it works on this one route and nowhere else.
- It is not a Supabase key and not a user session. Every other Duely route
  needs a Supabase-signed login token, and this key is not one.
- The route only reads named columns.
- Its only write is to `content_pseudonyms`, which stores the fake names.
- It cannot create or change users, balances, transactions, matches,
  settlements or withdrawals, and it cannot reach any admin function.

Duely has no admin page for managing API keys, so the key is only an
environment variable. To revoke or rotate it, change the variable in Railway.

## Response

```json
{
  "updated_at": "2026-09-15T07:00:00.000Z",
  "totals": {
    "duels_today": 312,
    "paid_out_today": 1240.5,
    "new_players_today": 47
  },
  "biggest_win": { "display_name": "NeonTiger", "game": "Block Burst", "amount": 125 },
  "recent_winners": [
    { "display_name": "RapidFox",  "game": "Color Rush", "amount": 75, "won_at": "2026-09-15T06:41:12.000Z", "quote": null },
    { "display_name": "NeonTiger", "game": "Tournament", "amount": 50, "won_at": "2026-09-15T05:02:40.000Z", "quote": null }
  ],
  "leaderboard": [
    { "rank": 1, "display_name": "NeonTiger", "elo": 1842 },
    { "rank": 2, "display_name": "PixelWolf", "elo": 1795 }
  ],
  "next_tournament": {
    "game": null,
    "possible_games": ["Block Burst", "Rush Hour", "Color Rush", "Tower", "Word VS"],
    "start_time": "2026-09-15T07:05:00.000Z",
    "entry_fee": 5,
    "entrants": 12,
    "spots_left": 4,
    "prize": 76
  }
}
```

*All values above are fake sample data.*

If one data source fails, only its section comes back as `null`. The rest of
the feed is still returned. Errors have no detail:
`{"error":"Unauthorized"}`, `{"error":"Feed unavailable"}`,
`{"error":"Too many requests"}`.

## Fields

"Today" means the current **UTC** calendar day. Amounts are in **Coins**. Diamond
play is not money, so it is never included.

| Field | Meaning | Source |
|---|---|---|
| `totals.duels_today` | Completed player-vs-player results today. Excludes bot matches, tournament entry rows, demo, admin and test accounts, and any status other than completed. Identical rows within 10 seconds count once. Cancelled or abandoned matches never write a result row. | `matches` |
| `totals.paid_out_today` | **Gross winnings credited to players today**: the full payout a winner received, stake included. Covers PvP wins, wins against a bot and tournament prizes. Confirmed rows only; duplicates within 10 seconds count once. **Not withdrawals.** Private and banned players are counted here but never named. | `transactions` type `match_win` (`amount_c` > 0) |
| `totals.new_players_today` | Accounts created today, excluding demo, admin and test accounts. | `profiles.created_at` |
| `biggest_win` | The largest single credited coin win today by a player who can be featured. | same as `paid_out_today` |
| `recent_winners` | Up to 5 of the latest coin wins in the last 7 days by players who can be featured. `game` is `"Tournament"` for tournament prizes. | same |
| `recent_winners[].quote` | Always `null`. Duely has no player quote or testimonial field, so none are ever made up. | — |
| `leaderboard` | Top 5 on the site's Ranked board, using the same rules (`services/eloBoard.js`): placed accounts only (at least 3 results), no private, demo or admin accounts, and an unset rating shows as 1000. Banned and test accounts are also removed. | `profiles` |
| `next_tournament` | The next real tournament taking entries: the busiest bracket in the current joinable slot, or the smallest stake if nobody has entered yet. Demo brackets, free Play-vs-Bot brackets and bots are not counted. | in-memory tournament pools and `tournamentFormat` |
| `next_tournament.start_time` | When entry closes and play begins. | |
| `next_tournament.prize` | Total prize money for a full 16-player bracket at that stake, after the 5% fee. | `prizesFor()` |
| `next_tournament.game` | Always `null`. Each round's game stays secret until that round starts, on the site and here. `possible_games` lists the games it can be drawn from. | |

## Privacy

- **Every player is a pseudonym.** A name is built from an HMAC of the internal
  account id using `CONTENT_FEED_PSEUDONYM_SECRET`. It never uses the username.
  Without the secret, a name cannot be traced back to an account.
- **Names are stable and unique.** `content_pseudonyms` (PENDING_SQL section 27)
  stores each name against an HMAC digest, never against the account id.
  - A unique constraint means two players can never share a name.
  - If two players would get the same name, the second gets the next candidate
    (for example `NeonTiger42`).
  - A name that matches a real username is skipped.
  - The table is locked to anon and authenticated users.
- **Who can be named:** only public profiles that are not banned and still
  exist.
  - Private profiles (`is_private`), banned accounts and deleted accounts are
    counted in the totals but never named.
  - Demo, admin and test accounts are left out of everything.
- **Last check before sending:** the whole response is scanned for anything
  that looks like a user id, email, wallet address, token or long key. It is
  also checked for any source id or username. If anything matches, the request
  gets a bare `500` and the log names nothing.
- **Never sent:** usernames, real names, emails, passwords, auth tokens, wallet
  or deposit addresses, user or database ids, IP addresses, balances, private
  profile data, transaction notes (they contain opponent usernames), match ids,
  tournament and pool ids, bracket contents, admin data, API keys and errors.
  The feed does not even read usernames, emails, wallets or balances from the
  database.

## Setup checklist

1. Run PENDING_SQL section 27.
2. In Railway, set `CONTENT_FEED_API_KEY` and `CONTENT_FEED_PSEUDONYM_SECRET`.
   If you use test accounts, also set `CONTENT_FEED_EXCLUDE_USER_IDS`.
3. Deploy the frontend so the Vercel rewrite is live.
4. Test it:

   ```bash
   curl -H "Authorization: Bearer $KEY" https://www.duely.us/api/v1/content-feed
   ```

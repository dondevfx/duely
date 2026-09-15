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
  "generated_at": "2026-09-15T07:00:00.000Z",
  "updated_at": "2026-09-15T07:00:00.000Z",
  "totals": { "duels_today": 31, "paid_out_today": 124.5, "new_players_today": 4 },
  "weekly": {
    "period_start": "2026-09-14T00:00:00.000Z",
    "period_end": "2026-09-21T00:00:00.000Z",
    "duels": 58, "paid_out": 410.2, "new_players": 9, "active_players": 22, "total_wagered": 436,
    "biggest_win": { "display_name": "NeonTiger", "game": "Tower", "amount": 47.5 },
    "top_winners": [ { "display_name": "NeonTiger", "amount_won": 61.3 } ],
    "top_games": [ { "game": "Color Rush", "duels": 21 }, { "game": "Tower", "duels": 14 } ]
  },
  "monthly": {
    "period_start": "2026-09-01T00:00:00.000Z",
    "period_end": "2026-10-01T00:00:00.000Z",
    "duels": 240, "paid_out": 1890, "new_players": 35, "active_players": 71, "total_wagered": 2010,
    "biggest_win": { "display_name": "RapidFox", "game": "Tournament", "amount": 76 },
    "top_winners": [ { "display_name": "RapidFox", "amount_won": 140.25 } ],
    "top_games": [ { "game": "Color Rush", "duels": 88 } ]
  },
  "comparisons": {
    "weekly_vs_previous_week": {
      "compared_period_start": "2026-09-07T00:00:00.000Z",
      "compared_period_end": "2026-09-08T07:00:00.000Z",
      "duels_percent_change": 32.1, "paid_out_percent_change": 12.5, "new_players_percent_change": null,
      "active_players_percent_change": -4.3, "total_wagered_percent_change": 18
    },
    "monthly_vs_previous_month": {
      "compared_period_start": "2026-08-01T00:00:00.000Z",
      "compared_period_end": "2026-08-15T07:00:00.000Z",
      "duels_percent_change": 8, "paid_out_percent_change": -2.5, "new_players_percent_change": 40,
      "active_players_percent_change": 11.1, "total_wagered_percent_change": 6.2
    }
  },
  "biggest_win": { "display_name": "NeonTiger", "game": "Block Burst", "amount": 25, "quote": null },
  "recent_winners": [
    { "display_name": "RapidFox", "game": "Color Rush", "amount": 9.5, "won_at": "2026-09-15T06:41:12.000Z", "quote": null }
  ],
  "leaderboard": [ { "rank": 1, "display_name": "NeonTiger", "elo": 1842 } ],
  "next_tournament": {
    "game": null,
    "possible_games": ["Block Burst", "Rush Hour", "Color Rush", "Tower", "Word VS"],
    "start_time": "2026-09-15T07:05:00.000Z",
    "entry_fee": 5, "entrants": 12, "spots_left": 4, "prize": 76
  }
}
```

*All values above are fake sample data.*

Query parameters are ignored. Nothing in the URL changes what is returned.

If one data source fails, only the figures from that source are `null`. The
rest of the feed is still returned. Errors have no detail:
`{"error":"Unauthorized"}`, `{"error":"Feed unavailable"}`,
`{"error":"Too many requests"}`.

## Periods

All periods use **UTC**. Every window is half-open, `[start, end)`: an event
exactly on a boundary belongs to the later period only, so nothing is
counted twice.

| Period | Window |
|---|---|
| today | 00:00 UTC today → now |
| current week | Monday 00:00 UTC → now (`period_end` is next Monday) |
| previous week | the 7 days before this Monday |
| current month | the 1st at 00:00 UTC → now (`period_end` is the next 1st) |
| previous month | the whole previous calendar month |

**Comparisons are like-for-like.** The current period so far is compared with
the same elapsed time from the start of the previous period, capped at that
period's end. `compared_period_start` and `compared_period_end` show the
exact window used. For example, on Tuesday at 07:00 the week is compared with
last Monday 00:00 → last Tuesday 07:00, not with the whole previous week.
`*_percent_change` is `(current − previous) / previous × 100`, rounded to one
decimal. It is **null when the previous value is 0**.

## Fields

Amounts are in **Coins**. Diamond play is not money, so it is never included in
money figures.

| Field | Meaning | Source |
|---|---|---|
| `duels` / `duels_today` | Completed player-vs-player results, both Coin and Diamond. Excludes bot matches, tournament entry rows, demo, admin and test accounts, and any status other than completed. Identical rows within 10 seconds count once. Cancelled or refunded matches never write a result row. | `matches` |
| `active_players` | Distinct players who took part in those duels. | `matches` |
| `total_wagered` | Coins staked in those duels: entry fee × 2 per duel. | `matches.entry_fee_c` |
| `paid_out` / `paid_out_today` | **Gross coin winnings credited**: the full payout, stake included, for PvP wins, wins against a bot and tournament prizes. Confirmed rows only, deduplicated. **Not withdrawals.** Private and banned players are counted but never named. | `transactions` `match_win` |
| `new_players` / `new_players_today` | Accounts created in the period, excluding demo, admin and test accounts. | `profiles.created_at` |
| `weekly/monthly.biggest_win` | The largest single credited coin win in the period by a player who can be featured. | `transactions` `match_win` |
| `top_winners[].amount_won` | Up to 5 featurable players with the highest **net** coin result, shown only if above 0. Net is: win payout − stake; + tournament prizes; − tournament entry fees; + tournament refunds; + draw refund − stake; − losses. The "Tournament entry" loss row is not counted a second time. | `transactions` |
| `top_games` | Games ranked by duel count, most first; ties are alphabetical. | `matches` |
| `biggest_win` (top level) | Today's largest featurable coin win. | same |
| `recent_winners` | Up to 5 of the latest featurable coin wins in the last 7 days. `game` is `"Tournament"` for tournament prizes. | same |
| `quote` | Always `null`. Duely has no approved quote or testimonial field. | — |
| `leaderboard` | Top 5 on the site's Ranked board, using the same rules (`services/eloBoard.js`). Banned and test accounts are also removed. | `profiles` |
| `next_tournament` | The next real tournament taking entries. Bots, demo brackets and free brackets are not counted. `game` is null until round one starts. | tournament pools |

When there is no activity, counts are `0`, `biggest_win` is `null`, and lists
are empty. Nothing is filled in to cover a gap.

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

# React Duel

A 1v1 real-time reaction game platform with crypto wallet integration and C Coin economy.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite + TailwindCSS |
| Backend | Node.js + Express + Socket.IO |
| Database / Auth | Supabase (Postgres + Auth) |
| Crypto | ethers.js v6 + MetaMask + Polygon |
| Deploy | Vercel (frontend) + Render (backend) |

---

## C Coin Economy

- **1 C Coin = $1 USD**
- Deposit MATIC or ETH → backend converts at live market rate → credits C Coins
- Withdraw C Coins → backend sends MATIC/ETH to your wallet
- Daily bonus: claim 1 free C Coin every 24 hours
- Match wagers: winner receives 95% of prize pool (5% platform fee)

---

## Local Setup

### 1. Clone and install

```bash
# Backend
cd backend && npm install

# Frontend
cd frontend && npm install
```

### 2. Supabase — create tables

In your Supabase project → SQL Editor, run:

```sql
-- Profiles
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  wallet_address text,
  c_coins numeric default 0 check (c_coins >= 0),
  wins int default 0,
  losses int default 0,
  elo int default 1000,
  streak int default 0,
  last_bonus_claimed timestamptz,
  created_at timestamptz default now()
);

-- Matches
create table matches (
  id uuid primary key default gen_random_uuid(),
  player1_id uuid references profiles(id),
  player2_id uuid references profiles(id),
  winner_id uuid references profiles(id),
  entry_fee_c numeric default 0,
  prize_pool_c numeric default 0,
  platform_fee_c numeric default 0,
  reaction_time_ms int,
  early_click boolean default false,
  played_at timestamptz default now()
);

-- Transactions
create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  type text check (type in ('deposit', 'withdrawal', 'match_win', 'match_loss', 'daily_bonus')),
  amount_c numeric,
  crypto_amount numeric,
  crypto_symbol text,
  tx_hash text,
  status text default 'confirmed',
  created_at timestamptz default now()
);

-- Helper RPCs (atomic balance operations)
create or replace function credit_coins(user_id uuid, amount numeric)
returns void language sql security definer as $$
  update profiles set c_coins = c_coins + amount where id = user_id;
$$;

create or replace function deduct_coins(user_id uuid, amount numeric)
returns void language sql security definer as $$
  update profiles set c_coins = c_coins - amount where id = user_id and c_coins >= amount;
$$;

create or replace function increment_win(uid uuid)
returns void language sql security definer as $$
  update profiles set wins = wins + 1, streak = streak + 1 where id = uid;
$$;

create or replace function increment_loss(uid uuid)
returns void language sql security definer as $$
  update profiles set losses = losses + 1, streak = 0 where id = uid;
$$;

-- Row Level Security
alter table profiles enable row level security;
create policy "Users can read all profiles" on profiles for select using (true);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Service role can do anything" on profiles using (true) with check (true);

alter table matches enable row level security;
create policy "Anyone can read matches" on matches for select using (true);

alter table transactions enable row level security;
create policy "Users can read own transactions" on transactions for select using (auth.uid() = user_id);
```

### 3. Configure environment variables

```bash
# Backend
cp .env.example backend/.env
# Edit backend/.env with your Supabase keys, RPC URLs, and wallet

# Frontend
cp .env.example frontend/.env
# Edit frontend/.env with your Supabase anon key and socket URL
```

### 4. Run locally

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev
```

Visit `http://localhost:5173`

---

## How Crypto Deposits Work

1. User connects MetaMask and selects network (Polygon or Ethereum)
2. Platform wallet address is displayed on the Wallet page
3. User sends MATIC/ETH to that address from MetaMask
4. User copies the transaction hash and enters it on the Wallet page
5. Backend calls CoinGecko API for live price, computes C Coin equivalent, and credits the user's balance in Supabase
6. (Optional) For fully automated detection: run a blockchain listener that watches the platform wallet for incoming transactions

## How Withdrawals Work

1. User enters C Coin amount and clicks Withdraw
2. Backend verifies sufficient balance, deducts from DB
3. Backend converts C Coins → crypto at live rate
4. Backend sends an on-chain transaction from the platform hot wallet to the user's registered wallet address
5. Transaction hash is returned and logged

> **Security note**: The platform wallet private key lives only in `backend/.env`. It is never exposed to the frontend or clients.

---

## Deployment

### Frontend → Vercel

1. Push `frontend/` to a GitHub repo
2. Import on vercel.com, set root to `frontend/`
3. Add all `VITE_*` environment variables
4. Deploy

### Backend → Render

1. Push `backend/` to a GitHub repo
2. Create a Web Service on render.com
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all environment variables (non-VITE ones)
6. Update `FRONTEND_URL` in backend env to your Vercel domain
7. Update `VITE_API_URL` and `VITE_SOCKET_URL` in frontend env to your Render URL

---

## Game Rules

- Both players join a room
- 3-second countdown
- Server waits a random 2–5 second delay after READY
- Server emits GO — first valid click wins
- Clicking before GO = automatic loss
- Winner receives 95% of prize pool
- ELO adjusts for both players after every match

---

## Project Structure

```
react-duel/
├── frontend/
│   └── src/
│       ├── components/     Navbar, GameCard, GlowButton, StatusIndicator, DailyBonus, Modal
│       ├── context/        AuthContext, SocketContext, WalletContext
│       ├── pages/          Home, Game, Leaderboard, Profile, Wallet, Login, Signup
│       └── utils/          supabase.js, api.js
└── backend/
    └── src/
        ├── routes/         auth, wallet, leaderboard, match, bonus
        ├── middleware/      auth (JWT), rateLimit
        ├── services/        walletService, eloService, matchmaking, gameEngine
        └── socket/          handlers (all real-time events)
```

import { Link } from 'react-router-dom';
import GameCard from '../components/GameCard';
import DailyBonus from '../components/DailyBonus';
import SpinWheel from '../components/SpinWheel';
import MatchTicker from '../components/MatchTicker';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import CoinIcon from '../components/CoinIcon';
import { fmtCoins, fmtExact } from '../utils/format';

const GAMES = [
  {
    title: 'Quick Match',
    description: 'Pick your bet and get matched instantly. Fast, competitive, no bots.',
    icon: '⚡',
    route: '/game/quick-match',
    available: true,
  },
  {
    title: 'Block Burst',
    description: 'Drag blocks onto the grid to fill rows and columns. Clear them to earn points. Fill the energy bar to unlock Blast Mode!',
    icon: '🟦',
    route: '/game/block-blast',
    available: true,
    countKey: 'block-blast',
  },
  {
    title: 'Coin Flip',
    description: 'Pick a side — get matched with the opposite. Instant result.',
    icon: '🟡',
    route: '/game/coin-flip',
    available: true,
    countKey: 'coin-flip',
  },
  {
    title: 'Word VS',
    description: 'Guess the same 5-letter word as your opponent. Solve it first and win instantly — 6 tries each.',
    icon: '🔤',
    route: '/game/scrabble',
    available: true,
    countKey: 'scrabble',
  },
  {
    title: 'Blackjack',
    description: 'Get closer to 21 than your opponent. Both players act simultaneously — no waiting.',
    icon: '🃏',
    route: '/game/blackjack',
    available: true,
    countKey: 'blackjack',
  },
];

function DailySpinWidget({ profile }) {
  return profile ? (
    <SpinWheel />
  ) : (
    <div className="relative rounded-2xl overflow-hidden">
      <div className="pointer-events-none opacity-50 select-none">
        <SpinWheel />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] rounded-2xl gap-3">
        <div className="text-3xl">🎡</div>
        <p className="text-white font-black text-lg">Daily Spin</p>
        <p className="text-muted text-sm text-center px-4">Win up to 50,000 💎 every day</p>
        <Link
          to="/login"
          className="px-6 py-2.5 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all text-sm"
        >
          Login to Spin
        </Link>
      </div>
    </div>
  );
}

export default function Home() {
  const { profile } = useAuth();
  const { playerCounts } = useSocket();

  return (
    <div className="min-h-screen bg-bg pt-2 md:pt-16">
      {/* Hero — tight on mobile, roomy on desktop (was ~120px of stacked
          top padding on every screen size) */}
      <section className="relative pt-3 md:pt-14 pb-10 px-4 overflow-hidden">
        <div className="relative max-w-7xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center justify-between gap-6 lg:gap-12">
            <div className="flex-1 text-center lg:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-primary/10 border border-primary/30 rounded-full text-primary text-sm font-medium mb-3 md:mb-6">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                Live — Play Now
              </div>
              <h1 className="text-5xl md:text-7xl font-black text-white mb-4 md:mb-6 leading-tight">
                1v1{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-primary">
                  Duels
                </span>
              </h1>
              <p className="text-xl text-muted max-w-2xl mx-auto lg:mx-0 mb-6 md:mb-10">
                Challenge opponents in real-time skill-based games. Wager{' '}
                <span className="text-primary font-semibold whitespace-nowrap"><CoinIcon size="1em" /> Coins</span>, climb the leaderboard,
                and prove you're the best.
              </p>
              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-4">
                <Link
                  to="/games"
                  className="px-8 py-4 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl shadow-glow hover:shadow-glow-lg transition-all text-lg"
                >
                  ⚡ Play Now
                </Link>
                <Link
                  to="/leaderboard"
                  className="px-8 py-4 border border-surfaceLight hover:border-primary text-muted hover:text-white font-semibold rounded-xl transition-all text-lg"
                >
                  Leaderboard
                </Link>
              </div>
            </div>

            {/* Daily spin — desktop only here; on mobile it's shown after the Blackjack
                game card further down the page instead (see Game cards section) */}
            <div className="hidden lg:block w-full max-w-sm lg:w-96 shrink-0">
              <DailySpinWidget profile={profile} />
            </div>
          </div>
        </div>
      </section>

      {/* Live match ticker */}
      <section className="border-y border-surfaceLight bg-surface/40 py-5 mt-0 mb-8">
        <div className="max-w-7xl mx-auto px-4">
          <MatchTicker />
        </div>
      </section>

      {/* Stats bar */}
      {profile && (
        <section className="max-w-7xl mx-auto px-4 mb-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Balance', value: (
                <span className="inline-flex items-center gap-1 max-w-full" title={`${fmtExact(profile.c_coins)} coins`}>
                  <span className="truncate min-w-0">{fmtCoins(profile.c_coins)}</span>
                  <CoinIcon size="0.85em" />
                </span>
              ) },
              { label: 'ELO', value: profile.elo ?? 1000 },
              { label: 'Wins', value: profile.wins ?? 0 },
              { label: 'Losses', value: profile.losses ?? 0 },
            ].map(stat => (
              <div key={stat.label} className="bg-surface border border-surfaceLight rounded-xl p-4 text-center overflow-hidden">
                <div className="text-2xl font-black text-white font-mono overflow-hidden">{stat.value}</div>
                <div className="text-xs text-muted mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Game cards + daily bonus */}
      <section className="max-w-7xl mx-auto px-4 pb-24">
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-white mb-6">Choose a Game</h2>
            <div className="grid sm:grid-cols-2 gap-5">
              {GAMES.map(game => (
                <GameCard key={game.title} {...game} liveCount={playerCounts?.[game.countKey] ?? 0} />
              ))}
            </div>

            {/* Daily spin — mobile/tablet only; desktop shows it in the hero instead */}
            <div className="lg:hidden mt-5 max-w-sm mx-auto sm:mx-0 sm:max-w-none">
              <DailySpinWidget profile={profile} />
            </div>
          </div>

          <div className="lg:w-72 flex flex-col gap-5 lg:pt-[3.5rem]">
            {profile ? (
              <DailyBonus />
            ) : (
              <div className="bg-surface border border-surfaceLight rounded-2xl p-5 text-center">
                <div className="text-2xl mb-2">💎</div>
                <div className="font-bold text-white mb-1">Diamond Bonus</div>
                <div className="text-sm text-muted mb-3">Claim 250 Diamonds every 5 minutes — free!</div>
                <Link
                  to="/login"
                  className="block w-full py-2.5 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all text-sm"
                >
                  Login to Claim
                </Link>
              </div>
            )}
            <div className="bg-surface border border-surfaceLight rounded-2xl p-5">
              <h3 className="font-bold text-white mb-3">How It Works</h3>
              <ul className="text-sm text-muted space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-primary">•</span>
                  <span className="inline-flex items-center gap-1">1 <CoinIcon size="1em" /> = $1 USD</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent">•</span>
                  💎 Diamonds are free — claim 250 every 5 min
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-primary">•</span>
                  <span>Bet <span className="inline-flex items-center gap-1 align-middle"><CoinIcon size="1em" /></span> Coins or 💎 Diamonds on any game</span>
                </li>
              </ul>
              <Link
                to="/wallet"
                className="mt-4 block text-center text-sm text-primary hover:text-accent transition-colors font-medium"
              >
                Open Wallet →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

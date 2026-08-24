import { Link } from 'react-router-dom';
import GameVideoCard from '../components/GameVideoCard';
import DailyBonus from '../components/DailyBonus';
import SpinWheel from '../components/SpinWheel';
import MatchTicker from '../components/MatchTicker';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import CoinIcon from '../components/CoinIcon';
import ReferralCard from '../components/ReferralCard';
import { fmtCoins, fmtExact } from '../utils/format';
import { GAMES } from '../data/games';

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
      {/* Hero — a little breathing room on mobile (~40px), roomy on desktop
          (was ~120px of stacked top padding on every screen size) */}
      <section className="relative pt-3 md:pt-14 pb-6 md:pb-10 px-4 overflow-hidden">
        <div className="relative max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 md:gap-12">
            <div className="flex-1 text-center md:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-primary/10 border border-primary/30 rounded-full text-primary text-sm font-medium mb-3 md:mb-6">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                Live — Play Now
              </div>
              <h1 className="text-5xl md:text-7xl font-black text-white mb-3 md:mb-6 leading-tight">
                1v1{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-primary">
                  Duels
                </span>
              </h1>
              <p className="text-lg md:text-xl text-muted max-w-2xl mx-auto md:mx-0 mb-5 md:mb-10">
                Challenge opponents in real-time skill-based games. Wager{' '}
                <span className="text-primary font-semibold whitespace-nowrap"><CoinIcon size="1em" /> Coins</span>, climb the leaderboard,
                and prove you're the best.
              </p>
              <div className="flex flex-wrap md:flex-nowrap items-center justify-center md:justify-start gap-4">
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
            <div className="hidden md:block w-full max-w-sm md:w-80 lg:w-96 shrink-0">
              <DailySpinWidget profile={profile} />
            </div>
          </div>
        </div>
      </section>

      {/* Live match ticker */}
      <section className="border-y border-surfaceLight bg-surface/40 py-3 md:py-5 mt-0 mb-5 md:mb-8">
        <div className="max-w-7xl mx-auto px-4">
          <MatchTicker />
        </div>
      </section>

      {/* Stats bar */}
      {profile && (
        <section className="max-w-7xl mx-auto px-4 mb-6 md:mb-10">
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
              <div key={stat.label} className="bg-surface border border-surfaceLight rounded-xl p-3 md:p-4 text-center overflow-hidden">
                <div className="text-xl md:text-2xl font-black text-white font-mono overflow-hidden">{stat.value}</div>
                <div className="text-xs text-muted mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Game cards + daily bonus */}
      <section className="max-w-7xl mx-auto px-4 pb-16 md:pb-24">
        <div className="flex flex-col md:flex-row gap-8">
          <div className="flex-1">
            <h2 className="text-xl md:text-2xl font-bold text-white mb-4 md:mb-6">Choose a Game</h2>
            {/* sm: 3 across — mobile stays 2, which already sizes well. The
                jump happens at sm rather than md: below md there is no
                sidebar yet, so the grid has the full column width to itself
                and 3-up has room; at md+ the sidebar (256–288px) starts
                eating into this column, so 3-up needs the smaller gap. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4">
              {GAMES.map(game => (
                <GameVideoCard
                  key={game.slug}
                  {...game}
                  liveCount={game.countKey ? (playerCounts?.[game.countKey] ?? 0) : 0}
                />
              ))}
            </div>

            {/* Invite — mobile only, above the daily spin. The desktop copy lives
                in the sidebar below How It Works; the two are complementary so
                exactly one renders at any width. */}
            <div className="md:hidden mt-5 max-w-sm mx-auto sm:mx-0 sm:max-w-none">
              <ReferralCard variant="compact" />
            </div>

            {/* Daily spin — mobile/tablet only; desktop shows it in the hero instead */}
            <div className="md:hidden mt-5 max-w-sm mx-auto sm:mx-0 sm:max-w-none">
              <DailySpinWidget profile={profile} />
            </div>
          </div>

          <div className="md:w-64 lg:w-72 flex flex-col gap-5 lg:pt-[3.5rem]">
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

            {/* Fills the empty space below How It Works. Desktop only — on
                mobile the copy above the daily spin is shown instead. */}
            <div className="hidden md:block">
              <ReferralCard variant="compact" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

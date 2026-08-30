import { Link } from 'react-router-dom';
import DiamondIcon from '../components/DiamondIcon';
import GameIcon from '../components/GameIcon';
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
import { LockIcon } from '../components/UiIcon';

function DailySpinWidget({ profile }) {
  return profile ? (
    <SpinWheel />
  ) : (
    <div className="relative rounded-2xl overflow-hidden">
      <div className="pointer-events-none opacity-50 select-none">
        <SpinWheel />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] rounded-2xl gap-3">
        <LockIcon size={32} />
        <p className="text-white font-black text-lg">Daily Spin</p>
        <p className="text-muted text-sm text-center px-4">Win up to 50,000 <DiamondIcon /> every day</p>
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
                Challenge opponents in real-time player vs player games. Wager{' '}
                <span className="text-primary font-semibold whitespace-nowrap"><CoinIcon size="1em" /> Coins</span>, climb the leaderboard,
                and prove you're the best.
              </p>
              <div className="flex flex-wrap md:flex-nowrap items-center justify-center md:justify-start gap-4">
                {/* min-w-[175px] on both so they match.
                    The padding, text size and height were already identical —
                    the only difference was the word: "Wallet" is shorter than
                    "Play Now", so it rendered 120px against 175px and read
                    as the smaller button. A shared minimum makes them equal
                    without stretching either past its natural size.

                    font-bold matches too; the outlined one was semibold, which
                    made the label look lighter as well as narrower. */}
                <Link
                  to="/games"
                  className="min-w-[175px] px-8 py-4 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl shadow-glow hover:shadow-glow-lg transition-all text-lg inline-flex items-center justify-center gap-2"
                >
                  <GameIcon game="quickMatch" size={22} />Play Now
                </Link>
                <Link
                  to="/wallet"
                  // White letters and a white outline, so it reads as the
                  // second half of a pair rather than as a disabled control —
                  // muted-on-muted made it look unavailable next to Play Now.
                  className="min-w-[175px] text-center px-8 py-4 border border-white/70 hover:border-white text-white hover:bg-white/10 font-bold rounded-xl transition-all text-lg"
                >
                  Wallet
                </Link>
              </div>
            </div>

            {/* Daily spin — desktop only here; below lg it is shown further
                down the page instead (see Game cards section). Gated on lg,
                not md, to match the copy below: at md they would both render
                and the page would show two spin wheels. */}
            <div className="hidden lg:block w-full max-w-sm lg:w-96 shrink-0">
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
          {/* Always 4 across, mobile included — these read as one strip of
              stats, not two rows of two. Mobile gets tighter padding/gap and
              a smaller number so four columns actually have room; md+ steps
              back up to the original sizing. */}
          <div className="grid grid-cols-4 gap-1.5 sm:gap-4">
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
              <div key={stat.label} className="bg-surface border border-surfaceLight rounded-xl py-3 px-1.5 sm:py-4 sm:px-3 md:p-4 text-center overflow-hidden min-w-0">
                <div className="text-sm sm:text-xl md:text-2xl font-black text-white font-mono overflow-hidden">{stat.value}</div>
                <div className="text-[10px] sm:text-xs text-muted mt-0.5 sm:mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Game cards + daily bonus */}
      <section className="max-w-7xl mx-auto px-4 pb-16 md:pb-24">
        {/* The right-hand column moves beside the grid at lg, not md.
            At md it stacked alongside on an iPad portrait, where this page
            ALREADY loses 240px to the left nav — an 834px viewport gave
            590px of page, and minus a 256px side column and its gap the
            seven cards shared 270px. They rendered 79px wide. Below lg the
            column now sits underneath, giving the grid the full width. */}
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1 min-w-0">
            <h2 className="text-xl md:text-2xl font-bold text-white mb-4 md:mb-6">Choose a Game</h2>
            {/* Column counts are chosen from the width this grid ACTUALLY
                gets — after the 240px left nav, and after the side column
                from xl — not from the raw viewport:

                NOTE: md is 720px in this project, not Tailwind's default
                768 (see tailwind.config.js) — so every iPad, portrait
                included, is already past it and always has the 240px left
                nav. Measured card widths:

                  phone     390px      2 cols -> 173px
                  sm        640-719    3 cols  (no left nav yet)
                  md/iPad   720-1279   2 cols -> 226-271px
                  xl        1280-1535  3 cols
                  2xl       1536+      4 cols  (side column returns at xl)

                The whole iPad range — portrait AND landscape — stays at 2.
                At 1194 landscape, 3 cols measured 189px, smaller than a
                phone's 173px in a far bigger window, because the 240px nav
                is the real constraint, not max-w-7xl.

                md drops back to 2 deliberately: that is where the left nav
                appears and takes 240px, so three cards there would be
                smaller than they are on a phone. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
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
            <div className="lg:hidden mt-5 max-w-sm mx-auto sm:mx-0 sm:max-w-none">
              <ReferralCard variant="compact" />
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
                <div className="text-2xl mb-2"><DiamondIcon /></div>
                <div className="font-bold text-white mb-1">Diamond Bonus</div>
                <div className="text-sm text-muted mb-3">Claim 500 Diamonds every minute — free!</div>
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
                  <span className="text-primary">•</span>
                  <DiamondIcon /> Diamonds are free — claim 500 every 1 min
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-primary">•</span>
                  <span>Bet <span className="inline-flex items-center gap-1 align-middle"><CoinIcon size="1em" /></span> Coins or <DiamondIcon /> Diamonds on any game</span>
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
            <div className="hidden lg:block">
              <ReferralCard variant="compact" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

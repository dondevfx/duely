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
import FitText from '../components/FitText';

// The stripped-back phone Home.
//
// Phones get the title, the game cards and How It Works, and nothing else: no
// description, no Play Now/Wallet pair, no ticker, no stats strip, no invite
// card, no daily spin, no diamond bonus, no "Games" heading. Everything else
// is unchanged.
//
// Kept as ONE switch rather than a `hidden sm:block` sprinkled through the
// file, because this is a trial — flipping PHONE_MINIMAL to false restores the
// old phone layout exactly, with nothing to hunt for.
//
// The stripped-back Home is now the Home, at every width.
//
// It started as a phone-only layout behind a breakpoint, because cutting six
// sections is a large change to make everywhere at once. Having lived with it,
// the answer to "does a desktop need the extra sections" turned out to be no —
// so the breakpoint goes rather than being widened. A layout that is right on
// one screen and merely tolerated on another is two layouts to keep working.
//
// The constants stay as the switch that turns the cut sections back on, which
// is why they are not deleted along with the breakpoint: PHONE_MINIMAL = false
// restores every one of them.
const PHONE_MINIMAL = true;

// `hidden` outright, not `hidden sm:block` — there is no width at which these
// come back now. Two variants because the wrappers are not all the same
// display type, and a flex row collapsed to block would reflow rather than
// reappear.
const PHONE_HIDE      = PHONE_MINIMAL ? 'hidden' : '';
const PHONE_HIDE_FLEX = PHONE_MINIMAL ? 'hidden' : 'flex';
// For the two blocks that were already desktop-only on their own (`hidden
// lg:block`) rather than through the switch. They survived the cut precisely
// because they were never wired to it — which is the argument for having one
// switch rather than a breakpoint per section.
const PHONE_HIDE_LG   = PHONE_MINIMAL ? 'hidden' : 'hidden lg:block';

// The How Duely Works card, as a grid cell.
//
// It used to sit in a side rail. It is now the ninth cell of a 3x3 grid: eight
// games and this, so a wide screen ends on a full row rather than on two
// games and a gap. col-span-2 on a phone keeps it full width under the four
// rows of two, which is where it already was.
//
// md:aspect-square so it matches the cards beside it — the games are square,
// and a shorter card in the corner reads as something that failed to load.
function HowDuelyWorks() {
  return (
          <div className="bg-surface border border-surfaceLight rounded-2xl p-5 xl:p-4 col-span-2 xl:col-span-1 xl:aspect-square flex flex-col justify-center">
            <h3 className="font-bold text-white mb-3 xl:mb-2">How Duely Works</h3>
            <ul className="text-sm xl:text-[0.8125rem] text-muted space-y-2 xl:space-y-1.5">
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span className="inline-flex items-center gap-1 flex-wrap">1 <CoinIcon size="1em" /> = $1 USD — deposit on the Wallet page</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                {/* Wrapped, like the other two bullets. Bare, the icon was a
                    flex CHILD of the li — items-start pinned it to the top of
                    the line and vertical-align does not apply inside flex, so
                    it floated above the sentence instead of sitting in it. */}
                <span><DiamondIcon /> Diamonds are free — claim diamonds on the Rewards page</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>Bet <span className="inline-flex items-center gap-1 align-middle"><CoinIcon size="1em" /></span> Coins or <DiamondIcon /> Diamonds on any game</span>
              </li>
            </ul>
            {/* Two destinations, because the card names two currencies and
                they are topped up in different places — coins on the wallet,
                diamonds on rewards. A single "Open Wallet" link left the
                diamond line with nowhere to go.

                Equal halves of one row: neither is the primary action, and
                sizing one larger would have said otherwise. */}
            <div className="mt-4 xl:mt-3 flex gap-2 shrink-0">
              <Link
                to="/wallet"
                className="flex-1 py-2.5 xl:py-2 rounded-xl bg-primary hover:bg-blue-500 text-white text-sm font-bold text-center transition-all"
              >
                Wallet
              </Link>
              <Link
                to="/rewards"
                className="flex-1 py-2.5 xl:py-2 rounded-xl bg-primary hover:bg-blue-500 text-white text-sm font-bold text-center transition-all"
              >
                Rewards
              </Link>
            </div>
          </div>
  );
}

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
    <div className="min-h-screen bg-bg pt-2">
      {/* Hero — a little breathing room on mobile (~40px), roomy on desktop
          (was ~120px of stacked top padding on every screen size) */}
      {/* One set of numbers, not two. The description, the buttons and the
          Games heading are gone at every width now, so this padding is the
          whole gap between the title and the first card everywhere — and the
          desktop values were chosen for a hero that still had content under
          the title. Keeping md:pt-14 md:pb-10 would leave a wide screen
          padding an empty space. */}
      <section className="relative pt-3 pb-2 px-4 overflow-hidden">
        <div className="relative max-w-7xl mx-auto">
          <div className="flex flex-col items-center justify-between gap-6">
            {/* Centred at every width: there is nothing beside it to align against. */}
            <div className="flex-1 text-center">
              <h1 className="text-5xl md:text-7xl font-black text-white mb-3 md:mb-6 leading-tight">
                1v1{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-primary">
                  Duels
                </span>
              </h1>
              <p className={`${PHONE_HIDE} text-lg md:text-xl text-muted max-w-2xl mx-auto md:mx-0 mb-5 md:mb-10`}>
                Challenge opponents in real-time player vs player games. Wager{' '}
                <span className="text-primary font-semibold whitespace-nowrap"><CoinIcon size="1em" /> Coins</span>, climb the leaderboard,
                and prove you're the best.
              </p>
              <div className={`${PHONE_HIDE_FLEX} flex-wrap md:flex-nowrap items-center justify-center md:justify-start gap-4`}>
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
            <div className={`${PHONE_HIDE_LG} w-full max-w-sm lg:w-96 shrink-0`}>
              <DailySpinWidget profile={profile} />
            </div>
          </div>
        </div>
      </section>

      {/* Live match ticker */}
      <section className={`${PHONE_HIDE} border-y border-surfaceLight bg-surface/40 py-3 md:py-5 mt-0 mb-5 md:mb-8`}>
        <div className="max-w-7xl mx-auto px-4">
          <MatchTicker />
        </div>
      </section>

      {/* Stats bar */}
      {profile && (
        <section className={`${PHONE_HIDE} max-w-7xl mx-auto px-4 mb-6 md:mb-10`}>
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
                <FitText className="text-sm sm:text-xl md:text-2xl font-black text-white font-mono">
                  {stat.value}
                </FitText>
                <div className="text-[0.625rem] sm:text-xs text-muted mt-0.5 sm:mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Game cards + daily bonus */}
      <section className="max-w-7xl mx-auto px-4 pb-16 md:pb-24">
        {/* One column at every width — the games, then How Duely Works under
            them, centred beneath the title. The side column was there to use
            the space a wide screen has spare, but with the extra sections cut
            it held one card, and a lone card in a 288px rail beside a grid is
            a layout built for content that is no longer there. */}
        <div className="flex flex-col gap-8">
          <div className="flex-1 min-w-0 w-full max-w-3xl xl:max-w-5xl mx-auto">
            <h2 className={`${PHONE_HIDE} text-xl md:text-2xl font-bold text-white mb-4 md:mb-6`}>Games</h2>
            {/* Two on a phone, three from md — and How Duely Works is the
                ninth cell rather than a separate block underneath.

                Eight games plus one card is exactly 3x3, which is the reason
                for three rather than four: four columns leaves the last row
                holding one game and a card with two empty cells beside them.
                Nine cells, no gaps.

                Three at xl, and that is about the two sidebars rather than the
                viewport. This page loses 240px to the left nav from md up and
                another 320px to world chat from lg up, so the grid gets 560px
                less than the window suggests. Measured, with both open:

                  iPad portrait   834px   3 cols -> 175px   2 cols -> 271px
                  iPad landscape  1194px  3 cols -> 189px   2 cols -> 285px
                  desktop         1440px  3 cols -> 271px

                Three columns below xl makes cards SMALLER than the 169px a
                phone gives in a window a third the size, which is the shape
                this layout already had once. So tablets take two and desktop
                takes three — and on desktop the ninth cell lands exactly where
                it was asked to. */}
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
              {GAMES.map(game => (
                <GameVideoCard
                  key={game.slug}
                  {...game}
                  liveCount={game.countKey ? (playerCounts?.[game.countKey] ?? 0) : 0}
                />
              ))}
              <HowDuelyWorks />
            </div>

            {/* Invite — mobile only, above the daily spin. The desktop copy lives
                in the sidebar below How It Works; the two are complementary so
                exactly one renders at any width. */}
            <div className={`${PHONE_HIDE} lg:hidden mt-5 max-w-sm mx-auto sm:mx-0 sm:max-w-none`}>
              <ReferralCard variant="compact" />
            </div>

            {/* Daily spin — mobile/tablet only; desktop shows it in the hero instead */}
            <div className={`${PHONE_HIDE} lg:hidden mt-5 max-w-sm mx-auto sm:mx-0 sm:max-w-none`}>
              <DailySpinWidget profile={profile} />
            </div>
          </div>

          {/* Under the games and the same width as them, rather than beside
              them in a fixed rail. */}
          <div className="w-full max-w-3xl mx-auto flex flex-col gap-5">
            {/* Wrapped rather than the column hidden — How It Works sits in this
                same column and stays on phones. */}
            <div className={PHONE_HIDE}>
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
            </div>


            {/* Fills the empty space below How It Works. Desktop only — on
                mobile the copy above the daily spin is shown instead. */}
            <div className={PHONE_HIDE_LG}>
              <ReferralCard variant="compact" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

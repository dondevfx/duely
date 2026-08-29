import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { getDisplayRank, isRanked } from '../utils/ranks';
import Avatar from './Avatar';
import GameIcon from './GameIcon';
import UiIcon from './UiIcon';
import RankIcon from './RankIcon';

// Order is deliberate and shared with the home and games pages — see
// data/games.js, which drives both. Changing it in one place only is how the
// three lists drift apart.
const GAMES = [
  { game: 'quickMatch', label: 'Quick Match',  route: '/game/quick-match', live: true },
  { game: 'blockBlast', label: 'Block Burst',  route: '/game/block-blast', live: true },
  { game: 'carDash',    label: 'Rush Hour',    route: '/game/car-dash',    live: true },
  { game: 'coin-flip',  label: 'Coin Flip',    route: '/game/coin-flip',   live: true },
  { game: 'colorRush',  label: 'Color Rush',   route: '/game/color-rush',  live: true },
  { game: 'tower',      label: 'Tower',        route: '/game/tower',       live: true },
  { game: 'scrabble',   label: 'Word VS',      route: '/game/scrabble',    live: true },
  { game: 'blackjack',  label: 'Blackjack',    route: '/game/blackjack',   live: true },
];

const NAV = [
  { ui: 'home',        label: 'Home',        route: '/' },
  { ui: 'games',       label: 'Games',       route: '/games' },
  { ui: 'rewards',     label: 'Rewards',     route: '/rewards' },
  { ui: 'profile',     label: 'Profile',     route: '/profile' },
  { ui: 'leaderboard', label: 'Leaderboard', route: '/leaderboard' },
  { ui: 'wallet',      label: 'Wallet',      route: '/wallet' },
  { ui: 'tip',         label: 'Tip',         route: '/tip' },
];

function linkCls(isActive) {
  return `flex items-center gap-3 px-3 py-3.5 rounded-lg text-[15px] font-medium mb-0.5 transition-colors border ${
    isActive
      ? 'bg-primary/15 text-primary border-primary/20'
      : 'text-muted border-transparent hover:text-white hover:bg-surfaceLight'
  }`;
}

const routeToKey = {
  '/game/block-blast':  'block-blast',
  '/game/coin-flip':    'coin-flip',
  '/game/scrabble':     'scrabble',
  '/game/blackjack':    'blackjack',
  '/game/car-dash':     'car-dash',
  '/game/color-rush':   'color-rush',
  '/game/tower':        'tower',
  '/game/quick-match':  null,
};

export default function LeftSidebar() {
  const { profile } = useAuth();
  const { playerCounts } = useSocket();
  const rank = profile ? getDisplayRank(profile) : null;
  const ranked = profile ? isRanked(profile) : false;

  return (
    <aside className="hidden md:flex fixed left-0 top-14 h-[calc(100vh-56px)] w-60 bg-surface border-r border-border flex-col z-30 overflow-y-auto">
      {/* Navigation */}
      <div className="px-3 pt-4 pb-2">
        <p className="text-xs text-muted uppercase tracking-widest px-2 mb-2 font-semibold">Menu</p>
        {NAV.map(item => (
          <NavLink
            key={item.route}
            to={item.route}
            end={item.route === '/'}
            className={({ isActive }) => linkCls(isActive)}
          >
            <UiIcon name={item.ui} size={19} />
            {item.label}
          </NavLink>
        ))}
      </div>

      <div className="mx-3 border-t border-border my-2" />

      {/* Games */}
      <div className="px-3 pb-4">
        <p className="text-xs text-muted uppercase tracking-widest px-2 mb-2 font-semibold">Games</p>
        {GAMES.map(game => (
          <NavLink
            key={game.route}
            to={game.route}
            className={({ isActive }) => linkCls(isActive)}
          >
            <GameIcon game={game.game} size={20} />
            <span className="flex-1">{game.label}</span>
            {(() => {
              const key = routeToKey[game.route];
              // key===null = no count for this route (Quick Match); key===undefined = unknown
              if (!key) return null;
              const count = playerCounts[key] || 0;
              if (count === 0) return null;
              return (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#1250B4', textShadow: '0 0 8px #1250B466' }}>
                    {count}
                  </span>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 5px #1250B4', display: 'inline-block' }} />
                </span>
              );
            })()}
          </NavLink>
        ))}
      </div>

      {/* Profile mini */}
      {profile && (
        <>
          <div className="mx-3 border-t border-border" />
          <div className="p-3 mt-auto">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar
                username={profile.username}
                avatarUrl={profile.avatar_url}
                color={profile.profile_color}
                className="w-9 h-9"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <div className="text-sm font-semibold text-white truncate">{profile.username}</div>
                  {(profile.current_streak ?? 0) >= 1 && (
                    <span className="text-xs font-bold text-orange-400" style={{ textShadow: '0 0 8px rgba(251,146,60,0.6)' }}>
                      🔥{profile.current_streak}
                    </span>
                  )}
                </div>
                {rank && <div className="text-xs text-muted flex items-center gap-1"><RankIcon rank={rank} size={14} />{rank.name}{ranked ? ` · ${profile.elo} ELO` : ''}</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

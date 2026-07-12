import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { getRank } from '../utils/ranks';

const GAMES = [
  { icon: '⚡', label: 'Quick Match',  route: '/game/quick-match', live: true },
  { icon: '🟦', label: 'Block Burst',  route: '/game/block-blast', live: true },
  { icon: '🟡', label: 'Coin Flip',    route: '/game/coin-flip',   live: true },
  { icon: '🔤', label: 'Word VS',       route: '/game/scrabble',    live: true },
  { icon: '🃏', label: 'Blackjack',    route: '/game/blackjack',   live: true },
];

const NAV = [
  { icon: '🏠', label: 'Home',         route: '/' },
  { icon: '🎡', label: 'Rewards',       route: '/rewards' },
  { icon: '👤', label: 'Profile',       route: '/profile' },
  { icon: '🏆', label: 'Leaderboard',   route: '/leaderboard' },
  { icon: '💳', label: 'Wallet',         route: '/wallet' },
  { icon: '💸', label: 'Tip',            route: '/tip' },
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
  '/game/quick-match':  null,
};

export default function LeftSidebar() {
  const { profile } = useAuth();
  const { playerCounts } = useSocket();
  const rank = profile ? getRank(profile.elo) : null;

  return (
    <aside className="hidden lg:flex fixed left-0 top-14 h-[calc(100vh-56px)] w-60 bg-surface border-r border-border flex-col z-30 overflow-y-auto">
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
            <span className="text-lg leading-none">{item.icon}</span>
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
            <span className="text-lg leading-none">{game.icon}</span>
            <span className="flex-1">{game.label}</span>
            {(() => {
              const key = routeToKey[game.route];
              // key===null = no count for this route (Quick Match); key===undefined = unknown
              if (!key) return null;
              const count = playerCounts[key] || 0;
              if (count === 0) return null;
              return (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#4ade80', textShadow: '0 0 8px #4ade8066' }}>
                    {count}
                  </span>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 5px #4ade80', display: 'inline-block' }} />
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
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                style={{
                  backgroundColor: `${profile.profile_color || '#1250B4'}22`,
                  border: `1.5px solid ${profile.profile_color || '#1250B4'}`,
                  color: profile.profile_color || '#1250B4',
                }}>
                {profile.username?.[0]?.toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <div className="text-sm font-semibold text-white truncate">{profile.username}</div>
                  {(profile.current_streak ?? 0) >= 1 && (
                    <span className="text-xs font-bold text-orange-400" style={{ textShadow: '0 0 8px rgba(251,146,60,0.6)' }}>
                      🔥{profile.current_streak}
                    </span>
                  )}
                </div>
                {rank && <div className="text-xs text-muted">{rank.icon} {rank.name} · {profile.elo} ELO</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

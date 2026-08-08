import { useNavigate } from 'react-router-dom';
import GlowButton from './GlowButton';

export default function GameCard({ title, description, icon, route, available = true, liveCount = 0 }) {
  const navigate = useNavigate();

  return (
    <div className={`
      relative flex flex-col gap-2 md:gap-4 p-3 md:p-6 rounded-2xl border transition-all duration-300
      ${available
        ? 'bg-surface border-surfaceLight hover:border-primary/50 hover:shadow-glow cursor-pointer group'
        : 'bg-surface/50 border-surfaceLight/50 opacity-60'}
    `}>
      {liveCount > 0 && (
        <div className="absolute top-2 right-2 md:top-4 md:right-4 inline-flex items-center gap-1 text-[10px] md:text-xs font-semibold px-1.5 md:px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30">
          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" style={{ boxShadow: '0 0 4px #1250B4' }} />
          {liveCount} Live
        </div>
      )}

      <div className="text-2xl md:text-4xl">{icon}</div>

      <div>
        {/* Mobile title bumped 14px → 16px; the md: size is unchanged. */}
        <h3 className="text-base md:text-xl font-bold text-white mb-0.5 md:mb-1 leading-tight group-hover:text-primary transition-colors">
          {title}
        </h3>
        <p className="text-[11px] md:text-sm text-muted leading-snug md:leading-relaxed line-clamp-3 md:line-clamp-none">{description}</p>
      </div>

      {available ? (
        <GlowButton
          onClick={() => navigate(route)}
          variant="primary"
          className="mt-auto w-full text-xs md:text-base py-2 md:py-3"
        >
          Play Now
        </GlowButton>
      ) : (
        <div className="mt-auto w-full text-center text-xs md:text-sm text-muted py-2 md:py-2.5 border border-surfaceLight rounded-lg">
          Coming Soon
        </div>
      )}
    </div>
  );
}

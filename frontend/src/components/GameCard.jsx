import { useNavigate } from 'react-router-dom';
import GlowButton from './GlowButton';

export default function GameCard({ title, description, icon, route, available = true, tag }) {
  const navigate = useNavigate();

  return (
    <div className={`
      relative flex flex-col gap-4 p-6 rounded-2xl border transition-all duration-300
      ${available
        ? 'bg-surface border-surfaceLight hover:border-primary/50 hover:shadow-glow cursor-pointer group'
        : 'bg-surface/50 border-surfaceLight/50 opacity-60'}
    `}>
      {tag && (
        <span className="absolute top-4 right-4 text-xs font-semibold px-2 py-0.5 rounded-full bg-accent/20 text-accent border border-accent/30">
          {tag}
        </span>
      )}

      <div className="text-4xl">{icon}</div>

      <div>
        <h3 className="text-xl font-bold text-white mb-1 group-hover:text-primary transition-colors">
          {title}
        </h3>
        <p className="text-sm text-muted leading-relaxed">{description}</p>
      </div>

      {available ? (
        <GlowButton
          onClick={() => navigate(route)}
          variant="primary"
          className="mt-auto w-full"
        >
          Play Now
        </GlowButton>
      ) : (
        <div className="mt-auto w-full text-center text-sm text-muted py-2.5 border border-surfaceLight rounded-lg">
          Coming Soon
        </div>
      )}
    </div>
  );
}

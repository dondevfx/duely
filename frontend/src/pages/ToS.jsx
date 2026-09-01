import { usePageReady } from '../hooks/usePageReady';
import { TOS_SECTIONS } from '../data/legal';

export default function ToS() {
  const ready = usePageReady();
  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">Terms of Service</h1>
        <p className="text-muted text-sm mb-10">Last updated: {new Date().getFullYear()}</p>

        {TOS_SECTIONS.map(({ title, body }) => (
          <div key={title} className="mb-8">
            <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
            <p className="text-muted text-sm leading-relaxed">{body}</p>
          </div>
        ))}

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted">
            Questions? Contact us through the platform chat or support channels.
          </p>
        </div>
      </div>
    </div>
  );
}


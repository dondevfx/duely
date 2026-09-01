import { usePageReady } from '../hooks/usePageReady';
import { PRIVACY_SECTIONS } from '../data/legal';

// Privacy policy. Written against what the app ACTUALLY does rather than from a
// template — every claim here maps to real code, and it needs to keep doing so:
//
//   account data      → Supabase Auth + profiles table
//   deposit addresses → addressService (derived per user+coin, stored in
//                       deposit_addresses so blockchainMonitor can watch them)
//   transactions      → transactions table (tx_hash, amounts, status)
//   match history     → matches + game_highscores
//   chat              → NOT stored; relayed over the socket and never written
//   errors            → Sentry, and only when SENTRY_DSN is set
//
// If any of those change, this page has to change with it. A privacy policy
// that no longer describes the system is worse than not having one.
export default function Privacy() {
  const ready = usePageReady();
  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">Privacy Policy</h1>
        <p className="text-muted text-sm mb-10">Last updated: {new Date().getFullYear()}</p>

        {PRIVACY_SECTIONS.map(({ title, body }) => (
          <div key={title} className="mb-8">
            <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
            <p className="text-muted text-sm leading-relaxed">{body}</p>
          </div>
        ))}

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted">
            Questions about your data? Contact us through the platform chat or support channels.
          </p>
        </div>
      </div>
    </div>
  );
}

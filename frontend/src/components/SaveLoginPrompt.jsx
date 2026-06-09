import { saveSession } from '../utils/supabase';

export default function SaveLoginPrompt({ onDone }) {
  async function handleSave() {
    await saveSession();
    onDone();
  }

  // "Not now" just closes for this session — prompt returns on next login
  function handleDismiss() {
    onDone();
  }

  return (
    <div className="fixed top-4 right-4 z-50 w-80 bg-surface border border-primary/40 rounded-2xl shadow-2xl p-4 animate-slide-down">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="text-2xl">🔑</div>
          <div>
            <p className="text-sm font-bold text-white">Save login info?</p>
            <p className="text-xs text-muted mt-0.5">Stay logged in automatically next visit</p>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-muted hover:text-white text-lg leading-none mt-0.5 flex-shrink-0"
        >
          ✕
        </button>
      </div>
      <div className="flex gap-2 mt-3">
        <button
          onClick={handleSave}
          className="flex-1 bg-primary hover:bg-primary/80 text-white text-sm font-bold py-2 rounded-xl transition-colors"
        >
          Save
        </button>
        <button
          onClick={handleDismiss}
          className="flex-1 bg-surfaceLight hover:bg-border text-muted text-sm font-bold py-2 rounded-xl transition-colors"
        >
          Not now
        </button>
      </div>
      <p className="text-xs text-muted text-center mt-2">This will appear each login until you save</p>
    </div>
  );
}

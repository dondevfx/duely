// ─────────────────────────────────────────────────────────
// BOT SERVICE  —  To disable all bots: BOTS_ENABLED = false
// ─────────────────────────────────────────────────────────
const BOTS_ENABLED = true;

const BOT_NAMES = ['Duely Bot'];

function createBotPlayer(entryFee = 0, gameType = 'reaction') {
  if (!BOTS_ENABLED) return null;
  return {
    socketId: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId:   `bot_${Date.now()}`,
    username: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
    elo:      950 + Math.floor(Math.random() * 100),
    entryFee,
    isBot:    true,
    gameType,
  };
}

// Bot clicks 700–1300ms after GO signal (human average is ~400-600ms so this is beatable)
function scheduleBotClick(io, supabase, roomId, botSocketId, goTime, handleClickFn) {
  if (!BOTS_ENABLED) return;
  const delay = 700 + Math.random() * 600;
  setTimeout(() => handleClickFn(io, supabase, roomId, botSocketId, goTime + delay), delay);
}

// Bot types at 180–240 CPM with natural jitter
function simulateBotTyping(io, roomId, text, onProgressFn, onCompleteFn) {
  if (!BOTS_ENABLED) return;
  const cpm = 180 + Math.random() * 60;
  const msPerChar = 60000 / cpm;
  let pos = 0;

  const tick = () => {
    pos++;
    onProgressFn(pos);
    if (pos >= text.length) {
      onCompleteFn();
    } else {
      const jitter = (Math.random() - 0.5) * 80;
      setTimeout(tick, Math.max(50, msPerChar + jitter));
    }
  };
  setTimeout(tick, msPerChar);
}

module.exports = { BOTS_ENABLED, createBotPlayer, scheduleBotClick, simulateBotTyping };

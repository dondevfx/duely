import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import CoinIcon from './CoinIcon';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';

const MAX_MESSAGES = 100;
const ADMIN_ID  = '423d2b0c-1dae-4947-8340-b07575954383';
const BOT_ID    = 'duely-bot-v1';
const BOT_NAME  = 'Duely Bot';
const BOT_COLOR = '#00BFFF';

const BOT_LINES = [
  "💎 Don't forget your daily spin — up to 50,000 diamonds free every day!",
  "🔥 Win streak badges are earned, not given. Keep that fire alive 🔥",
  "🌟 Nothing like a 1v1 grind to prove who the real GOAT is",
  "💎 Claim 250 free diamonds every 30 minutes — don't sleep on it",
  "💸 Tip your friends some coins when they're having a rough run",
  "⚔️ The 1v1 grind never stops. Win or learn — no other options.",
  "🌙 Late night gaming hits completely different. Who's still up?",
  "🏋️ Bot matches are perfect warmup before you go ranked, trust",
  "💡 Affiliate codes — share yours and earn on every match your friends play",
  "🦾 Practice vs bot, dominate vs humans. That's the formula.",
  "🏆 New week, new chance to climb. Reset your mindset, let's go",
  "💬 Shoutout to everyone grinding the rank wheels daily",
  "💎 Spin all your unlocked rank wheels every day — free diamonds stack up",
  "🟦 Block Burst: clearing rows AND columns at the same time is where it's at",
  "💎 Diamond bets vs bot pay full 2x on a win — no house fee.",
  "🎡 Six spin wheels on the Rewards page. Spin them all daily.",
  "⚡ Power-ups in Block Burst change the whole game. Watch the grid.",
  "🔥 Win streaks show on your profile, chat, and the leaderboard.",
  "🔤 Word VS: short words score fast — save the long ones for premium squares.",
  "🏅 Rakeback pays you back just for playing — claim it every day.",
  "🟡 Coin Flip: pick Heads or Tails and you'll be matched with someone on the other side.",
  "🃏 Blackjack: get closer to 21 than your opponent — without going bust.",
  "🃏 Blackjack: both players act at the same time, then the dealer reveals. No waiting!",
  "🟡 Coin Flip is the fastest way to double your coins — one flip, instant result.",
];

// Stable fake cumulative P&L for the bot — starts at 0, ends ~+184K
const BOT_HISTORY = (() => {
  const pts = [];
  let net = 0;
  for (let i = 90; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    net += (Math.random() < 0.3 ? -1 : 1) * Math.random() * 4500;
    pts.push({ date: d.toISOString().slice(0, 10), balance: Math.round(net * 100) / 100 });
  }
  // Force a dramatic end value
  pts[pts.length - 1].balance = 184291.50;
  return pts;
})();

const BOT_PROFILE = {
  id: BOT_ID,
  username: BOT_NAME,
  elo: 9999,
  wins: 5847,
  losses: 142,
  current_streak: 100,
  best_streak: 100,
  total_wagered: 9284100,
  total_wagered_diamonds: 48392810,
  rank: 1,
  profile_color: BOT_COLOR,
};

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderMessage(text, myUsername) {
  const parts = text.split(/(@\w+)/g);
  return parts.map((part, i) => {
    if (/^@\w+$/.test(part)) {
      const isMe = myUsername && part.slice(1).toLowerCase() === myUsername.toLowerCase();
      return (
        <span key={i} className={isMe ? 'text-warning font-bold' : 'text-accent font-semibold'}>
          {part}
        </span>
      );
    }
    return part;
  });
}

// ── Line Chart ────────────────────────────────────────────────────────────────
function fmtAxis(v) {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toFixed(0);
}

function LineChart({ data }) {
  const wrapRef  = useRef(null);
  const [svgW, setSvgW] = useState(560);
  const [tooltip, setTooltip] = useState(null);

  // Measure real pixel width so SVG coords === screen coords (no scaling)
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([e]) => setSvgW(Math.floor(e.contentRect.width)));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (!data || data.length < 2) return <div ref={wrapRef} />;

  const H = 180, PL = 62, PR = 12, PT = 26, PB = 32;
  const w = svgW - PL - PR, h = H - PT - PB;

  const balances = data.map(d => d.balance);
  const minB = Math.min(...balances);
  const maxB = Math.max(...balances);
  const range = maxB - minB || 1;

  const xOf = i => PL + (i / (data.length - 1)) * w;
  const yOf = v => PT + h - ((v - minB) / range) * h;

  const pts   = data.map((d, i) => [xOf(i), yOf(d.balance)]);
  const lineD = 'M ' + pts.map(p => p.join(' ')).join(' L ');
  const areaD = `M ${PL} ${PT + h} L ` + pts.map(p => p.join(' ')).join(' L ') + ` L ${PL + w} ${PT + h} Z`;

  const isUp  = balances[balances.length - 1] >= balances[0];
  const color = isUp ? '#22c55e' : '#ef4444';

  const yTicks    = Array.from({ length: 5 }, (_, i) => minB + (range * i / 4));
  const xTickIdxs = [0, Math.round((data.length - 1) * 0.33), Math.round((data.length - 1) * 0.66), data.length - 1];

  function fmtXDate(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function handleMouseMove(e) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    // SVG is drawn at true pixels — no scaling needed
    const mouseX = e.clientX - rect.left;
    const relX   = Math.max(0, Math.min(1, (mouseX - PL) / w));
    const idx    = Math.round(relX * (data.length - 1));
    const d      = data[idx];
    setTooltip({ idx, dotX: xOf(idx), dotY: yOf(d.balance), date: d.date, balance: d.balance });
  }

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: H, cursor: 'crosshair' }}
      onMouseMove={handleMouseMove} onMouseLeave={() => setTooltip(null)}>
      <svg width={svgW} height={H}>
        <defs>
          <linearGradient id={`cg-${isUp ? 'up' : 'dn'}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Title */}
        <text x={PL + w / 2} y={PT - 9} textAnchor="middle" fontSize="11" fill="#64748b" fontWeight="600" fontFamily="system-ui,sans-serif">
          Net Coins Gained / Lost — Last 90 Days
        </text>

        {/* Y grid + labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PL} y1={yOf(v)} x2={PL + w} y2={yOf(v)}
              stroke="#1e293b" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '4,4'} />
            <text x={PL - 7} y={yOf(v)} textAnchor="end" dominantBaseline="middle"
              fontSize="11" fill="#475569" fontFamily="system-ui,sans-serif">
              {fmtAxis(v)}
            </text>
          </g>
        ))}

        {/* X labels */}
        {xTickIdxs.map(i => (
          <text key={i} x={xOf(i)} y={PT + h + 20} textAnchor="middle"
            fontSize="11" fill="#475569" fontFamily="system-ui,sans-serif">
            {fmtXDate(data[i].date)}
          </text>
        ))}

        {/* Axis line */}
        <line x1={PL} y1={PT} x2={PL} y2={PT + h} stroke="#334155" strokeWidth="1.5" />

        {/* Area + line */}
        <path d={areaD} fill={`url(#cg-${isUp ? 'up' : 'dn'})`} />
        <path d={lineD} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover vertical guide */}
        {tooltip && (
          <line x1={tooltip.dotX} y1={PT} x2={tooltip.dotX} y2={PT + h}
            stroke={color} strokeWidth="1" strokeDasharray="3,3" opacity="0.5" />
        )}

        {/* Hover dot */}
        {tooltip && (
          <circle cx={tooltip.dotX} cy={tooltip.dotY}
            r="5" fill={color} stroke="white" strokeWidth="2" />
        )}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'absolute',
          left: tooltip.dotX > svgW * 0.65 ? tooltip.dotX - 120 : tooltip.dotX + 12,
          top: Math.max(4, tooltip.dotY - 50),
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 8,
          padding: '6px 12px',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          zIndex: 99,
          boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>{fmtXDate(tooltip.date)}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: tooltip.balance >= 0 ? '#22c55e' : '#ef4444' }}>
            <span style={{display:'inline-flex',alignItems:'center',gap:2}}>{tooltip.balance >= 0 ? '+' : ''}{tooltip.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <CoinIcon size="0.85em" /></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Profile Popup ─────────────────────────────────────────────────────────────
function ProfilePopup({ userId, username, isAdmin, onClose, onBan, onUnban, isBanned, isBot }) {
  const { profile: myProfile, refreshProfile } = useAuth();
  const { activeGames } = useSocket();
  const navigate = useNavigate();
  const [data, setData]           = useState(isBot ? BOT_PROFILE : null);
  const [history, setHistory]     = useState(isBot ? BOT_HISTORY : null);
  const [loading, setLoading]     = useState(!isBot);
  const [tipAmount, setTipAmount] = useState('');
  const [tipCurrency, setTipCurrency] = useState('coins');
  const [tipSending, setTipSending]   = useState(false);
  const [tipResult, setTipResult]     = useState(null);
  const [friendStatus, setFriendStatus] = useState(null); // null | 'sent' | 'friends' | 'error'
  const isOwn = userId === myProfile?.id;

  const liveGame = !isBot && !isOwn
    ? activeGames?.find(g => g.player1?.username === username || g.player2?.username === username)
    : null;

  async function sendFriendRequest() {
    try {
      await api.post('/auth/friend-request-by-id', { userId });
      setFriendStatus('sent');
    } catch (err) {
      if (err.message?.includes('Already friends')) setFriendStatus('friends');
      else setFriendStatus('error');
    }
  }

  useEffect(() => {
    if (isBot) return;
    Promise.all([
      api.get(`/auth/public/${userId}`),
      api.get(`/auth/coin-history/${userId}`).catch(() => null),
      api.get('/auth/friends').catch(() => []),
    ]).then(([prof, hist, friendships]) => {
      setData(prof);
      setHistory(hist);
      // Determine existing friendship status so we don't show "Add Friend" for existing friends
      const myId = myProfile?.id;
      const match = Array.isArray(friendships) && friendships.find(f =>
        (f.requester?.id === userId || f.addressee?.id === userId)
      );
      if (match) {
        if (match.status === 'accepted') setFriendStatus('friends');
        else if (match.requester?.id === myId) setFriendStatus('sent');
        else setFriendStatus(null); // incoming request — still show Add Friend (will accept elsewhere)
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [userId, isBot, myProfile?.id]);

  async function handleTip() {
    const amt = tipCurrency === 'diamonds' ? Math.floor(parseFloat(tipAmount)) : parseFloat(tipAmount);
    if (!amt || amt <= 0) return;
    setTipSending(true);
    setTipResult(null);
    try {
      await api.post('/wallet/tip', { recipientUsername: username, amount: amt, currency: tipCurrency });
      setTipResult({ ok: true, text: `Sent to ${username}!` });
      setTipAmount('');
      await refreshProfile();
    } catch (err) {
      setTipResult({ ok: false, text: err.message });
    } finally {
      setTipSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-surfaceLight rounded-2xl w-[760px] max-w-[calc(100vw-32px)] shadow-2xl animate-slide-up max-h-[92vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="p-7">
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <span className="text-sm text-muted uppercase tracking-widest font-semibold">
              {isBot ? 'Duely Bot' : 'Player Profile'}
            </span>
            <button onClick={onClose} className="text-muted hover:text-white text-base w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surfaceLight transition-colors">✕</button>
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : data ? (
            <>
              {/* Avatar + name */}
              <div className="flex items-center gap-5 mb-6">
                <div className="relative shrink-0">
                  <div className="w-20 h-20 rounded-full flex items-center justify-center text-4xl font-black"
                    style={{
                      backgroundColor: `${data.profile_color || '#1E90FF'}22`,
                      border: `3px solid ${data.profile_color || '#1E90FF'}`,
                      color: data.profile_color || '#1E90FF',
                    }}>
                    {isBot ? '🤖' : data.username?.[0]?.toUpperCase()}
                  </div>
                  {(data.current_streak ?? 0) >= 1 && (
                    <span
                      className="absolute -top-1 -left-1 flex items-center justify-center min-w-[22px] h-[22px] rounded-full font-black leading-none px-1"
                      style={{ background: 'rgba(0,0,0,0.88)', color: '#fb923c', border: '1.5px solid rgba(251,146,60,0.5)', fontSize: 11, textShadow: '0 0 8px rgba(251,146,60,0.7)' }}
                    >
                      🔥{data.current_streak}
                    </span>
                  )}
                </div>
                <div>
                  <div className="text-3xl font-black text-white flex items-center gap-2">
                    {data.username}
                    {isBot && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                        style={{ background: `${BOT_COLOR}22`, color: BOT_COLOR, border: `1px solid ${BOT_COLOR}44` }}>
                        BOT
                      </span>
                    )}
                  </div>
                  <div className="text-base text-muted mt-1">Rank #{data.rank}</div>
                </div>
              </div>

              {/* ELO / Wins / Losses */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { label: 'ELO',    value: (data.elo ?? 0).toLocaleString(),    color: 'text-accent'  },
                  { label: 'Wins',   value: (data.wins ?? 0).toLocaleString(),   color: 'text-success' },
                  { label: 'Losses', value: (data.losses ?? 0).toLocaleString(), color: 'text-danger'  },
                ].map(s => (
                  <div key={s.label} className="bg-bg rounded-xl p-4 text-center">
                    <div className={`text-2xl font-black ${s.color}`}>{s.value}</div>
                    <div className="text-sm text-muted mt-1">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Wagered */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="bg-bg rounded-xl px-5 py-4">
                  <div className="text-sm text-muted mb-1">Coins Wagered</div>
                  <div className="text-xl font-black text-white inline-flex items-center gap-1">{fmt(data.total_wagered)} <CoinIcon size="0.85em" /></div>
                </div>
                <div className="bg-bg rounded-xl px-5 py-4">
                  <div className="text-sm text-muted mb-1">Diamonds Wagered</div>
                  <div className="text-xl font-black text-white">{(data.total_wagered_diamonds ?? 0).toLocaleString()} 💎</div>
                </div>
              </div>

              {/* Coin history chart */}
              {history && history.length > 1 && (
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted font-semibold uppercase tracking-wider">Net Coin P&amp;L (90d)</span>
                    <span className="text-sm font-bold" style={{
                      color: history[history.length - 1].balance >= 0 ? '#22c55e' : '#ef4444',
                    }}>
                      {history[history.length - 1].balance >= 0 ? '+' : ''}
                      <span style={{display:'inline-flex',alignItems:'center',gap:2}}>{history[history.length - 1].balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <CoinIcon size="0.85em" /></span>
                    </span>
                  </div>
                  <div className="bg-bg rounded-xl px-2 pt-2 pb-1 overflow-hidden">
                    <LineChart data={history} />
                  </div>
                </div>
              )}

              {/* Admin moderation */}
              {isAdmin && !isOwn && !isBot && (
                <div className="border-t border-border pt-5 mb-5">
                  <p className="text-xs text-muted font-semibold mb-2">Admin</p>
                  <button
                    onClick={() => { isBanned ? onUnban(userId, username) : onBan(userId, username); onClose(); }}
                    className={`w-full py-2.5 rounded-xl text-sm font-bold transition-all ${
                      isBanned
                        ? 'bg-success/10 text-success border border-success/30 hover:bg-success/20'
                        : 'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20'
                    }`}
                  >
                    {isBanned ? '✓ Unban from Chat' : '🚫 Ban from Chat'}
                  </button>
                </div>
              )}

              {/* Friend request + Watch Live */}
              {!isOwn && !isBot && (
                <div className="border-t border-border pt-5 mb-5 flex gap-2 flex-wrap">
                  {liveGame && (
                    <button
                      onClick={() => { onClose(); navigate('/play-now', { state: { spectateGame: liveGame.id } }); }}
                      className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20"
                    >
                      ▶ Watch Live
                    </button>
                  )}
                  <button
                    onClick={sendFriendRequest}
                    disabled={friendStatus === 'sent' || friendStatus === 'friends'}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all border ${
                      friendStatus === 'sent'    ? 'bg-success/10 text-success border-success/30 opacity-70' :
                      friendStatus === 'friends' ? 'bg-primary/10 text-primary border-primary/30 opacity-70' :
                      friendStatus === 'error'   ? 'bg-danger/10 text-danger border-danger/30' :
                      'bg-surfaceLight text-white border-surfaceLight hover:border-primary'
                    }`}
                  >
                    {friendStatus === 'sent'    ? '✓ Request Sent' :
                     friendStatus === 'friends' ? '✓ Friends' :
                     friendStatus === 'error'   ? 'Already sent' :
                     '+ Add Friend'}
                  </button>
                </div>
              )}

              {/* Tip */}
              {!isOwn && !isBot && (
                <div className="border-t border-border pt-5">
                  <div className="text-sm text-muted mb-3 font-semibold">Send Tip</div>
                  <div className="flex gap-2 mb-3">
                    {['coins', 'diamonds'].map(c => (
                      <button key={c}
                        onClick={() => { setTipCurrency(c); setTipAmount(''); setTipResult(null); }}
                        className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${
                          tipCurrency === c ? 'bg-primary text-white' : 'bg-surfaceLight text-muted hover:text-white'
                        }`}>
                        {c === 'coins' ? <span className="inline-flex items-center gap-1"><CoinIcon size="0.8em" /> Coins</span> : '💎 Diamonds'}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="number" value={tipAmount} onChange={e => setTipAmount(e.target.value)}
                      placeholder={tipCurrency === 'coins' ? '0.00' : '0'} min="0"
                      className="flex-1 bg-bg border border-border rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-primary transition-colors"
                    />
                    <button onClick={handleTip} disabled={tipSending || !tipAmount || parseFloat(tipAmount) <= 0}
                      className="px-5 py-2.5 bg-primary rounded-xl text-white text-sm font-bold hover:bg-blue-500 disabled:opacity-40 transition-all">
                      {tipSending ? '...' : 'Send'}
                    </button>
                  </div>
                  {tipResult && (
                    <p className={`text-sm mt-2 ${tipResult.ok ? 'text-success' : 'text-danger'}`}>{tipResult.text}</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-center text-muted py-6">Profile not found</p>
          )}
        </div>
      </div>
    </div>
  );
}

export { ProfilePopup };

// ── ChatSidebar ───────────────────────────────────────────────────────────────
export default function ChatSidebar({ open, onToggle }) {
  const { socket, authenticated } = useSocket();
  const { profile } = useAuth();
  const location = useLocation();
  const isHome = location.pathname === '/';
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, message: 'Welcome to World Chat!', timestamp: Date.now() },
  ]);
  const [input, setInput]         = useState('');
  const [popup, setPopup]         = useState(null);
  const [bannedUsers, setBannedUsers] = useState(new Set());
  const [mobileOpen, setMobileOpen] = useState(false);
  const bottomRef      = useRef(null);
  const mobileBottomRef = useRef(null);
  const inputRef       = useRef(null);
  const mobileInputRef = useRef(null);
  const botTimerRef    = useRef(null);

  const isAdmin = profile?.id === ADMIN_ID;

  function toggle() {
    onToggle(!open);
  }

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onMessage = (msg) => {
      setMessages(prev => [
        ...prev.slice(-MAX_MESSAGES + 1),
        { ...msg, id: msg.messageId || `${msg.userId}-${msg.timestamp}` },
      ]);
    };
    const onDeleted = ({ messageId }) => {
      setMessages(prev => prev.filter(m => m.id !== messageId));
    };
    const onSystem = ({ message }) => {
      setMessages(prev => [
        ...prev.slice(-MAX_MESSAGES + 1),
        { id: `sys-${Date.now()}`, system: true, message, timestamp: Date.now() },
      ]);
    };
    const onBanned = ({ reason }) => {
      setMessages(prev => [
        ...prev,
        { id: `sys-banned-${Date.now()}`, system: true, message: reason || 'You have been banned from chat.', timestamp: Date.now() },
      ]);
    };

    socket.on('chat_message',    onMessage);
    socket.on('message_deleted', onDeleted);
    socket.on('chat_system',     onSystem);
    socket.on('chat_banned',     onBanned);

    return () => {
      socket.off('chat_message',    onMessage);
      socket.off('message_deleted', onDeleted);
      socket.off('chat_system',     onSystem);
      socket.off('chat_banned',     onBanned);
    };
  }, [socket]);

  // ── Duely Bot interval ────────────────────────────────────────────────────
  useEffect(() => {
    function scheduleBot() {
      const delay = 30000 + Math.random() * 90000; // 30–120s
      botTimerRef.current = setTimeout(() => {
        const line = BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)];
        setMessages(prev => [
          ...prev.slice(-MAX_MESSAGES + 1),
          {
            id: `bot-${Date.now()}`,
            userId:        BOT_ID,
            username:      BOT_NAME,
            color:         BOT_COLOR,
            message:       line,
            timestamp:     Date.now(),
            isBot:         true,
            currentStreak: 100,
          },
        ]);
        scheduleBot();
      }, delay);
    }
    scheduleBot();
    return () => clearTimeout(botTimerRef.current);
  }, []);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    if (mobileOpen) mobileBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, mobileOpen]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || !socket || !authenticated) return;
    socket.emit('chat_message', { message: text });
    setInput('');
    inputRef.current?.focus();
  }, [input, socket, authenticated]);

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function deleteMessage(messageId) {
    if (!socket || !isAdmin) return;
    socket.emit('admin_delete_message', { messageId });
  }

  function banUser(userId, username) {
    if (!socket || !isAdmin) return;
    socket.emit('admin_chat_ban', { userId, username });
    setBannedUsers(prev => new Set([...prev, userId]));
  }

  function unbanUser(userId, username) {
    if (!socket || !isAdmin) return;
    socket.emit('admin_chat_unban', { userId, username });
    setBannedUsers(prev => { const s = new Set(prev); s.delete(userId); return s; });
  }

  function openPopup(msg) {
    if (msg.isBot) {
      setPopup({ userId: BOT_ID, username: BOT_NAME, isBot: true });
    } else if (msg.userId === ADMIN_ID && !isAdmin) {
      // Non-admins cannot view the admin's profile popup
      return;
    } else {
      setPopup({ userId: msg.userId, username: msg.username, isBot: false });
    }
  }

  return (
    <>
      {popup && (
        <ProfilePopup
          userId={popup.userId}
          username={popup.username}
          isBot={popup.isBot}
          isAdmin={isAdmin}
          isBanned={bannedUsers.has(popup.userId)}
          onBan={banUser}
          onUnban={unbanUser}
          onClose={() => setPopup(null)}
        />
      )}

      <aside className={`hidden lg:flex fixed right-0 top-14 h-[calc(100vh-56px)] w-80 bg-surface border-l border-border flex-col z-30 transition-transform duration-300 ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
          <span className="text-sm font-bold text-white flex-1">World Chat</span>
          <button onClick={toggle} title="Hide chat"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted hover:text-white hover:bg-surfaceLight transition-colors text-sm">
            ✕
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
          {messages.map(msg => {
            if (msg.system) {
              return (
                <div key={msg.id} className="text-center py-1">
                  <span className="text-xs text-muted/60 italic">{msg.message}</span>
                </div>
              );
            }

            const isOwn       = msg.userId === profile?.id;
            const isMentioned = profile?.username && (msg.mentions || []).includes(profile.username.toLowerCase());
            const msgColor    = msg.color || '#1E90FF';

            return (
              <div key={msg.id} className={`text-sm group ${isOwn ? 'flex flex-col items-end' : 'flex flex-col items-start'}`}>
                <div className={`flex items-center gap-1.5 mb-0.5 px-1 ${isOwn ? 'flex-row-reverse' : ''}`}>
                  <div
                    onClick={() => openPopup(msg)}
                    className="relative shrink-0"
                    style={{ cursor: (msg.userId === ADMIN_ID && !isAdmin) ? 'default' : 'pointer' }}
                  >
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black"
                      style={{ backgroundColor: `${msgColor}33`, border: `1.5px solid ${msgColor}`, color: msgColor }}>
                      {msg.isBot ? '🤖' : msg.username?.[0]?.toUpperCase()}
                    </div>
                    {(msg.currentStreak ?? 0) >= 1 && (
                      <span
                        className="absolute -top-1 -left-1 flex items-center justify-center min-w-[14px] h-[14px] rounded-full font-black leading-none px-0.5"
                        style={{ background: 'rgba(0,0,0,0.9)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.5)', fontSize: 7 }}
                      >
                        🔥{msg.currentStreak}
                      </span>
                    )}
                  </div>
                  <span
                    onClick={() => openPopup(msg)}
                    className={`text-xs font-semibold ${(msg.userId === ADMIN_ID && !isAdmin) ? '' : 'hover:underline'}`}
                    style={{ color: msgColor, cursor: (msg.userId === ADMIN_ID && !isAdmin) ? 'default' : 'pointer' }}>
                    {msg.username}
                    {msg.isBot && (
                      <span className="ml-1 text-[9px] px-1 py-0.5 rounded font-bold"
                        style={{ background: `${BOT_COLOR}18`, color: BOT_COLOR }}>BOT</span>
                    )}
                  </span>
                  {isAdmin && !msg.isBot && (
                    <button
                      onClick={() => deleteMessage(msg.id)}
                      className="opacity-0 group-hover:opacity-100 text-[10px] text-danger/60 hover:text-danger transition-all ml-1"
                      title="Delete message"
                    >✕</button>
                  )}
                </div>
                <div
                  onClick={() => openPopup(msg)}
                  className={`
                    px-3 py-2 rounded-2xl max-w-[85%] break-words text-xs leading-relaxed transition-opacity
                    ${(msg.userId === ADMIN_ID && !isAdmin) ? '' : 'cursor-pointer hover:opacity-80'}
                    ${isOwn
                      ? 'text-white'
                      : `bg-surfaceLight text-white ${isMentioned ? 'border border-warning/60 bg-warning/10' : ''}`
                    }
                  `}
                  style={isOwn ? { backgroundColor: `${msgColor}33`, border: `1px solid ${msgColor}44` } : {}}
                >
                  {renderMessage(msg.message, profile?.username)}
                </div>
                <span className="text-[10px] text-muted/40 mt-0.5 px-1">{formatTime(msg.timestamp)}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="p-3 border-t border-border">
          {authenticated ? (
            <div className="flex gap-2">
              <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey} maxLength={150}
                placeholder="Message... use @ to mention"
                className="flex-1 bg-surfaceLight border border-border rounded-xl px-3 py-2 text-white text-xs placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
              <button onClick={send} disabled={!input.trim()}
                className="px-3 py-2 bg-primary rounded-xl text-white text-xs font-bold hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-glow">
                ↑
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted text-center py-1">Sign in to chat</p>
          )}
        </div>
      </aside>

      {!open && (
        <button onClick={toggle}
          className="hidden lg:flex fixed bottom-6 right-4 z-40 items-center gap-2 bg-surface border border-border hover:border-primary rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:shadow-glow transition-all">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
          World Chat
        </button>
      )}

      {/* Mobile floating chat button — home screen only */}
      {!mobileOpen && isHome && (
        <button
          onClick={() => setMobileOpen(true)}
          className="lg:hidden fixed bottom-5 right-4 z-40 flex items-center gap-2 bg-surface border border-primary/40 hover:border-primary rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-all"
        >
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
          World Chat
        </button>
      )}

      {/* Mobile chat overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-[55] flex flex-col bg-surface">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center gap-2 shrink-0 pt-safe" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
            <div className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
            <span className="text-sm font-bold text-white flex-1">World Chat</span>
            <button
              onClick={() => setMobileOpen(false)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-white hover:bg-surfaceLight transition-colors text-base"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
            {messages.map(msg => {
              if (msg.system) {
                return (
                  <div key={msg.id} className="text-center py-1">
                    <span className="text-xs text-muted/60 italic">{msg.message}</span>
                  </div>
                );
              }
              const isOwn       = msg.userId === profile?.id;
              const isMentioned = profile?.username && (msg.mentions || []).includes(profile.username.toLowerCase());
              const msgColor    = msg.color || '#1E90FF';
              return (
                <div key={msg.id} className={`text-sm group ${isOwn ? 'flex flex-col items-end' : 'flex flex-col items-start'}`}>
                  <div className={`flex items-center gap-1.5 mb-0.5 px-1 ${isOwn ? 'flex-row-reverse' : ''}`}>
                    <div
                      onClick={() => openPopup(msg)}
                      className="relative shrink-0"
                      style={{ cursor: (msg.userId === ADMIN_ID && !isAdmin) ? 'default' : 'pointer' }}
                    >
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black"
                        style={{ backgroundColor: `${msgColor}33`, border: `1.5px solid ${msgColor}`, color: msgColor }}>
                        {msg.isBot ? '🤖' : msg.username?.[0]?.toUpperCase()}
                      </div>
                      {(msg.currentStreak ?? 0) >= 1 && (
                        <span className="absolute -top-1 -left-1 flex items-center justify-center min-w-[14px] h-[14px] rounded-full font-black leading-none px-0.5"
                          style={{ background: 'rgba(0,0,0,0.9)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.5)', fontSize: 7 }}>
                          🔥{msg.currentStreak}
                        </span>
                      )}
                    </div>
                    <span
                      onClick={() => openPopup(msg)}
                      className={`text-xs font-semibold ${(msg.userId === ADMIN_ID && !isAdmin) ? '' : 'hover:underline'}`}
                      style={{ color: msgColor, cursor: (msg.userId === ADMIN_ID && !isAdmin) ? 'default' : 'pointer' }}>
                      {msg.username}
                      {msg.isBot && (
                        <span className="ml-1 text-[9px] px-1 py-0.5 rounded font-bold"
                          style={{ background: `${BOT_COLOR}18`, color: BOT_COLOR }}>BOT</span>
                      )}
                    </span>
                    {isAdmin && !msg.isBot && (
                      <button onClick={() => deleteMessage(msg.id)}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-danger/60 hover:text-danger transition-all ml-1" title="Delete">✕</button>
                    )}
                  </div>
                  <div
                    onClick={() => openPopup(msg)}
                    className={`px-3 py-2 rounded-2xl max-w-[85%] break-words text-xs leading-relaxed transition-opacity
                      ${(msg.userId === ADMIN_ID && !isAdmin) ? '' : 'cursor-pointer hover:opacity-80'}
                      ${isOwn ? 'text-white' : `bg-surfaceLight text-white ${isMentioned ? 'border border-warning/60 bg-warning/10' : ''}`}`}
                    style={isOwn ? { backgroundColor: `${msgColor}33`, border: `1px solid ${msgColor}44` } : {}}
                  >
                    {renderMessage(msg.message, profile?.username)}
                  </div>
                  <span className="text-[10px] text-muted/40 mt-0.5 px-1">{formatTime(msg.timestamp)}</span>
                </div>
              );
            })}
            <div ref={mobileBottomRef} />
          </div>

          {/* Input */}
          <div className="p-3 border-t border-border shrink-0 pb-safe" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
            {authenticated ? (
              <div className="flex gap-2">
                <input ref={mobileInputRef} value={input} onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKey} maxLength={150}
                  placeholder="Message... use @ to mention"
                  className="flex-1 bg-surfaceLight border border-border rounded-xl px-3 py-2 text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  style={{ fontSize: '16px' }}
                />
                <button onClick={send} disabled={!input.trim()}
                  className="px-3 py-2 bg-primary rounded-xl text-white text-sm font-bold hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-glow">
                  ↑
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted text-center py-1">Sign in to chat</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

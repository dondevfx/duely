const { v4: uuidv4 } = require('uuid');
const { deleteRoom, getRoomBySocket } = require('../services/matchmaking');
const {
  createDirectBlockBlastRoom,
  addToBlockBlastQueue, removeFromBlockBlastQueue,
  getBlockBlastRoom, deleteBlockBlastRoom, getBlockBlastRoomBySocket,
  startBlockBlastCountdown, handleBlockBlastComplete, handleBlockBlastStuck,
  trackBlockBlastScorePing, checkBlockBlastOvertake,
} = require('../services/blockBlastEngine');
const {
  createDirectTowerRoom,
  addToTowerQueue, removeFromTowerQueue,
  getTowerRoom, deleteTowerRoom, getTowerRoomBySocket,
  startTowerCountdown, handleTowerComplete,
  trackTowerScorePing, checkTowerOvertake,
} = require('../services/towerEngine');
const {
  addToCarDashQueue, removeFromCarDashQueue,
  createDirectCarDashRoom,
  getCarDashRoom, deleteCarDashRoom, getCarDashRoomBySocket,
  startCarDashCountdown, trackCarDashProgress, handleCarDashCrash,
  forceResolveCarDash, checkOvertake,
} = require('../services/carDashEngine');
const {
  addToWordleQueue, removeFromWordleQueue,
  createDirectWordleRoom,
  getWordleRoom, deleteWordleRoom, getWordleRoomBySocket,
  startWordleGame, handleWordleGuess,
  scheduleBotWordleMove, getRandomWordleWord,
  evaluateGuess, MAX_GUESSES, WORD_LENGTH,
} = require('../services/wordleEngine');
const { isValidWord } = require('../services/wordValidator');
const {
  addToCoinFlipQueue, removeFromCoinFlipQueue,
  createDirectCoinFlipRoom,
  getCoinFlipRoom, deleteCoinFlipRoom, getCoinFlipRoomBySocket,
  resolveCoinFlip,
} = require('../services/coinFlipEngine');
const {
  addToBlackjackQueue, removeFromBlackjackQueue,
  getBlackjackRoom, deleteBlackjackRoom, getBlackjackRoomBySocket,
  createDirectBlackjackRoom,
  startBlackjackGame,
  handleBlackjackHit, handleBlackjackStand, handleBlackjackSplit,
} = require('../services/blackjackEngine');
const { checkSocketClickRate, cleanupSocket } = require('../middleware/rateLimit');
const { createBotPlayer } = require('../services/botService');

// The same game is known by two names in this codebase: a queue/bet-count key
// ('block-blast', 'car-dash') and a room id ('blockBlast', 'carDash'). Both are
// load-bearing — the counts map is keyed one way and the room switch the other —
// so a component holding one and sending the other is an easy mistake to make.
// It was: Block Burst's lobby passed its bet-count key into the friend invite,
// and every Block Burst invite came back "Invalid game."
//
// Normalising here means no client spelling can break an invite, and there is
// exactly one place to look when a seventh game is added.
const GAME_ALIASES = {
  'block-blast': 'blockBlast',
  'car-dash':    'carDash',
  'word-vs':     'scrabble',
  'wordle':      'scrabble',
  'coinflip':    'coin-flip',
};
const VALID_GAME_TYPES = ['blackjack', 'coin-flip', 'scrabble', 'blockBlast', 'carDash', 'tower'];
const canonicalGameType = (g) => GAME_ALIASES[g] || g;

const { isDemo: isDemoAccount, randomFunnyName } = require('../services/demoAccounts');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const {
  settleMatch, settleCoinFlip, settleMatchDiamonds, forfeitSettleDiamonds, forfeitSettleCoins,
  deductCoins, deductDiamonds, deductMatchFees, creditDiamonds, creditCoins,
  settleBotMatch,
} = require('../services/walletService');
const { lockUser, unlockUser, isLocked } = require('../services/lockService');
const { updateElo: _updateElo } = require('../services/eloService');
const { verifyToken } = require('../middleware/auth');

module.exports = function registerSocketHandlers(io, supabase) {
  // ── Shared private-room registry (all game types) ─────────────
  const pendingPrivateRooms = new Map(); // code → { gameType, p1, createdAt }
  const wordleSoloSessions = new Map(); // sessionId → { userId, word, fee, currency }
const userQueues = new Set(); // userId → currently in a queue (prevents dual-tab double-join)
  // Returns true if user is in a queue OR in an active match (lock held until settlement)
  const inMatchOrQueue = (uid) => userQueues.has(uid) || isLocked(uid);

  // Every room type, in one place. Used both for settling on leave and for the
  // guard below.
  const ROOM_LOOKUPS = () => ([
    [getRoomBySocket,           deleteRoom,           'reaction'],
    [getBlockBlastRoomBySocket, deleteBlockBlastRoom, 'blockBlast'],
    [getWordleRoomBySocket,     deleteWordleRoom,     'scrabble'],
    [getCoinFlipRoomBySocket,   deleteCoinFlipRoom,   'coin_flip'],
    [getBlackjackRoomBySocket,  deleteBlackjackRoom,  'blackjack'],
    [getCarDashRoomBySocket,    deleteCarDashRoom,    'carDash'],
    [getTowerRoomBySocket,      deleteTowerRoom,      'tower'],
  ]);

  // Is this socket already sitting in a live room of ANY game?
  //
  // inMatchOrQueue() alone does not cover this. It is built on userQueues, which
  // is cleared the moment a match starts, and on isLocked(), which is only set
  // for PAID entries — so a player already mid-match could open a second game,
  // and a free game was never covered at all. One socket in two rooms means the
  // per-socket room lookups return only one of them, so a leave settles one and
  // leaves the other to the stall watchdog.
  //
  // Balances were never at risk: entry fees are taken by an atomic DB call that
  // throws on insufficient funds, so a second game could not be paid for twice.
  // This is about room and settlement integrity.
  function _inLiveRoom(socketId) {
    for (const [getFn] of ROOM_LOOKUPS()) {
      const found = getFn(socketId);
      if (!found || !found.room) continue;
      // Engines do not agree on how a finished room is marked: most set
      // state === 'finished', Word VS instead flips a `settled` flag and has no
      // state field at all. Checking only one of them treats a finished Word VS
      // room as live and locks the player out of starting anything else until
      // the room is swept.
      const done = found.room.state === 'finished' || found.room.settled === true;
      if (!done) return true;
    }
    return false;
  }
  const chatBanned = new Set(); // userId → banned from chat
  const lastChatAt = new Map(); // userId → last chat message timestamp (flood control)
  const CHAT_MIN_INTERVAL_MS = 750;

  // ── Friend game invites ───────────────────────────────────────────────
  const pendingInvites = new Map();     // inviteId → invite record
  const INVITE_TTL_MS      = 45_000;    // popup lifetime once actually shown
  const INVITE_MAX_HOLD_MS = 5 * 60_000; // max time to hold a deferred (in-game) invite

  const _socketsForUser = (userId) => {
    const out = [];
    for (const [, s] of io.sockets.sockets) if (s._authenticatedUserId === userId) out.push(s);
    return out;
  };
  const _isUserOnline = (userId) => _socketsForUser(userId).length > 0;
  // A room that has already settled (player is sitting on the victory/loss
  // screen) does NOT count as being in a game — otherwise invites stay deferred
  // and never pop up until they navigate away.
  const _activeRoomFor = (sid) => {
    const found = getRoomBySocket(sid) || getBlockBlastRoomBySocket(sid) || getWordleRoomBySocket(sid) ||
                  getCoinFlipRoomBySocket(sid) || getBlackjackRoomBySocket(sid) || getCarDashRoomBySocket(sid);
    if (!found) return null;
    const room = found.room || found;
    if (!room) return null;
    if (room.state === 'finished' || room.settled) return null;
    return found;
  };
  const _isUserInGame = (userId) => _socketsForUser(userId).some(s => !!_activeRoomFor(s.id));

  // Cancel any private room this socket is hosting, plus the invite tied to it.
  // Called whenever the host leaves the page/disconnects — without this the room
  // stays open and the invitee can still drag the departed host into a match.
  function _cancelHostedRooms(socketId, userId) {
    for (const [code, room] of [...pendingPrivateRooms]) {
      if (room.p1.socketId !== socketId) continue;
      pendingPrivateRooms.delete(code);
      if ((room.p1.entryFee || 0) > 0) unlockUser(room.p1.userId || userId);
      for (const [iid, inv] of [...pendingInvites]) {
        if (inv.code !== code) continue;
        _cleanupInvite(iid);
        for (const s of _socketsForUser(inv.toUserId)) s.emit('invite_cancelled', { inviteId: iid });
      }
    }
  }

  function _cleanupInvite(inviteId) {
    const inv = pendingInvites.get(inviteId);
    if (!inv) return null;
    if (inv.timer) { clearTimeout(inv.timer); inv.timer = null; }
    pendingInvites.delete(inviteId);
    return inv;
  }
  // Send the invite popup to the invitee and start its visible-lifetime timer.
  function _deliverInvite(inviteId) {
    const inv = pendingInvites.get(inviteId);
    if (!inv) return;
    // Nobody to deliver to (they went offline since the invite was created) —
    // tear the room down so it can't be joined later and the host isn't left
    // waiting on a match that will never come.
    if (!_isUserOnline(inv.toUserId)) { _expireInvite(inviteId, 'unavailable'); return; }
    inv.deferred = false;
    if (inv.timer) clearTimeout(inv.timer);
    for (const s of _socketsForUser(inv.toUserId)) {
      s.emit('game_invite', {
        inviteId: inv.inviteId, code: inv.code, fromUsername: inv.fromUsername,
        gameType: inv.gameType, entryFee: inv.entryFee, currency: inv.currency,
      });
    }
    inv.timer = setTimeout(() => _expireInvite(inviteId, 'expired'), INVITE_TTL_MS);
  }
  // Free the room + unlock the inviter, pull the popup, notify both sides.
  function _expireInvite(inviteId, reason) {
    const inv = _cleanupInvite(inviteId);
    if (!inv) return;
    const room = pendingPrivateRooms.get(inv.code);
    if (room && room.p1.userId === inv.fromUserId) {
      pendingPrivateRooms.delete(inv.code);
      if (inv.entryFee > 0) unlockUser(inv.fromUserId);
    }
    for (const s of _socketsForUser(inv.toUserId)) s.emit('invite_cancelled', { inviteId });
    for (const s of _socketsForUser(inv.fromUserId)) s.emit('invite_expired', { inviteId, reason });
  }

  // ── Short disconnect buffer to survive mobile browser backgrounding ───
  // Delays forfeit by DISCONNECT_GRACE_MS so the socket has time to
  // auto-reconnect. If reconnected, we silently update the player's socketId
  // in the room so game events keep flowing — no rejoin UI, no extra events.
  const DISCONNECT_GRACE_MS = 8_000;
  const disconnectTimers = new Map(); // userId → { timer, jobs: [{ forfeitFn, updateSocketFn, cancelled }] }
  const resumeCounts = new Map();     // userId → reconnect claims used in the current match

  // ── Live player count tracking ────────────────────────────────
  // socketGameMap is the single source of truth.
  // playerCounts is NEVER mutated directly — it is always recomputed from socketGameMap.
  // This means stale counts are impossible: every emit reflects real connected sockets.
  const socketGameMap = {}; // socketId → gameType

  // ── Per-bet-size player count tracking ───────────────────────
  const betCounts = {};    // { 'tetris:50:coins': 2, 'chess:100:diamonds': 1, ... }
  const socketBetMap = {}; // socketId → 'gameType:entryFee:currency'

  function _buildPlayerCounts() {
    const counts = {};
    for (const gameType of Object.values(socketGameMap)) {
      counts[gameType] = (counts[gameType] || 0) + 1;
    }
    return counts;
  }

  function incrementCount(gameType, socketId, entryFee, currency) {
    if (socketId) {
      // Remove stale bet tracking if this socket was already in a game
      const prevBetKey = socketBetMap[socketId];
      if (prevBetKey) {
        betCounts[prevBetKey] = Math.max(0, (betCounts[prevBetKey] || 0) - 1);
        delete socketBetMap[socketId];
      }
      socketGameMap[socketId] = gameType;
      if (entryFee !== undefined && currency !== undefined) {
        const betKey = `${gameType}:${entryFee}:${currency}`;
        betCounts[betKey] = (betCounts[betKey] || 0) + 1;
        socketBetMap[socketId] = betKey;
      }
    }
    emitCounts();
  }

  function decrementCount(gameType, socketId) {
    if (socketId) {
      delete socketGameMap[socketId];
      const betKey = socketBetMap[socketId];
      if (betKey) {
        betCounts[betKey] = Math.max(0, (betCounts[betKey] || 0) - 1);
        delete socketBetMap[socketId];
      }
    }
    emitCounts();
  }

  function emitCounts() {
    io.emit('player_counts', { counts: _buildPlayerCounts() });
    io.emit('bet_counts',    { counts: { ...betCounts } });
  }

  // Listen for game_ended events from any engine and decrement player counts immediately.
  // This drops the count as soon as a result is settled, not just on socket disconnect.
  const gameEvents = require('../services/gameEvents');
  gameEvents.on('game_ended', ({ socketIds }) => {
    for (const sid of socketIds) {
      if (socketGameMap[sid]) {
        decrementCount(socketGameMap[sid], sid);
      }
    }
    // A player just left a match — deliver any invites that were held while they
    // were in a game (they only pop up once you're out of a game).
    const freedUsers = new Set();
    for (const sid of socketIds || []) {
      const s = io.sockets.sockets.get(sid);
      if (s?._authenticatedUserId) freedUsers.add(s._authenticatedUserId);
    }
    for (const uid of freedUsers) {
      if (_isUserInGame(uid)) continue; // still in another match
      for (const [iid, inv] of pendingInvites) {
        if (inv.toUserId === uid && inv.deferred) _deliverInvite(iid);
      }
    }
  });

  // Deposit credited by a background service (swapPoller / blockchainMonitor):
  // notify the depositing user's live sockets so the UI can toast + refresh.
  gameEvents.on('deposit_credited', ({ userId, amount, currency }) => {
    for (const [, sock] of io.sockets.sockets) {
      if (sock._authenticatedUserId === userId) {
        sock.emit('deposit_credited', { amount, currency });
      }
    }
  });

  // Any balance movement (match settle, entry fee, tip, deposit, withdrawal,
  // refund) → tell that user's client so the displayed balance updates live.
  gameEvents.on('balance_changed', ({ userId }) => {
    for (const [, sock] of io.sockets.sockets) {
      if (sock._authenticatedUserId === userId) sock.emit('balance_changed');
    }
  });

  function _genPrivateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  io.on('connection', (socket) => {
    let authenticatedUser = null;

    // Send current player counts snapshot to new connection
    socket.emit('player_counts', { counts: _buildPlayerCounts() });
    socket.emit('bet_counts', { counts: { ...betCounts } });
    require('../services/tickerService').sendSeed(socket);
    socket.on('request_ticker_seed', () => require('../services/tickerService').sendSeed(socket));

    // ── Liveness probe ────────────────────────────────────────────────
    //
    // Answers an ack and nothing else. It exists for the phone-unlock case: iOS
    // freezes a backgrounded tab's socket without closing it, so on return the
    // client still reports `connected` while the server has long since timed the
    // session out. The client cannot tell the difference without asking, and
    // waiting for the ping timeout to notice is the 5-10 seconds of
    // "Connecting…" a player sees after switching back to Safari.
    //
    // Deliberately requires no auth: the answer is the same either way, and
    // gating it would mean a socket that lost its session could not use it.
    socket.on('ping_check', (ack) => {
      if (typeof ack === 'function') ack({ ok: true });
    });

    // ── Auth ──────────────────────────────────────────────────────────
    socket.on('authenticate', async ({ token }) => {
      try {
        const user = await verifyToken(token);
        if (!user) { socket.emit('error', { message: 'Authentication failed' }); return; }
        const { data: profile } = await supabase
          .from('profiles').select('id,username,elo,c_coins,profile_color,current_streak').eq('id', user.id).single();
        if (!profile) { socket.emit('error', { message: 'Profile not found' }); return; }
        authenticatedUser = { userId: user.id, ...profile, isDemo: isDemoAccount(user.id) };
        socket._authenticatedUserId = user.id;
        socket.emit('authenticated', { userId: user.id, username: profile.username });

        // NOTE: reconnecting does NOT by itself cancel a pending forfeit.
        //
        // It used to. That silently rebound any active room to the new socket,
        // on the assumption that a reconnect means "I am resuming the match".
        // A page refresh breaks that assumption: the client comes back,
        // authenticates, and boots straight to the lobby with no game state —
        // but the server had already handed it the old room. The player was
        // then tied to a match they were not playing, which ended their NEXT
        // game early and denied the opponent the forfeit they were owed.
        //
        // A client that genuinely is mid-match now has to say so, by emitting
        // 'resume_match'. Silence means gone, and the forfeit runs.
      } catch { socket.emit('error', { message: 'Authentication error' }); }
    });

    // ── Explicit match re-claim after a dropped connection ───────────
    // Only a client that is still actually rendering an active game sends
    // this. It is what separates "my connection blipped" from "I left".
    // How many times a single player may drop and re-claim before the grace
    // period stops being offered. Without a cap, disconnecting just before the
    // 8s forfeit and reconnecting resets the clock, so it can be repeated
    // forever to dodge a loss. The per-game timers (Rush Hour's stall watchdog,
    // Blackjack's 20s turn timer, Word VS's fail timer) already stop the
    // OPPONENT being frozen — they run server-side regardless of anyone's
    // connection — so this is about the leaver, not the stayer.
    const MAX_RESUMES = 3;

    socket.on('resume_match', () => {
      if (!authenticatedUser) return;
      const pending = disconnectTimers.get(authenticatedUser.userId);
      if (!pending) return;

      const used = (resumeCounts.get(authenticatedUser.userId) || 0) + 1;
      resumeCounts.set(authenticatedUser.userId, used);
      if (used > MAX_RESUMES) {
        // Out of grace. Let the pending forfeit run rather than cancelling it.
        socket.emit('resume_denied', { reason: 'Too many reconnects this match.' });
        return;
      }
      clearTimeout(pending.timer);
      disconnectTimers.delete(authenticatedUser.userId);
      for (const job of pending.jobs) {
        if (!job.cancelled) job.updateSocketFn(socket);
      }
      socket.emit('match_resumed');
    });

    // ── Global lobby chat ─────────────────────────────────────────────
    socket.on('chat_message', ({ message }) => {
      if (!authenticatedUser) return;
      if (chatBanned.has(authenticatedUser.userId)) {
        socket.emit('chat_banned', { reason: 'You have been banned from chat.' });
        return;
      }
      const trimmed = (message || '').toString().trim().slice(0, 150);
      if (!trimmed) return;
      // Flood control — drop messages sent faster than one per CHAT_MIN_INTERVAL_MS.
      const nowMs = Date.now();
      if (nowMs - (lastChatAt.get(authenticatedUser.userId) || 0) < CHAT_MIN_INTERVAL_MS) return;
      lastChatAt.set(authenticatedUser.userId, nowMs);
      const mentions = [];
      const mentionRe = /@(\w+)/g;
      let mMatch;
      while ((mMatch = mentionRe.exec(trimmed)) !== null) mentions.push(mMatch[1].toLowerCase());
      const messageId = `${authenticatedUser.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      io.emit('chat_message', {
        messageId,
        userId:   authenticatedUser.userId,
        username: authenticatedUser.username,
        color:    authenticatedUser.profile_color || '#1E90FF',
        message:  trimmed,
        mentions,
        timestamp: Date.now(),
        currentStreak: authenticatedUser.current_streak || 0,
      });
    });

    // ── Profile color sync ────────────────────────────────────────────
    socket.on('update_profile_color', ({ color }) => {
      if (!authenticatedUser) return;
      if (typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color)) {
        authenticatedUser.profile_color = color;
      }
    });

    // ── Admin chat moderation ─────────────────────────────────────────
    socket.on('admin_delete_message', ({ messageId }) => {
      if (!authenticatedUser) return;
      if (authenticatedUser.userId !== process.env.ADMIN_USER_ID) return;
      io.emit('message_deleted', { messageId });
    });

    socket.on('admin_chat_ban', ({ userId, username }) => {
      if (!authenticatedUser) return;
      if (authenticatedUser.userId !== process.env.ADMIN_USER_ID) return;
      chatBanned.add(userId);
      // Notify the banned socket
      for (const [, s] of io.sockets.sockets) {
        if (s._authenticatedUserId === userId) {
          s.emit('chat_banned', { reason: 'You have been banned from chat by an admin.' });
        }
      }
      io.emit('chat_system', { message: `${username} was banned from chat.` });
    });

    socket.on('admin_chat_unban', ({ userId, username }) => {
      if (!authenticatedUser) return;
      if (authenticatedUser.userId !== process.env.ADMIN_USER_ID) return;
      chatBanned.delete(userId);
      io.emit('chat_system', { message: `${username} was unbanned from chat.` });
    });

    // ── Allowed entry fees for active games ──────────────────────────────────
    const VALID_COIN_FEES    = new Set([0, 1, 5, 10, 25, 50, 100]);
    const VALID_DIAMOND_FEES = new Set([0, 50, 100, 250, 500, 1000, 5000, 50000]);
    function isValidFee(fee, cur) {
      return cur === 'diamonds' ? VALID_DIAMOND_FEES.has(Number(fee)) : VALID_COIN_FEES.has(Number(fee));
    }

    // ════════════════════════════════════════════════════════════════
    //  BLOCK BLAST
    // ════════════════════════════════════════════════════════════════
    socket.on('join_block_blast_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!isValidFee(entryFee, currency)) return socket.emit('error', { message: 'Invalid entry fee' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      socket._startingGame = 'block_blast';
      try {
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      // Player navigated away while we were awaiting the DB query — bail out cleanly
      if (socket._pendingForfeitGame === 'block_blast') {
        socket._pendingForfeitGame = null;
        if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
        return;
      }
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
      userQueues.add(authenticatedUser.userId);
      incrementCount('block-blast', socket.id, entryFee, currency);
      const match = addToBlockBlastQueue(player);
      if (match) {
        const { roomId, p1, p2 } = match;
        userQueues.delete(p1.userId); userQueues.delete(p2.userId);
        // Deduct fees from both players BEFORE notifying clients — no exploit window
        if (entryFee > 0) {
          try {
            await deductMatchFees(supabase, p1.userId, p2.userId, entryFee, currency);
            const room = getBlockBlastRoom(roomId);
            if (room) room.feesDeducted = true;
          } catch (e) {
            console.error('[block-blast] fee deduction failed:', e.message);
            deleteBlockBlastRoom(roomId);
            unlockUser(p1.userId); unlockUser(p2.userId);
            decrementCount('block-blast', p1.socketId);
            decrementCount('block-blast', p2.socketId);
            io.emit('queue_entry_removed', { id: p1.socketId });
            io.emit('queue_entry_removed', { id: p2.socketId });
            const s1e = io.sockets.sockets.get(p1.socketId);
            const s2e = io.sockets.sockets.get(p2.socketId);
            if (s1e) s1e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            if (s2e) s2e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            return;
          }
        } else {
          const room = getBlockBlastRoom(roomId);
          if (room) room.feesDeducted = true;
        }
        const s1 = io.sockets.sockets.get(p1.socketId);
        const s2 = io.sockets.sockets.get(p2.socketId);
        const bbP1Name = p1.isDemo ? randomFunnyName() : p1.username;
        const bbP2Name = p2.isDemo ? randomFunnyName() : p2.username;
        if (s1) { s1.join(roomId); s1.emit('block_blast_match_found', { roomId, opponent: { userId: p2.userId, username: bbP2Name, elo: p2.elo }, entryFee: p1.entryFee, currency: p1.currency }); }
        if (s2) { s2.join(roomId); s2.emit('block_blast_match_found', { roomId, opponent: { userId: p1.userId, username: bbP1Name, elo: p1.elo }, entryFee: p2.entryFee, currency: p2.currency }); }
        io.emit('queue_entry_removed', { id: p1.socketId });
        io.emit('queue_entry_removed', { id: p2.socketId });
        if (!p1.isBot && !p2.isBot) {
          io.emit('active_game_started', {
            id: roomId,
            gameType: 'block-blast',
            player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
            player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
            entryFee: p1.entryFee || 0,
            currency: p1.currency || 'coins',
            score1: 0,
            score2: 0,
            startedAt: Date.now(),
          });
        }
        startBlockBlastCountdown(io, supabase, roomId);
      } else {
        socket.emit('block_blast_queue_joined');
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'block-blast',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
        // Demo accounts: no other demo within 3s → bot match (demo always wins,
        // bot score trails a little). Funny opponent name.
        if (authenticatedUser.isDemo) {
          setTimeout(async () => {
            if (!removeFromBlockBlastQueue(socket.id)) return; // already matched or left
            userQueues.delete(authenticatedUser.userId);
            unlockUser(authenticatedUser.userId);
            io.emit('queue_entry_removed', { id: socket.id });
            try {
              if (entryFee > 0) {
                if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
                else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
              }
            } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
            const bot = createBotPlayer(entryFee, 'block_blast');
            bot.entryFee = entryFee;
            bot.username = randomFunnyName();
            const { roomId } = createDirectBlockBlastRoom(player, bot);
            if (entryFee > 0) { const r = getBlockBlastRoom(roomId); if (r) r.feesDeducted = true; }
            socket.join(roomId);
            socket.emit('block_blast_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, currency, vsBot: true });
            startBlockBlastCountdown(io, supabase, roomId);
          }, 3000);
        }
      }
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('leave_block_blast_queue', () => {
      removeFromBlockBlastQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('block-blast', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
    });

    socket.on('play_block_blast_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      socket._startingGame = 'block_blast';
      try {
        if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
        const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (entryFee > 0) {
          try {
            if (currency === 'diamonds') {
              await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
            } else {
              await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
            }
          } catch (e) {
            return socket.emit('error', { message: e.message || 'Insufficient balance' });
          }
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        const bot = createBotPlayer(entryFee, 'block_blast');
        bot.entryFee = entryFee;
        const { roomId } = createDirectBlockBlastRoom(player, bot);
        if (entryFee > 0) { const r = getBlockBlastRoom(roomId); if (r) r.feesDeducted = true; }
        socket.join(roomId);
        if (socket._pendingForfeitGame === 'block_blast') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          await _handleForfeit(io, supabase, { roomId, room: getBlockBlastRoom(roomId) }, socket.id, deleteBlockBlastRoom, 'blockBlast');
          return;
        }
        incrementCount('block-blast', socket.id, entryFee, currency);
        socket.emit('block_blast_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
        startBlockBlastCountdown(io, supabase, roomId);
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('block_blast_complete', ({ roomId, score = 0 }) => {
      if (!authenticatedUser) return;
      handleBlockBlastComplete(io, supabase, roomId, socket.id, score);
    });

    socket.on('block_blast_stuck', ({ roomId, score = 0 }) => {
      if (!authenticatedUser) return;
      handleBlockBlastStuck(io, supabase, roomId, socket.id, score);
    });

    socket.on('block_blast_score_ping', ({ roomId, score }) => {
      if (!authenticatedUser) return;
      const room = getBlockBlastRoom(roomId);
      if (!room || room.state !== 'active') return;
      // Validate and track — returns the clamped authoritative score
      const verified = trackBlockBlastScorePing(roomId, socket.id, score || 0);
      if (verified === null) return;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('block_blast_opponent_score', { score: verified });
      // If this ping just passed the score they were chasing, end it now rather
      // than making them play out the rest of the window.
      checkBlockBlastOvertake(io, supabase, roomId);
      if (!room.isSolo) {
        const [rp1, rp2] = room.players;
        const s1 = socket.id === rp1.socketId ? verified : (room.pingScores[rp1.socketId] || 0);
        const s2 = socket.id === rp2.socketId ? verified : (room.pingScores[rp2.socketId] || 0);
        io.emit('active_game_score', { id: roomId, score1: s1, score2: s2 });
      }
    });

    socket.on('block_blast_rematch_request', ({ roomId }) => {
      const room = getBlockBlastRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('block_blast_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown'; room.startTime = null; room.rematches = {}; room.scores = {};
        startBlockBlastCountdown(io, supabase, roomId);
      }
    });

    socket.on('join_tower_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!isValidFee(entryFee, currency)) return socket.emit('error', { message: 'Invalid entry fee' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      socket._startingGame = 'tower';
      try {
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      // Player navigated away while we were awaiting the DB query — bail out cleanly
      if (socket._pendingForfeitGame === 'tower') {
        socket._pendingForfeitGame = null;
        if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
        return;
      }
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
      userQueues.add(authenticatedUser.userId);
      incrementCount('tower', socket.id, entryFee, currency);
      const match = addToTowerQueue(player);
      if (match) {
        const { roomId, p1, p2 } = match;
        userQueues.delete(p1.userId); userQueues.delete(p2.userId);
        // Deduct fees from both players BEFORE notifying clients — no exploit window
        if (entryFee > 0) {
          try {
            await deductMatchFees(supabase, p1.userId, p2.userId, entryFee, currency);
            const room = getTowerRoom(roomId);
            if (room) room.feesDeducted = true;
          } catch (e) {
            console.error('[block-blast] fee deduction failed:', e.message);
            deleteTowerRoom(roomId);
            unlockUser(p1.userId); unlockUser(p2.userId);
            decrementCount('tower', p1.socketId);
            decrementCount('tower', p2.socketId);
            io.emit('queue_entry_removed', { id: p1.socketId });
            io.emit('queue_entry_removed', { id: p2.socketId });
            const s1e = io.sockets.sockets.get(p1.socketId);
            const s2e = io.sockets.sockets.get(p2.socketId);
            if (s1e) s1e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            if (s2e) s2e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            return;
          }
        } else {
          const room = getTowerRoom(roomId);
          if (room) room.feesDeducted = true;
        }
        const s1 = io.sockets.sockets.get(p1.socketId);
        const s2 = io.sockets.sockets.get(p2.socketId);
        const twP1Name = p1.isDemo ? randomFunnyName() : p1.username;
        const twP2Name = p2.isDemo ? randomFunnyName() : p2.username;
        if (s1) { s1.join(roomId); s1.emit('tower_match_found', { roomId, opponent: { userId: p2.userId, username: twP2Name, elo: p2.elo }, entryFee: p1.entryFee, currency: p1.currency }); }
        if (s2) { s2.join(roomId); s2.emit('tower_match_found', { roomId, opponent: { userId: p1.userId, username: twP1Name, elo: p1.elo }, entryFee: p2.entryFee, currency: p2.currency }); }
        io.emit('queue_entry_removed', { id: p1.socketId });
        io.emit('queue_entry_removed', { id: p2.socketId });
        if (!p1.isBot && !p2.isBot) {
          io.emit('active_game_started', {
            id: roomId,
            gameType: 'tower',
            player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
            player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
            entryFee: p1.entryFee || 0,
            currency: p1.currency || 'coins',
            score1: 0,
            score2: 0,
            startedAt: Date.now(),
          });
        }
        startTowerCountdown(io, supabase, roomId);
      } else {
        socket.emit('tower_queue_joined');
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'tower',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
        // Demo accounts: no other demo within 3s → bot match (demo always wins,
        // bot score trails a little). Funny opponent name.
        if (authenticatedUser.isDemo) {
          setTimeout(async () => {
            if (!removeFromTowerQueue(socket.id)) return; // already matched or left
            userQueues.delete(authenticatedUser.userId);
            unlockUser(authenticatedUser.userId);
            io.emit('queue_entry_removed', { id: socket.id });
            try {
              if (entryFee > 0) {
                if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
                else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
              }
            } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
            const bot = createBotPlayer(entryFee, 'tower');
            bot.entryFee = entryFee;
            bot.username = randomFunnyName();
            const { roomId } = createDirectTowerRoom(player, bot);
            if (entryFee > 0) { const r = getTowerRoom(roomId); if (r) r.feesDeducted = true; }
            socket.join(roomId);
            socket.emit('tower_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, currency, vsBot: true });
            startTowerCountdown(io, supabase, roomId);
          }, 3000);
        }
      }
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('leave_tower_queue', () => {
      removeFromTowerQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('tower', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
    });

    socket.on('play_tower_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      socket._startingGame = 'tower';
      try {
        if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
        const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (entryFee > 0) {
          try {
            if (currency === 'diamonds') {
              await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
            } else {
              await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
            }
          } catch (e) {
            return socket.emit('error', { message: e.message || 'Insufficient balance' });
          }
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        const bot = createBotPlayer(entryFee, 'tower');
        bot.entryFee = entryFee;
        const { roomId } = createDirectTowerRoom(player, bot);
        if (entryFee > 0) { const r = getTowerRoom(roomId); if (r) r.feesDeducted = true; }
        socket.join(roomId);
        if (socket._pendingForfeitGame === 'tower') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          await _handleForfeit(io, supabase, { roomId, room: getTowerRoom(roomId) }, socket.id, deleteTowerRoom, 'tower');
          return;
        }
        incrementCount('tower', socket.id, entryFee, currency);
        socket.emit('tower_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
        startTowerCountdown(io, supabase, roomId);
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('tower_complete', ({ roomId, score = 0, taps = null }) => {
      if (!authenticatedUser) return;
      // taps is advisory only — it feeds the metronomic-run check and never the
      // score, which comes from the server's own clamped tally.
      handleTowerComplete(io, supabase, roomId, socket.id, score, Array.isArray(taps) ? taps.slice(0, 4000) : null);
    });

    socket.on('tower_score_ping', ({ roomId, score }) => {
      if (!authenticatedUser) return;
      const room = getTowerRoom(roomId);
      if (!room || room.state !== 'active') return;
      // Validate and track — returns the clamped authoritative score
      const verified = trackTowerScorePing(roomId, socket.id, score || 0);
      if (verified === null) return;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('tower_opponent_score', { score: verified });
      // If this ping just passed the score they were chasing, end it now rather
      // than making them play out the rest of the window.
      checkTowerOvertake(io, supabase, roomId);
      if (!room.isSolo) {
        const [rp1, rp2] = room.players;
        const s1 = socket.id === rp1.socketId ? verified : (room.pingScores[rp1.socketId] || 0);
        const s2 = socket.id === rp2.socketId ? verified : (room.pingScores[rp2.socketId] || 0);
        io.emit('active_game_score', { id: roomId, score1: s1, score2: s2 });
      }
    });

    socket.on('tower_rematch_request', ({ roomId }) => {
      const room = getTowerRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('tower_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown'; room.startTime = null; room.rematches = {}; room.scores = {};
        startTowerCountdown(io, supabase, roomId);
      }
    });


    // ════════════════════════════════════════════════════════════════
    //  HIGHWAY DASH (car dodge — longest survival wins)
    // ════════════════════════════════════════════════════════════════
    socket.on('join_car_dash_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!isValidFee(entryFee, currency)) return socket.emit('error', { message: 'Invalid entry fee' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      socket._startingGame = 'car_dash';
      try {
        const { data: profile } = await supabase
          .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
        if (socket._pendingForfeitGame === 'car_dash') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          return;
        }
        if (entryFee > 0) {
          if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
            return socket.emit('error', { message: 'Insufficient diamonds' });
          if (currency === 'coins' && profile.c_coins < entryFee)
            return socket.emit('error', { message: 'Insufficient C Coins' });
          lockUser(authenticatedUser.userId);
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        userQueues.add(authenticatedUser.userId);
        incrementCount('car-dash', socket.id, entryFee, currency);
        const match = addToCarDashQueue(player);
        if (match) {
          const { roomId, p1, p2 } = match;
          userQueues.delete(p1.userId); userQueues.delete(p2.userId);
          if (entryFee > 0) {
            try {
              await deductMatchFees(supabase, p1.userId, p2.userId, entryFee, currency);
              const room = getCarDashRoom(roomId);
              if (room) room.feesDeducted = true;
            } catch (e) {
              console.error('[car-dash] fee deduction failed:', e.message);
              deleteCarDashRoom(roomId);
              unlockUser(p1.userId); unlockUser(p2.userId);
              decrementCount('car-dash', p1.socketId);
              decrementCount('car-dash', p2.socketId);
              io.emit('queue_entry_removed', { id: p1.socketId });
              io.emit('queue_entry_removed', { id: p2.socketId });
              const s1e = io.sockets.sockets.get(p1.socketId);
              const s2e = io.sockets.sockets.get(p2.socketId);
              if (s1e) s1e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
              if (s2e) s2e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
              return;
            }
          } else {
            const room = getCarDashRoom(roomId);
            if (room) room.feesDeducted = true;
          }
          const s1 = io.sockets.sockets.get(p1.socketId);
          const s2 = io.sockets.sockets.get(p2.socketId);
          const n1 = p1.isDemo ? randomFunnyName() : p1.username;
          const n2 = p2.isDemo ? randomFunnyName() : p2.username;
          if (s1) { s1.join(roomId); s1.emit('car_dash_match_found', { roomId, opponent: { userId: p2.userId, username: n2, elo: p2.elo }, entryFee, currency }); }
          if (s2) { s2.join(roomId); s2.emit('car_dash_match_found', { roomId, opponent: { userId: p1.userId, username: n1, elo: p1.elo }, entryFee, currency }); }
          io.emit('queue_entry_removed', { id: p1.socketId });
          io.emit('queue_entry_removed', { id: p2.socketId });
          startCarDashCountdown(io, supabase, roomId);
        } else {
          socket.emit('car_dash_queue_joined');
          io.emit('queue_entry_added', {
            id: socket.id, gameType: 'car-dash', entryFee, currency,
            username: authenticatedUser.username || 'Player',
            elo: authenticatedUser.elo || 1000,
            profileColor: authenticatedUser.profile_color || '#1250B4',
            currentStreak: authenticatedUser.current_streak || 0,
          });
          // Demo accounts: no other demo within 3s → rigged bot match.
          if (authenticatedUser.isDemo) {
            setTimeout(async () => {
              if (!removeFromCarDashQueue(socket.id)) return;
              userQueues.delete(authenticatedUser.userId);
              unlockUser(authenticatedUser.userId);
              io.emit('queue_entry_removed', { id: socket.id });
              try {
                if (entryFee > 0) {
                  if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
                  else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
                }
              } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
              const bot = createBotPlayer(entryFee, 'car_dash');
              bot.entryFee = entryFee; bot.currency = currency;
              bot.username = randomFunnyName();
              const { roomId } = createDirectCarDashRoom(player, bot);
              const r = getCarDashRoom(roomId); if (r) r.feesDeducted = true;
              socket.join(roomId);
              socket.emit('car_dash_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, currency, vsBot: true });
              startCarDashCountdown(io, supabase, roomId);
            }, 3000);
          }
        }
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('leave_car_dash_queue', () => {
      removeFromCarDashQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('car-dash', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
      socket.emit('car_dash_queue_left');
    });

    socket.on('play_car_dash_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      socket._startingGame = 'car_dash';
      try {
        if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
        const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (entryFee > 0) {
          try {
            if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
            else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
          } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        const bot = createBotPlayer(entryFee, 'car_dash');
        bot.entryFee = entryFee; bot.currency = currency;
        const { roomId } = createDirectCarDashRoom(player, bot);
        const r = getCarDashRoom(roomId); if (r) r.feesDeducted = true;
        socket.join(roomId);
        if (socket._pendingForfeitGame === 'car_dash') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          await _handleForfeit(io, supabase, { roomId, room: getCarDashRoom(roomId) }, socket.id, deleteCarDashRoom, 'carDash');
          return;
        }
        incrementCount('car-dash', socket.id, entryFee, currency);
        socket.emit('car_dash_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, currency, vsBot: true });
        startCarDashCountdown(io, supabase, roomId);
      } finally {
        socket._startingGame = null;
      }
    });

    // Live progress for the opponent bar — server clamps to real elapsed time.
    socket.on('car_dash_progress', ({ roomId, ms, score }) => {
      if (!authenticatedUser) return;
      const room = getCarDashRoom(roomId);
      if (!room || room.state !== 'active') return;
      const verified = trackCarDashProgress(roomId, socket.id, ms, score);
      if (verified === null) return;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('car_dash_opponent_progress', { ms: verified });
      // If the opponent has already crashed and this player has just gone past
      // their score, the match is decided — end it rather than making them
      // drive on.
      checkOvertake(io, supabase, roomId);
    });

    // Client reports a crash; the SERVER decides how long they survived.
    socket.on('car_dash_crash', ({ roomId, score }) => {
      if (!authenticatedUser) return;
      handleCarDashCrash(io, supabase, roomId, socket.id, score);
    });

    // ════════════════════════════════════════════════════════════════
    //  PRIVATE ROOMS (generic — all game types)
    // ════════════════════════════════════════════════════════════════
    socket.on('create_private_room', async ({ gameType, entryFee = 0, currency = 'coins', side = 'heads' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      if (entryFee > 0) {
        const { data: pf } = await supabase.from('profiles').select('c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (currency === 'diamonds' && (pf.diamonds || 0) < entryFee) return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && pf.c_coins < entryFee) return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId); // prevent withdraw/tip while waiting
      }
      let code;
      do { code = _genPrivateCode(); } while (pendingPrivateRooms.has(code));
      const p1 = { socketId: socket.id, userId: authenticatedUser.userId, username: authenticatedUser.username, elo: authenticatedUser.elo, entryFee, currency, side };
      pendingPrivateRooms.set(code, { gameType: canonicalGameType(gameType), p1, createdAt: Date.now() });
      socket.emit('private_room_created', { code });
      // Auto-expire after 10 minutes and unlock
      setTimeout(() => {
        if (pendingPrivateRooms.get(code)?.p1.socketId === socket.id) {
          pendingPrivateRooms.delete(code);
          if (entryFee > 0) unlockUser(authenticatedUser.userId);
        }
      }, 600000);
    });

    socket.on('cancel_private_room', () => {
      for (const [code, room] of pendingPrivateRooms) {
        if (room.p1.socketId === socket.id) {
          pendingPrivateRooms.delete(code);
          if ((room.p1.entryFee || 0) > 0) unlockUser(authenticatedUser.userId);
          // Pull back any invite tied to this room so the friend's popup vanishes.
          for (const [iid, inv] of pendingInvites) {
            if (inv.code === code) {
              _cleanupInvite(iid);
              for (const s of _socketsForUser(inv.toUserId)) s.emit('invite_cancelled', { inviteId: iid });
            }
          }
          break;
        }
      }
    });

    // ── Friend game invite: create a private room and ping a friend directly ──
    socket.on('invite_friend', async ({ friendId, gameType, entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      const fromId = authenticatedUser.userId;
      const fail = (message) => socket.emit('invite_failed', { message });
      if (!friendId || friendId === fromId) return fail("You can't invite yourself.");
      // friendId is interpolated into a PostgREST .or() filter below, which is a
      // raw filter string rather than a bound parameter. Nothing exploitable
      // reaches it today — _isUserOnline compares against verified user ids, so
      // a non-UUID fails there first — but that is check ORDER protecting it,
      // not the filter itself. Anyone reordering these guards, or relaxing the
      // online requirement to allow offline invites, would open an
      // authorization bypass. Validate the shape here so it cannot regress.
      if (!UUID_RE.test(String(friendId))) return fail('Invalid friend.');
      gameType = canonicalGameType(gameType);
      if (!VALID_GAME_TYPES.includes(gameType)) return fail('Invalid game.');
      if (!isValidFee(entryFee, currency)) return fail('Invalid entry fee.');
      if (inMatchOrQueue(fromId)) return fail('Finish your current game first.');
      if (!_isUserOnline(friendId)) return fail('That friend is offline.');

      // Must be accepted friends.
      const { data: fr } = await supabase.from('friends').select('id')
        .or(`and(requester_id.eq.${fromId},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${fromId})`)
        .eq('status', 'accepted').maybeSingle();
      if (!fr) return fail('You can only invite friends.');

      const { data: fp } = await supabase.from('profiles').select('username,invites_enabled').eq('id', friendId).single();
      if (fp && fp.invites_enabled === false) return fail(`${fp.username || 'That player'} isn't accepting invites.`);

      // Dedupe — one pending invite per (inviter → friend).
      for (const inv of pendingInvites.values()) {
        if (inv.fromUserId === fromId && inv.toUserId === friendId) return fail('You already invited them.');
      }

      if (entryFee > 0) {
        const { data: me } = await supabase.from('profiles').select('c_coins,diamonds').eq('id', fromId).single();
        if (currency === 'diamonds' && (me?.diamonds || 0) < entryFee) return fail('Insufficient diamonds.');
        if (currency !== 'diamonds' && (me?.c_coins || 0) < entryFee) return fail('Insufficient C Coins.');
        lockUser(fromId);
      }

      let code; do { code = _genPrivateCode(); } while (pendingPrivateRooms.has(code));
      const p1 = { socketId: socket.id, userId: fromId, username: authenticatedUser.username, elo: authenticatedUser.elo, entryFee, currency, side: 'heads' };
      pendingPrivateRooms.set(code, { gameType: canonicalGameType(gameType), p1, createdAt: Date.now() });

      const inviteId = 'inv_' + uuidv4();
      pendingInvites.set(inviteId, {
        inviteId, code, fromUserId: fromId, fromUsername: authenticatedUser.username,
        toUserId: friendId, gameType, entryFee, currency, createdAt: Date.now(), timer: null, deferred: false,
      });

      // Inviter moves to the waiting screen.
      socket.emit('invite_sent', { inviteId, code, friendUsername: fp?.username || 'your friend', gameType, entryFee, currency });

      // Deliver now, or hold until the friend leaves their current game.
      if (_isUserInGame(friendId)) {
        const inv = pendingInvites.get(inviteId);
        inv.deferred = true;
        inv.timer = setTimeout(() => _expireInvite(inviteId, 'timeout'), INVITE_MAX_HOLD_MS);
      } else {
        _deliverInvite(inviteId);
      }
    });

    socket.on('invite_decline', ({ inviteId }) => {
      if (!authenticatedUser) return;
      const inv = pendingInvites.get(inviteId);
      if (!inv || inv.toUserId !== authenticatedUser.userId) return;
      _cleanupInvite(inviteId);
      const room = pendingPrivateRooms.get(inv.code);
      if (room && room.p1.userId === inv.fromUserId) {
        pendingPrivateRooms.delete(inv.code);
        if (inv.entryFee > 0) unlockUser(inv.fromUserId);
      }
      for (const s of _socketsForUser(inv.fromUserId)) s.emit('invite_declined', { inviteId, byUsername: authenticatedUser.username });
    });

    // Which of the given users are currently connected (for the invite friend list).
    socket.on('check_online', ({ userIds }) => {
      if (!authenticatedUser || !Array.isArray(userIds)) return;
      const online = userIds.filter(id => _isUserOnline(id));
      socket.emit('online_status', { online });
    });

    // Read-only look at a private room, so a shared challenge link can show the
    // host and the stake on an accept/decline screen BEFORE anyone commits.
    // Joining deducts a real entry fee, so clicking a link must never be the
    // thing that spends money.
    //
    // Mutates nothing and never joins. Auth is required to match
    // join_private_room — codes are only 6 characters, and without a gate this
    // would let anyone sweep the space and read off open rooms and their stakes.
    socket.on('peek_private_room', ({ code }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      const key = (code || '').toUpperCase().trim();
      const pending = pendingPrivateRooms.get(key);
      if (!pending) return socket.emit('error', { message: 'Room not found. Check the code and try again.' });
      socket.emit('private_room_info', {
        code: key,
        gameType:     pending.gameType,
        hostUsername: pending.p1?.username || 'A player',
        hostElo:      pending.p1?.elo ?? null,
        entryFee:     pending.p1?.entryFee || 0,
        currency:     pending.p1?.currency || 'coins',
        isHost:       pending.p1?.userId === authenticatedUser.userId,
      });
    });

    socket.on('join_private_room', async ({ gameType, code }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const key = (code || '').toUpperCase().trim();
      const pending = pendingPrivateRooms.get(key);
      if (!pending) return socket.emit('error', { message: 'Room not found. Check the code and try again.' });
      // Compare canonical ids on BOTH sides. The stored one is normalised when
      // the room is created, but the incoming one was not — so a client holding
      // a queue key rather than a room id was told "Wrong game type for this
      // code" and the invite simply refused to open, with the reason buried in a
      // generic error toast.
      if (canonicalGameType(pending.gameType) !== canonicalGameType(gameType)) {
        console.warn(`[private] game type mismatch — code:${key} stored:${pending.gameType} sent:${gameType}`);
        return socket.emit('error', { message: 'Wrong game type for this code.' });
      }
      gameType = canonicalGameType(gameType);
      if (pending.p1.socketId === socket.id) return socket.emit('error', { message: "You can't join your own room." });
      const p1Socket = io.sockets.sockets.get(pending.p1.socketId);
      if (!p1Socket) { pendingPrivateRooms.delete(key); if ((pending.p1.entryFee || 0) > 0) unlockUser(pending.p1.userId); return socket.emit('error', { message: 'Room host disconnected.' }); }

      const { entryFee, currency } = pending.p1;
      if (entryFee > 0) {
        const { data: pf } = await supabase.from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
        if (currency === 'diamonds' && (pf.diamonds || 0) < entryFee) return socket.emit('error', { message: 'Insufficient diamonds to join this room.' });
        if (currency === 'coins' && pf.c_coins < entryFee) return socket.emit('error', { message: 'Insufficient C Coins to join this room.' });
        lockUser(authenticatedUser.userId); // lock joiner until match settlement
      }
      const { data: profile2 } = await supabase.from('profiles').select('elo,username').eq('id', authenticatedUser.userId).single();

      pendingPrivateRooms.delete(key);
      // Joining consumes any invite tied to this room (both players are matched now).
      for (const [iid, inv] of pendingInvites) {
        if (inv.code === key) _cleanupInvite(iid);
      }
      const p1 = pending.p1;
      const p2 = { socketId: socket.id, userId: authenticatedUser.userId, username: profile2.username, elo: profile2.elo, entryFee, currency };

      _pairPrivatePlayers(gameType, p1, p2, io, supabase);
    });

    // ════════════════════════════════════════════════════════════════
    //  WORDLE (Word VS)
    // ════════════════════════════════════════════════════════════════
    socket.on('join_scrabble_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!isValidFee(entryFee, currency)) return socket.emit('error', { message: 'Invalid entry fee' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a queue' });
      socket._startingGame = 'scrabble';
      try {
        const { data: profile } = await supabase
          .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
        if (socket._pendingForfeitGame === 'scrabble') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          return;
        }
        if (entryFee > 0) {
          if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
            return socket.emit('error', { message: 'Insufficient diamonds' });
          if (currency === 'coins' && profile.c_coins < entryFee)
            return socket.emit('error', { message: 'Insufficient C Coins' });
          lockUser(authenticatedUser.userId);
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        userQueues.add(authenticatedUser.userId);
        incrementCount('scrabble', socket.id, entryFee, currency);
        const match = addToWordleQueue(player);
        if (match) {
          const { roomId, p1, p2 } = match;
          userQueues.delete(p1.userId); userQueues.delete(p2.userId);
          if (entryFee > 0) {
            try {
              await deductMatchFees(supabase, p1.userId, p2.userId, entryFee, currency);
              const room = getWordleRoom(roomId);
              if (room) room.feesDeducted = true;
            } catch (e) {
              console.error('[wordle] fee deduction failed:', e.message);
              deleteWordleRoom(roomId);
              unlockUser(p1.userId); unlockUser(p2.userId);
              decrementCount('scrabble', p1.socketId);
              decrementCount('scrabble', p2.socketId);
              io.emit('queue_entry_removed', { id: p1.socketId });
              io.emit('queue_entry_removed', { id: p2.socketId });
              const s1e = io.sockets.sockets.get(p1.socketId);
              const s2e = io.sockets.sockets.get(p2.socketId);
              if (s1e) s1e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
              if (s2e) s2e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
              return;
            }
          } else {
            const room = getWordleRoom(roomId);
            if (room) room.feesDeducted = true;
          }
          const s1 = io.sockets.sockets.get(p1.socketId);
          const s2 = io.sockets.sockets.get(p2.socketId);
          const wvP1Name = p1.isDemo ? randomFunnyName() : p1.username;
          const wvP2Name = p2.isDemo ? randomFunnyName() : p2.username;
          if (s1) { s1.join(roomId); s1.emit('scrabble_match_found', { roomId, opponent: { userId: p2.userId, username: wvP2Name, elo: p2.elo }, entryFee: p1.entryFee, currency: p1.currency }); }
          if (s2) { s2.join(roomId); s2.emit('scrabble_match_found', { roomId, opponent: { userId: p1.userId, username: wvP1Name, elo: p1.elo }, entryFee: p2.entryFee, currency: p2.currency }); }
          io.emit('queue_entry_removed', { id: p1.socketId });
          io.emit('queue_entry_removed', { id: p2.socketId });
          io.to(roomId).emit('scrabble_countdown', { count: 3 });
          await new Promise(r => setTimeout(r, 1000));
          if (!getWordleRoom(roomId)) return;
          io.to(roomId).emit('scrabble_countdown', { count: 2 });
          await new Promise(r => setTimeout(r, 1000));
          if (!getWordleRoom(roomId)) return;
          io.to(roomId).emit('scrabble_countdown', { count: 1 });
          await new Promise(r => setTimeout(r, 1000));
          if (!getWordleRoom(roomId)) return;
          startWordleGame(io, supabase, roomId);
        } else {
          socket.emit('scrabble_queue_joined');
          io.emit('queue_entry_added', {
            id: socket.id, gameType: 'scrabble', entryFee, currency,
            username: authenticatedUser.username || 'Player',
            elo: authenticatedUser.elo || 1000,
            profileColor: authenticatedUser.profile_color || '#1E90FF',
            currentStreak: authenticatedUser.current_streak || 0,
          });
          // Demo accounts: no other demo within 3s → bot match (demo always wins;
          // bot stays a little behind). Funny opponent name.
          if (authenticatedUser.isDemo) {
            setTimeout(async () => {
              if (!removeFromWordleQueue(socket.id)) return; // already matched or left
              userQueues.delete(authenticatedUser.userId);
              unlockUser(authenticatedUser.userId);
              io.emit('queue_entry_removed', { id: socket.id });
              try {
                if (entryFee > 0) {
                  if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
                  else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
                }
              } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
              const botSocketId = 'bot_wordle_' + uuidv4();
              const bot = { socketId: botSocketId, userId: botSocketId, username: randomFunnyName(), elo: 1000, entryFee, currency, isBot: true };
              const { roomId } = createDirectWordleRoom(player, bot);
              const room = getWordleRoom(roomId);
              if (room) room.feesDeducted = true;
              socket.join(roomId);
              socket.emit('scrabble_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, currency, vsBot: true });
              socket.emit('scrabble_countdown', { count: 3 });
              await new Promise(r => setTimeout(r, 1000));
              if (!getWordleRoom(roomId)) return;
              socket.emit('scrabble_countdown', { count: 2 });
              await new Promise(r => setTimeout(r, 1000));
              if (!getWordleRoom(roomId)) return;
              socket.emit('scrabble_countdown', { count: 1 });
              await new Promise(r => setTimeout(r, 1000));
              if (!getWordleRoom(roomId)) return;
              startWordleGame(io, supabase, roomId);
              setTimeout(() => scheduleBotWordleMove(io, supabase, roomId, botSocketId), 500);
            }, 3000);
          }
        }
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('leave_scrabble_queue', () => {
      removeFromWordleQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('scrabble', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
      socket.emit('scrabble_queue_left');
    });

    socket.on('wordle_guess', ({ roomId, guess }) => {
      if (!authenticatedUser) return;
      handleWordleGuess(io, supabase, roomId, socket.id, guess || '');
    });

    socket.on('play_scrabble_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      socket._startingGame = 'scrabble';
      try {
        if (currency !== 'diamonds') entryFee = 0; // bot games free for coins
        const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (entryFee > 0) {
          try {
            if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
            else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
          } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        const { v4: uuid } = require('uuid');
        const botSocketId = 'bot_wordle_' + uuid();
        const bot = { socketId: botSocketId, userId: botSocketId, username: 'Duely Bot', elo: 1000, entryFee, currency, isBot: true };
        const { roomId } = createDirectWordleRoom(player, bot);
        const room = getWordleRoom(roomId);
        if (room) room.feesDeducted = true;
        socket.join(roomId);
        socket.emit('scrabble_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
        socket.emit('scrabble_countdown', { count: 3 });
        await new Promise(r => setTimeout(r, 1000));
        if (!getWordleRoom(roomId)) return;
        socket.emit('scrabble_countdown', { count: 2 });
        await new Promise(r => setTimeout(r, 1000));
        if (!getWordleRoom(roomId)) return;
        socket.emit('scrabble_countdown', { count: 1 });
        await new Promise(r => setTimeout(r, 1000));
        if (!getWordleRoom(roomId)) return;
        startWordleGame(io, supabase, roomId);
        // Bot starts guessing after a short pause
        setTimeout(() => scheduleBotWordleMove(io, supabase, roomId, botSocketId), 500);
      } finally {
        socket._startingGame = null;
      }
    });

    // ── Wordle paid solo (diamond mode) ──────────────────────────────
    socket.on('wordle_solo_start', async ({ entryFee = 0, currency = 'diamonds' } = {}) => {
      if (!authenticatedUser) return socket.emit('wordle_solo_error', { error: 'Not authenticated' });
      try {
        const fee = Math.floor(entryFee);
        if (fee > 0 && currency === 'diamonds') {
          const { data: prof } = await supabase.from('profiles').select('diamonds').eq('id', authenticatedUser.userId).single();
          if (!prof || prof.diamonds < fee) return socket.emit('wordle_solo_error', { error: 'Insufficient Diamonds' });
          await deductDiamonds(supabase, authenticatedUser.userId, fee);
        }
        const { v4: uuid } = require('uuid');
        const sessionId = uuid();
        const word = getRandomWordleWord();
        // The answer word is kept SERVER-SIDE only — it is never sent to the
        // client. Guesses are submitted to and evaluated by the server, so the
        // client cannot self-report "solved". Prevents free diamond/ELO minting.
        wordleSoloSessions.set(sessionId, { userId: authenticatedUser.userId, word, fee, currency, guesses: 0, finished: false });
        setTimeout(() => wordleSoloSessions.delete(sessionId), 10 * 60 * 1000);
        socket.emit('wordle_solo_ready', { sessionId });
      } catch (e) {
        socket.emit('wordle_solo_error', { error: e.message || 'Failed to start' });
      }
    });

    // Server-authoritative solo guess: the client submits a guess, the server
    // evaluates it against the hidden word and decides when the game is solved
    // or exhausted, then settles. No trust in any client-supplied outcome.
    socket.on('wordle_solo_guess', async ({ sessionId, guess }) => {
      if (!authenticatedUser) return;
      const session = wordleSoloSessions.get(sessionId);
      if (!session || session.userId !== authenticatedUser.userId || session.finished) return;

      const g = (guess || '').toUpperCase().trim();
      if (g.length !== WORD_LENGTH || !/^[A-Z]+$/.test(g)) {
        return socket.emit('wordle_error', { error: 'Guess must be 5 letters' });
      }
      if (!isValidWord(g.toLowerCase())) {
        return socket.emit('wordle_error', { error: 'Not a valid word' });
      }
      if (session.guesses >= MAX_GUESSES) return;

      const feedback = evaluateGuess(session.word, g);
      session.guesses += 1;
      const solved = feedback.every(c => c.status === 'correct');
      const guessNumber = session.guesses;
      const done = solved || guessNumber >= MAX_GUESSES;

      socket.emit('wordle_solo_guess_result', { feedback, guessNumber, solved });

      if (!done) return;

      // ── Settle (server-decided outcome) ──────────────────────────────
      session.finished = true;
      wordleSoloSessions.delete(sessionId);
      const userId = authenticatedUser.userId;

      let payout = 0;
      if (solved && session.fee > 0 && session.currency === 'diamonds') {
        payout = Math.floor(session.fee * 2 * 0.95);
        await creditDiamonds(supabase, userId, payout).catch(() => {});
      }

      let newElo = null;
      try {
        const { data: prof } = await supabase.from('profiles').select('elo').eq('id', userId).single();
        const currentElo = prof?.elo ?? 1000;
        const { eloGain, eloLoss } = require('../services/eloService');
        newElo = solved ? currentElo + eloGain() : Math.max(0, currentElo - eloLoss());
        await supabase.from('profiles').update({ elo: newElo }).eq('id', userId);
        await supabase.rpc(solved ? 'increment_win' : 'increment_loss', { uid: userId }).catch(() => {});
      } catch (e) {
        console.error('[wordle_solo] ELO update failed:', e.message);
      }

      socket.emit('wordle_solo_settled', {
        won: solved, payout, currency: session.currency, entryFee: session.fee, newElo, word: session.word,
      });
    });

    // ════════════════════════════════════════════════════════════════
    //  COIN FLIP
    // ════════════════════════════════════════════════════════════════
    socket.on('join_coin_flip_queue', async ({ entryFee = 0, currency = 'coins', side }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!['heads', 'tails'].includes(side)) return socket.emit('error', { message: 'Pick heads or tails' });
      if (!isValidFee(entryFee, currency)) return socket.emit('error', { message: 'Invalid entry fee' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a queue' });
      const { data: profile } = await supabase.from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0 && currency === 'diamonds' && profile.diamonds < entryFee)
        return socket.emit('error', { message: 'Insufficient Diamonds' });
      if (entryFee > 0 && currency !== 'diamonds' && profile.c_coins < entryFee)
        return socket.emit('error', { message: 'Insufficient C Coins' });
      if (entryFee > 0) lockUser(authenticatedUser.userId);
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, side, isDemo: authenticatedUser.isDemo || false };
      userQueues.add(authenticatedUser.userId);
      incrementCount('coin-flip', socket.id, entryFee, currency);
      const match = addToCoinFlipQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        // Deduct fees BEFORE notifying clients
        if (entryFee > 0) {
          try {
            await deductMatchFees(supabase, match.p1.userId, match.p2.userId, entryFee, currency);
            const room = getCoinFlipRoom(match.roomId);
            if (room) room.feesDeducted = true;
          } catch (e) {
            console.error('[coin-flip] fee deduction failed:', e.message);
            deleteCoinFlipRoom(match.roomId);
            unlockUser(match.p1.userId); unlockUser(match.p2.userId);
            decrementCount('coin-flip', match.p1.socketId);
            decrementCount('coin-flip', match.p2.socketId);
            io.emit('queue_entry_removed', { id: match.p1.socketId });
            io.emit('queue_entry_removed', { id: match.p2.socketId });
            const s1e = io.sockets.sockets.get(match.p1.socketId);
            const s2e = io.sockets.sockets.get(match.p2.socketId);
            if (s1e) s1e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            if (s2e) s2e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            return;
          }
        } else {
          const room = getCoinFlipRoom(match.roomId);
          if (room) room.feesDeducted = true;
        }
        const s1 = io.sockets.sockets.get(match.p1.socketId);
        const s2 = io.sockets.sockets.get(match.p2.socketId);
        // Demo-vs-demo: relabel each opponent with a funny name.
        const p1Name = match.p1.isDemo ? randomFunnyName() : match.p1.username;
        const p2Name = match.p2.isDemo ? randomFunnyName() : match.p2.username;
        if (s1) { s1.join(match.roomId); s1.emit('coin_flip_match_found', { roomId: match.roomId, opponent: { userId: match.p2.userId, username: p2Name, elo: match.p2.elo }, side: match.p1.side, entryFee, currency: match.p1.currency }); }
        if (s2) { s2.join(match.roomId); s2.emit('coin_flip_match_found', { roomId: match.roomId, opponent: { userId: match.p1.userId, username: p1Name, elo: match.p1.elo }, side: match.p2.side, entryFee, currency: match.p2.currency }); }
        // 3s countdown + 3s spin = 6s before resolving
        setTimeout(() => resolveCoinFlip(io, supabase, match.roomId), 6000);
      } else {
        socket.emit('coin_flip_queue_joined', { side });
        // Demo accounts: if no other demo shows up within 3s, drop into a rigged
        // bot match (demo always wins) with a funny opponent name.
        if (authenticatedUser.isDemo) {
          setTimeout(async () => {
            if (!removeFromCoinFlipQueue(socket.id)) return; // already matched or left
            userQueues.delete(authenticatedUser.userId);
            unlockUser(authenticatedUser.userId); // bot flow is self-contained; release queue lock
            try {
              if (entryFee > 0) {
                if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
                else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
              }
            } catch (e) { unlockUser(authenticatedUser.userId); return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
            const bot = { socketId: `bot_cf_${uuidv4()}`, userId: `bot_cf_${uuidv4()}`, username: randomFunnyName(), elo: 1000, entryFee, currency, side: side === 'heads' ? 'tails' : 'heads', isBot: true };
            const { roomId } = createDirectCoinFlipRoom(player, bot);
            if (entryFee > 0) { const r = getCoinFlipRoom(roomId); if (r) r.feesDeducted = true; }
            socket.join(roomId);
            socket.emit('coin_flip_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, side, entryFee, currency, vsBot: true });
            setTimeout(() => resolveCoinFlip(io, supabase, roomId), 6000);
          }, 3000);
        }
      }
    });

    socket.on('leave_coin_flip_queue', () => {
      removeFromCoinFlipQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('coin-flip', socket.id);
      socket.emit('coin_flip_queue_left');
    });

    socket.on('play_coin_flip_vs_bot', async ({ entryFee = 0, currency = 'coins', side } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!['heads', 'tails'].includes(side)) return socket.emit('error', { message: 'Pick heads or tails' });
      socket._startingGame = 'coin_flip';
      try {
        // CoinFlip bot is diamonds-only; never allow a coins bet vs bot
        if (currency !== 'diamonds') entryFee = 0;
        const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (entryFee > 0) {
          try {
            if (currency === 'diamonds') {
              await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
            } else {
              await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
            }
          } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, side, isDemo: authenticatedUser.isDemo || false };
        const bot = { socketId: `bot_cf_${uuidv4()}`, userId: `bot_cf_${uuidv4()}`, username: 'Duely Bot', elo: 1000, entryFee, currency, side: side === 'heads' ? 'tails' : 'heads', isBot: true };
        // Use createDirectCoinFlipRoom so the room is tracked in coinFlipRooms map.
        // This means getCoinFlipRoomBySocket finds it on disconnect → _handleForfeit
        // fires → fee is settled and room cleaned up properly.
        const { roomId } = createDirectCoinFlipRoom(player, bot);
        if (entryFee > 0) { const r = getCoinFlipRoom(roomId); if (r) r.feesDeducted = true; }
        socket.join(roomId);
        if (socket._pendingForfeitGame === 'coin_flip') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          await _handleForfeit(io, supabase, { roomId, room: getCoinFlipRoom(roomId) }, socket.id, deleteCoinFlipRoom, 'coin_flip');
          return;
        }
        socket.emit('coin_flip_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, side, entryFee, vsBot: true });
        // Resolve after countdown (6s) + flip animation via the standard resolveCoinFlip
        setTimeout(() => resolveCoinFlip(io, supabase, roomId), 6000);
      } finally {
        socket._startingGame = null;
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  BLACKJACK
    // ════════════════════════════════════════════════════════════════
    socket.on('join_bj_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      if (!isValidFee(entryFee, currency)) return socket.emit('error', { message: 'Invalid entry fee' });
      if (userQueues.has(authenticatedUser.userId)) return socket.emit('error', { message: 'Already in a queue' });
      socket._startingGame = 'blackjack';
      try {
      const { data: profile } = await supabase.from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      // Player navigated away while we were awaiting the DB query — bail out cleanly
      if (socket._pendingForfeitGame === 'blackjack') {
        socket._pendingForfeitGame = null;
        if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
        return;
      }
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee) return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee) return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
      userQueues.add(authenticatedUser.userId);
      incrementCount('blackjack', socket.id, entryFee, currency);
      const match = addToBlackjackQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        // Deduct fees BEFORE notifying clients
        if (entryFee > 0) {
          try {
            await deductMatchFees(supabase, match.p1.userId, match.p2.userId, entryFee, currency);
            const room = getBlackjackRoom(match.roomId);
            if (room) room.feesDeducted = true;
          } catch (e) {
            console.error('[blackjack] fee deduction failed:', e.message);
            deleteBlackjackRoom(match.roomId);
            unlockUser(match.p1.userId); unlockUser(match.p2.userId);
            decrementCount('blackjack', match.p1.socketId);
            decrementCount('blackjack', match.p2.socketId);
            io.emit('queue_entry_removed', { id: match.p1.socketId });
            io.emit('queue_entry_removed', { id: match.p2.socketId });
            const s1e = io.sockets.sockets.get(match.p1.socketId);
            const s2e = io.sockets.sockets.get(match.p2.socketId);
            if (s1e) s1e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            if (s2e) s2e.emit('match_cancelled', { message: 'Your balance changed. Please rejoin the queue.' });
            return;
          }
        } else {
          const room = getBlackjackRoom(match.roomId);
          if (room) room.feesDeducted = true;
        }
        const s1 = io.sockets.sockets.get(match.p1.socketId);
        const s2 = io.sockets.sockets.get(match.p2.socketId);
        const p1Name = match.p1.isDemo ? randomFunnyName() : match.p1.username;
        const p2Name = match.p2.isDemo ? randomFunnyName() : match.p2.username;
        if (s1) { s1.join(match.roomId); s1.emit('bj_match_found', { roomId: match.roomId, opponent: { userId: match.p2.userId, username: p2Name, elo: match.p2.elo }, entryFee, currency: match.p1.currency }); }
        if (s2) { s2.join(match.roomId); s2.emit('bj_match_found', { roomId: match.roomId, opponent: { userId: match.p1.userId, username: p1Name, elo: match.p1.elo }, entryFee, currency: match.p2.currency }); }
        startBlackjackGame(io, supabase, match.roomId);
      } else {
        socket.emit('bj_queue_joined');
        // Demo accounts: no other demo within 3s → rigged bot match (demo always wins).
        if (authenticatedUser.isDemo) {
          setTimeout(async () => {
            if (!removeFromBlackjackQueue(socket.id)) return; // already matched or left
            userQueues.delete(authenticatedUser.userId);
            unlockUser(authenticatedUser.userId);
            try {
              if (entryFee > 0) {
                if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
                else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
              }
            } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
            const bot = { socketId: null, userId: 'bot_bj_' + uuidv4(), username: randomFunnyName(), elo: 1000, entryFee, currency, isBot: true };
            const { roomId } = createDirectBlackjackRoom(player, bot);
            if (entryFee > 0) { const r = getBlackjackRoom(roomId); if (r) r.feesDeducted = true; }
            socket.join(roomId);
            socket.emit('bj_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, currency, vsBot: true });
            startBlackjackGame(io, supabase, roomId);
          }, 3000);
        }
      }
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('leave_bj_queue', () => {
      removeFromBlackjackQueue(socket.id);
      removeFromCarDashQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('blackjack', socket.id);
      socket.emit('bj_queue_left');
    });

    // ── Generic leave_all_queues: called when any game page unmounts ─────────────
    // Removes socket from every queue and clears the userQueues lock so they can
    // join a new queue immediately without getting "Already in a queue".
    socket.on('leave_all_queues', () => {
      _cancelHostedRooms(socket.id, authenticatedUser?.userId);
      removeFromBlockBlastQueue(socket.id);
      removeFromWordleQueue(socket.id);
      removeFromCoinFlipQueue(socket.id);
      removeFromBlackjackQueue(socket.id);
      removeFromCarDashQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      io.emit('queue_entry_removed', { id: socket.id });
    });

    // ── Generic leave_game: decrement live player count when game page unmounts ──
    socket.on('leave_game', () => {
      if (socketGameMap[socket.id]) {
        decrementCount(socketGameMap[socket.id], socket.id);
      }
    });

    // ── Player forfeit: explicitly called when a player navigates away mid-match ──
    socket.on('player_forfeit', async () => {
      if (!authenticatedUser) return;
      _cancelHostedRooms(socket.id, authenticatedUser.userId);
      const roomLookups = [
        [getRoomBySocket,           deleteRoom,           'reaction'],
        [getBlockBlastRoomBySocket, deleteBlockBlastRoom, 'blockBlast'],
        [getWordleRoomBySocket,     deleteWordleRoom,     'scrabble'],
        [getCoinFlipRoomBySocket,   deleteCoinFlipRoom,   'coin_flip'],
        [getBlackjackRoomBySocket,  deleteBlackjackRoom,  'blackjack'],
        [getCarDashRoomBySocket,    deleteCarDashRoom,    'carDash'],
    [getTowerRoomBySocket,      deleteTowerRoom,      'tower'],
      ];
      let forfeited = false;
      for (const [getFn, delFn, gameType] of roomLookups) {
        const found = getFn(socket.id);
        if (!found) continue;
        const { room } = found;
        // 'finished' = already settled — just clean up
        if (room.state === 'finished') { delFn(found.roomId); continue; }
        // 'waiting' rooms (countdown not yet started) still need forfeit notification to stayer
        await _handleForfeit(io, supabase, found, socket.id, delFn, gameType);
        // Clean up queue tracking so player can re-enter lobby cleanly
        if (authenticatedUser) userQueues.delete(authenticatedUser.userId);
        forfeited = true;
        break;
      }
      // No active room found — the player may be waiting in a queue. SPA navigation
      // keeps the socket connected (no 'disconnect' fires), so without this they'd
      // stay queued and later get matched as a no-show "ghost" — freezing/robbing
      // their opponent. Drop them from every queue and release the queue lock.
      if (!forfeited) {
        removeFromWordleQueue(socket.id);
        removeFromCoinFlipQueue(socket.id);
        removeFromBlackjackQueue(socket.id);
        removeFromCarDashQueue(socket.id);
        removeFromBlockBlastQueue(socket.id);
        unlockUser(authenticatedUser.userId);
        userQueues.delete(authenticatedUser.userId);
        io.emit('queue_entry_removed', { id: socket.id });

        // A bot/queue handler may be mid-await on its DB query (before room creation).
        // Only mark a pending forfeit if that specific handler set _startingGame, so we
        // never false-positive on a lobby exit followed by a different game starting.
        if (socket._startingGame) {
          socket._pendingForfeitGame = socket._startingGame;
          if (socket._pendingForfeitGameTimer) clearTimeout(socket._pendingForfeitGameTimer);
          socket._pendingForfeitGameTimer = setTimeout(() => { socket._pendingForfeitGame = null; }, 8000);
        }
      }
    });

    socket.on('play_bj_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (_inLiveRoom(socket.id))
        return socket.emit('error', { message: 'Finish your current game first.' });
      resumeCounts.delete(authenticatedUser.userId);   // fresh match, fresh grace
      socket._startingGame = 'blackjack';
      try {
        if (currency !== 'diamonds') entryFee = 0;
        const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
        if (entryFee > 0) {
          try {
            if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
            else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
          } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
        }
        const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, isDemo: authenticatedUser.isDemo || false };
        const bot = { socketId: null, userId: 'bot_bj_' + uuidv4(), username: 'Duely Bot', elo: 1000, entryFee, currency, isBot: true };
        const { roomId } = createDirectBlackjackRoom(player, bot);
        if (entryFee > 0) { const r = getBlackjackRoom(roomId); if (r) r.feesDeducted = true; }
        socket.join(roomId);
        if (socket._pendingForfeitGame === 'blackjack') {
          socket._pendingForfeitGame = null;
          if (socket._pendingForfeitGameTimer) { clearTimeout(socket._pendingForfeitGameTimer); socket._pendingForfeitGameTimer = null; }
          await _handleForfeit(io, supabase, { roomId, room: getBlackjackRoom(roomId) }, socket.id, deleteBlackjackRoom, 'blackjack');
          return;
        }
        incrementCount('blackjack', socket.id, entryFee, currency);
        socket.emit('bj_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
        startBlackjackGame(io, supabase, roomId);
      } finally {
        socket._startingGame = null;
      }
    });

    socket.on('bj_hit', ({ roomId }) => {
      if (!authenticatedUser) return;
      handleBlackjackHit(io, supabase, roomId, socket.id);
    });

    socket.on('bj_stand', ({ roomId }) => {
      if (!authenticatedUser) return;
      handleBlackjackStand(io, supabase, roomId, socket.id);
    });

    socket.on('bj_split', ({ roomId }) => {
      if (!authenticatedUser) return;
      handleBlackjackSplit(io, supabase, roomId, socket.id);
    });


    // ── Disconnect ────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      cleanupSocket(socket.id);
      // Close every room this socket was hosting (not just the first) and pull
      // back the invites tied to them.
      _cancelHostedRooms(socket.id, authenticatedUser?.userId);
      // Inviter disconnected — cancel their outstanding invites and pull the popup.
      if (authenticatedUser) {
        for (const [iid, inv] of pendingInvites) {
          if (inv.fromUserId === authenticatedUser.userId) {
            _cleanupInvite(iid);
            for (const s of _socketsForUser(inv.toUserId)) s.emit('invite_cancelled', { inviteId: iid });
          }
        }
      }
      // Decrement player count if socket was tracked for a game
      // (decrementCount also cleans up socketGameMap and socketBetMap entries)
      if (socketGameMap[socket.id]) {
        decrementCount(socketGameMap[socket.id], socket.id);
      }

      // Remove from all queues
      removeFromBlockBlastQueue(socket.id);
      removeFromWordleQueue(socket.id);
      removeFromCoinFlipQueue(socket.id);
      removeFromBlackjackQueue(socket.id);
      removeFromCarDashQueue(socket.id);
      // Broadcast queue entry removal so Play Now page stays in sync
      io.emit('queue_entry_removed', { id: socket.id });

      // Settle/forfeit any active rooms
      const roomLookups = [
        [getRoomBySocket,           deleteRoom,           'reaction'],
        [getBlockBlastRoomBySocket, deleteBlockBlastRoom, 'blockBlast'],
        [getWordleRoomBySocket,     deleteWordleRoom,     'scrabble'],
        [getCoinFlipRoomBySocket,   deleteCoinFlipRoom,   'coin_flip'],
        [getBlackjackRoomBySocket,  deleteBlackjackRoom,  'blackjack'],
        [getCarDashRoomBySocket,    deleteCarDashRoom,    'carDash'],
    [getTowerRoomBySocket,      deleteTowerRoom,      'tower'],
      ];

      const pendingJobs = [];

      for (const [getFn, delFn, gameType] of roomLookups) {
        const found = getFn(socket.id);
        if (!found) continue;
        const { room, roomId } = found;
        if (room.state === 'finished') { delFn(roomId); continue; }

        const leaver = room.players?.find(p => p.socketId === socket.id);
        // Bots or solo rooms: forfeit immediately, no grace period needed
        if (!leaver || leaver.isBot) {
          await _handleForfeit(io, supabase, found, socket.id, delFn, gameType);
          continue;
        }

        const leaverSocketId = socket.id;
        const forfeitFn = async () => {
          const stillFound = getFn(leaverSocketId) || { room, roomId };
          if (!stillFound.room || stillFound.room.state === 'finished') { delFn(roomId); return; }
          await _handleForfeit(io, supabase, stillFound, leaverSocketId, delFn, gameType);
        };
        const updateSocketFn = (newSocket) => {
          leaver.socketId = newSocket.id;
          newSocket._authenticatedUserId = leaver.userId;
          newSocket.join(roomId);
        };
        pendingJobs.push({ forfeitFn, updateSocketFn, cancelled: false });
      }

      if (pendingJobs.length > 0 && authenticatedUser) {
        const existing = disconnectTimers.get(authenticatedUser.userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(async () => {
          disconnectTimers.delete(authenticatedUser.userId);
          for (const job of pendingJobs) {
            if (!job.cancelled) await job.forfeitFn();
          }
        }, DISCONNECT_GRACE_MS);
        disconnectTimers.set(authenticatedUser.userId, { timer, jobs: pendingJobs });
      }
    });
  });

  // ── Forfeit handler (called on disconnect from active room) ────────────
  // One player left: stayer wins and gets paid. Both left: deduct both (fees).
  async function _handleForfeit(io, supabase, roomData, leaverSocketId, deleteFn, gameType) {
    const { roomId, room } = roomData;
    if (!room || room.state === 'finished') {
      deleteFn(roomId); return;
    }
    // Prevent double-processing if both disconnect near-simultaneously
    room.state = 'finished';
    // Cancel any pending game timers (e.g. Blackjack auto-stand) so they don't fire after forfeit
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }

    const leaver = room.players.find(p => p.socketId === leaverSocketId);
    const stayer = room.players.find(p => p.socketId !== leaverSocketId);

    if (!leaver || !stayer || leaver.isBot) { io.emit('active_game_ended', { id: roomId }); deleteFn(roomId); return; }

    const fee      = room.entryFee || 0;
    const currency = room.currency || 'coins';

    if (fee > 0 && !room.feesDeducted) {
      // Match was found but fees were never charged (player disconnected before deduction completed)
      // No money was taken — notify stayer so they aren't stuck on the countdown screen
      unlockUser(leaver.userId);
      if (!stayer.isBot) unlockUser(stayer.userId);
      const stayerSock = io.sockets.sockets.get(stayer.socketId);
      if (stayerSock && !stayer.isBot) {
        stayerSock.emit('match_cancelled', { message: 'Your opponent disconnected before the match started.' });
      }
      io.emit('active_game_ended', { id: roomId });
      deleteFn(roomId);
      return;
    }

    if (fee > 0 && stayer.isBot) {
      // Human forfeited a paid bot game — loses the bet. The STREAK is left
      // alone: it is a PvP record, and quitting a bot match is not a loss to
      // an opponent.
      try {
        await settleBotMatch(supabase, leaver.userId, fee, currency, false);
      } catch (e) { console.error('bot forfeit settle error:', e.message); }
    } else if (fee > 0 && !stayer.isBot) {
      const stayerSocket = io.sockets.sockets.get(stayer.socketId);

      if (stayerSocket) {
        console.log(`[forfeit] settling game:${gameType} currency:${currency} fee:${fee} winner:${stayer.userId} loser:${leaver.userId}`);

        // Pre-calculate ELO (used even if settle fails)
        // Fallback values, used only if the real ELO update below throws.
        // Same ranges as a played-out match — a forfeit should not be worth a
        // different amount.
        const { eloGain, eloLoss } = require('../services/eloService');
        let newWinnerElo = (stayer.elo || 1000) + eloGain();
        let newLoserElo  = Math.max(0, (leaver.elo || 1000) - eloLoss());
        let winnerPayout = 0;

        try {
          // ── ELO update ────────────────────────────────────────────────
          try {
            const eloData = await _updateElo(supabase, stayer.userId, leaver.userId, stayer.elo || 1000, leaver.elo || 1000);
            newWinnerElo = eloData.newWinnerElo ?? newWinnerElo;
            newLoserElo  = eloData.newLoserElo  ?? newLoserElo;
          } catch (eloErr) {
            console.error('[forfeit] elo update failed:', eloErr.message);
          }

          // ── Wallet settlement — mirrors normal match: both pay, winner gets the
          // pot minus rake. Coin flip uses its own 2% rake; other coin games 5%.
          const adminId = process.env.ADMIN_USER_ID;
          const result = currency === 'diamonds'
            ? await forfeitSettleDiamonds(supabase, stayer.userId, leaver.userId, fee)
            : gameType === 'coin_flip'
              ? await settleCoinFlip(supabase, stayer.userId, leaver.userId, fee, { game: 'Coin Flip', winnerUsername: stayer.username, loserUsername: leaver.username })
              : await forfeitSettleCoins(supabase, stayer.userId, leaver.userId, fee, adminId);
          winnerPayout = result.winnerPayout ?? 0;

          // ── Rakeback (coins only, same as normal match) ───────────────
          if (currency === 'coins') {
            const { creditRakeback } = require('../services/rakebackService');
            await creditRakeback(supabase, stayer.userId, leaver.userId, fee * 2, 'coins')
              .catch(e => console.error('[forfeit] rakeback failed:', e.message));
          }

          // ── Streak ────────────────────────────────────────────────────
          // Same helper the engines use, so a forfeit and a played-out match
          // treat streaks identically. This branch is already PvP-only
          // (stayer.isBot is false), and the helper re-checks anyway.
          const { applyMatchStreaks } = require('../services/eloService');
          applyMatchStreaks(supabase, stayer, leaver).catch(() => {});

          console.log(`[forfeit] settle OK — payout:${winnerPayout} newWinnerElo:${newWinnerElo}`);
        } catch (e) {
          console.error('[forfeit] settle FAILED:', e.message);
          unlockUser(stayer.userId);
          unlockUser(leaver.userId);
        }

        stayerSocket.emit('opponent_disconnected', {
          winnerId:       stayer.userId,
          loserId:        leaver.userId,
          winnerUsername: stayer.username,
          loserUsername:  leaver.username,
          winnerPayout,
          entryFee:       fee,
          newWinnerElo,
          newLoserElo,
          currency,
        });
      } else {
        // Both players dropped within the reconnect grace window — no game was
        // played and there is no winner, so refund each their entry fee (it was
        // deducted at match start). Previously this only unlocked, silently
        // keeping both fees.
        try {
          if (currency === 'diamonds') {
            await creditDiamonds(supabase, stayer.userId, fee);
            await creditDiamonds(supabase, leaver.userId, fee);
          } else {
            await creditCoins(supabase, stayer.userId, fee);
            await creditCoins(supabase, leaver.userId, fee);
          }
        } catch (e) { console.error('[forfeit] double-disconnect refund failed:', e.message); }
        unlockUser(stayer.userId);
        unlockUser(leaver.userId);
      }
    } else {
      // Free match — just notify opponent if still connected
      const stayerSocket = io.sockets.sockets.get(stayer.socketId);
      if (stayerSocket && !stayer.isBot) stayerSocket.emit('opponent_disconnected', {
        winnerId:      stayer.userId,
        loserId:       leaver.userId,
        winnerUsername: stayer.username,
        loserUsername:  leaver.username,
        winnerPayout:  0,
        currency,
      });
    }

    io.emit('active_game_ended', { id: roomId });
    deleteFn(roomId);
  }

  // ── Private helpers ───────────────────────────────────────────────
  function _startReactionMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    startCountdown(io, supabase, roomId);
  }

  // ── Private room pairing dispatcher ───────────────────────────
  async function _pairPrivatePlayers(gameType, p1, p2, io, supabase) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (!s1 || !s2) return;

    // Entry fees were only ever *checked* (not deducted) when the room was
    // created/joined — without this, neither player's balance ever actually
    // moved, yet settleMatch/settleBotMatch still credit the winner the full
    // prize pool assuming deduction already happened. Deduct now, before any
    // room is created, mirroring the queue-match pairing flow exactly.
    const entryFee = p1.entryFee || 0;
    const currency = p1.currency || 'coins';
    if (entryFee > 0) {
      try {
        await deductMatchFees(supabase, p1.userId, p2.userId, entryFee, currency);
      } catch (e) {
        console.error('[private match] fee deduction failed:', e.message);
        unlockUser(p1.userId); unlockUser(p2.userId);
        s1.emit('match_cancelled', { message: 'Your balance changed. Please try again.' });
        s2.emit('match_cancelled', { message: 'Your balance changed. Please try again.' });
        return;
      }
    }

    function emit2(event, extra1 = {}, extra2 = {}) {
      s1.join(roomId); s2.join(roomId);
      s1.emit(event, { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, ...extra1 });
      s2.emit(event, { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, ...extra2 });
    }

    let roomId;
    switch (gameType) {
      case 'blockBlast': {
        ({ roomId } = createDirectBlockBlastRoom(p1, p2));
        if (entryFee > 0) { const r = getBlockBlastRoom(roomId); if (r) r.feesDeducted = true; }
        emit2('block_blast_match_found'); startBlockBlastCountdown(io, supabase, roomId); break;
      }
      case 'tower': {
        ({ roomId } = createDirectTowerRoom(p1, p2));
        if (entryFee > 0) { const r = getTowerRoom(roomId); if (r) r.feesDeducted = true; }
        emit2('tower_match_found'); startTowerCountdown(io, supabase, roomId); break;
      }
      case 'scrabble': {
        ({ roomId } = createDirectWordleRoom(p1, p2));
        if (entryFee > 0) { const r = getWordleRoom(roomId); if (r) r.feesDeducted = true; }
        s1.join(roomId); s2.join(roomId);
        s1.emit('scrabble_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, currency: p1.currency });
        s2.emit('scrabble_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, currency: p2.currency });
        io.to(roomId).emit('scrabble_countdown', { count: 3 });
        setTimeout(() => io.to(roomId).emit('scrabble_countdown', { count: 2 }), 1000);
        setTimeout(() => io.to(roomId).emit('scrabble_countdown', { count: 1 }), 2000);
        setTimeout(() => startWordleGame(io, supabase, roomId), 3000);
        break;
      }
      case 'coin-flip': {
        const result = createDirectCoinFlipRoom(p1, p2);
        roomId = result.roomId;
        const p2cf = result.p2;
        if (entryFee > 0) { const r = getCoinFlipRoom(roomId); if (r) r.feesDeducted = true; }
        s1.join(roomId); s2.join(roomId);
        s1.emit('coin_flip_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, side: p1.side, entryFee: p1.entryFee, currency: p1.currency });
        s2.emit('coin_flip_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, side: p2cf.side, entryFee: p2.entryFee, currency: p2.currency });
        setTimeout(() => resolveCoinFlip(io, supabase, roomId), 6000);
        break;
      }
      // Rush Hour was never wired into private rooms: the lobby offered
      // "Challenge a Friend", the server minted a code, and then nothing
      // happened for either player because this switch had no case for it.
      case 'carDash': {
        ({ roomId } = createDirectCarDashRoom(p1, p2));
        if (entryFee > 0) { const r = getCarDashRoom(roomId); if (r) r.feesDeducted = true; }
        s1.join(roomId); s2.join(roomId);
        s1.emit('car_dash_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, currency: p1.currency });
        s2.emit('car_dash_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, currency: p2.currency });
        startCarDashCountdown(io, supabase, roomId);
        break;
      }
      case 'blackjack': {
        ({ roomId } = createDirectBlackjackRoom(p1, p2));
        if (entryFee > 0) { const r = getBlackjackRoom(roomId); if (r) r.feesDeducted = true; }
        s1.join(roomId); s2.join(roomId);
        s1.emit('bj_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, currency: p1.currency });
        s2.emit('bj_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, currency: p2.currency });
        startBlackjackGame(io, supabase, roomId);
        break;
      }
      default: break;
    }
  }

  // ── Spectator mode ────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
  socket.on('spectate_game', ({ gameId }) => {
    // Deliberately NOT gated on authentication: /spectate/:gameId is a public
    // route and the socket only authenticates when a session exists, so
    // requiring auth here would break spectating for logged-out visitors. It
    // would also buy nothing — every room-wide broadcast is a result, a
    // countdown or a shared seed. Hands, guesses and per-player progress are all
    // sent to individual sockets, so joining a room reveals nothing private.
    //
    // What IS worth bounding is how many rooms one socket can attach to.
    if (!gameId || typeof gameId !== 'string' || gameId.length > 100) return;

    // One spectated room at a time, so a socket cannot accumulate memberships.
    if (socket._spectating && socket._spectating !== gameId) {
      socket.leave(socket._spectating);
    }
    socket._spectating = gameId;
    socket.join(gameId);

    // Try to find the room in supported engines and send a snapshot
    const scrabbleRoom = getWordleRoom(gameId);
    if (scrabbleRoom) {
      const [p1, p2] = scrabbleRoom.players;
      socket.emit('spectate_snapshot', {
        gameType: 'scrabble',
        player1: { userId: p1.userId, username: p1.username },
        player2: { userId: p2?.userId, username: p2?.username },
      });
      return;
    }

    const bbRoom = getBlockBlastRoom(gameId);
    if (bbRoom) {
      const [p1, p2] = bbRoom.players;
      socket.emit('spectate_snapshot', {
        gameType: 'blockBlast',
        player1: { userId: p1.userId, username: p1.username },
        player2: { userId: p2?.userId, username: p2?.username },
        score1: bbRoom.scores[p1.socketId] ?? 0,
        score2: bbRoom.scores[p2?.socketId] ?? 0,
      });
      return;
    }

    const coinRoom = getCoinFlipRoom(gameId);
    if (coinRoom) {
      const [p1, p2] = coinRoom.players;
      socket.emit('spectate_snapshot', {
        gameType: 'coinFlip',
        player1: { userId: p1.userId, username: p1.username },
        player2: { userId: p2?.userId, username: p2?.username },
      });
      return;
    }

    const bjRoom = getBlackjackRoom(gameId);
    if (bjRoom) {
      const [p1, p2] = bjRoom.players;
      socket.emit('spectate_snapshot', {
        gameType: 'blackjack',
        player1: { userId: p1.userId, username: p1.username },
        player2: { userId: p2?.userId, username: p2?.username },
      });
      return;
    }

    // Game not found or already ended
    socket.emit('spectate_snapshot', { gameType: 'unknown' });
  });
  }); // end spectate connection listener
};





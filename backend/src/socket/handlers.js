const { v4: uuidv4 } = require('uuid');
const {
  addToQueue, removeFromQueue,
  createDirectRoom,
  createPrivateRoom, joinPrivateRoom,
  getRoom, deleteRoom, getRoomBySocket,
} = require('../services/matchmaking');
const { startCountdown, handleClick } = require('../services/gameEngine');
const {
  createDirectTypeRoom,
  addToTypeQueue, removeFromTypeQueue,
  getTypeRoom, deleteTypeRoom, getTypeRoomBySocket,
  startTypeCountdown, handleTypeProgress, resolveTypeMatch,
} = require('../services/typeGameEngine');
const {
  makeSequence,
  createDirectMemoryRoom,
  addToMemoryQueue, removeFromMemoryQueue,
  getMemoryRoom, deleteMemoryRoom, getMemoryRoomBySocket,
  startMemoryCountdown, handleMemoryClick,
} = require('../services/memoryGameEngine');
const {
  createDirectAimRoom,
  addToAimQueue, removeFromAimQueue,
  getAimRoom, deleteAimRoom, getAimRoomBySocket,
  startAimCountdown, handleAimClick,
} = require('../services/aimGameEngine');
const {
  createDirectC4Room,
  addToC4Queue, removeFromC4Queue,
  getC4Room, deleteC4Room, getC4RoomBySocket,
  startC4Countdown, handleC4Drop,
  emptyBoard,
  startC4Timer, clearC4TimerForRoom,
} = require('../services/connectFourEngine');
const {
  createDirectDartRoom,
  addToDartQueue, removeFromDartQueue,
  getDartRoom, deleteDartRoom, getDartRoomBySocket,
  startDartCountdown, handleDartShoot,
} = require('../services/dartGameEngine');
const {
  createDirectAsteroidRoom,
  addToAsteroidQueue, removeFromAsteroidQueue,
  getAsteroidRoom, deleteAsteroidRoom, getAsteroidRoomBySocket,
  startAsteroidCountdown, handleAsteroidDeath,
} = require('../services/asteroidsEngine');
const {
  createDirectStarshipRoom,
  addToStarshipQueue, removeFromStarshipQueue,
  getStarshipRoom, deleteStarshipRoom, getStarshipRoomBySocket,
  startStarshipCountdown, handleStarshipDeath,
} = require('../services/starshipEngine');
const {
  createDirectBlockBlastRoom,
  addToBlockBlastQueue, removeFromBlockBlastQueue,
  getBlockBlastRoom, deleteBlockBlastRoom, getBlockBlastRoomBySocket,
  startBlockBlastCountdown, handleBlockBlastComplete, handleBlockBlastStuck,
} = require('../services/blockBlastEngine');
const {
  createDirectPianoRoom,
  addToPianoQueue, removeFromPianoQueue,
  getPianoRoom, deletePianoRoom, getPianoRoomBySocket,
  startPianoCountdown, handlePianoDeath, handlePianoScorePing,
} = require('../services/pianoTilesEngine');
const {
  createDirectClickRoom,
  addToClickQueue, removeFromClickQueue,
  getClickRoom, deleteClickRoom, getClickRoomBySocket,
  startClickRaceCountdown, handleClickRaceClick,
} = require('../services/clickRaceEngine');
const {
  addToTTTQueue, removeFromTTTQueue,
  getTTTRoom, deleteTTTRoom, getTTTRoomBySocket,
  createDirectTTTRoom,
  startTTTRound, handleTTTMove,
  startTTTTimer, clearTTTTimerForRoom,
} = require('../services/ticTacToeEngine');
const {
  addToTetrisQueue, removeFromTetrisQueue,
  getTetrisRoom, deleteTetrisRoom, getTetrisRoomBySocket,
  createDirectTetrisRoom,
  startTetrisMatch, handleTetrisToppedOut, handleTetrisBoardUpdate,
} = require('../services/tetrisEngine');
const {
  addToChessQueue, removeFromChessQueue,
  getChessRoom, deleteChessRoom, getChessRoomBySocket,
  createDirectChessRoom,
  startChessGame, handleChessMove, handleChessGameOver,
  startChessTimer, clearChessTimerForRoom,
} = require('../services/chessEngine');
const {
  addToCrossroadQueue, removeFromCrossroadQueue,
  getCrossroadRoom, deleteCrossroadRoom, getCrossroadRoomBySocket,
  createDirectCrossroadRoom,
  startCrossroadRound, handleCrossroadGoal, handleCrossroadProgress,
} = require('../services/crossroadEngine');
const {
  addToScrabbleQueue, removeFromScrabbleQueue,
  getScrabbleRoom, deleteScrabbleRoom, getScrabbleRoomBySocket,
  createDirectScrabbleRoom,
  startScrabbleGame, scheduleBotMove,
  handleScrabblePlay, handleScrabbleSkip, handleScrabbleExchange,
} = require('../services/scrabbleEngine');
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
const {
  settleMatch, settleMatchDiamonds, forfeitSettleDiamonds, forfeitSettleCoins,
  deductCoins, deductDiamonds,
  settleBotMatch,
} = require('../services/walletService');
const { lockUser, unlockUser, isLocked } = require('../services/lockService');
const { updateElo: _updateElo } = require('../services/eloService');
const { createClient } = require('@supabase/supabase-js');

module.exports = function registerSocketHandlers(io, supabase) {
  // ── Shared private-room registry (all game types) ─────────────
  const pendingPrivateRooms = new Map(); // code → { gameType, p1, createdAt }
const userQueues = new Set(); // userId → currently in a queue (prevents dual-tab double-join)
  // Returns true if user is in a queue OR in an active match (lock held until settlement)
  const inMatchOrQueue = (uid) => userQueues.has(uid) || isLocked(uid);
  const chatBanned = new Set(); // userId → banned from chat

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

    // ── Auth ──────────────────────────────────────────────────────────
    socket.on('authenticate', async ({ token }) => {
      try {
        const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        const { data: { user }, error } = await anonClient.auth.getUser(token);
        if (error || !user) { socket.emit('error', { message: 'Authentication failed' }); return; }
        const { data: profile } = await supabase
          .from('profiles').select('id,username,elo,c_coins,profile_color,current_streak').eq('id', user.id).single();
        if (!profile) { socket.emit('error', { message: 'Profile not found' }); return; }
        authenticatedUser = { userId: user.id, ...profile };
        socket._authenticatedUserId = user.id;
        socket.emit('authenticated', { userId: user.id, username: profile.username });
      } catch { socket.emit('error', { message: 'Authentication error' }); }
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

    // ════════════════════════════════════════════════════════════════
    //  REACTION DUEL
    // ════════════════════════════════════════════════════════════════
    socket.on('join_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();

      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }

      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      userQueues.add(authenticatedUser.userId);
      const match = addToQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startReactionMatch(io, supabase, match);
      } else {
        socket.emit('queue_joined', { position: 'waiting' });
      }
    });

    socket.on('leave_queue', () => {
      removeFromQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      socket.emit('queue_left');
    });

    // Instant bot match
    socket.on('play_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
      const { data: profile } = await supabase
        .from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
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
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      const bot = createBotPlayer(entryFee, 'reaction');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const roomId = createDirectRoom(player, bot);
      socket.join(roomId);
      socket.emit('match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startCountdown(io, supabase, roomId);
    });

    socket.on('create_private', async ({ entryFee = 0 }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      if (entryFee > 0) {
        const { data: pf } = await supabase.from('profiles').select('c_coins').eq('id', authenticatedUser.userId).single();
        if ((pf?.c_coins ?? 0) < entryFee) return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: authenticatedUser.username, elo: authenticatedUser.elo, entryFee,
      };
      const { roomId, inviteCode } = createPrivateRoom(player, entryFee);
      socket.join(roomId);
      socket.emit('private_created', { roomId, inviteCode });
    });

    socket.on('join_private', async ({ inviteCode }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,elo,username').eq('id', authenticatedUser.userId).single();
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo,
      };
      const result = joinPrivateRoom(player, inviteCode.toUpperCase());
      if (!result) return socket.emit('error', { message: 'Invalid or expired invite code' });
      const { roomId, room } = result;
      socket.join(roomId);
      const host = room.players[0];
      if (!host.isBot) {
        io.to(host.socketId).emit('match_found', {
          roomId, opponent: { userId: player.userId, username: player.username, elo: player.elo },
          entryFee: room.entryFee,
        });
      }
      socket.emit('match_found', {
        roomId, opponent: { userId: host.userId, username: host.username, elo: host.elo },
        entryFee: room.entryFee,
      });
      startCountdown(io, supabase, roomId);
    });

    socket.on('player_click', async ({ roomId, clientTime }) => {
      if (!authenticatedUser) return;
      if (!checkSocketClickRate(socket.id)) return socket.emit('error', { message: 'Too fast' });
      await handleClick(io, supabase, roomId, socket.id, clientTime || Date.now());
    });

    socket.on('rematch_request', ({ roomId }) => {
      const room = getRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('rematch_requested');
      // If all real players agreed (bot auto-agrees)
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown'; room.goTime = null;
        room.clicks = {}; room.clickReceived = false; room.rematches = {};
        room.round = 1;
        room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
        startCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  TYPING RACE
    // ════════════════════════════════════════════════════════════════
    socket.on('join_type_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();

      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }

      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      userQueues.add(authenticatedUser.userId);
      incrementCount('type', socket.id, entryFee, currency);
      const match = addToTypeQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startTypeMatch(io, supabase, match);
      } else {
        socket.emit('type_queue_joined', { position: 'waiting' });
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'type',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
      }
    });

    socket.on('leave_type_queue', () => {
      removeFromTypeQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('type', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
      socket.emit('type_queue_left');
    });

    // Instant bot match for typing
    socket.on('play_type_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
      const { data: profile } = await supabase
        .from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
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
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      const bot = createBotPlayer(entryFee, 'type');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectTypeRoom(player, bot);
      socket.join(roomId);
      incrementCount('type', socket.id, entryFee, currency);
      socket.emit('type_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startTypeCountdown(io, roomId);
    });

    socket.on('type_progress', ({ roomId, position }) => {
      if (!authenticatedUser) return;
      handleTypeProgress(io, roomId, socket.id, position);
    });

    socket.on('type_complete', async ({ roomId }) => {
      if (!authenticatedUser) return;
      const room = getTypeRoom(roomId);
      if (!room) return;
      const loser = room.players.find(p => p.socketId !== socket.id);
      await resolveTypeMatch(io, supabase, roomId, socket.id, loser?.socketId, 'complete');
    });

    socket.on('type_rematch_request', ({ roomId }) => {
      const room = getTypeRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('type_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        const text = room.text; // reuse same text
        room.state = 'countdown'; room.startTime = null; room.rematches = {};
        room.progress = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
        startTypeCountdown(io, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  MEMORY MATCH
    // ════════════════════════════════════════════════════════════════
    socket.on('join_memory_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();

      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }

      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      userQueues.add(authenticatedUser.userId);
      const match = addToMemoryQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startMemoryMatch(io, supabase, match);
      } else {
        socket.emit('memory_queue_joined', { position: 'waiting' });
      }
    });

    socket.on('leave_memory_queue', () => {
      removeFromMemoryQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      socket.emit('memory_queue_left');
    });

    socket.on('play_memory_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
      const { data: profile } = await supabase
        .from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
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
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      const bot = createBotPlayer(entryFee, 'memory');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectMemoryRoom(player, bot);
      socket.join(roomId);
      socket.emit('memory_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startMemoryCountdown(io, supabase, roomId);
    });

    socket.on('memory_tile_click', ({ roomId, tileIndex }) => {
      if (!authenticatedUser) return;
      handleMemoryClick(io, supabase, roomId, socket.id, tileIndex);
    });

    socket.on('memory_rematch_request', ({ roomId }) => {
      const room = getMemoryRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('memory_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown';
        room.sequence = makeSequence();
        room.progress = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
        room.rematches = {};
        room.round = 1;
        room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
        startMemoryCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  AIM TRAINER
    // ════════════════════════════════════════════════════════════════
    socket.on('join_aim_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();

      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }

      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      userQueues.add(authenticatedUser.userId);
      const match = addToAimQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startAimMatch(io, supabase, match);
      } else {
        socket.emit('aim_queue_joined', { position: 'waiting' });
      }
    });

    socket.on('leave_aim_queue', () => {
      removeFromAimQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      socket.emit('aim_queue_left');
    });

    socket.on('play_aim_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
      const { data: profile } = await supabase
        .from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
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
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      const bot = createBotPlayer(entryFee, 'aim');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectAimRoom(player, bot);
      socket.join(roomId);
      socket.emit('aim_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startAimCountdown(io, supabase, roomId);
    });

    socket.on('aim_click', async ({ roomId, targetId }) => {
      if (!authenticatedUser) return;
      await handleAimClick(io, supabase, roomId, socket.id, targetId);
    });

    socket.on('aim_rematch_request', ({ roomId }) => {
      const room = getAimRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('aim_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown';
        room.scores = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
        room.currentTarget = null;
        room.rematches = {};
        room.round = 1;
        room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
        startAimCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  CONNECT FOUR
    // ════════════════════════════════════════════════════════════════
    socket.on('join_c4_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();

      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }

      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      userQueues.add(authenticatedUser.userId);
      incrementCount('c4', socket.id, entryFee, currency);
      const match = addToC4Queue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startC4Match(io, supabase, match);
      } else {
        socket.emit('c4_queue_joined', { position: 'waiting' });
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'c4',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
      }
    });

    socket.on('leave_c4_queue', () => {
      removeFromC4Queue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('c4', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
      socket.emit('c4_queue_left');
    });

    socket.on('play_c4_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0; // bot games are free for coins
      const { data: profile } = await supabase
        .from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
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
      const player = {
        socketId: socket.id, userId: authenticatedUser.userId,
        username: profile.username, elo: profile.elo, entryFee, currency,
      };
      const bot = createBotPlayer(entryFee, 'c4');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectC4Room(player, bot);
      socket.join(roomId);
      incrementCount('c4', socket.id, entryFee, currency);
      socket.emit('c4_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startC4Countdown(io, supabase, roomId);
    });

    socket.on('c4_drop', async ({ roomId, col }) => {
      if (!authenticatedUser) return;
      await handleC4Drop(io, supabase, roomId, socket.id, col);
    });

    socket.on('c4_rematch_request', ({ roomId }) => {
      const room = getC4Room(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('c4_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown';
        room.board = emptyBoard();
        room.turnIndex = 0;
        room.rematches = {};
        startC4Countdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  DART GAME
    // ════════════════════════════════════════════════════════════════
    socket.on('join_dart_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      const match = addToDartQueue(player);
      if (match) { userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId); _startDartMatch(io, supabase, match); }
      else socket.emit('dart_queue_joined');
    });

    socket.on('leave_dart_queue', () => { removeFromDartQueue(socket.id); if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); } });

    socket.on('play_dart_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'dart');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectDartRoom(player, bot);
      socket.join(roomId);
      socket.emit('dart_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startDartCountdown(io, supabase, roomId);
    });

    socket.on('dart_shoot', async ({ roomId, xAim, yPower }) => {
      if (!authenticatedUser) return;
      await handleDartShoot(io, supabase, roomId, socket.id, xAim, yPower);
    });

    socket.on('dart_rematch_request', ({ roomId }) => {
      const room = getDartRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('dart_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown'; room.round = 0;
        room.scores = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
        room.roundShots = {}; room.rematches = {};
        startDartCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  ASTEROIDS
    // ════════════════════════════════════════════════════════════════
    socket.on('join_asteroid_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      const match = addToAsteroidQueue(player);
      if (match) { userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId); _startAsteroidMatch(io, supabase, match); }
      else socket.emit('asteroid_queue_joined');
    });

    socket.on('leave_asteroid_queue', () => { removeFromAsteroidQueue(socket.id); if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); } });

    socket.on('play_asteroid_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'asteroids');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectAsteroidRoom(player, bot);
      socket.join(roomId);
      socket.emit('asteroid_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startAsteroidCountdown(io, supabase, roomId);
    });

    socket.on('asteroid_died', ({ roomId, score = 0 }) => {
      if (!authenticatedUser) return;
      const room = getAsteroidRoom(roomId);
      if (room) room.scores[socket.id] = score;
      handleAsteroidDeath(io, supabase, roomId, socket.id);
    });

    socket.on('asteroid_score_ping', ({ roomId, score }) => {
      if (!authenticatedUser) return;
      const room = getAsteroidRoom(roomId);
      if (!room || room.state !== 'active') return;
      room.scores[socket.id] = score || 0;
    });

    socket.on('asteroid_rematch_request', ({ roomId }) => {
      const room = getAsteroidRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('asteroid_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown'; room.startTime = null; room.rematches = {};
        startAsteroidCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  STARSHIP
    // ════════════════════════════════════════════════════════════════
    socket.on('join_starship_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      const match = addToStarshipQueue(player);
      if (match) {
        const { roomId, p1, p2 } = match;
        userQueues.delete(p1.userId); userQueues.delete(p2.userId);
        const s1 = io.sockets.sockets.get(p1.socketId);
        const s2 = io.sockets.sockets.get(p2.socketId);
        if (s1) { s1.join(roomId); s1.emit('starship_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee }); }
        if (s2) { s2.join(roomId); s2.emit('starship_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee }); }
        startStarshipCountdown(io, supabase, roomId);
      } else {
        socket.emit('starship_queue_joined');
      }
    });

    socket.on('leave_starship_queue', () => { removeFromStarshipQueue(socket.id); if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); } });

    socket.on('play_starship_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot    = { socketId: null, userId: 'bot_ssp_' + uuidv4(), username: 'Duely Bot', elo: 1000, entryFee, currency, isBot: true };
      const { roomId } = createDirectStarshipRoom(player, bot);
      socket.join(roomId);
      socket.emit('starship_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startStarshipCountdown(io, supabase, roomId);
    });

    socket.on('starship_died', ({ roomId, score = 0 }) => {
      if (!authenticatedUser) return;
      handleStarshipDeath(io, supabase, roomId, socket.id, score);
    });

    socket.on('starship_rematch_request', ({ roomId }) => {
      const room = getStarshipRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('starship_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown'; room.startTime = null; room.rematches = {}; room.scores = {};
        startStarshipCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  BLOCK BLAST
    // ════════════════════════════════════════════════════════════════
    socket.on('join_block_blast_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      incrementCount('block-blast', socket.id, entryFee, currency);
      const match = addToBlockBlastQueue(player);
      if (match) {
        const { roomId, p1, p2 } = match;
        userQueues.delete(p1.userId); userQueues.delete(p2.userId);
        const s1 = io.sockets.sockets.get(p1.socketId);
        const s2 = io.sockets.sockets.get(p2.socketId);
        if (s1) { s1.join(roomId); s1.emit('block_blast_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee }); }
        if (s2) { s2.join(roomId); s2.emit('block_blast_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee }); }
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'block_blast');
      bot.entryFee = entryFee;
      const { roomId } = createDirectBlockBlastRoom(player, bot);
      socket.join(roomId);
      incrementCount('block-blast', socket.id, entryFee, currency);
      socket.emit('block_blast_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startBlockBlastCountdown(io, supabase, roomId);
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
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('block_blast_opponent_score', { score: score || 0 });
      if (!room.isSolo) {
        const [rp1, rp2] = room.players;
        const s1 = socket.id === rp1.socketId ? (score || 0) : (room.scores[rp1.socketId] || 0);
        const s2 = socket.id === rp2.socketId ? (score || 0) : (room.scores[rp2.socketId] || 0);
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

    // ════════════════════════════════════════════════════════════════
    //  PIANO TILES
    // ════════════════════════════════════════════════════════════════
    socket.on('join_piano_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      incrementCount('piano', socket.id, entryFee, currency);
      const match = addToPianoQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startPianoMatch(io, supabase, match);
      } else {
        socket.emit('piano_queue_joined');
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'piano',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
      }
    });

    socket.on('leave_piano_queue', () => {
      removeFromPianoQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('piano', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
    });

    socket.on('play_piano_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'piano');
      bot.entryFee = entryFee;
      const { roomId } = createDirectPianoRoom(player, bot);
      socket.join(roomId);
      incrementCount('piano', socket.id, entryFee, currency);
      socket.emit('piano_match_found', { roomId, opponent: null, entryFee, vsBot: true });
      startPianoCountdown(io, supabase, roomId);
    });

    socket.on('piano_died', async ({ roomId, tilesHit }) => {
      if (!authenticatedUser) return;
      await handlePianoDeath(io, supabase, roomId, socket.id, tilesHit || 0);
    });

    socket.on('piano_score_ping', ({ roomId, tilesHit }) => {
      if (!authenticatedUser) return;
      handlePianoScorePing(io, roomId, socket.id, tilesHit || 0);
    });

    socket.on('piano_progress', ({ roomId, tilesHit }) => {
      const room = getPianoRoom(roomId);
      if (!room) return;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('piano_opponent_progress', { tilesHit });
    });

    socket.on('piano_rematch_request', ({ roomId }) => {
      const room = getPianoRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('piano_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown';
        room.seed = Math.floor(Math.random() * 2147483647);
        room.rematches = {};
        startPianoCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  CLICK RACE
    // ════════════════════════════════════════════════════════════════
    socket.on('join_click_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      const match = addToClickQueue(player);
      if (match) { userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId); _startClickMatch(io, supabase, match); }
      else socket.emit('click_queue_joined');
    });

    socket.on('leave_click_queue', () => { removeFromClickQueue(socket.id); if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); } });

    socket.on('play_click_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'click');
      bot.entryFee = entryFee;
      const { roomId } = createDirectClickRoom(player, bot);
      socket.join(roomId);
      socket.emit('click_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startClickRaceCountdown(io, supabase, roomId);
    });

    socket.on('click_race_click', ({ roomId }) => {
      if (!authenticatedUser) return;
      handleClickRaceClick(roomId, socket.id);
    });

    socket.on('click_rematch_request', ({ roomId }) => {
      const room = getClickRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('click_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'countdown';
        room.clicks = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
        room.lastClickAt = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
        room.botIntervals = [];
        room.rematches = {};
        room.round = 1;
        room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
        startClickRaceCountdown(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  TIC TAC TOE
    // ════════════════════════════════════════════════════════════════
    socket.on('join_ttt_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      const match = addToTTTQueue(player);
      if (match) { userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId); _startTTTMatch(io, supabase, match); }
      else socket.emit('ttt_queue_joined');
    });

    socket.on('leave_ttt_queue', () => { removeFromTTTQueue(socket.id); if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); } });

    socket.on('play_ttt_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'ttt');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectTTTRoom(player, bot);
      socket.join(roomId);
      const room = getTTTRoom(roomId);
      socket.emit('ttt_match_found', {
        roomId,
        opponent: { userId: bot.userId, username: bot.username, elo: bot.elo },
        entryFee,
        vsBot: true,
        marks: Object.fromEntries(room.players.map(p => [p.userId, room.marks[p.socketId]])),
      });
      startTTTRound(io, supabase, roomId);
    });

    socket.on('ttt_move', ({ roomId, cell }) => {
      if (!authenticatedUser) return;
      handleTTTMove(io, supabase, roomId, socket.id, cell);
    });

    socket.on('ttt_rematch_request', ({ roomId }) => {
      const room = getTTTRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('ttt_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.rematches = {};
        room.round = 1;
        room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
        startTTTRound(io, supabase, roomId);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  TETRIS
    // ════════════════════════════════════════════════════════════════
    socket.on('join_tetris_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      incrementCount('tetris', socket.id, entryFee, currency);
      const match = addToTetrisQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startTetrisMatch(io, supabase, match);
      } else {
        socket.emit('tetris_queue_joined');
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'tetris',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
      }
    });

    socket.on('leave_tetris_queue', () => {
      removeFromTetrisQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('tetris', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
    });

    socket.on('play_tetris_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'tetris');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectTetrisRoom(player, bot);
      socket.join(roomId);
      incrementCount('tetris', socket.id, entryFee, currency);
      socket.emit('tetris_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startTetrisMatch(io, roomId, supabase);
    });

    socket.on('tetris_topped_out', async ({ roomId, linesCleared, score }) => {
      if (!authenticatedUser) return;
      await handleTetrisToppedOut(io, supabase, roomId, socket.id, linesCleared || 0, score || 0);
    });

    socket.on('tetris_board_update', ({ roomId, board }) => {
      if (!authenticatedUser) return;
      handleTetrisBoardUpdate(io, roomId, socket.id, board);
    });

    socket.on('tetris_score_ping', ({ roomId, linesCleared, score }) => {
      if (!authenticatedUser) return;
      const room = getTetrisRoom(roomId);
      if (!room || room.state !== 'active') return;
      room.lines[socket.id] = linesCleared || 0;
      if (score !== undefined && room.scores) room.scores[socket.id] = score || 0;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('tetris_opponent_lines', { linesCleared: linesCleared || 0 });
      if (!room.players.some(p => p.isBot)) {
        const [rp1, rp2] = room.players;
        const sc1 = room.scores ? (room.scores[rp1.socketId] || 0) : 0;
        const sc2 = room.scores ? (room.scores[rp2.socketId] || 0) : 0;
        io.emit('active_game_score', { id: roomId, score1: sc1, score2: sc2 });
      }
    });

    socket.on('tetris_garbage', ({ roomId, rows }) => {
      if (!authenticatedUser) return;
      const room = getTetrisRoom(roomId);
      if (!room || room.state !== 'active') return;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('tetris_garbage_incoming', { rows: Math.min(rows, 4) });
    });

    socket.on('tetris_rematch_request', ({ roomId }) => {
      const room = getTetrisRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('tetris_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.rematches = {};
        room.round = 1;
        room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
        startTetrisMatch(io, roomId, supabase);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  CHESS
    // ════════════════════════════════════════════════════════════════
    socket.on('join_chess_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      incrementCount('chess', socket.id, entryFee, currency);
      const match = addToChessQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        _startChessMatch(io, supabase, match);
      } else {
        socket.emit('chess_queue_joined');
        io.emit('queue_entry_added', {
          id: socket.id,
          gameType: 'chess',
          entryFee,
          currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
      }
    });

    socket.on('leave_chess_queue', () => {
      removeFromChessQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('chess', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
    });

    socket.on('play_chess_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = createBotPlayer(entryFee, 'chess');
      if (!bot) return socket.emit('error', { message: 'Bots are disabled' });
      bot.entryFee = entryFee;
      const { roomId } = createDirectChessRoom(player, bot);
      socket.join(roomId);
      incrementCount('chess', socket.id, entryFee, currency);
      const room = getChessRoom(roomId);
      const myColor = room.colors[player.userId];
      if (room) room.state = 'active';
      socket.emit('chess_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true, myColor });
      // Start timer if human plays white (goes first)
      if (myColor === 'w') startChessTimer(io, supabase, roomId);
    });

    socket.on('chess_move', ({ roomId, from, to, boardSnapshot }) => {
      if (!authenticatedUser) return;
      const chessRoom = getChessRoom(roomId);
      if (chessRoom && boardSnapshot) chessRoom.boardSnapshot = boardSnapshot;
      handleChessMove(io, supabase, roomId, socket.id, from, to);
    });

    // Bot finished its turn client-side — restart the human player's timer
    socket.on('chess_bot_done', ({ roomId }) => {
      if (!authenticatedUser) return;
      const room = getChessRoom(roomId);
      if (!room || room.state !== 'active') return;
      const bot = room.players.find(p => p.isBot);
      if (!bot) return;
      clearChessTimerForRoom(roomId);
      if (room.consecutiveMisses) room.consecutiveMisses[bot.userId] = 0;
      room.currentTurn = room.colors[bot.userId] === 'w' ? 'b' : 'w';
      startChessTimer(io, supabase, roomId);
    });

    socket.on('chess_game_over', async ({ roomId, winnerSocketId, reason }) => {
      if (!authenticatedUser) return;
      const sid = winnerSocketId === null ? null : (winnerSocketId || socket.id);
      await handleChessGameOver(io, supabase, roomId, sid, reason || 'checkmate');
    });

    socket.on('chess_resign', async ({ roomId }) => {
      if (!authenticatedUser) return;
      const room = getChessRoom(roomId);
      if (!room) return;
      const opp = room.players.find(p => p.socketId !== socket.id);
      const winnerId = opp ? opp.socketId : null;
      await handleChessGameOver(io, supabase, roomId, winnerId, 'resign');
    });

    socket.on('chess_rematch_request', ({ roomId }) => {
      const room = getChessRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('chess_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.rematches = {};
        // Swap colors for rematch
        const [p1, p2] = room.players;
        const tmp = room.colors[p1.userId];
        room.colors[p1.userId] = room.colors[p2.userId];
        room.colors[p2.userId] = tmp;
        room.currentTurn = 'w';
        _startChessMatch(io, supabase, { roomId, p1: room.players[0], p2: room.players[1] });
      }
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
      pendingPrivateRooms.set(code, { gameType, p1, createdAt: Date.now() });
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
          break;
        }
      }
    });

    socket.on('join_private_room', async ({ gameType, code }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const key = (code || '').toUpperCase().trim();
      const pending = pendingPrivateRooms.get(key);
      if (!pending) return socket.emit('error', { message: 'Room not found. Check the code and try again.' });
      if (pending.gameType !== gameType) return socket.emit('error', { message: 'Wrong game type for this code.' });
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
      const p1 = pending.p1;
      const p2 = { socketId: socket.id, userId: authenticatedUser.userId, username: profile2.username, elo: profile2.elo, entryFee, currency };

      _pairPrivatePlayers(gameType, p1, p2, io, supabase);
    });

    // ════════════════════════════════════════════════════════════════
    //  CROSSROAD
    // ════════════════════════════════════════════════════════════════
    socket.on('join_crossroad_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (inMatchOrQueue(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a match or queue — finish or leave your current game first.' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      const match = addToCrossroadQueue(player);
      if (match) {
        const { roomId, p1, p2 } = match;
        userQueues.delete(p1.userId); userQueues.delete(p2.userId);
        const s1 = io.sockets.sockets.get(p1.socketId);
        const s2 = io.sockets.sockets.get(p2.socketId);
        if (s1) { s1.join(roomId); s1.emit('crossroad_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee }); }
        if (s2) { s2.join(roomId); s2.emit('crossroad_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee }); }
        startCrossroadRound(io, roomId);
      } else {
        socket.emit('crossroad_queue_joined');
      }
    });

    socket.on('leave_crossroad_queue', () => { removeFromCrossroadQueue(socket.id); if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); } });

    socket.on('play_crossroad_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot    = { socketId: null, userId: 'bot_crd_' + uuidv4(), username: 'Duely Bot', elo: 1000, entryFee, currency, isBot: true };
      const { roomId } = createDirectCrossroadRoom(player, bot);
      socket.join(roomId);
      socket.emit('crossroad_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startCrossroadRound(io, roomId);
    });

    socket.on('crossroad_crossed', ({ roomId }) => {
      if (!authenticatedUser) return;
      handleCrossroadGoal(io, supabase, roomId, socket.id);
    });

    socket.on('crossroad_progress', ({ roomId, row }) => {
      if (!authenticatedUser) return;
      handleCrossroadProgress(io, roomId, socket.id, row);
    });

    socket.on('crossroad_rematch_request', ({ roomId }) => {
      const room = getCrossroadRoom(roomId);
      if (!room) return;
      room.rematches = room.rematches || {};
      room.rematches[socket.id] = true;
      const opp = room.players.find(p => p.socketId !== socket.id);
      if (opp && !opp.isBot) io.to(opp.socketId).emit('crossroad_rematch_requested');
      if (room.players.every(p => p.isBot || room.rematches[p.socketId])) {
        room.state = 'waiting'; room.rematches = {}; room.roundWins = {};
        room.players.forEach(p => { room.roundWins[p.userId] = 0; });
        room.round = 1;
        startCrossroadRound(io, roomId);
      }
    });

    // ── Spectator ─────────────────────────────────────────────────────
    socket.on('join_spectator', ({ roomId }) => {
      if (!authenticatedUser || !roomId) return;
      socket.join(roomId + '_spectators');
      // Send current Tetris boards if available
      const tRoom = getTetrisRoom(roomId);
      if (tRoom?.boards) {
        for (const [sid, board] of Object.entries(tRoom.boards)) {
          const playerIdx = tRoom.players.findIndex(p => p.socketId === sid);
          if (playerIdx !== -1) socket.emit('tetris_spectator_board', { playerIdx, board });
        }
        socket.emit('spectator_players', {
          players: tRoom.players.map((p, i) => ({ playerIdx: i, userId: p.userId, username: p.username })),
        });
      }
    });

    socket.on('leave_spectator', ({ roomId }) => {
      if (!roomId) return;
      socket.leave(roomId + '_spectators');
    });

    // ════════════════════════════════════════════════════════════════
    //  SCRABBLE
    // ════════════════════════════════════════════════════════════════
    socket.on('join_scrabble_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (userQueues.has(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a queue' });
      const { data: profile } = await supabase
        .from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee)
          return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee)
          return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      incrementCount('scrabble', socket.id, entryFee, currency);
      const match = addToScrabbleQueue(player);
      if (match) {
        const { roomId, p1, p2 } = match;
        userQueues.delete(p1.userId); userQueues.delete(p2.userId);
        const s1 = io.sockets.sockets.get(p1.socketId);
        const s2 = io.sockets.sockets.get(p2.socketId);
        if (s1) { s1.join(roomId); s1.emit('scrabble_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee }); }
        if (s2) { s2.join(roomId); s2.emit('scrabble_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee }); }
        io.emit('queue_entry_removed', { id: p1.socketId });
        io.emit('queue_entry_removed', { id: p2.socketId });
        // Brief countdown then start
        io.to(roomId).emit('scrabble_countdown', { count: 3 });
        await new Promise(r => setTimeout(r, 1000));
        io.to(roomId).emit('scrabble_countdown', { count: 2 });
        await new Promise(r => setTimeout(r, 1000));
        io.to(roomId).emit('scrabble_countdown', { count: 1 });
        await new Promise(r => setTimeout(r, 1000));
        startScrabbleGame(io, supabase, roomId);
      } else {
        socket.emit('scrabble_queue_joined');
        io.emit('queue_entry_added', {
          id: socket.id, gameType: 'scrabble', entryFee, currency,
          username: authenticatedUser.username || 'Player',
          elo: authenticatedUser.elo || 1000,
          profileColor: authenticatedUser.profile_color || '#1E90FF',
          currentStreak: authenticatedUser.current_streak || 0,
        });
      }
    });

    socket.on('leave_scrabble_queue', () => {
      removeFromScrabbleQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('scrabble', socket.id);
      io.emit('queue_entry_removed', { id: socket.id });
      socket.emit('scrabble_queue_left');
    });

    socket.on('play_scrabble_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0; // bot games free for coins
      const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        try {
          if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
          else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
        } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const { v4: uuid } = require('uuid');
      const botSocketId = 'bot_scrabble_' + uuid();
      const bot = { socketId: botSocketId, userId: botSocketId, username: 'Duely Bot', elo: 1000, entryFee, currency, isBot: true };
      const { roomId } = createDirectScrabbleRoom(player, bot);
      socket.join(roomId);
      socket.emit('scrabble_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      socket.emit('scrabble_countdown', { count: 3 });
      await new Promise(r => setTimeout(r, 1000));
      socket.emit('scrabble_countdown', { count: 2 });
      await new Promise(r => setTimeout(r, 1000));
      socket.emit('scrabble_countdown', { count: 1 });
      await new Promise(r => setTimeout(r, 1000));
      startScrabbleGame(io, supabase, roomId);
    });

    socket.on('scrabble_play_word', ({ roomId, placements }) => {
      if (!authenticatedUser) return;
      handleScrabblePlay(io, supabase, roomId, socket.id, placements || []);
    });

    socket.on('scrabble_skip', ({ roomId }) => {
      if (!authenticatedUser) return;
      handleScrabbleSkip(io, supabase, roomId, socket.id);
    });

    socket.on('scrabble_exchange', ({ roomId, letters }) => {
      if (!authenticatedUser) return;
      handleScrabbleExchange(io, supabase, roomId, socket.id, letters || []);
    });

    // ════════════════════════════════════════════════════════════════
    //  COIN FLIP
    // ════════════════════════════════════════════════════════════════
    socket.on('join_coin_flip_queue', async ({ entryFee = 0, currency = 'coins', side }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (!['heads', 'tails'].includes(side)) return socket.emit('error', { message: 'Pick heads or tails' });
      // Coin flip only allows PvP for coins; diamonds = bot only
      if (currency === 'diamonds') return socket.emit('error', { message: 'Diamond Coin Flip is vs bot only' });
      if (userQueues.has(authenticatedUser.userId))
        return socket.emit('error', { message: 'Already in a queue' });
      const { data: profile } = await supabase.from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0 && profile.c_coins < entryFee)
        return socket.emit('error', { message: 'Insufficient C Coins' });
      if (entryFee > 0) lockUser(authenticatedUser.userId);
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, side };
      userQueues.add(authenticatedUser.userId);
      incrementCount('coin-flip', socket.id, entryFee, currency);
      const match = addToCoinFlipQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        const s1 = io.sockets.sockets.get(match.p1.socketId);
        const s2 = io.sockets.sockets.get(match.p2.socketId);
        if (s1) { s1.join(match.roomId); s1.emit('coin_flip_match_found', { roomId: match.roomId, opponent: { userId: match.p2.userId, username: match.p2.username, elo: match.p2.elo }, side: match.p1.side, entryFee }); }
        if (s2) { s2.join(match.roomId); s2.emit('coin_flip_match_found', { roomId: match.roomId, opponent: { userId: match.p1.userId, username: match.p1.username, elo: match.p1.elo }, side: match.p2.side, entryFee }); }
        // Resolve after 3s animation
        setTimeout(() => resolveCoinFlip(io, supabase, match.roomId), 3000);
      } else {
        socket.emit('coin_flip_queue_joined', { side });
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
      if (!['heads', 'tails'].includes(side)) return socket.emit('error', { message: 'Pick heads or tails' });
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
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency, side };
      const botSide = side === 'heads' ? 'tails' : 'heads';
      const bot = { socketId: null, userId: 'bot_cf_' + uuidv4(), username: 'Duely Bot', elo: 1000, entryFee, currency, side: botSide, isBot: true };
      const roomId = 'coinflip_' + uuidv4();
      const { getCoinFlipRoom: _gcfr } = require('../services/coinFlipEngine');
      // Manually create the room without going through queue
      const cfRooms = require('../services/coinFlipEngine');
      const room = { roomId, players: [player, bot], entryFee, currency, state: 'active' };
      // Store via internal map — use resolveCoinFlip directly
      socket.join(roomId);
      socket.emit('coin_flip_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, side, entryFee, vsBot: true });
      // Resolve via internal logic — inject room directly
      const coinFlipMod = require('../services/coinFlipEngine');
      coinFlipMod.getCoinFlipRoom; // touch to ensure loaded
      // Resolve immediately after animation
      setTimeout(async () => {
        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        const playerWon = player.side === result;
        const winner = playerWon ? player : bot;
        const loser  = playerWon ? bot : player;
        const isFree = entryFee === 0;

        const { calculateNewRatings, applyEloUpdate: _applyElo } = require('../services/eloService');
        const { newWinnerElo, newLoserElo } = isFree
          ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
          : calculateNewRatings(winner.elo, loser.elo);

        let balanceChange = null;
        if (entryFee > 0) {
          try {
            balanceChange = await require('../services/walletService').settleBotMatch(supabase, player.userId, entryFee, currency, playerWon);
          } catch (e) { console.error('[coinflip bot]', e.message); }
        }
        let winnerStreak = 0, isFirstWin = false;
        if (!isFree) {
          if (playerWon) {
            try { await _applyElo(supabase, player.userId, newWinnerElo); } catch {}
            try { await supabase.rpc('increment_win', { uid: player.userId }); } catch {}
            try { ({ winnerStreak, isFirstWin } = await require('../services/eloService').updateStreaks(supabase, player.userId, null)); } catch {}
          } else {
            try { await _applyElo(supabase, player.userId, newLoserElo); } catch {}
            try { await supabase.rpc('increment_loss', { uid: player.userId }); } catch {}
            try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', player.userId); } catch {}
          }
        }
        try {
          await supabase.from('matches').insert({
            player1_id: player.userId, player2_id: null,
            winner_id: playerWon ? player.userId : null,
            game_type: 'coin_flip',
            entry_fee_c: currency === 'coins' ? entryFee : 0,
            entry_fee_diamonds: currency === 'diamonds' ? entryFee : 0,
          });
        } catch {}
        gameEvents.emit('game_ended', { socketIds: [socket.id] });
        socket.emit('coin_flip_result', {
          result,
          winnerId: winner.userId,
          loserId: loser.userId,
          winnerUsername: winner.username,
          loserUsername: loser.username,
          newWinnerElo,
          newLoserElo,
          balanceChange,
          currency,
          entryFee,
          winnerStreak: winnerStreak ?? 0,
          isFirstWin: isFirstWin ?? false,
        });
      }, 3000);
    });

    // ════════════════════════════════════════════════════════════════
    //  BLACKJACK
    // ════════════════════════════════════════════════════════════════
    socket.on('join_bj_queue', async ({ entryFee = 0, currency = 'coins' }) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (userQueues.has(authenticatedUser.userId)) return socket.emit('error', { message: 'Already in a queue' });
      const { data: profile } = await supabase.from('profiles').select('c_coins,diamonds,elo,username').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        if (currency === 'diamonds' && (profile.diamonds || 0) < entryFee) return socket.emit('error', { message: 'Insufficient diamonds' });
        if (currency === 'coins' && profile.c_coins < entryFee) return socket.emit('error', { message: 'Insufficient C Coins' });
        lockUser(authenticatedUser.userId);
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      userQueues.add(authenticatedUser.userId);
      incrementCount('blackjack', socket.id, entryFee, currency);
      const match = addToBlackjackQueue(player);
      if (match) {
        userQueues.delete(match.p1.userId); userQueues.delete(match.p2.userId);
        const s1 = io.sockets.sockets.get(match.p1.socketId);
        const s2 = io.sockets.sockets.get(match.p2.socketId);
        if (s1) { s1.join(match.roomId); s1.emit('bj_match_found', { roomId: match.roomId, opponent: { userId: match.p2.userId, username: match.p2.username, elo: match.p2.elo }, entryFee }); }
        if (s2) { s2.join(match.roomId); s2.emit('bj_match_found', { roomId: match.roomId, opponent: { userId: match.p1.userId, username: match.p1.username, elo: match.p1.elo }, entryFee }); }
        startBlackjackGame(io, supabase, match.roomId);
      } else {
        socket.emit('bj_queue_joined');
      }
    });

    socket.on('leave_bj_queue', () => {
      removeFromBlackjackQueue(socket.id);
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      decrementCount('blackjack', socket.id);
      socket.emit('bj_queue_left');
    });

    // ── Generic leave_all_queues: called when any game page unmounts ─────────────
    // Removes socket from every queue and clears the userQueues lock so they can
    // join a new queue immediately without getting "Already in a queue".
    socket.on('leave_all_queues', () => {
      removeFromQueue(socket.id);
      removeFromTypeQueue(socket.id);
      removeFromMemoryQueue(socket.id);
      removeFromAimQueue(socket.id);
      removeFromC4Queue(socket.id);
      removeFromDartQueue(socket.id);
      removeFromAsteroidQueue(socket.id);
      removeFromPianoQueue(socket.id);
      removeFromClickQueue(socket.id);
      removeFromTTTQueue(socket.id);
      removeFromTetrisQueue(socket.id);
      removeFromChessQueue(socket.id);
      removeFromStarshipQueue(socket.id);
      removeFromBlockBlastQueue(socket.id);
      removeFromCrossroadQueue(socket.id);
      removeFromScrabbleQueue(socket.id);
      removeFromCoinFlipQueue(socket.id);
      removeFromBlackjackQueue(socket.id);
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
      const roomLookups = [
        [getRoomBySocket,           deleteRoom,           'reaction'],
        [getTypeRoomBySocket,       deleteTypeRoom,       'type'],
        [getMemoryRoomBySocket,     deleteMemoryRoom,     'memory'],
        [getAimRoomBySocket,        deleteAimRoom,        'aim'],
        [getC4RoomBySocket,         deleteC4Room,         'connectFour'],
        [getDartRoomBySocket,       deleteDartRoom,       'darts'],
        [getAsteroidRoomBySocket,   deleteAsteroidRoom,   'asteroids'],
        [getPianoRoomBySocket,      deletePianoRoom,      'piano'],
        [getClickRoomBySocket,      deleteClickRoom,      'clickRace'],
        [getTTTRoomBySocket,        deleteTTTRoom,        'tictactoe'],
        [getTetrisRoomBySocket,     deleteTetrisRoom,     'tetris'],
        [getChessRoomBySocket,      deleteChessRoom,      'chess'],
        [getStarshipRoomBySocket,   deleteStarshipRoom,   'starship'],
        [getBlockBlastRoomBySocket, deleteBlockBlastRoom, 'blockBlast'],
        [getCrossroadRoomBySocket,  deleteCrossroadRoom,  'crossroad'],
        [getScrabbleRoomBySocket,   deleteScrabbleRoom,   'scrabble'],
        [getCoinFlipRoomBySocket,   deleteCoinFlipRoom,   'coin_flip'],
        [getBlackjackRoomBySocket,  deleteBlackjackRoom,  'blackjack'],
      ];
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
        break;
      }
    });

    socket.on('play_bj_vs_bot', async ({ entryFee = 0, currency = 'coins' } = {}) => {
      if (!authenticatedUser) return socket.emit('error', { message: 'Not authenticated' });
      if (currency !== 'diamonds') entryFee = 0;
      const { data: profile } = await supabase.from('profiles').select('elo,username,c_coins,diamonds').eq('id', authenticatedUser.userId).single();
      if (entryFee > 0) {
        try {
          if (currency === 'diamonds') await deductDiamonds(supabase, authenticatedUser.userId, Math.floor(entryFee));
          else await deductCoins(supabase, authenticatedUser.userId, parseFloat(entryFee));
        } catch (e) { return socket.emit('error', { message: e.message || 'Insufficient balance' }); }
      }
      const player = { socketId: socket.id, userId: authenticatedUser.userId, username: profile.username, elo: profile.elo, entryFee, currency };
      const bot = { socketId: null, userId: 'bot_bj_' + uuidv4(), username: 'Duely Bot', elo: 1000, entryFee, currency, isBot: true };
      const { roomId } = createDirectBlackjackRoom(player, bot);
      socket.join(roomId);
      incrementCount('blackjack', socket.id, entryFee, currency);
      socket.emit('bj_match_found', { roomId, opponent: { userId: bot.userId, username: bot.username, elo: bot.elo }, entryFee, vsBot: true });
      startBlackjackGame(io, supabase, roomId);
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

    // ── Spectator ─────────────────────────────────────────────────────────────
    socket.on('join_spectator', ({ roomId }) => {
      if (!authenticatedUser) return;
      socket.join(roomId + '_spectators');
      // Send current Tetris boards if available
      const { getTetrisRoom } = require('../services/tetrisEngine');
      const tRoom = getTetrisRoom(roomId);
      if (tRoom?.boards) {
        for (let idx = 0; idx < tRoom.players.length; idx++) {
          const p = tRoom.players[idx];
          const board = tRoom.boards[p.socketId];
          if (board) socket.emit('tetris_spectator_board', { playerIdx: idx, board });
        }
      }
      // Send current Scrabble board if available
      const sRoom = getScrabbleRoom(roomId);
      if (sRoom?.board) {
        socket.emit('scrabble_spectator_board', { board: sRoom.board, scores: sRoom.scores });
      }
    });

    socket.on('leave_spectator', ({ roomId }) => {
      socket.leave(roomId + '_spectators');
    });

    // ── Disconnect ────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      if (authenticatedUser) { unlockUser(authenticatedUser.userId); userQueues.delete(authenticatedUser.userId); }
      cleanupSocket(socket.id);
      for (const [code, room] of pendingPrivateRooms) {
        if (room.p1.socketId === socket.id) {
          pendingPrivateRooms.delete(code);
          if ((room.p1.entryFee || 0) > 0) unlockUser(room.p1.userId);
          break;
        }
      }
      // Decrement player count if socket was tracked for a game
      // (decrementCount also cleans up socketGameMap and socketBetMap entries)
      if (socketGameMap[socket.id]) {
        decrementCount(socketGameMap[socket.id], socket.id);
      }

      // Remove from all queues
      removeFromQueue(socket.id);
      removeFromTypeQueue(socket.id);
      removeFromMemoryQueue(socket.id);
      removeFromAimQueue(socket.id);
      removeFromC4Queue(socket.id);
      removeFromDartQueue(socket.id);
      removeFromAsteroidQueue(socket.id);
      removeFromPianoQueue(socket.id);
      removeFromClickQueue(socket.id);
      removeFromTTTQueue(socket.id);
      removeFromTetrisQueue(socket.id);
      removeFromChessQueue(socket.id);
      removeFromStarshipQueue(socket.id);
      removeFromBlockBlastQueue(socket.id);
      removeFromCrossroadQueue(socket.id);
      removeFromScrabbleQueue(socket.id);
      removeFromCoinFlipQueue(socket.id);
      removeFromBlackjackQueue(socket.id);
      // Broadcast queue entry removal so Play Now page stays in sync
      io.emit('queue_entry_removed', { id: socket.id });

      // Settle/forfeit any active rooms
      const roomLookups = [
        [getRoomBySocket,         deleteRoom,          'reaction'],
        [getTypeRoomBySocket,     deleteTypeRoom,      'type'],
        [getMemoryRoomBySocket,   deleteMemoryRoom,    'memory'],
        [getAimRoomBySocket,      deleteAimRoom,       'aim'],
        [getC4RoomBySocket,       deleteC4Room,        'connectFour'],
        [getDartRoomBySocket,     deleteDartRoom,      'darts'],
        [getAsteroidRoomBySocket, deleteAsteroidRoom,  'asteroids'],
        [getPianoRoomBySocket,    deletePianoRoom,     'piano'],
        [getClickRoomBySocket,    deleteClickRoom,     'clickRace'],
        [getTTTRoomBySocket,      deleteTTTRoom,       'tictactoe'],
        [getTetrisRoomBySocket,   deleteTetrisRoom,    'tetris'],
        [getChessRoomBySocket,    deleteChessRoom,     'chess'],
        [getStarshipRoomBySocket, deleteStarshipRoom,  'starship'],
        [getBlockBlastRoomBySocket, deleteBlockBlastRoom, 'blockBlast'],
        [getCrossroadRoomBySocket, deleteCrossroadRoom, 'crossroad'],
        [getScrabbleRoomBySocket,   deleteScrabbleRoom,   'scrabble'],
        [getCoinFlipRoomBySocket,   deleteCoinFlipRoom,   'coin_flip'],
        [getBlackjackRoomBySocket,  deleteBlackjackRoom,  'blackjack'],
      ];
      for (const [getFn, delFn, gameType] of roomLookups) {
        const found = getFn(socket.id);
        if (!found) continue;
        const { room } = found;

        const leaver = room.players?.find(p => p.socketId === socket.id);
        if (!leaver || leaver.isBot) {
          await _handleForfeit(io, supabase, found, socket.id, delFn, gameType);
          continue;
        }
        if (room.state === 'finished') {
          delFn(found.roomId);
          continue;
        }

        // Immediate forfeit — includes 'waiting' (countdown phase) so stayer is notified
        await _handleForfeit(io, supabase, found, socket.id, delFn, gameType);
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

    if (fee > 0 && stayer.isBot) {
      // Human forfeited a bot game — they lose their bet
      try {
        await settleBotMatch(supabase, leaver.userId, fee, currency, false);
        const leaverSocket = io.sockets.sockets.get(leaver.socketId);
        if (leaverSocket) leaverSocket.emit('opponent_disconnected', {
          winnerId: stayer.userId, loserId: leaver.userId,
          winnerPayout: 0, currency,
        });
      } catch (e) { console.error('bot forfeit settle error:', e.message); }
    } else if (fee > 0 && !stayer.isBot) {
      const stayerSocket = io.sockets.sockets.get(stayer.socketId);

      if (stayerSocket) {
        console.log(`[forfeit] settling game:${gameType} currency:${currency} fee:${fee} winner:${stayer.userId} loser:${leaver.userId}`);

        // Pre-calculate ELO (used even if settle fails)
        let newWinnerElo = (stayer.elo || 1000) + 25;
        let newLoserElo  = Math.max(0, (leaver.elo || 1000) - 25);
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

          // ── Wallet settlement — use dedicated forfeit RPCs ────────────
          const result = currency === 'diamonds'
            ? await forfeitSettleDiamonds(supabase, stayer.userId, leaver.userId, fee)
            : await forfeitSettleCoins(supabase, stayer.userId, leaver.userId, fee);
          winnerPayout = result.winnerPayout ?? 0;

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
        // Both disconnected — refund both (unlock only, no coins moved)
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

  function _startTypeMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('type_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('type_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    io.emit('queue_entry_removed', { id: p1.socketId });
    io.emit('queue_entry_removed', { id: p2.socketId });
    if (!p1.isBot && !p2.isBot) {
      io.emit('active_game_started', {
        id: roomId,
        gameType: 'type',
        player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
        player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
        entryFee: p1.entryFee || 0,
        currency: p1.currency || 'coins',
        score1: 0,
        score2: 0,
        startedAt: Date.now(),
      });
    }
    startTypeCountdown(io, roomId);
  }

  function _startC4Match(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('c4_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('c4_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    io.emit('queue_entry_removed', { id: p1.socketId });
    io.emit('queue_entry_removed', { id: p2.socketId });
    if (!p1.isBot && !p2.isBot) {
      io.emit('active_game_started', {
        id: roomId,
        gameType: 'c4',
        player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
        player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
        entryFee: p1.entryFee || 0,
        currency: p1.currency || 'coins',
        score1: 0,
        score2: 0,
        startedAt: Date.now(),
      });
    }
    startC4Countdown(io, supabase, roomId);
  }

  function _startAimMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('aim_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('aim_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    startAimCountdown(io, supabase, roomId);
  }

  function _startMemoryMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('memory_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('memory_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    startMemoryCountdown(io, supabase, roomId);
  }

  function _startDartMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('dart_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('dart_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    startDartCountdown(io, supabase, roomId);
  }

  function _startAsteroidMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('asteroid_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('asteroid_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    startAsteroidCountdown(io, supabase, roomId);
  }

  function _startPianoMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('piano_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('piano_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    io.emit('queue_entry_removed', { id: p1.socketId });
    io.emit('queue_entry_removed', { id: p2.socketId });
    if (!p1.isBot && !p2.isBot) {
      io.emit('active_game_started', {
        id: roomId,
        gameType: 'piano',
        player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
        player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
        entryFee: p1.entryFee || 0,
        currency: p1.currency || 'coins',
        score1: 0,
        score2: 0,
        startedAt: Date.now(),
      });
    }
    startPianoCountdown(io, supabase, roomId);
  }

  function _startClickMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('click_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('click_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    startClickRaceCountdown(io, supabase, roomId);
  }

  function _startTTTMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    const room = getTTTRoom(roomId);
    const marks = room ? Object.fromEntries(room.players.map(p => [p.userId, room.marks[p.socketId]])) : {};
    if (!p1.isBot) io.to(p1.socketId).emit('ttt_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, marks,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('ttt_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, marks,
    });
    startTTTRound(io, supabase, roomId);
  }

  function _startTetrisMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('tetris_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
    });
    if (!p2.isBot) io.to(p2.socketId).emit('tetris_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
    });
    io.emit('queue_entry_removed', { id: p1.socketId });
    io.emit('queue_entry_removed', { id: p2.socketId });
    if (!p1.isBot && !p2.isBot) {
      io.emit('active_game_started', {
        id: roomId,
        gameType: 'tetris',
        player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
        player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
        entryFee: p1.entryFee || 0,
        currency: p1.currency || 'coins',
        score1: 0,
        score2: 0,
        startedAt: Date.now(),
      });
    }
    startTetrisMatch(io, roomId, supabase);
  }

  function _startChessMatch(io, supabase, { roomId, p1, p2 }) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (s1) s1.join(roomId);
    if (s2) s2.join(roomId);
    const room = getChessRoom(roomId);
    if (!p1.isBot) io.to(p1.socketId).emit('chess_match_found', {
      roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee,
      myColor: room ? room.colors[p1.userId] : 'w',
    });
    if (!p2.isBot) io.to(p2.socketId).emit('chess_match_found', {
      roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee,
      myColor: room ? room.colors[p2.userId] : 'b',
    });
    io.emit('queue_entry_removed', { id: p1.socketId });
    io.emit('queue_entry_removed', { id: p2.socketId });
    if (!p1.isBot && !p2.isBot) {
      io.emit('active_game_started', {
        id: roomId,
        gameType: 'chess',
        player1: { username: p1.username, elo: p1.elo, profileColor: p1.profile_color || '#1E90FF' },
        player2: { username: p2.username, elo: p2.elo, profileColor: p2.profile_color || '#1E90FF' },
        entryFee: p1.entryFee || 0,
        currency: p1.currency || 'coins',
        score1: 0,
        score2: 0,
        startedAt: Date.now(),
      });
    }
    startChessGame(io, roomId, supabase);
  }

  // ── Private room pairing dispatcher ───────────────────────────
  function _pairPrivatePlayers(gameType, p1, p2, io, supabase) {
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (!s1 || !s2) return;

    function emit2(event, extra1 = {}, extra2 = {}) {
      s1.join(roomId); s2.join(roomId);
      s1.emit(event, { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, ...extra1 });
      s2.emit(event, { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, ...extra2 });
    }

    let roomId;
    switch (gameType) {
      case 'blockBlast': { ({ roomId } = createDirectBlockBlastRoom(p1, p2)); emit2('block_blast_match_found');     startBlockBlastCountdown(io, supabase, roomId); break; }
      case 'starship':   { ({ roomId } = createDirectStarshipRoom(p1, p2));   emit2('starship_match_found');        startStarshipCountdown(io, supabase, roomId); break; }
      case 'asteroids':  { ({ roomId } = createDirectAsteroidRoom(p1, p2));   emit2('asteroid_match_found');        startAsteroidCountdown(io, supabase, roomId); break; }
      case 'type':       { ({ roomId } = createDirectTypeRoom(p1, p2));       emit2('type_match_found');            startTypeCountdown(io, roomId); break; }
      case 'memory':     { ({ roomId } = createDirectMemoryRoom(p1, p2));     emit2('memory_match_found');          startMemoryCountdown(io, supabase, roomId); break; }
      case 'aim':        { ({ roomId } = createDirectAimRoom(p1, p2));        emit2('aim_match_found');             startAimCountdown(io, supabase, roomId); break; }
      case 'darts':      { ({ roomId } = createDirectDartRoom(p1, p2));       emit2('dart_match_found');            startDartCountdown(io, supabase, roomId); break; }
      case 'piano':      { ({ roomId } = createDirectPianoRoom(p1, p2));      emit2('piano_match_found');           startPianoCountdown(io, supabase, roomId); break; }
      case 'clickRace':  { ({ roomId } = createDirectClickRoom(p1, p2));      emit2('click_match_found');           startClickRaceCountdown(io, supabase, roomId); break; }
      case 'ttt':        { ({ roomId } = createDirectTTTRoom(p1, p2));        emit2('ttt_match_found');             startTTTRound(io, supabase, roomId); break; }
      case 'tetris':     { ({ roomId } = createDirectTetrisRoom(p1, p2));     emit2('tetris_match_found');          startTetrisMatch(io, roomId, supabase); break; }
      case 'chess': {
        ({ roomId } = createDirectChessRoom(p1, p2));
        const cr = getChessRoom(roomId);
        s1.join(roomId); s2.join(roomId);
        s1.emit('chess_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee, myColor: cr ? cr.colors[p1.userId] : 'w' });
        s2.emit('chess_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee, myColor: cr ? cr.colors[p2.userId] : 'b' });
        startChessGame(io, roomId, supabase);
        break;
      }
      case 'crossroad':    { ({ roomId } = createDirectCrossroadRoom(p1, p2)); emit2('crossroad_match_found'); startCrossroadRound(io, roomId); break; }
      case 'connectfour':  { ({ roomId } = createDirectC4Room(p1, p2)); emit2('c4_match_found');        startC4Countdown(io, supabase, roomId); break; }
      case 'scrabble': {
        ({ roomId } = createDirectScrabbleRoom(p1, p2));
        s1.join(roomId); s2.join(roomId);
        s1.emit('scrabble_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee });
        s2.emit('scrabble_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee });
        io.to(roomId).emit('scrabble_countdown', { count: 3 });
        setTimeout(() => io.to(roomId).emit('scrabble_countdown', { count: 2 }), 1000);
        setTimeout(() => io.to(roomId).emit('scrabble_countdown', { count: 1 }), 2000);
        setTimeout(() => startScrabbleGame(io, supabase, roomId), 3000);
        break;
      }
      case 'coin-flip': {
        const result = createDirectCoinFlipRoom(p1, p2);
        roomId = result.roomId;
        const p2cf = result.p2;
        s1.join(roomId); s2.join(roomId);
        s1.emit('coin_flip_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, side: p1.side, entryFee: p1.entryFee });
        s2.emit('coin_flip_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, side: p2cf.side, entryFee: p2.entryFee });
        setTimeout(() => resolveCoinFlip(io, supabase, roomId), 3000);
        break;
      }
      case 'blackjack': {
        ({ roomId } = createDirectBlackjackRoom(p1, p2));
        s1.join(roomId); s2.join(roomId);
        s1.emit('bj_match_found', { roomId, opponent: { userId: p2.userId, username: p2.username, elo: p2.elo }, entryFee: p1.entryFee });
        s2.emit('bj_match_found', { roomId, opponent: { userId: p1.userId, username: p1.username, elo: p1.elo }, entryFee: p2.entryFee });
        startBlackjackGame(io, supabase, roomId);
        break;
      }
      default: break;
    }
  }

  // ── Spectator mode ────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
  socket.on('spectate_game', ({ gameId }) => {
    if (!gameId) return;
    socket.join(gameId);

    // Try to find the room in supported engines and send a snapshot
    const scrabbleRoom = getScrabbleRoom(gameId);
    if (scrabbleRoom) {
      const [p1, p2] = scrabbleRoom.players;
      const scores = scrabbleRoom.scores || {};
      socket.emit('spectate_snapshot', {
        gameType: 'scrabble',
        board: scrabbleRoom.board,
        scores,
        player1: { userId: p1.userId, username: p1.username },
        player2: { userId: p2?.userId, username: p2?.username },
        bagCount: scrabbleRoom.bag?.length ?? 0,
        currentTurnUserId: scrabbleRoom.players[scrabbleRoom.turnIndex ?? 0]?.userId,
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





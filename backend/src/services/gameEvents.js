// Lightweight event bus so game engines can signal game-end
// without a circular dependency back into handlers.js.
// Usage in engine: gameEvents.emit('game_ended', { roomId, socketIds: [s1, s2] });
// Usage in handlers: gameEvents.on('game_ended', ({ socketIds }) => { ... });

const { EventEmitter } = require('events');
module.exports = new EventEmitter();

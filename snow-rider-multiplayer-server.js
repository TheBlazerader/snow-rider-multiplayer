'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 10;
const rooms = new Map();

const DEFAULT_SETTINGS = {
  density: 1, treeRate: 55, rockRate: 25, rampRate: 20,
  treeScale: 1, rockScale: 1, rampScale: 1,
  coinChance: 45, ringCount: 5, pitChance: 20, pitSpacing: 9,
  steering: 1.7, acceleration: 0.6, maxSpeed: 55,
  jumpPower: 16, rampBoost: 21, gravity: 30, trackWidth: 20,
  raceDistance: 1000, powerupsEnabled: false
};
const NUMERIC_RANGES = {
  density: [0.1, 4], treeRate: [0, 100], rockRate: [0, 100], rampRate: [0, 100],
  treeScale: [0.1, 4], rockScale: [0.1, 4], rampScale: [0.1, 4],
  coinChance: [0, 100], ringCount: [1, 30], pitChance: [0, 100], pitSpacing: [1, 100],
  steering: [0, 8], acceleration: [0, 5], maxSpeed: [1, 150],
  jumpPower: [0, 60], rampBoost: [0, 80], gravity: [1, 100], trackWidth: [8, 60],
  raceDistance: [100, 100000]
};

function send(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function broadcast(room, data, except = null) {
  for (const p of room.players.values()) if (p.socket !== except) send(p.socket, data);
}
function cleanName(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Rider';
}
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, role: p.role, color: p.color,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: p.speed, score: p.score,
    alive: p.alive, spectator: p.spectator, showNames: p.showNames
  };
}
function playerList(room) { return [...room.players.values()].map(publicPlayer); }
function lobbyState(room) {
  broadcast(room, {
    type: 'lobby_state', code: room.code, mode: room.mode,
    settings: room.settings, phase: room.phase, players: playerList(room)
  });
}
function sanitizeSettings(input, previous) {
  const out = { ...previous };
  if (!input || typeof input !== 'object') return out;
  for (const [key, range] of Object.entries(NUMERIC_RANGES)) {
    const n = Number(input[key]);
    if (Number.isFinite(n)) out[key] = Math.max(range[0], Math.min(range[1], n));
  }
  if (typeof input.powerupsEnabled === 'boolean') out.powerupsEnabled = input.powerupsEnabled;
  return out;
}
function findRoom(socket) {
  return socket.roomCode ? rooms.get(socket.roomCode) : null;
}
function findPlayer(room, socket) {
  if (!room) return null;
  for (const p of room.players.values()) if (p.socket === socket) return p;
  return null;
}
function sendError(socket, message) { send(socket, { type: 'error', message }); }
function finishMatch(room, winner) {
  if (room.phase !== 'running') return;
  room.phase = 'finished';
  const payload = {
    type: 'match_finished', winner: winner ? winner.name : '',
    winnerId: winner ? winner.id : '', mode: room.mode,
    players: playerList(room)
  };
  broadcast(room, payload);
}
function checkRemaining(room) {
  if (room.phase !== 'running') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1) finishMatch(room, alive[0] || null);
}
function eliminate(room, player, reason = 'hit') {
  if (!player || !player.alive || room.phase !== 'running') return;
  player.alive = false;
  player.spectator = room.mode === 'arena-bash';
  broadcast(room, { type: 'player_eliminated', id: player.id, name: player.name, reason, players: playerList(room) });
  checkRemaining(room);
}
function forwardVector(yaw) { return { x: Math.sin(yaw), z: -Math.cos(yaw) }; }
function checkBashHits(room) {
  if (room.mode !== 'bash' && room.mode !== 'arena-bash') return;
  const alive = [...room.players.values()].filter(p => p.alive);
  for (const attacker of alive) {
    if (attacker.speed < 7) continue;
    const f = forwardVector(attacker.yaw);
    for (const target of alive) {
      if (target === attacker || !target.alive) continue;
      const dx = target.x - attacker.x, dz = target.z - attacker.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 2.9 * 2.9 || d2 < 0.0001) continue;
      const d = Math.sqrt(d2);
      const ahead = (dx * f.x + dz * f.z) / d;
      const tf = forwardVector(target.yaw);
      const aligned = f.x * tf.x + f.z * tf.z;
      if (ahead > 0.58 && aligned > 0.25) {
        eliminate(room, target, 'rammed from behind');
        if (room.phase !== 'running') return;
      }
    }
  }
}
function assignStartPositions(room) {
  const players = [...room.players.values()];
  const halfWidth = Math.max(5, Number(room.settings.trackWidth) || 20);
  const seed = crypto.randomInt(1, 0x7fffffff);
  if (room.mode === 'arena-bash') {
    const half = halfWidth * 3 - 7;
    players.forEach((p, i) => {
      let x = 0, z = 0, tries = 0;
      do {
        x = (Math.random() * 2 - 1) * half;
        z = (Math.random() * 2 - 1) * half;
        tries++;
      } while (tries < 80 && players.some(q => q !== p && q._assigned && Math.hypot(q.x - x, q.z - z) < 8));
      p.x = x; p.z = z; p.y = 0; p.yaw = Math.random() * Math.PI * 2; p._assigned = true;
    });
    for (const p of players) delete p._assigned;
  } else {
    const spread = Math.min(halfWidth - 2, Math.max(2, (players.length - 1) * 1.1));
    players.forEach((p, i) => {
      p.x = players.length === 1 ? 0 : -spread + (spread * 2 * i / (players.length - 1));
      p.z = 0; p.y = 0; p.yaw = 0;
    });
  }
  for (const p of players) {
    p.speed = room.mode === 'bash' ? 18 : 24;
    p.score = 0; p.alive = true; p.spectator = false;
  }
  room.seed = seed;
}
function startMatch(room) {
  room.phase = 'running';
  assignStartPositions(room);
  if (room.mode === 'race') room.settings.powerupsEnabled = true;
  broadcast(room, {
    type: 'match_started', mode: room.mode, seed: room.seed,
    settings: room.settings, players: playerList(room)
  });
}
function closeRoom(room, reason = 'room_closed') {
  if (!room) return;
  rooms.delete(room.code);
  for (const p of room.players.values()) {
    p.socket.roomCode = null;
    send(p.socket, { type: reason });
    try { p.socket.close(1000, 'Party closed'); } catch (_) {}
  }
  room.players.clear();
}
function handle(socket, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  const room = findRoom(socket);
  const player = findPlayer(room, socket);

  if (msg.type === 'create_room') {
    if (socket.roomCode) return sendError(socket, 'Leave your current party first.');
    const code = makeCode();
    const p = {
      id: crypto.randomUUID(), socket, name: cleanName(msg.name), role: 'leader',
      color: 0xd94b4b, x: 0, y: 0, z: 0, yaw: 0, speed: 0, score: 0,
      alive: true, spectator: false, showNames: msg.showNames !== false, lastStateAt: 0
    };
    const newRoom = {
      code, leaderId: p.id, players: new Map([[p.id, p]]), mode: 'race',
      settings: sanitizeSettings(msg.settings, { ...DEFAULT_SETTINGS }), phase: 'lobby', seed: 0, createdAt: Date.now()
    };
    if (typeof msg.powerupsEnabled === 'boolean') newRoom.settings.powerupsEnabled = msg.powerupsEnabled;
    rooms.set(code, newRoom); socket.roomCode = code;
    send(socket, { type: 'room_created', selfId: p.id, role: 'leader', code, mode: newRoom.mode, settings: newRoom.settings, players: playerList(newRoom) });
    return;
  }

  if (msg.type === 'join_room') {
    if (socket.roomCode) return sendError(socket, 'Leave your current party first.');
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const target = rooms.get(code);
    if (!target) return sendError(socket, 'Party not found. Check the 6-character code.');
    if (target.phase === 'running') return sendError(socket, 'That party is already playing.');
    if (target.players.size >= MAX_PLAYERS) return sendError(socket, 'That party is full (10 players maximum).');
    const colors = [0x2588d8, 0x31a66a, 0x9b59b6, 0xe69a28, 0x21a7a1, 0xd65c9b, 0x6879d8, 0x8a6b4f, 0x5c9eae];
    const p = {
      id: crypto.randomUUID(), socket, name: cleanName(msg.name), role: 'member',
      color: colors[(target.players.size - 1) % colors.length], x: 0, y: 0, z: 0, yaw: 0, speed: 0, score: 0,
      alive: true, spectator: false, showNames: msg.showNames !== false, lastStateAt: 0
    };
    target.players.set(p.id, p); socket.roomCode = code;
    send(socket, { type: 'room_joined', selfId: p.id, role: 'member', code, mode: target.mode, settings: target.settings, players: playerList(target) });
    lobbyState(target);
    return;
  }

  if (!room || !player) return sendError(socket, 'You are not in a party.');
  if (msg.type === 'set_name') {
    player.name = cleanName(msg.name); lobbyState(room); return;
  }
  if (msg.type === 'set_show_names') {
    player.showNames = msg.showNames !== false; lobbyState(room); return;
  }
  if (msg.type === 'set_mode') {
    if (player.id !== room.leaderId) return sendError(socket, 'Only the party leader can change the mode.');
    if (!['race', 'bash', 'arena-bash'].includes(msg.mode)) return;
    room.mode = msg.mode; lobbyState(room); return;
  }
  if (msg.type === 'set_settings') {
    if (player.id !== room.leaderId) return sendError(socket, 'Only the party leader can change modifications.');
    room.settings = sanitizeSettings(msg.settings, room.settings);
    if (room.mode === 'race') room.settings.powerupsEnabled = true;
    lobbyState(room); return;
  }
  if (msg.type === 'start_match') {
    if (player.id !== room.leaderId) return sendError(socket, 'Only the party leader can start the match.');
    if (room.players.size < 2) return sendError(socket, 'At least 2 players are needed to start.');
    if (room.phase === 'running') return;
    startMatch(room); return;
  }
  if (msg.type === 'player_state') {
    if (room.phase !== 'running' || (!player.alive && room.mode !== 'arena-bash')) return;
    const now = Date.now();
    if (now - player.lastStateAt < 25) return;
    player.lastStateAt = now;
    const number = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
    player.x = number(msg.x, player.x, -500, 500);
    player.y = number(msg.y, player.y, -20, 50);
    player.z = number(msg.z, player.z, -100000, 100000);
    player.yaw = number(msg.yaw, player.yaw, -1000, 1000);
    player.speed = number(msg.speed, player.speed, 0, 200);
    player.score = number(msg.score, player.score, 0, 100000000);
    player.showNames = msg.showNames !== false;
    if (room.mode === 'race' && player.score >= room.settings.raceDistance) {
      finishMatch(room, player); return;
    }
    checkBashHits(room);
    return;
  }
  if (msg.type === 'player_eliminated') {
    eliminate(room, player, String(msg.reason || 'crash').slice(0, 40)); return;
  }
  if (msg.type === 'leave_room') {
    if (player.id === room.leaderId) { closeRoom(room); return; }
    room.players.delete(player.id); socket.roomCode = null;
    send(socket, { type: 'left_room' });
    if (room.phase === 'running') checkRemaining(room); else lobbyState(room);
    return;
  }
  if (msg.type === 'close_room' && player.id === room.leaderId) { closeRoom(room); return; }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'Snow Rider Multiplayer', rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });
wss.on('connection', socket => {
  socket.roomCode = null;
  socket.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { sendError(socket, 'Invalid message format.'); return; }
    try { handle(socket, msg); }
    catch (err) { console.error('Request error:', err); sendError(socket, 'The server could not process that request.'); }
  });
  socket.on('close', () => {
    const room = findRoom(socket);
    if (!room) return;
    const player = findPlayer(room, socket);
    if (!player) return;
    if (player.id === room.leaderId) { closeRoom(room); return; }
    room.players.delete(player.id);
    if (room.phase === 'running') checkRemaining(room); else lobbyState(room);
  });
  socket.on('error', err => console.error('WebSocket error:', err.message));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > 12 * 60 * 60 * 1000 || room.players.size === 0) closeRoom(room);
    else if (room.phase === 'running') broadcast(room, { type: 'snapshot', players: playerList(room) });
  }
}, 50).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Snow Rider Multiplayer listening on ${PORT}`));

// server.js
// ------------------------------------------------------------------
// Express static host + Socket.io room server for the tactical FPS.
// Responsibilities:
//   1. Serve the frontend (public/) as static files.
//   2. Create/join "rooms" identified by a short code, so a URL like
//      https://your-app.glitch.me/?room=AB12CD drops a friend straight
//      into the same match.
//   3. Relay high-frequency player state (position/rotation/anim) to
//      everyone else in the room.
//   4. Own the parts that must not be trusted to the client: HP,
//      credits, round/buy-phase timers, kill rewards, bomb plant/defuse.
// ------------------------------------------------------------------

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Tunable game constants ----------------
const BUY_PHASE_SECONDS = 30;
const ROUND_PHASE_SECONDS = 100;
const ROUND_END_SECONDS = 5;
const BOMB_TIMER_SECONDS = 45;
const DEFUSE_DURATION_MS = 7000; // plant hold time is enforced client-side; only defuse needs a server timer

const START_CREDITS = 800;
const MAX_CREDITS = 9000;
const ROUND_WIN_REWARD = 3000;
// Loss-streak based "loss bonus" (index 0 = first loss in a row, ...).
const ROUND_LOSS_REWARD = [1900, 1900, 2400, 2400, 2900, 2900];
const KILL_REWARD = 200;
const PLAYER_MAX_HP = 100;

// Weapon catalog. Names are original (not the exact trademarked
// Valorant weapon names) but the price/damage/mag/fire-rate shape
// mirrors the classic pistol -> SMG -> rifle -> sniper economy curve.
const WEAPONS = {
  sidearm:  { name: 'Sidearm',  price: 0,    damage: 26,  mag: 12, fireRate: 6.75 },
  buckshot: { name: 'Buckshot', price: 150,  damage: 12,  mag: 2,  fireRate: 3.3 },
  viper:    { name: 'Viper',    price: 450,  damage: 26,  mag: 13, fireRate: 10 },
  falcon:   { name: 'Falcon',   price: 800,  damage: 55,  mag: 6,  fireRate: 4 },
  wisp:     { name: 'Wisp',     price: 1600, damage: 26,  mag: 30, fireRate: 13.3 },
  raptor:   { name: 'Raptor',   price: 2050, damage: 35,  mag: 24, fireRate: 9.15 },
  vanguard: { name: 'Vanguard', price: 2900, damage: 40,  mag: 25, fireRate: 9.75 },
  reaper:   { name: 'Reaper',   price: 4700, damage: 150, mag: 5,  fireRate: 0.6 },
};

// World-space bomb site rectangles. Must match public/js/mapBuilder.js
// SITE_ZONES exactly, since both sides use these to validate plant/defuse.
const SITE_ZONES = {
  A: { minX: 18, maxX: 34, minZ: -34, maxZ: -18 },
  B: { minX: -34, maxX: -18, minZ: -34, maxZ: -18 },
};

function inSite(pos, site) {
  const z = SITE_ZONES[site];
  return pos.x >= z.minX && pos.x <= z.maxX && pos.z >= z.minZ && pos.z <= z.maxZ;
}

// ---------------- Room state ----------------
/** @type {Map<string, any>} roomId -> room state */
const rooms = new Map();

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function spawnPointFor(team) {
  const jitter = () => (Math.random() - 0.5) * 4;
  return team === 'attackers'
    ? { x: jitter(), y: 1, z: 40 + jitter() }
    : { x: jitter(), y: 1, z: -40 + jitter() };
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    players: new Map(),
    phase: 'buy', // 'buy' | 'round' | 'end'
    phaseEndsAt: Date.now() + BUY_PHASE_SECONDS * 1000,
    round: 1,
    lossStreak: { attackers: 0, defenders: 0 },
    bomb: { planted: false, defused: false, site: null, plantedAt: 0, planter: null },
    timer: null,
  };
  rooms.set(roomId, room);
  room.timer = setInterval(() => tickRoom(room), 1000);
  return room;
}

function getOrCreateRoom(roomId) {
  const id = roomId && rooms.has(roomId) ? roomId : (roomId || makeRoomId());
  let room = rooms.get(id);
  if (!room) room = createRoom(id);
  return room;
}

function assignTeam(room) {
  let attackers = 0;
  let defenders = 0;
  for (const p of room.players.values()) {
    if (p.team === 'attackers') attackers++; else defenders++;
  }
  return attackers <= defenders ? 'attackers' : 'defenders';
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    team: p.team,
    hp: p.hp,
    alive: p.alive,
    credits: p.credits,
    weapon: p.weapon,
    kills: p.kills,
    deaths: p.deaths,
    position: p.position,
    rotation: p.rotation,
    anim: p.anim,
  };
}

function roomSnapshot(room) {
  return {
    roomId: room.id,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    round: room.round,
    bomb: room.bomb,
    players: Array.from(room.players.values()).map(publicPlayer),
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit('room_update', roomSnapshot(room));
}

// ---------------- Phase / round loop ----------------
function tickRoom(room) {
  if (room.players.size === 0) return;
  const now = Date.now();

  if (room.phase === 'round' && room.bomb.planted && !room.bomb.defused) {
    const detonateAt = room.bomb.plantedAt + BOMB_TIMER_SECONDS * 1000;
    if (now >= detonateAt) {
      endRound(room, 'attackers', 'bomb_exploded');
      return;
    }
  }

  const timeLeft = Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000));

  if (timeLeft <= 0) {
    if (room.phase === 'buy') {
      room.phase = 'round';
      room.phaseEndsAt = now + ROUND_PHASE_SECONDS * 1000;
      io.to(room.id).emit('phase_change', { phase: room.phase, phaseEndsAt: room.phaseEndsAt });
    } else if (room.phase === 'round') {
      // Timer ran out with no bomb detonation -> defenders hold.
      endRound(room, 'defenders', 'time_expired');
      return;
    } else if (room.phase === 'end') {
      startNextRound(room);
      return;
    }
  }

  io.to(room.id).emit('phase_tick', { phase: room.phase, timeLeft });
}

function startNextRound(room) {
  room.round += 1;
  room.bomb = { planted: false, defused: false, site: null, plantedAt: 0, planter: null };
  for (const p of room.players.values()) {
    p.hp = PLAYER_MAX_HP;
    p.alive = true;
    p.position = spawnPointFor(p.team);
  }
  room.phase = 'buy';
  room.phaseEndsAt = Date.now() + BUY_PHASE_SECONDS * 1000;
  io.to(room.id).emit('round_start', roomSnapshot(room));
}

function endRound(room, winningTeam, reason) {
  room.phase = 'end';
  room.phaseEndsAt = Date.now() + ROUND_END_SECONDS * 1000;

  const losingTeam = winningTeam === 'attackers' ? 'defenders' : 'attackers';
  room.lossStreak[winningTeam] = 0;
  room.lossStreak[losingTeam] = Math.min(5, room.lossStreak[losingTeam] + 1);

  for (const p of room.players.values()) {
    if (p.team === winningTeam) {
      p.credits = Math.min(MAX_CREDITS, p.credits + ROUND_WIN_REWARD);
    } else {
      const idx = Math.min(room.lossStreak[losingTeam] - 1, ROUND_LOSS_REWARD.length - 1);
      p.credits = Math.min(MAX_CREDITS, p.credits + ROUND_LOSS_REWARD[idx]);
    }
  }

  io.to(room.id).emit('round_end', { winningTeam, reason, snapshot: roomSnapshot(room) });
}

function checkRoundEndByElimination(room) {
  if (room.phase !== 'round') return;
  const alive = { attackers: 0, defenders: 0 };
  const total = { attackers: 0, defenders: 0 };
  for (const p of room.players.values()) {
    total[p.team]++;
    if (p.alive) alive[p.team]++;
  }
  if (total.attackers > 0 && alive.attackers === 0) endRound(room, 'defenders', 'elimination');
  else if (total.defenders > 0 && alive.defenders === 0) endRound(room, 'attackers', 'elimination');
}

// ---------------- Socket handling ----------------
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join_room', ({ roomId, name } = {}) => {
    const room = getOrCreateRoom((roomId || '').trim().toUpperCase() || undefined);
    currentRoom = room;
    socket.join(room.id);

    const team = assignTeam(room);
    const player = {
      id: socket.id,
      name: String(name || `Agent-${socket.id.slice(0, 4)}`).slice(0, 16),
      team,
      hp: PLAYER_MAX_HP,
      alive: true,
      credits: START_CREDITS,
      weapon: 'sidearm',
      kills: 0,
      deaths: 0,
      position: spawnPointFor(team),
      rotation: { y: 0 },
      anim: 'idle',
    };
    room.players.set(socket.id, player);

    socket.emit('joined', {
      selfId: socket.id,
      roomId: room.id,
      weapons: WEAPONS,
      snapshot: roomSnapshot(room),
    });
    socket.to(room.id).emit('player_joined', publicPlayer(player));
    broadcastRoom(room);
  });

  socket.on('move', (data) => {
    if (!currentRoom || !data) return;
    const p = currentRoom.players.get(socket.id);
    if (!p || !p.alive) return;
    p.position = data.position;
    p.rotation = data.rotation;
    p.anim = data.anim || 'idle';
    socket.to(currentRoom.id).emit('player_moved', {
      id: socket.id,
      position: p.position,
      rotation: p.rotation,
      anim: p.anim,
      t: Date.now(),
    });
  });

  socket.on('shoot', (data) => {
    if (!currentRoom || !data) return;
    const p = currentRoom.players.get(socket.id);
    if (!p || !p.alive) return;
    socket.to(currentRoom.id).emit('player_shoot', {
      id: socket.id, origin: data.origin, direction: data.direction, weapon: p.weapon,
    });
  });

  socket.on('report_hit', ({ targetId, damage, headshot } = {}) => {
    if (!currentRoom || currentRoom.phase !== 'round') return;
    const shooter = currentRoom.players.get(socket.id);
    const target = currentRoom.players.get(targetId);
    if (!shooter || !target || !shooter.alive || !target.alive) return;
    if (shooter.team === target.team) return; // no friendly fire

    // Server clamps damage regardless of what the client reports.
    const dmg = Math.max(1, Math.min(150, Number(damage) || 0));
    target.hp = Math.max(0, target.hp - dmg);
    io.to(currentRoom.id).emit('player_damaged', {
      targetId, hp: target.hp, byId: socket.id, headshot: !!headshot,
    });

    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.deaths += 1;
      shooter.kills += 1;
      shooter.credits = Math.min(MAX_CREDITS, shooter.credits + KILL_REWARD);
      io.to(currentRoom.id).emit('player_eliminated', {
        targetId, byId: socket.id, headshot: !!headshot,
      });
      checkRoundEndByElimination(currentRoom);
    }
  });

  socket.on('buy_weapon', (weaponKey) => {
    if (!currentRoom || currentRoom.phase !== 'buy') return;
    const p = currentRoom.players.get(socket.id);
    const w = WEAPONS[weaponKey];
    if (!p || !w) return;
    if (p.credits < w.price) return;
    p.credits -= w.price;
    p.weapon = weaponKey;
    socket.emit('economy_update', { credits: p.credits, weapon: p.weapon });
  });

  socket.on('plant_bomb', ({ site } = {}) => {
    if (!currentRoom || currentRoom.phase !== 'round') return;
    const p = currentRoom.players.get(socket.id);
    if (!p || !p.alive || p.team !== 'attackers') return;
    if (currentRoom.bomb.planted) return;
    if (!SITE_ZONES[site] || !inSite(p.position, site)) return;

    currentRoom.bomb = {
      planted: true, defused: false, site, plantedAt: Date.now(), planter: socket.id,
    };
    io.to(currentRoom.id).emit('bomb_planted', {
      site, detonateAt: currentRoom.bomb.plantedAt + BOMB_TIMER_SECONDS * 1000,
    });
  });

  socket.on('defuse_bomb', () => {
    if (!currentRoom || currentRoom.phase !== 'round') return;
    const p = currentRoom.players.get(socket.id);
    if (!p || !p.alive || p.team !== 'defenders') return;
    if (!currentRoom.bomb.planted || currentRoom.bomb.defused) return;

    currentRoom.bomb.defused = true; // lock the defuse to this attempt
    const roomId = currentRoom.id;
    io.to(roomId).emit('defuse_started', { by: socket.id });
    setTimeout(() => {
      const room = rooms.get(roomId);
      if (!room || !room.players.has(socket.id)) return;
      if (room.phase !== 'round' || !room.bomb.planted) return;
      endRound(room, 'defenders', 'bomb_defused');
    }, DEFUSE_DURATION_MS);
  });

  socket.on('chat', (msg) => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (!p) return;
    io.to(currentRoom.id).emit('chat', { name: p.name, msg: String(msg || '').slice(0, 140) });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    currentRoom.players.delete(socket.id);
    socket.to(currentRoom.id).emit('player_left', { id: socket.id });
    if (currentRoom.players.size === 0) {
      clearInterval(currentRoom.timer);
      rooms.delete(currentRoom.id);
    } else {
      checkRoundEndByElimination(currentRoom);
      broadcastRoom(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tactical FPS server listening on port ${PORT}`);
});

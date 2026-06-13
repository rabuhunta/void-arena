// ============================================================
//  VOID ARENA — server/index.js
//  Комнаты, лобби, игровой цикл, переподключение.
//  Запуск: node server/index.js  (порт из process.env.PORT или 3000)
// ============================================================
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { GLOBAL, TEAMS, CHARACTERS, MAPS, derive } = require('./balance');
const { Match } = require('./game');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const TEST_MODE = process.env.TEST_MODE === '1';

// rooms: code -> { code, players: {A:{token,name,socketId,order,ready,connected,graceTimer}, B:...}, match, loops }
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return rooms.has(c) ? makeCode() : c;
}

function publicRoomState(room) {
  const p = t => room.players[t] ? {
    name: room.players[t].name, team: t,
    ready: room.players[t].ready, orderSet: !!room.players[t].order,
    connected: room.players[t].connected,
  } : null;
  return {
    code: room.code,
    phase: room.match ? 'battle' : 'lobby',
    A: p('A'), B: p('B'),
    teams: { A: TEAMS.A, B: TEAMS.B },
    mapId: room.mapId || 'void',
    host: room.host || 'A',
  };
}

function charPayload() {
  const out = {};
  for (const id of Object.keys(CHARACTERS)) {
    const c = CHARACTERS[id];
    out[id] = {
      id, name: c.name, title: c.title, archetype: c.archetype,
      color: c.color, glow: c.glow, radius: c.radius,
      stats: c.stats, derived: derive(id),
      attack: c.attack,
      skillName: c.skill.name, skillCost: c.skill.cost === 'ALL' ? 'вся мана' : c.skill.cost,
      passiveName: c.passive.name,
    };
  }
  return out;
}

function broadcastRoom(room) {
  for (const t of ['A', 'B']) {
    const pl = room.players[t];
    if (pl && pl.socketId) io.to(pl.socketId).emit('room', { ...publicRoomState(room), yourTeam: t });
  }
}

function startMatch(room) {
  const orders = {
    A: room.players.A.order.map(i => TEAMS.A.roster[i]),
    B: room.players.B.order.map(i => TEAMS.B.roster[i]),
  };
  const map = MAPS[room.mapId] || MAPS.void;
  room.match = new Match(orders, () => {}, map.obstacles);
  const dt = 1 / GLOBAL.TICK_RATE;

  for (const t of ['A', 'B']) {
    const pl = room.players[t];
    if (pl?.socketId) io.to(pl.socketId).emit('start', {
      arena: { w: GLOBAL.ARENA_W, h: GLOBAL.ARENA_H },
      chars: charPayload(),
      orders, you: t,
      names: { A: room.players.A.name, B: room.players.B.name },
      map: { id: map.id, obstacles: map.obstacles },
    });
  }

  room.loops = {
    sim: setInterval(() => {
      try { room.match.tick(dt); } catch (e) { console.error('tick error', e); }
    }, 1000 / GLOBAL.TICK_RATE),
    snap: setInterval(() => {
      const m = room.match;
      if (!m) return;
      for (const t of ['A', 'B']) {
        const pl = room.players[t];
        if (pl?.socketId) io.to(pl.socketId).emit('snap', m.snapshotFor(t));
      }
      m.flushEvents();
      if (m.phase === 'over' && !room.overSent) {
        room.overSent = true;
        emitBoth(room, 'over', { winner: m.winner });
        setTimeout(() => stopMatchKeepRoom(room), 800);
      }
    }, 1000 / GLOBAL.SNAP_RATE),
  };
}

function stopMatchKeepRoom(room) {
  if (room.loops) { clearInterval(room.loops.sim); clearInterval(room.loops.snap); room.loops = null; }
  room.overSent = false;
  // матч оставляем в памяти до реванша, чтобы экран победы знал победителя
}

function destroyRoom(room, reason) {
  stopMatchKeepRoom(room);
  for (const t of ['A', 'B']) {
    const pl = room.players[t];
    if (pl?.graceTimer) clearTimeout(pl.graceTimer);
    if (pl?.socketId) io.to(pl.socketId).emit('roomClosed', { reason });
  }
  rooms.delete(room.code);
}

io.on('connection', socket => {
  let myRoom = null;
  let myTeam = null;

  function bind(room, team) {
    myRoom = room; myTeam = team;
    room.players[team].socketId = socket.id;
    room.players[team].connected = true;
    if (room.players[team].graceTimer) { clearTimeout(room.players[team].graceTimer); room.players[team].graceTimer = null; }
  }

  socket.on('create', (data, cb) => {
    const name = String(data?.name || 'Игрок').slice(0, 16);
    const team = data?.team === 'B' ? 'B' : 'A';
    const code = makeCode();
    const token = crypto.randomBytes(12).toString('hex');
    const room = { code, players: { A: null, B: null }, match: null, loops: null, mapId: 'void', host: team };
    room.players[team] = { token, name, socketId: socket.id, order: null, ready: false, connected: true, graceTimer: null };
    rooms.set(code, room);
    bind(room, team);
    cb?.({ ok: true, code, token, team });
    broadcastRoom(room);
  });

  socket.on('join', (data, cb) => {
    const code = String(data?.code || '').toUpperCase().trim();
    const name = String(data?.name || 'Игрок').slice(0, 16);
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, err: 'Комната не найдена. Проверь код.' });
    const freeTeam = !room.players.A ? 'A' : !room.players.B ? 'B' : null;
    if (!freeTeam) return cb?.({ ok: false, err: 'Комната уже заполнена.' });
    const token = crypto.randomBytes(12).toString('hex');
    room.players[freeTeam] = { token, name, socketId: socket.id, order: null, ready: false, connected: true, graceTimer: null };
    bind(room, freeTeam);
    cb?.({ ok: true, code, token, team: freeTeam });
    broadcastRoom(room);
  });

  socket.on('resume', (data, cb) => {
    const room = rooms.get(String(data?.code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, err: 'Комната уже закрыта.' });
    const team = ['A', 'B'].find(t => room.players[t]?.token === data?.token);
    if (!team) return cb?.({ ok: false, err: 'Неверный токен.' });
    bind(room, team);
    cb?.({ ok: true, team, code: room.code, inBattle: !!room.match });
    if (room.match) {
      const rmap = MAPS[room.mapId] || MAPS.void;
      io.to(socket.id).emit('start', {
        arena: { w: GLOBAL.ARENA_W, h: GLOBAL.ARENA_H },
        chars: charPayload(),
        orders: { A: room.match.orders.A, B: room.match.orders.B },
        you: team,
        names: { A: room.players.A?.name, B: room.players.B?.name },
        map: { id: rmap.id, obstacles: rmap.obstacles },
      });
      const bothOn = room.players.A?.connected && room.players.B?.connected;
      if (bothOn && room.match.paused) { room.match.paused = false; emitBoth(room, 'resumed', {}); }
    }
    broadcastRoom(room);
  });

  socket.on('order', data => {
    if (!myRoom || !myTeam) return;
    const ord = Array.isArray(data?.order) ? data.order.map(Number) : null;
    const rosterLen = TEAMS[myTeam].roster.length;
    if (!ord || ord.length !== 3) return;
    // три РАЗНЫХ индекса в пределах ростера
    const uniq = new Set(ord);
    if (uniq.size !== 3) return;
    if (ord.some(i => !Number.isInteger(i) || i < 0 || i >= rosterLen)) return;
    myRoom.players[myTeam].order = ord;
    broadcastRoom(myRoom);
  });

  socket.on('selectMap', d => {
    if (!myRoom || !myTeam) return;
    if (myRoom.host !== myTeam) return;        // карту выбирает только хост
    if (myRoom.match) return;                  // нельзя менять во время боя
    const id = String(d?.mapId || '');
    if (!MAPS[id]) return;
    myRoom.mapId = id;
    emitBoth(myRoom, 'mapSelected', { mapId: id });
    broadcastRoom(myRoom);
  });

  socket.on('leave', () => {
    if (!myRoom || !myTeam) return;
    const room = myRoom, team = myTeam;
    const other = room.players[team === 'A' ? 'B' : 'A'];
    if (room.match && !room.match.winner && other?.socketId) {
      io.to(other.socketId).emit('over', { winner: team === 'A' ? 'B' : 'A', reason: 'forfeit' });
    }
    stopMatchKeepRoom(room);
    room.match = null;
    room.players[team] = null;
    myRoom = null; myTeam = null;
    if (!room.players.A && !room.players.B) destroyRoom(room, 'empty');
    else broadcastRoom(room);
  });

  socket.on('ready', () => {
    if (!myRoom || !myTeam) return;
    const pl = myRoom.players[myTeam];
    if (!pl.order) return;
    pl.ready = true;
    broadcastRoom(myRoom);
    const a = myRoom.players.A, b = myRoom.players.B;
    if (a?.ready && b?.ready && !myRoom.match) startMatch(myRoom);
  });

  socket.on('input', d => {
    if (myRoom?.match && myTeam) myRoom.match.setInput(myTeam, +d?.mx || 0, +d?.my || 0);
  });

  socket.on('act', d => {
    if (myRoom?.match && myTeam) myRoom.match.action(myTeam, String(d?.type || ''));
  });

  socket.on('rematch', () => {
    if (!myRoom || !myTeam) return;
    myRoom.players[myTeam].ready = false;
    myRoom.players[myTeam].order = null;
    myRoom.players[myTeam].wantsRematch = true;
    const a = myRoom.players.A, b = myRoom.players.B;
    if (a?.wantsRematch && b?.wantsRematch) {
      a.wantsRematch = b.wantsRematch = false;
      stopMatchKeepRoom(myRoom);
      myRoom.match = null;
      emitBoth(myRoom, 'lobbyBack', {});
      broadcastRoom(myRoom);
    } else {
      emitBoth(myRoom, 'rematchWait', { team: myTeam });
    }
  });

  socket.on('pingx', cb => cb?.(Date.now()));

  // тест-хуки
  if (TEST_MODE) {
    socket.on('debugSet', d => {
      const m = myRoom?.match; if (!m) return;
      const f = m.fighters[d.team];
      if (!f) return;
      if (d.x !== undefined) f.x = d.x;
      if (d.y !== undefined) f.y = d.y;
      if (d.hp !== undefined) f.hp = d.hp;
      if (d.mana !== undefined) f.mana = d.mana;
      if (d.phase) m.phase = d.phase;
    });
    socket.on('debugGet', cb => {
      const m = myRoom?.match; if (!m) return cb?.(null);
      const g = t => m.fighters[t] ? { id: m.fighters[t].charId, hp: m.fighters[t].hp, mana: m.fighters[t].mana, x: m.fighters[t].x, y: m.fighters[t].y, alive: m.fighters[t].alive, nullified: m.fighters[t].nullified } : null;
      cb?.({ t: m.t, phase: m.phase, A: g('A'), B: g('B'), clone: !!m.clone, fog: !!m.fog, field: !!m.field, voidTheme: m.voidTheme, winner: m.winner, idx: m.idx });
    });
  }

  socket.on('disconnect', () => {
    if (!myRoom || !myTeam) return;
    const room = myRoom, team = myTeam;
    const pl = room.players[team];
    if (!pl || pl.socketId !== socket.id) return;
    pl.connected = false; pl.socketId = null;
    if (room.match && room.match.phase !== 'over') {
      room.match.paused = true;
      emitBoth(room, 'paused', { name: pl.name, grace: GLOBAL.RECONNECT_GRACE });
    }
    broadcastRoom(room);
    pl.graceTimer = setTimeout(() => {
      const other = room.players[team === 'A' ? 'B' : 'A'];
      if (room.match && room.match.phase !== 'over' && other?.socketId) {
        io.to(other.socketId).emit('over', { winner: team === 'A' ? 'B' : 'A', reason: 'forfeit' });
      }
      if (!room.players.A?.connected && !room.players.B?.connected) destroyRoom(room, 'empty');
      else { stopMatchKeepRoom(room); room.match = null; room.players[team] = null; broadcastRoom(room); }
    }, GLOBAL.RECONNECT_GRACE * 1000);
  });
});

function emitBoth(room, ev, payload) {
  for (const t of ['A', 'B']) {
    const pl = room.players[t];
    if (pl?.socketId) io.to(pl.socketId).emit(ev, payload);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VOID ARENA  →  http://localhost:${PORT}`));

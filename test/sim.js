// Интеграционный тест VOID ARENA: сервер + 2 клиента, полный цикл матча.
// Запуск: npm test  (поднимает сервер сам, TEST_MODE=1, порт 3107)
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3107;
const URL = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; console.log(`  ✘ FAIL: ${label}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect() {
  return new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });
}
const emitCb = (s, ev, data) => new Promise(res => s.emit(ev, data, res));
const dbg = s => new Promise(res => s.emit('debugGet', res));
const waitEvent = (s, ev, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting '${ev}'`)), ms);
  s.once(ev, d => { clearTimeout(t); res(d); });
});
async function until(fn, label, ms = 12000, step = 120) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  // --- сервер ---
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, TEST_MODE: '1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  await until(async () => {
    try { const s = await connect(); s.disconnect(); return true; } catch { return false; }
  }, 'server up', 10000, 250);
  console.log('Сервер поднялся.');

  const A = await connect();
  const B = await connect();

  try {
    // --- 1. Комната ---
    console.log('\n[1] Лобби и комната');
    const cr = await emitCb(A, 'create', { name: 'Тест-А', team: 'A' });
    ok(cr?.ok && /^[A-Z0-9]{6}$/.test(cr.code), `create → код ${cr?.code}`);
    const bad = await emitCb(B, 'join', { code: 'ZZZZZZ', name: 'Тест-Б' });
    ok(bad?.ok === false, 'join с неверным кодом отклонён');
    const jn = await emitCb(B, 'join', { code: cr.code, name: 'Тест-Б' });
    ok(jn?.ok && jn.team === 'B', 'join по коду → команда B');

    // --- 2. Порядок и старт ---
    console.log('\n[2] Выбор порядка и старт матча');
    const startA = waitEvent(A, 'start');
    const startB = waitEvent(B, 'start');
    A.emit('order', { order: [0, 1, 2] }); A.emit('ready');
    B.emit('order', { order: [0, 1, 2] }); B.emit('ready');
    const [sa, sb] = await Promise.all([startA, startB]);
    ok(sa.you === 'A' && sb.you === 'B', 'оба получили start со своей стороной');
    ok(sa.arena?.w > 0 && Array.isArray(sa.orders?.B), 'в start есть арена и порядки');

    let snaps = 0;
    A.on('snap', () => snaps++);
    await sleep(700);
    ok(snaps >= 5, `снапшоты идут (${snaps} за 0.7с)`);

    // пропускаем отсчёт
    A.emit('debugSet', { phase: 'fight' });
    await until(async () => (await dbg(A))?.phase === 'fight', 'фаза fight');
    ok(true, 'фаза fight');

    // --- 3. Движение ---
    console.log('\n[3] Движение по инпуту');
    const p0 = (await dbg(A)).A;
    A.emit('input', { mx: 0, my: 1 });
    await sleep(500);
    A.emit('input', { mx: 0, my: 0 });
    const p1 = (await dbg(A)).A;
    ok(p1.y - p0.y > 20, `Вейл сдвинулся вниз (Δy=${(p1.y - p0.y).toFixed(0)})`);

    // лицом вправо
    A.emit('input', { mx: 1, my: 0 });
    await sleep(160);
    A.emit('input', { mx: 0, my: 0 });

    // --- 4. Атака наносит урон ---
    console.log('\n[4] Базовая атака');
    A.emit('debugSet', { team: 'A', x: 550, y: 350 });
    A.emit('debugSet', { team: 'B', x: 605, y: 350, hp: 140 }); // полные HP; 2 удара нелетальны
    await sleep(80);
    const hpB0 = (await dbg(A)).B.hp;
    for (let i = 0; i < 2; i++) {
      A.emit('debugSet', { team: 'A', x: 550, y: 350 });
      A.emit('debugSet', { team: 'B', x: 605, y: 350 });
      A.emit('act', { type: 'attack' });
      await sleep(450);
    }
    const hpB1 = (await dbg(A)).B.hp;
    ok(hpB1 < hpB0, `HP Сектанта упало: ${hpB0.toFixed(0)} → ${hpB1.toFixed(0)}`);

    // --- 5. Скилл Вейла: туман ---
    console.log('\n[5] Активный скилл (Голубая паранойя)');
    await until(async () => (await dbg(A))?.phase === 'fight', 'фаза fight перед скиллом');
    A.emit('debugSet', { team: 'A', mana: 200 });
    await sleep(60);
    A.emit('act', { type: 'skill' });
    const st5 = await until(async () => { const d = await dbg(A); return d.fog ? d : null; }, 'туман активен', 4000);
    ok(!!st5.fog, 'туман (fog) активен на сервере');

    // --- 6. Рывок ---
    console.log('\n[6] Рывок');
    A.emit('debugSet', { team: 'A', x: 300, y: 350 });
    A.emit('input', { mx: 1, my: 0 });
    await sleep(60);
    const d0 = (await dbg(A)).A.x;
    A.emit('act', { type: 'dash' });
    await sleep(450);
    A.emit('input', { mx: 0, my: 0 });
    const d1 = (await dbg(A)).A.x;
    ok(d1 - d0 > 80, `рывок сместил Вейла (Δx=${(d1 - d0).toFixed(0)})`);

    // --- помощник: добить текущего бойца B ---
    async function killCurrentB(label) {
      const before = (await dbg(A)).idx.B;
      for (let i = 0; i < 30; i++) {
        const st = await dbg(A);
        if (st.idx.B > before || st.phase === 'over') return st;
        if (st.phase === 'fight') {
          A.emit('debugSet', { team: 'A', x: 550, y: 350 });
          A.emit('debugSet', { team: 'B', x: 605, y: 350, hp: 1 });
          A.emit('act', { type: 'attack' });
        }
        await sleep(330);
      }
      throw new Error(`не добил: ${label}`);
    }

    // --- 7. Своп: смерть Сектанта → выходит Дюк ---
    console.log('\n[7] Своп бойца (3v3)');
    const st7 = await killCurrentB('сектант');
    ok(st7.idx.B === 1 || st7.phase === 'over', `Сектант пал, idx.B=${st7.idx.B}`);
    await until(async () => (await dbg(A)).phase === 'fight', 'возврат в fight после свопа');
    const st7b = await dbg(A);
    ok(st7b.B.id === 'duk', `вышел следующий боец: ${st7b.B.id}`);
    await sleep(1600); // пережидаем неуязвимость спавна

    // --- 8. Смерть Дюка → Король ---
    const st8 = await killCurrentB('дюк');
    ok(st8.idx.B === 2, `Дюк пал, idx.B=${st8.idx.B}`);
    await until(async () => (await dbg(A)).phase === 'fight', 'fight с Королём');
    await sleep(1600);
    const st8b = await dbg(A);
    ok(st8b.B.id === 'king', `на арене Король: ${st8b.B.id}`);

    // --- 9. Spore Ministry: клон при <50% HP ---
    console.log('\n[9] Пассивка Короля (клон)');
    A.emit('debugSet', { team: 'B', hp: 95, x: 605, y: 350 });
    A.emit('debugSet', { team: 'A', x: 550, y: 350 });
    await sleep(80);
    A.emit('act', { type: 'attack' });
    const st9 = await until(async () => { const d = await dbg(A); return d.clone ? d : null; }, 'клон Короля', 5000);
    ok(!!st9.clone, 'клон появился при падении ниже 50% HP');

    // --- 10. Добиваем Короля → победа A ---
    console.log('\n[10] Победа');
    const overA = waitEvent(A, 'over', 15000);
    const st10 = await killCurrentB('король');
    ok(st10.phase === 'over' && st10.winner === 'A', `матч окончен, победитель ${st10.winner}`);
    const ov = await overA;
    ok(ov?.winner === 'A', "клиенты получили событие 'over'");

    // --- 11. Реванш → возврат в лобби ---
    console.log('\n[11] Реванш');
    const lb = waitEvent(A, 'lobbyBack', 8000);
    A.emit('rematch'); B.emit('rematch');
    await lb;
    ok(true, "оба нажали реванш → 'lobbyBack'");

    // --- 12. Резюм по токену (реконнект) ---
    console.log('\n[12] Переподключение по токену');
    const rs = await emitCb(A, 'resume', { code: cr.code, token: cr.token });
    ok(rs?.ok && rs.team === 'A', 'resume по токену принят');
  } finally {
    A.disconnect(); B.disconnect();
    srv.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`\nИтог: ${passed} ✔ / ${failed} ✘`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('\nТЕСТ УПАЛ:', e.message); process.exit(1); });

// ============================================================
//  VOID ARENA — public/js/client.js
//  Весь клиент: лобби, бой, рендер, ввод, эффекты.
// ============================================================
(() => {
'use strict';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAng = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

const socket = io();

// ---------- клиентская мета персонажей (для лобби до старта матча) ----------
const META = {
  veil:      { name: 'Вейл',            arch: 'Ассасин',  img: 'assets/portraits/veil_card.png',      fb: 'assets/veil.jpg',      line: 'HP 4 · ATK 9 · SPD 7' },
  rabbit:    { name: 'Квазарный Кролик',arch: 'Маг',      img: 'assets/portraits/rabbit_card.png',    fb: 'assets/rabbit.jpg',    line: 'HP 8 · ATK 9 · MANA 9' },
  kain:      { name: 'Каин',            arch: 'Воин',     img: 'assets/portraits/kain_card.png',      fb: 'assets/kain.jpg',      line: 'HP 6 · ATK 8 · DEF 6' },
  sectarian: { name: 'Сектант Бегемота',arch: 'Колдун',   img: 'assets/portraits/sectarian_card.png', fb: 'assets/sectarian.jpg', line: 'HP 7 · ATK 6 · MANA 7' },
  duk:       { name: 'Святой Дюк',      arch: 'Следопыт', img: 'assets/portraits/duk_card.png',       fb: 'assets/duk.jpg',       line: 'HP 6 · ATK 7 · MANA 9' },
  king:      { name: 'Грибной Король',  arch: 'Гигант',   img: 'assets/portraits/king_card.png',      fb: 'assets/king.jpg',      line: 'HP 9 · DEF 7 · ATK 7' },
  barogun:   { name: 'Барогун Гилзкернес', arch: 'Тяж. стрелок', img: 'assets/portraits/barogun_card.png',    fb: 'assets/portraits/barogun.png',    line: 'HP 8 · DEF 5 · ATK 4' },
  heir:      { name: 'Наследница Видения',  arch: 'Снайпер',      img: 'assets/portraits/heir_card.png',       fb: 'assets/portraits/heir.png',       line: 'HP 3 · ATK 9 · SPD 6' },
  reflection:{ name: 'Отражение Бога',      arch: 'Маг',         img: 'assets/portraits/reflection_card.png', fb: 'assets/portraits/reflection.png', line: 'HP 7 · MANA 9 · DEF 6' },
  defender:  { name: 'Защитник Храмов',     arch: 'Танк',        img: 'assets/portraits/defender_card.png',   fb: 'assets/portraits/defender.png',   line: 'HP 8 · DEF 8 · ATK 5' },
  chief:     { name: 'Вождь Червей',        arch: 'Призыватель', img: 'assets/portraits/chief_card.png',      fb: 'assets/portraits/chief.png',      line: 'HP 3 · SPD 4 · ATK 2' },
  lucian:    { name: 'Люциан Вальмонт',     arch: 'Дуэлянт',     img: 'assets/portraits/lucian_card.png',     fb: 'assets/portraits/lucian.png',     line: 'HP 4 · SPD 9 · ATK 7' },
  spiger:    { name: 'Спайгер',             arch: 'Скоростной',  img: 'assets/portraits/spiger_card.png',     fb: 'assets/portraits/spiger.png',     line: 'HP 3 · SPD 9 · ATK 5' },
};

// ---------- карты ----------
const MAP_META = {
  void:   { name: 'Арена Пустоты', img: 'assets/maps/void.jpg',   fb: '#0a0a12', accent: '154,127,214', mote: 'void' },
  temple: { name: 'Забытый Храм',  img: 'assets/maps/temple.jpg', fb: '#14100c', accent: '216,168,95',  mote: 'temple' },
  forest: { name: 'Гнилой Лес',    img: 'assets/maps/forest.jpg', fb: '#120c0a', accent: '201,106,79',  mote: 'forest' },
};
const MAPIMG = {};            // id -> Image (если загрузилась)
let currentMapId = 'void';
let mapObstacles = [];
let isHost = false;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
const SKILL_KEYS = { veil: 'fog', rabbit: 'channel', kain: 'field', sectarian: 'cone', duk: 'mark', king: 'royaldash',
  barogun: 'spray', heir: 'aim', reflection: 'godmark', defender: 'parry', chief: 'larva', lucian: 'pseudo', spiger: 'overclock' };
const HERO_IDS = Object.keys(META);

// ---------- состояние ----------
let my = { name: '', team: null, code: null, token: null };
let pickedHero = null;
let chars = null, arena = { w: 1200, h: 700 }, youTeam = 'A', names = { A: '', B: '' }, orders = null;
let inBattle = false;
let snapPrev = null, snapCur = null, recvPrev = 0, recvCur = 0;
let lastPhase = '';
let overShown = false;

// ---------- спрайты: отдаем как есть с авто-кропом ----------
const SPRITES = {}; // id -> {c: canvas, w, h}
function bake(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, W, H);
  const p = d.data;

  // Мы полностью удалили алгоритм "выжигания" фона по яркости (Luma-Alpha).
  // Игра полагается на родную прозрачность картинки.

  // 3) Авто-кроп по родной непрозрачности пикселей: убирает пустые поля, центрует фигурку.
  let minX = W, minY = H, maxX = 0, maxY = 0, any = false;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    if (p[(py * W + px) * 4 + 3] > 24) { 
      any = true; 
      if (px < minX) minX = px; 
      if (px > maxX) maxX = px; 
      if (py < minY) minY = py; 
      if (py > maxY) maxY = py; 
    }
  }
  if (!any) return { c, w: W, h: H };
  
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const cc = document.createElement('canvas');
  cc.width = cw; cc.height = ch;
  cc.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return { c: cc, w: cw, h: ch };
}
// ---------- прелоадер (splash) ----------
const PRELOAD = { total: 0, done: 0, finished: false, t0: performance.now() };
function preloadTick() {
  PRELOAD.done++;
  const k = PRELOAD.total ? PRELOAD.done / PRELOAD.total : 1;
  const fill = $('splash-fill');
  if (fill) fill.style.transform = `scaleX(${clamp(k, 0, 1)})`;
  const pct = $('splash-pct');
  if (pct) pct.textContent = `пробуждение арены… ${Math.round(k * 100)}%`;
  if (PRELOAD.done >= PRELOAD.total) finishSplash();
}
function finishSplash() {
  if (PRELOAD.finished) return;
  PRELOAD.finished = true;
  const wait = Math.max(0, 1200 - (performance.now() - PRELOAD.t0));
  setTimeout(() => {
    const sp = $('splash');
    if (sp) sp.classList.add('hide');
    setMusic('theme');
  }, wait);
}
function track(img) {
  PRELOAD.total++;
  img.addEventListener('load', preloadTick, { once: true });
  img.addEventListener('error', preloadTick, { once: true });
}

const PORTRAIT = {};                 // id -> url портрета для HUD (с фолбэком)
const uiImgs = { victory: false, defeat: false };

for (const id of Object.keys(META)) {
  SPRITES[id] = { atkArr: [] };
  let fellBack = false;
  const fallbackAll = () => {
    if (fellBack) return;
    fellBack = true;
    const old = new Image();
    old.onload = () => {
      const b = bake(old);
      if (!SPRITES[id].idle) SPRITES[id].idle = b;
      if (!SPRITES[id].dash) SPRITES[id].dash = b;
      if (!SPRITES[id].atkArr.some(Boolean)) SPRITES[id].atkArr[0] = b;
    };
    old.src = META[id].fb;
  };
  for (const pose of ['idle', 'dash']) {
    const im = new Image();
    track(im);
    im.onload = () => { SPRITES[id][pose] = bake(im); };
    im.onerror = fallbackAll;
    im.src = `assets/anims/${id}_${pose}.png`;
  }
  ['atk', 'atk2', 'atk3'].forEach((nm, ix) => {
    const im = new Image();
    track(im);
    im.onload = () => { SPRITES[id].atkArr[ix] = bake(im); };
    im.onerror = () => { if (nm === 'atk') fallbackAll(); }; // atk2/atk3 опциональны
    im.src = `assets/anims/${id}_${nm}.png`;
  });
  const pi = new Image();
  track(pi);
  pi.onload = () => { PORTRAIT[id] = pi.src; };
  pi.onerror = () => { PORTRAIT[id] = `assets/${id}_p.jpg`; };
  pi.src = `assets/portraits/${id}.png`;
  const ci = new Image(); track(ci); ci.src = META[id].img;   // карточный — греем кэш
}
for (const mid of Object.keys(MAP_META)) {
  const im = new Image();
  track(im);
  im.onload = () => { MAPIMG[mid] = im; if (mid === currentMapId) bakeFloor(); };
  im.src = MAP_META[mid].img;
}
{ // фоны экранов исхода и меню
  const v = new Image(); track(v); v.onload = () => { uiImgs.victory = true; }; v.src = 'assets/ui/victory_bg.jpg';
  const d = new Image(); track(d); d.onload = () => { uiImgs.defeat = true; }; d.src = 'assets/ui/defeat_bg.jpg';
  const mb = new Image(); track(mb); mb.src = 'assets/ui/menu_bg.jpg';
}
// подстраховка, если какие-то onload не стрельнут
setTimeout(finishSplash, 9000);

// ---------- аудио ----------
const AUD = (() => {
  const mk = (src, loop, vol) => { const a = new Audio(src); a.loop = loop; a.volume = vol; a.preload = 'none'; return a; };
  return {
    theme:   mk('assets/audio/theme.mp3',   true,  .40),
    battle:  mk('assets/audio/battle.mp3',  true,  .45),
    battle2: mk('assets/audio/battle2.mp3', true,  .45),
    victory: mk('assets/audio/victory.mp3', false, .60),
    defeat:  mk('assets/audio/defeat.mp3',  false, .55),
  };
})();
let audMuted = false;
try { audMuted = localStorage.getItem('hm_mute') === '1'; } catch (e) {}
let audUnlocked = false, audCur = null;
function applyMute() {
  for (const k in AUD) AUD[k].muted = audMuted;
  const b = $('btn-mute');
  if (b) { b.classList.toggle('off', audMuted); b.textContent = audMuted ? '♪' : '♪'; }
}
function setMusic(name) {
  const pick = name === 'battle' ? (Math.random() < .5 ? 'battle' : 'battle2') : name;
  if (audCur === pick && pick && !AUD[pick].paused) return;
  if (audCur && AUD[audCur]) { AUD[audCur].pause(); AUD[audCur].currentTime = 0; }
  audCur = pick || null;
  if (audCur && audUnlocked) AUD[audCur].play().catch(() => {});
}
function sting(name) {
  const a = AUD[name];
  if (!a || !audUnlocked) return;
  a.currentTime = 0; a.play().catch(() => {});
}
function unlockAudio() {
  if (audUnlocked) return;
  audUnlocked = true;
  if (audCur) AUD[audCur].play().catch(() => {});
}
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });
applyMute();
const muteBtn = $('btn-mute');
if (muteBtn) muteBtn.addEventListener('click', () => {
  audMuted = !audMuted;
  try { localStorage.setItem('hm_mute', audMuted ? '1' : '0'); } catch (e) {}
  applyMute();
});

// ---------- экраны ----------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  document.body.classList.toggle('in-battle', id === 'screen-battle');
}

// ---------- сохранение сессии ----------
const SKEY = 'va_session';
function saveSession() { try { localStorage.setItem(SKEY, JSON.stringify({ code: my.code, token: my.token, name: my.name })); } catch (e) {} }
function clearSession() { try { localStorage.removeItem(SKEY); } catch (e) {} }
function loadSession() { try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { return null; } }

// ============================================================
//  ЛОББИ
// ============================================================
const inpName = $('inp-name'), inpCode = $('inp-code'), homeErr = $('home-err');
const saved = loadSession();
if (saved?.name) inpName.value = saved.name;

function syncCreateBtn() { $('btn-create').disabled = !inpName.value.trim(); }
inpName.addEventListener('input', syncCreateBtn);
syncCreateBtn();

$('btn-create').addEventListener('click', () => {
  my.name = inpName.value.trim() || 'Игрок';
  socket.emit('create', { name: my.name }, res => {
    if (!res?.ok) { homeErr.textContent = res?.err || 'Не удалось открыть врата.'; return; }
    Object.assign(my, { code: res.code, token: res.token, team: res.team });
    saveSession();
    enterRoom();
  });
});
$('btn-join').addEventListener('click', doJoin);
inpCode.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
function doJoin() {
  const code = inpCode.value.trim().toUpperCase();
  if (code.length !== 6) { homeErr.textContent = 'Код арены — 6 символов.'; return; }
  my.name = inpName.value.trim() || 'Игрок';
  socket.emit('join', { code, name: my.name }, res => {
    if (!res?.ok) { homeErr.textContent = res?.err || 'Врата не открылись.'; return; }
    Object.assign(my, { code: res.code, token: res.token, team: res.team });
    saveSession();
    enterRoom();
  });
}

// автопереподключение
if (saved?.code && saved?.token) {
  socket.emit('resume', { code: saved.code, token: saved.token }, res => {
    if (res?.ok) {
      Object.assign(my, { code: saved.code, token: saved.token, team: res.team, name: saved.name });
      if (!res.inBattle) enterRoom();
    } else clearSession();
  });
}
socket.on('connect', () => {
  if (my.code && my.token && inBattle) socket.emit('resume', { code: my.code, token: my.token }, () => {});
});

// ============================================================
//  КОМНАТА / ПОРЯДОК
// ============================================================
function enterRoom() {
  setMusic('theme');
  $('room-code').textContent = my.code || '------';
  pickedHero = null;
  $('btn-ready').disabled = true;
  $('btn-ready').textContent = 'К БОЮ';
  $('room-status').textContent = '';
  show('screen-room');
}
$('btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(my.code); $('btn-copy').textContent = 'скопировано'; }
  catch (e) { $('btn-copy').textContent = my.code; }
  setTimeout(() => $('btn-copy').textContent = 'копировать', 1400);
});

socket.on('room', data => {
  if (!my.team) my.team = data.yourTeam;
  isHost = data.host === data.yourTeam;
  setMapSel(data.mapId);
  setMapLock();
  $('room-code').textContent = data.code;
  const other = data.yourTeam === 'A' ? data.B : data.A;
  const mine = data.yourTeam === 'A' ? data.A : data.B;
  $('room-opponent').textContent = other
    ? `⚔ ${other.name}${other.connected ? '' : ' (отключён)'} — ${other.ready ? 'готов к бою' : other.heroId ? 'герой выбран' : 'выбирает героя'}`
    : 'ожидание второго владыки… отправь ему код';
  if (mine?.ready) $('room-status').textContent = other?.ready ? 'врата открываются…' : 'ждём соперника…';
});

let builtHeroPick = false;
function buildOrderCards() {
  if (builtHeroPick) { refreshBadges(); return; }
  builtHeroPick = true;
  const wrap = $('order-cards');
  wrap.innerHTML = '';
  HERO_IDS.forEach(id => {
    const m = META[id];
    const card = document.createElement('div');
    card.className = 'ocard';
    card.dataset.hero = id;
    card.innerHTML = `<div class="oc-num"></div><img src="${m.img}" onerror="this.onerror=null;this.src='${m.fb}'" alt="${m.name}">
      <div class="oc-name">${m.name}</div><div class="oc-arch">${m.arch}</div>
      <div class="oc-stats"><b>${m.line}</b></div>`;
    card.addEventListener('click', () => {
      pickedHero = id;
      refreshBadges();
      socket.emit('pickHero', { heroId: pickedHero });
      $('btn-ready').disabled = false;
    });
    wrap.appendChild(card);
  });
  // карта "случайный выбор"
  const rnd = document.createElement('div');
  rnd.className = 'ocard ocard-random';
  rnd.innerHTML = `<div class="oc-rand-sigil">⚄</div><div class="oc-name">Случайный выбор</div><div class="oc-arch">Судьба решает</div>`;
  rnd.addEventListener('click', () => {
    pickedHero = HERO_IDS[(Math.random() * HERO_IDS.length) | 0];
    refreshBadges();
    socket.emit('pickHero', { heroId: pickedHero });
    $('btn-ready').disabled = false;
  });
  wrap.appendChild(rnd);
  refreshBadges();
}
function refreshBadges() {
  document.querySelectorAll('.ocard').forEach(card => {
    card.classList.toggle('picked', card.dataset.hero === pickedHero);
  });
}
buildOrderCards();
$('btn-ready').addEventListener('click', () => {
  socket.emit('ready');
  $('btn-ready').disabled = true;
  $('btn-ready').textContent = 'ЖДЁМ…';
});

$('btn-rand-order').addEventListener('click', () => {
  pickedHero = HERO_IDS[(Math.random() * HERO_IDS.length) | 0];
  refreshBadges();
  socket.emit('pickHero', { heroId: pickedHero });
  $('btn-ready').disabled = false;
});

// ---------- выбор карты ----------
function buildMapPick() {
  const wrap = $('map-pick');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const id of Object.keys(MAP_META)) {
    const m = MAP_META[id];
    const c = document.createElement('div');
    c.className = 'map-card';
    c.dataset.map = id;
    c.innerHTML = `<img src="${m.img}" alt=""><div class="mc-name">${m.name}</div>`;
    c.addEventListener('click', () => { if (isHost && !inBattle) socket.emit('selectMap', { mapId: id }); });
    wrap.appendChild(c);
  }
}
function setMapSel(id) {
  if (id && MAP_META[id] && id !== currentMapId) { currentMapId = id; bakeFloor(); }
  document.querySelectorAll('.map-card').forEach(c => c.classList.toggle('sel', c.dataset.map === currentMapId));
}
function setMapLock() {
  document.querySelectorAll('.map-card').forEach(c => c.classList.toggle('locked', !isHost));
  const h = $('map-hint');
  if (h) h.textContent = isHost ? 'Ты хост — выбери арену.' : 'Арену выбирает хост.';
}
buildMapPick();
setMapSel('void');
socket.on('mapSelected', d => setMapSel(d.mapId));

// ---------- рандомный бой из меню ----------
$('btn-random-battle').addEventListener('click', () => {
  my.name = inpName.value.trim() || 'Странник';
  socket.emit('create', { name: my.name }, res => {
    if (!res?.ok) { homeErr.textContent = res?.err || 'Врата не открылись.'; return; }
    Object.assign(my, { code: res.code, token: res.token, team: res.team });
    saveSession();
    enterRoom();
    const ids = Object.keys(MAP_META);
    socket.emit('selectMap', { mapId: ids[(Math.random() * ids.length) | 0] });
    pickedHero = HERO_IDS[(Math.random() * HERO_IDS.length) | 0];
    socket.emit('pickHero', { heroId: pickedHero });
    socket.emit('ready');
    $('btn-ready').disabled = true;
    $('btn-ready').textContent = 'ЖДЁМ…';
    $('room-status').textContent = 'судьба бросила кости — жди соперника и кидай ему код';
  });
});

// ---------- навигация меню v2 ----------
function fadeTo(id) {
  const b = $('blackout');
  b.classList.add('on');
  setTimeout(() => {
    show(id);
    if (id === 'screen-yarik') requestAnimationFrame(() => $('screen-yarik').classList.add('in'));
    else $('screen-yarik').classList.remove('in');
    setTimeout(() => b.classList.remove('on'), 60);
  }, 430);
}
$('btn-menu-play').addEventListener('click', () => fadeTo('screen-play'));
$('btn-menu-lore').addEventListener('click', () => fadeTo('screen-lore'));
$('btn-menu-yarik').addEventListener('click', () => fadeTo('screen-yarik'));
$('btn-play-back').addEventListener('click', () => fadeTo('screen-home'));
$('btn-lore-back').addEventListener('click', () => fadeTo('screen-home'));
$('btn-yarik-back').addEventListener('click', () => fadeTo('screen-home'));
$('screen-yarik').addEventListener('click', e => { if (e.target.id !== 'btn-yarik-back') fadeTo('screen-home'); });
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || inBattle) return;
  for (const id of ['screen-play', 'screen-lore', 'screen-yarik']) {
    if ($(id).classList.contains('active')) { fadeTo('screen-home'); return; }
  }
});

// ---------- выход из комнаты и из боя ----------
function leaveToMenu() {
  try { socket.emit('leave'); } catch (err) {}
  clearSession();
  setTimeout(() => location.reload(), 140);
}
$('btn-room-back').addEventListener('click', leaveToMenu);
$('btn-battle-exit').addEventListener('click', () => $('confirm-leave').classList.add('show'));
$('cl-no').addEventListener('click', () => $('confirm-leave').classList.remove('show'));
$('cl-yes').addEventListener('click', leaveToMenu);

// ============================================================
//  БОЙ — инициализация
// ============================================================
const cv = $('game');
const ctx = cv.getContext('2d');
let DPR = 1, scale = 1, offX = 0, offY = 0;

socket.on('start', data => {
  arena = data.arena; chars = data.chars; youTeam = data.you; names = data.names; orders = data.orders;
  if (data.map) { currentMapId = MAP_META[data.map.id] ? data.map.id : 'void'; mapObstacles = data.map.obstacles || []; }
  inBattle = true; overShown = false; lastPhase = '';
  snapPrev = snapCur = null;
  fx.length = 0; texts.length = 0; shake = 0; flashWhite = 0; flashRed = 0; timeScale = 1; ownSim = null;
  poseUntil.clear(); telegraphs.length = 0; animState.clear();
  $('confirm-leave').classList.remove('show');
  setMusic('battle');
  show('screen-battle');
  resize();
  banner('ПРИГОТОВЬСЯ', false, 1300);
});

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(innerWidth * DPR);
  cv.height = Math.round(innerHeight * DPR);
  scale = Math.min(cv.width / arena.w, cv.height / arena.h);
  offX = (cv.width - arena.w * scale) / 2;
  offY = (cv.height - arena.h * scale) / 2;
  bakeFloor();
}
addEventListener('resize', resize);

// ---------- пол арены (кэш) ----------
let floorC = null, floorVoidC = null, mapC = null, vinC = null, mapBleed = 0, parX = 0, parY = 0;
function bakeFloor() {
  const make = voidMode => {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(arena.w * scale));
    c.height = Math.max(2, Math.round(arena.h * scale));
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    if (voidMode) {
      x.fillStyle = '#040406'; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 2 * scale;
      x.beginPath(); x.arc(w / 2, h / 2, 250 * scale, 0, 7); x.stroke();
    } else {
      const g = x.createRadialGradient(w / 2, h / 2, 60 * scale, w / 2, h / 2, w * 0.62);
      g.addColorStop(0, '#13131a'); g.addColorStop(1, '#0a0a0e');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(201,168,106,.07)'; x.lineWidth = 1.4 * scale;
      x.beginPath(); x.arc(w / 2, h / 2, 240 * scale, 0, 7); x.stroke();
      x.setLineDash([6 * scale, 10 * scale]);
      x.beginPath(); x.arc(w / 2, h / 2, 170 * scale, 0, 7); x.stroke();
      x.setLineDash([]);
      x.strokeStyle = 'rgba(142,47,47,.10)';
      x.beginPath(); x.moveTo(w / 2 - 240 * scale, h / 2); x.lineTo(w / 2 + 240 * scale, h / 2);
      x.moveTo(w / 2, h / 2 - 240 * scale); x.lineTo(w / 2, h / 2 + 240 * scale); x.stroke();
    }
    x.strokeStyle = voidMode ? 'rgba(255,255,255,.10)' : 'rgba(201,168,106,.16)';
    x.lineWidth = 2 * scale;
    x.strokeRect(6 * scale, 6 * scale, w - 12 * scale, h - 12 * scale);
    x.strokeStyle = voidMode ? 'rgba(255,255,255,.04)' : 'rgba(201,168,106,.05)';
    x.strokeRect(14 * scale, 14 * scale, w - 28 * scale, h - 28 * scale);
    return c;
  };
  floorC = make(false); floorVoidC = make(true);

  // фон выбранной карты (масштабируем один раз)
  mapC = null;
  mapBleed = Math.round(16 * scale);
  const mi = MAPIMG[currentMapId];
  if (mi) {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(arena.w * scale) + mapBleed * 2);
    c.height = Math.max(2, Math.round(arena.h * scale) + mapBleed * 2);
    const x = c.getContext('2d');
    x.drawImage(mi, 0, 0, c.width, c.height);
    const g = x.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, 'rgba(0,0,0,.30)');
    g.addColorStop(.42, 'rgba(0,0,0,.06)');
    g.addColorStop(1, 'rgba(0,0,0,.32)');
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = 'rgba(201,168,106,.15)';
    x.lineWidth = 2 * scale;
    x.strokeRect(6 * scale, 6 * scale, c.width - 12 * scale, c.height - 12 * scale);
    mapC = c;
  }

  // виньетка (кэш)
  {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(arena.w * scale));
    c.height = Math.max(2, Math.round(arena.h * scale));
    const x = c.getContext('2d');
    const g = x.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.42, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    vinC = c;
  }
}

// ---------- атмосферные частицы ----------
const motes = Array.from({ length: 36 }, () => ({
  x: Math.random() * 1200, y: Math.random() * 700,
  vy: -4 - Math.random() * 8, ph: Math.random() * 7, s: 1 + Math.random() * 1.6,
}));

// ============================================================
//  ВВОД
// ============================================================
let mx = 0, mzy = 0;
const keys = {};
function sendInput() { socket.emit('input', { mx, my: mzy }); }
setInterval(() => { if (inBattle) sendInput(); }, 200);

function recalcMove() {
  let x = 0, y = 0;
  if (keys.KeyW || keys.ArrowUp) y -= 1;
  if (keys.KeyS || keys.ArrowDown) y += 1;
  if (keys.KeyA || keys.ArrowLeft) x -= 1;
  if (keys.KeyD || keys.ArrowRight) x += 1;
  if (x !== mx || y !== mzy) { mx = x; mzy = y; sendInput(); }
}
addEventListener('keydown', e => {
  if (!inBattle) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyJ') { socket.emit('act', { type: 'attack' }); return; }
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'KeyK') socket.emit('act', { type: 'skill' });
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') socket.emit('act', { type: 'dash' });
  recalcMove();
});
addEventListener('keyup', e => { keys[e.code] = false; recalcMove(); });

let mouseHold = null;
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('mousedown', e => {
  if (!inBattle) return;
  if (e.button === 0) {
    socket.emit('act', { type: 'attack' });
    mouseHold = setInterval(() => socket.emit('act', { type: 'attack' }), 140);
  } else if (e.button === 2) socket.emit('act', { type: 'skill' });
});
addEventListener('mouseup', () => { if (mouseHold) { clearInterval(mouseHold); mouseHold = null; } });

// ---------- тач ----------
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const joyZone = $('joy-zone'), joyBase = $('joy-base'), joyStick = $('joy-stick');
let joyId = null, joyCx = 0, joyCy = 0;
joyZone.addEventListener('pointerdown', e => {
  joyId = e.pointerId; joyCx = e.clientX; joyCy = e.clientY;
  joyBase.style.display = 'block';
  joyBase.style.left = (joyCx - 55) + 'px'; joyBase.style.top = (joyCy - 55) + 'px';
  joyZone.setPointerCapture(e.pointerId);
});
joyZone.addEventListener('pointermove', e => {
  if (e.pointerId !== joyId) return;
  let dx = e.clientX - joyCx, dy = e.clientY - joyCy;
  const len = Math.hypot(dx, dy), max = 42;
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  joyStick.style.left = (31 + dx) + 'px'; joyStick.style.top = (31 + dy) + 'px';
  const nx = Math.abs(dx) < 7 ? 0 : dx / max, ny = Math.abs(dy) < 7 ? 0 : dy / max;
  if (nx !== mx || ny !== mzy) { mx = nx; mzy = ny; sendInput(); }
});
function joyEnd(e) {
  if (e.pointerId !== joyId) return;
  joyId = null; joyBase.style.display = 'none';
  joyStick.style.left = '31px'; joyStick.style.top = '31px';
  mx = 0; mzy = 0; sendInput();
}
joyZone.addEventListener('pointerup', joyEnd);
joyZone.addEventListener('pointercancel', joyEnd);

let atkHold = null;
const hold = (el, type) => {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    socket.emit('act', { type });
    if (type === 'attack') atkHold = setInterval(() => socket.emit('act', { type: 'attack' }), 150);
  });
  const stop = () => { if (atkHold && type === 'attack') { clearInterval(atkHold); atkHold = null; } };
  el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop); el.addEventListener('pointerleave', stop);
};
hold($('tb-atk'), 'attack'); hold($('tb-skill'), 'skill'); hold($('tb-dash'), 'dash');

// ============================================================
//  СНАПШОТЫ И СОБЫТИЯ
// ============================================================
socket.on('snap', s => {
  snapPrev = snapCur; recvPrev = recvCur;
  snapCur = s; recvCur = performance.now();
  for (const e of s.events || []) handleEvent(e);
  updateHud(s);
  if (s.phase !== lastPhase) {
    if (s.phase === 'over' && !overShown) { overShown = true; setTimeout(() => showOver(s.winner, null), 1600); }
    lastPhase = s.phase;
  }
});
socket.on('paused', d => {
  $('pause-text').textContent = `${d.name} переподключается… бой на паузе (${d.grace} с)`;
  $('pause-overlay').classList.add('show');
});
socket.on('resumed', () => $('pause-overlay').classList.remove('show'));
socket.on('over', d => { if (!overShown) { overShown = true; showOver(d.winner, d.reason); } });
socket.on('roomClosed', () => { clearSession(); location.reload(); });
socket.on('lobbyBack', () => { inBattle = false; $('pause-overlay').classList.remove('show'); enterRoom(); });
socket.on('rematchWait', d => {
  $('over-status').textContent = d.team === youTeam ? 'ждём соперника…' : 'соперник зовёт на реванш!';
});

function showOver(winner, reason) {
  inBattle = false;
  $('pause-overlay').classList.remove('show');
  const win = winner === youTeam;
  const sc = $('screen-over');
  sc.classList.toggle('win', win);
  sc.classList.toggle('lose', !win);
  sc.classList.toggle('noimg', !(win ? uiImgs.victory : uiImgs.defeat));
  setMusic(null);
  sting(win ? 'victory' : 'defeat');
  $('over-title').textContent = win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
  $('over-title').style.color = win ? '#e6dcc3' : '#d06262';
  const wn = names[winner] || 'Владыка';
  $('over-sub').textContent = reason === 'forfeit'
    ? 'соперник покинул арену — пустота засчитала победу'
    : win ? 'чудеса на вашей стороне' : 'чудеса отвернулись от вас';
  void wn;
  $('over-status').textContent = '';
  $('btn-rematch').disabled = false;
  show('screen-over');
}
$('btn-rematch').addEventListener('click', () => { socket.emit('rematch'); $('btn-rematch').disabled = true; });
$('btn-exit').addEventListener('click', () => { clearSession(); location.reload(); });

// ============================================================
//  ЭФФЕКТЫ
// ============================================================
const fx = [];     // частицы/кольца/дуги
const texts = [];  // всплывающие числа и слова
let shake = 0, flashWhite = 0, flashRed = 0, timeScale = 1, slowUntil = 0;

function spark(x, y, n, color, sp = 160, size = 3, life = 0.5) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 7, v = sp * (0.4 + Math.random() * 0.8);
    fx.push({ t: 'p', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, size: size * (0.6 + Math.random() * 0.8), color });
  }
}
function ring(x, y, r0, r1, color, life = 0.5, lw = 3) { fx.push({ t: 'r', x, y, r0, r1, color, life, max: life, lw }); }
function arcFx(x, y, face, range, arcDeg, color, life = 0.28, lw = 7) { fx.push({ t: 'a', x, y, face, range, arc: arcDeg * Math.PI / 180, color, life, max: life, lw }); }
function coneFx(x, y, face, range, arcDeg, color, life = 0.4) { fx.push({ t: 'c', x, y, face, range, arc: arcDeg * Math.PI / 180, color, life, max: life }); }
function popText(x, y, str, color, size = 16, life = 0.9) { texts.push({ x, y, str, color, size, life, max: life }); }

// ---------- позы спрайтов, анимация, телеграфы ----------
const poseUntil = new Map();   // eid -> {pose, until, t0}
const telegraphs = [];         // {eid, until, dur}
const animState = new Map();   // eid -> {px,py,pt,vx,walkPh,atkIx,trail,dieAt,dustAt,seen}
function anim(eid) {
  let a = animState.get(eid);
  if (!a) { a = { px: 0, py: 0, pt: 0, vx: 0, walkPh: 0, atkIx: 0, trail: [], dieAt: 0, dustAt: 0, seen: 0 }; animState.set(eid, a); }
  a.seen = performance.now();
  if (animState.size > 24) for (const [k, v] of animState) if (performance.now() - v.seen > 8000) animState.delete(k);
  return a;
}
function setPose(eid, pose, durS, bump, phase) {
  if (eid === undefined) return;
  const t0 = performance.now();
  poseUntil.set(eid, { pose, until: t0 + durS * 1000, t0, phase: phase || null });
  if (bump && pose === 'atk') anim(eid).atkIx++;
}

function posOf(eid) {
  const s = snapCur; if (!s) return null;
  for (const f of [s.A, s.B, ...(s.extras || [])]) if (f && f.eid === eid) return f;
  return null;
}

function handleEvent(e) {
  switch (e.k) {
    case 'swap': banner(`ВЫХОДИТ · ${e.name.toUpperCase()}`, false, 1300); break;
    case 'fight': banner('БОЙ', true, 900); break;
    case 'hit': {
      const col = e.dot ? '#8fd17a' : e.crit ? '#f0a050' : e.self ? '#b07ad1' : '#f0e6d2';
      spark(e.x, e.y, e.crit ? 14 : 8, e.crit ? '#f0a050' : '#d06262', e.crit ? 230 : 150);
      popText(e.x + (Math.random() * 24 - 12), e.y - 30, String(e.dmg), col, e.crit ? 23 : e.dot ? 13 : 16);
      if (e.dmg >= 60) shake = Math.max(shake, 7);
      break;
    }
    case 'miss': popText(e.x, e.y - 14, e.forced ? 'паранойя!' : 'мимо', e.forced ? '#7ab8d1' : '#6e6a5e', 13, 0.7); break;
    case 'void': ring(e.x, e.y, 8, 52, '#9a8cc9', 0.5); popText(e.x, e.y - 36, 'в пустоту', '#b8a8e0', 13); break;
    case 'blocked': ring(e.x, e.y, 14, 34, '#ffffff', 0.3, 2); break;
    case 'slash': setPose(e.eid, 'atk', 0.30, true, 'strike'); arcFx(e.x, e.y, e.face, e.range * 0.85, e.arc, e.heavy ? '#f0dca0' : '#d8d2c4', e.heavy ? 0.34 : 0.24, e.heavy ? 9 : 6); if (e.heavy) shake = Math.max(shake, 4); break;
    case 'windup': { setPose(e.eid, 'atk', e.dur + 0.18, true, 'wind'); telegraphs.push({ eid: e.eid, until: performance.now() + e.dur * 1000, dur: e.dur }); const p = posOf(e.eid); if (p) ring(p.x, p.y, 30, 16, '#ffffff44', e.dur, 2); break; }
    case 'shoot': { setPose(e.eid, 'atk', 0.25, true, 'strike'); spark(e.x + Math.cos(e.face) * 30, e.y + Math.sin(e.face) * 30, 5, '#ffe9b0', 120, 2, 0.25); break; }
    case 'dash': setPose(e.eid, 'dash', 0.26); spark(e.x, e.y, 6, '#c9a86a', 90, 2, 0.35); break;
    case 'skill':
      setPose(e.eid, 'atk', 0.4, true, 'strike');
      if (e.fx === 'fog') { banner('ГОЛУБАЯ ПАРАНОЙЯ', false, 1200); const p = posOf(e.eid); if (p) ring(p.x, p.y, 20, 240, '#5a7d9e', 0.9, 4); }
      if (e.fx === 'channel') { /* рендер по st.channel */ }
      if (e.fx === 'field') { banner('ПРИГОВОР ЛУНЫ', false, 1200); ring(e.x, e.y, 30, e.r, '#b58cff', 0.8, 4); shake = Math.max(shake, 5); }
      if (e.fx === 'cone') {
        coneFx(e.x, e.y, e.face, e.range, e.arc, '#a33b3b');
        for (let i = 0; i < 12; i++) {
          const aa = e.face + (Math.random() - 0.5) * (e.arc * Math.PI / 180);
          const vv = 200 + Math.random() * 240;
          fx.push({ t: 'p', x: e.x + Math.cos(aa) * 22, y: e.y + Math.sin(aa) * 22, vx: Math.cos(aa) * vv, vy: Math.sin(aa) * vv, life: .45, max: .45, size: 3, color: i % 3 ? '#7a1f1f' : '#d04545' });
        }
      }
      if (e.fx === 'mark') { /* рисуется из extras */ }
      if (e.fx === 'royaldash') { const p = posOf(e.eid); if (p) spark(p.x, p.y, 12, '#cfc6b8', 200, 3, 0.5); }
      // --- новые 7 ---
      if (e.fx === 'spray') {                                   // Барогун: шквал пуль
        banner('СВОРА СТВОЛОВ', false, 1100);
        for (let i = 0; i < 22; i++) {
          const aa = e.face + (Math.random() - 0.5) * (e.arc * Math.PI / 180);
          const vv = 320 + Math.random() * 280;
          fx.push({ t: 'p', x: e.x + Math.cos(aa) * 24, y: e.y + Math.sin(aa) * 24, vx: Math.cos(aa) * vv, vy: Math.sin(aa) * vv, life: .5, max: .5, size: 2.6, color: i % 2 ? '#ffd98a' : '#ffaa44' });
        }
        shake = Math.max(shake, 5);
      }
      if (e.fx === 'aim') { banner('ПРИЦЕЛИВАНИЕ', false, 900); const p = posOf(e.eid); if (p) ring(p.x, p.y, 14, 70, '#ff9d9d', 0.5, 2); }
      if (e.fx === 'godmark') { banner('GGGGOD STRIKE', false, 1400); }   // круг рисуется из extras
      if (e.fx === 'parry') { const p = posOf(e.eid); if (p) { ring(p.x, p.y, 10, 50, '#fff0c8', 0.35, 3); } }
      if (e.fx === 'larva') { const p = posOf(e.eid); if (p) spark(p.x, p.y, 8, '#cfe08a', 90, 2.4, 0.5); }
      if (e.fx === 'grave') { banner('ГЛУБИНА МОГИЛЫ', false, 1200); ring(e.x, e.y, 24, e.r, '#9aa86a', 0.8, 4); }
      if (e.fx === 'pseudo') { banner('ПСЕВДОРЕАЛЬНЫЙ РАЗРЫВ', false, 1100); const p = posOf(e.eid); if (p) spark(p.x, p.y, 14, '#dfe8ff', 220, 2.6, 0.6); }
      if (e.fx === 'overclock') { banner('РАЗГОН', false, 900); const p = posOf(e.eid); if (p) ring(p.x, p.y, 12, 80, '#d6ecff', 0.5, 3); }
      break;
    case 'finisher': { setPose(e.eid, 'atk', 0.5, true, 'strike'); const p = posOf(e.eid); if (p) { ring(p.x, p.y, 40, 150, '#f0dca0', 0.5, 6); shake = Math.max(shake, 10); } break; }
    // --- события новых механик ---
    case 'beam': {                                              // Наследница: выстрел лучом
      const len = e.range || 540;
      fx.push({ t: 'beam', x: e.x, y: e.y, ang: e.ang, len, life: .35, max: .35, hit: !!e.hit });
      if (e.hit) shake = Math.max(shake, 6);
      break;
    }
    case 'godhit': {                                            // Отражение: удар с неба
      ring(e.x, e.y, 20, e.r, '#a8f0e0', 0.7, 6);
      ring(e.x, e.y, 10, e.r * 0.7, '#ffffff', 0.5, 3);
      spark(e.x, e.y, 30, '#cfe4dd', 300, 3.5, 0.8);
      fx.push({ t: 'b', x: e.x, y: e.y, life: .6, max: .6 });
      flashWhite = 0.5; shake = Math.max(shake, 10);
      break;
    }
    case 'godmark': break;                                      // телеграф рисуется из extras
    case 'parry': { ring(e.x, e.y, 8, e.heavy ? 70 : 46, '#fff0c8', 0.35, 3); popText(e.x, e.y - 40, e.heavy ? 'БЛОК' : 'ПАРИРОВАНО', '#fff0c8', e.heavy ? 14 : 16, 0.9); if (!e.heavy) spark(e.x, e.y, 10, '#ffe9b0', 160, 2.2, 0.4); break; }
    case 'echo': spark(e.x, e.y, 6, '#dfe8ff', 120, 2, 0.4); break;
    case 'pseudoHit': spark(e.x, e.y, 8, '#c9d4f0', 150, 2.2, 0.4); popText(e.x + (Math.random()*16-8), e.y - 26, '✦', '#dfe8ff', 14, 0.5); break;
    case 'spigerStack': { const p = posOf(e.eid); if (p) { ring(p.x, p.y, 8, 28 + e.n * 10, '#d6ecff', 0.4, 2); popText(p.x, p.y - 46, 'x' + (e.n + 1), '#d6ecff', 13 + e.n * 2, 0.6); } break; }
    case 'spigerBurst': { ring(e.x, e.y, 14, 90, '#d6ecff', 0.5, 3); spark(e.x, e.y, 18, '#a7c6e0', 240, 3, 0.6); shake = Math.max(shake, 7); break; }
    case 'flare': { flashWhite = 0.7; banner('ОСВЕТИТЕЛЬНАЯ', false, 1000); ring(e.x, e.y, 30, 400, '#fff4d0', 0.7, 4); break; }
    case 'larvaSpawn': spark(e.x, e.y, 7, '#cfe08a', 80, 2.2, 0.5); break;
    case 'larvaDie': spark(e.x, e.y, 6, '#9aa86a', 100, 2, 0.4); break;
    case 'awaken': { banner('ПРОБУЖДЕНИЕ ВОЖДЯ', true, 1500); ring(e.x, e.y, 30, 260, '#cfe08a', 0.9, 5); flashRed = 0.3; shake = Math.max(shake, 10); break; }
    case 'chiefRevive': { ring(e.x, e.y, 16, 120, '#cfe08a', 0.7, 4); spark(e.x, e.y, 20, '#9aa86a', 220, 3, 0.7); popText(e.x, e.y - 50, 'ВОЗРОЖДЕНИЕ', '#cfe08a', 15, 1.1); break; }
    case 'impact': spark(e.x, e.y, 16, '#ffe9b0', 260, 3, 0.5); ring(e.x, e.y, 10, 70, '#ffe9b0', 0.4); fx.push({ t: 'b', x: e.x, y: e.y, life: .55, max: .55 }); shake = Math.max(shake, 6); break;
    case 'tp': ring(e.x, e.y, 6, 44, '#ffe9b0', 0.45, 2); break;
    case 'absh': { popText(e.x, e.y - 50, 'ABSHOTLUTION', '#7ab8d1', 15, 1.1); ring(e.x, e.y, 10, 60, '#7ab8d1', 0.6); break; }
    case 'cancel': popText(e.x, e.y - 40, 'СОРВАНО', '#d06262', 17, 1); shake = Math.max(shake, 6); break;
    case 'quasar': {
      flashWhite = 1; banner('КВАЗАРНОЕ ОБНУЛЕНИЕ', false, 1800);
      const cx = arena.w / 2, cy = arena.h / 2;
      ring(cx, cy, 30, 560, '#ffffff', 0.9, 6);
      ring(cx, cy, 20, 420, '#cfd6ff', 0.7, 4);
      ring(cx, cy, 12, 280, '#b58cff', 0.55, 3);
      break;
    }
    case 'shake': shake = Math.max(shake, e.mag); break;
    case 'crack': spark(e.x, e.y, 7, '#f0a050', 130, 2.4, 0.5); popText(e.x, e.y - 44, 'трещина', '#f0a050', 12); break;
    case 'tears': spark(e.x, e.y, 9, '#e84d7a', 110, 2.2, 0.6); break;
    case 'clone': banner('SPORE MINISTRY', false, 1300); spark(e.x, e.y, 26, '#a8c99a', 240, 3, 0.7); ring(e.x, e.y, 16, 120, '#a8c99a', 0.6); break;
    case 'cloud': ring(e.x, e.y, 20, e.r, '#a8c99a', 0.7, 3); break;
    case 'denied': { const p = posOf(e.eid); if (p) popText(p.x, p.y - 50, 'запечатано', '#9a8cc9', 13); break; }
    case 'ko': {
      const df = snapCur?.[e.team];
      if (df) anim(df.eid).dieAt = performance.now();
      banner(`${e.name.toUpperCase()} ПОВЕРЖЕН`, true, 1600);
    }
      ring(e.x, e.y, 20, 180, '#d06262', 0.9, 5);
      spark(e.x, e.y, 30, '#8e2f2f', 280, 4, 0.9);
      flashRed = 0.6; shake = Math.max(shake, 12);
      timeScale = 0.35; slowUntil = performance.now() + 850;
      break;

    case 'over': break;
  }
}

// ---------- баннер ----------
let bannerTimer = null;
function banner(text, red = false, ms = 1100) {
  const b = $('banner');
  b.textContent = text;
  b.classList.toggle('red', red);
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}

// ============================================================
//  HUD
// ============================================================
function sideEls(side) {
  return side === 'left'
    ? { img: $('hp-img-A'), name: $('hud-name-A'), hp: $('hpbar-A'), num: $('hpnum-A'), mn: $('mnbar-A'), pips: $('pips-A') }
    : { img: $('hp-img-B'), name: $('hud-name-B'), hp: $('hpbar-B'), num: $('hpnum-B'), mn: $('mnbar-B'), pips: $('pips-B') };
}
function updateHud(s) {
  const meF = s[youTeam], enF = s[youTeam === 'A' ? 'B' : 'A'];
  fillSide('left', meF, youTeam, s);
  fillSide('right', enF, youTeam === 'A' ? 'B' : 'A', s);
  if (meF?.cd) {
    setCd('sk-atk', meF.cd.atk, true);
    setCd('sk-skill', meF.cd.skill, meF.cd.skillReady);
    setCd('sk-dash', meF.cd.dash, true);
    $('sk-skill-name').textContent = chars?.[meF.id]?.skillName || 'скилл';
  }
}
function fillSide(side, f, team, s) {
  const el = sideEls(side);
  if (!f) return;
  const psrc = PORTRAIT[f.id] || `assets/${f.id}_p.jpg`;
  if (el.img.dataset.pid !== f.id + psrc) { el.img.src = psrc; el.img.dataset.pid = f.id + psrc; }
  el.name.textContent = `${chars?.[f.id]?.name || f.id} · ${names[team] || ''}`;
  if (f.hp === null) {
    el.hp.style.transform = 'scaleX(1)';
    el.hp.style.opacity = '.35';
    el.num.textContent = '???';
    el.mn.style.transform = 'scaleX(1)'; el.mn.style.opacity = '.25';
  } else {
    el.hp.style.opacity = '1'; el.mn.style.opacity = '1';
    const pct = clamp(f.hp / f.maxHp, 0, 1);
    el.hp.className = 'fill ' + (pct > 0.6 ? 'hp-hi' : pct > 0.3 ? 'hp-mid' : 'hp-low');
    el.hp.style.transform = `scaleX(${pct})`;
    el.num.textContent = `${f.hp}/${f.maxHp}`;
    el.mn.style.transform = `scaleX(${clamp((f.mana ?? 0) / f.maxMana, 0, 1)})`;
  }
  const pips = el.pips.querySelectorAll('i');
  (s.bench[team] || []).forEach((alive, i) => pips[i]?.classList.toggle('dead', !alive));
}
function setCd(id, frac, ready) {
  const el = $(id);
  el.style.setProperty('--cd', clamp(frac, 0, 1));
  el.classList.toggle('nomana', !ready);
}

// ============================================================
//  РЕНДЕР
// ============================================================
let ownSim = null, ownEid = -1;
let lastTime = performance.now();
const projTrail = new Map();

function entLerp(eid, getter) {
  const cur = getter(snapCur);
  if (!cur) return null;
  const prev = snapPrev ? getter(snapPrev) : null;
  if (!prev || prev.eid !== cur.eid) return { ...cur };
  const span = Math.max(20, recvCur - recvPrev);
  const t = clamp((performance.now() - recvCur) / span, 0, 1.15);
  return { ...cur, x: lerp(prev.x, cur.x, t), y: lerp(prev.y, cur.y, t), face: lerpAng(prev.face, cur.face, t) };
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (now > slowUntil) timeScale = 1;
  const sdt = dt * timeScale;

  if (!inBattle && lastPhase !== 'over') return;
  if (!snapCur || !chars) return;
  const s = snapCur;

  // --- сборка сущностей с интерполяцией ---
  const A = entLerp(s.A?.eid, sn => sn.A);
  const B = entLerp(s.B?.eid, sn => sn.B);
  const cloneCur = (s.extras || []).find(e => e.eid !== undefined && e.id);
  const C = cloneCur ? entLerp(cloneCur.eid, sn => (sn.extras || []).find(e => e.eid === cloneCur.eid)) : null;

  // --- предсказание своего бойца ---
  const meSrv = youTeam === 'A' ? A : B;
  if (meSrv) {
    if (!ownSim || ownEid !== meSrv.eid || Math.hypot(ownSim.x - meSrv.x, ownSim.y - meSrv.y) > 150) {
      ownSim = { x: meSrv.x, y: meSrv.y }; ownEid = meSrv.eid;
    }
    const spd = (chars[meSrv.id]?.derived?.moveSpeed || 180) * (meSrv.spdMult ?? 1);
    const len = Math.hypot(mx, mzy) || 1;
    if (meSrv.canMove && (mx || mzy)) {
      ownSim.x += mx / Math.max(1, len) * spd * sdt;
      ownSim.y += mzy / Math.max(1, len) * spd * sdt;
    }
    ownSim.x = clamp(ownSim.x, 26, arena.w - 26);
    ownSim.y = clamp(ownSim.y, 26, arena.h - 26);
    for (const o of mapObstacles) {
      const cx2 = clamp(ownSim.x, o.x, o.x + o.w), cy2 = clamp(ownSim.y, o.y, o.y + o.h);
      const ddx = ownSim.x - cx2, ddy = ownSim.y - cy2, dd = Math.hypot(ddx, ddy);
      if (dd < 26 && dd > 0.001) { ownSim.x = cx2 + ddx / dd * 26; ownSim.y = cy2 + ddy / dd * 26; }
    }
    ownSim.x = lerp(ownSim.x, meSrv.x, 0.16);
    ownSim.y = lerp(ownSim.y, meSrv.y, 0.16);
    meSrv.x = ownSim.x; meSrv.y = ownSim.y;
  }

  // --- мир ---
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);

  const shx = (Math.random() * 2 - 1) * shake * scale * 0.7;
  const shy = (Math.random() * 2 - 1) * shake * scale * 0.7;
  shake = Math.max(0, shake - 60 * dt);
  ctx.translate(offX + shx, offY + shy);

  {
    const fa = s.A, fb = s.B;
    let tx = 0, ty = 0;
    if (fa && fb) {
      tx = ((fa.x + fb.x) / 2 / arena.w - 0.5) * -14 * scale;
      ty = ((fa.y + fb.y) / 2 / arena.h - 0.5) * -8 * scale;
    }
    parX = lerp(parX, tx, 0.05); parY = lerp(parY, ty, 0.05);   // камера «дышит»
  }
  if (s.zones?.voidTheme) ctx.drawImage(floorVoidC, 0, 0);
  else if (mapC) ctx.drawImage(mapC, -mapBleed + parX, -mapBleed + parY);
  else ctx.drawImage(floorC, 0, 0);

  ctx.save();
  ctx.scale(scale, scale);

  // атмосферные частицы — свои на каждой карте
  {
    const style = MAP_META[currentMapId]?.mote || 'void';
    const acc = MAP_META[currentMapId]?.accent || '201,168,106';
    const down = style === 'forest';                      // в Лесу споры оседают вниз
    for (const m of motes) {
      const vy = down ? Math.abs(m.vy) * 0.7 : m.vy;
      m.y += vy * sdt;
      m.x += Math.sin(m.ph * 0.9) * 6 * sdt;              // лёгкий дрейф
      m.ph += sdt;
      if (!down && m.y < -8) { m.y = arena.h + 6; m.x = Math.random() * arena.w; }
      if (down && m.y > arena.h + 8) { m.y = -6; m.x = Math.random() * arena.w; }
      const flick = style === 'temple' ? 0.16 * Math.sin(m.ph * 5.2) : 0.10 * Math.sin(m.ph * 1.4);
      const a = Math.max(0.03, 0.12 + flick);
      ctx.fillStyle = s.zones?.voidTheme ? `rgba(255,255,255,${a})` : `rgba(${acc},${a})`;
      ctx.fillRect(m.x, m.y, m.s, m.s);
    }
  }

  // --- препятствия карты ---
  if (!s.zones?.voidTheme) {
    const acc = MAP_META[currentMapId]?.accent || '201,168,106';
    for (const o of mapObstacles) {
      ctx.fillStyle = 'rgba(4,4,8,0.66)';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(o.x, o.y, o.w, 4);
      ctx.strokeStyle = `rgba(${acc},0.35)`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
    }
  }

  // --- телеграфы атак (зона перед ударом) ---
  for (let i = telegraphs.length - 1; i >= 0; i--) {
    const tg = telegraphs[i];
    const left = (tg.until - now) / 1000;
    if (left <= 0) { telegraphs.splice(i, 1); continue; }
    const f = posOf(tg.eid);
    if (!f) continue;
    const meta = chars?.[f.id];
    const atk2 = meta?.attack;
    if (!atk2) continue;
    const mine = f.team === youTeam;
    const col = mine ? '201,168,106' : '208,98,98';
    const k = clamp(1 - left / Math.max(0.08, tg.dur), 0.2, 1);
    if (atk2.type === 'melee') {
      const arcR = (atk2.arc || 70) * Math.PI / 180;
      ctx.fillStyle = `rgba(${col},${0.07 + 0.10 * k})`;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.arc(f.x, f.y, atk2.range, f.face - arcR / 2, f.face + arcR / 2);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `rgba(${col},${0.25 + 0.35 * k})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const len = Math.min(atk2.range || 380, 380);
      ctx.strokeStyle = `rgba(${col},${0.12 + 0.22 * k})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(f.x + Math.cos(f.face) * 24, f.y + Math.sin(f.face) * 24);
      ctx.lineTo(f.x + Math.cos(f.face) * len, f.y + Math.sin(f.face) * len);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // — пустота Кролика: медленные кольца от центра —
  if (s.zones?.voidTheme) {
    const qcx = arena.w / 2, qcy = arena.h / 2;
    for (let i = 0; i < 2; i++) {
      const k = ((now % 1700) / 1700 + i * 0.5) % 1;
      ctx.globalAlpha = (1 - k) * 0.20;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(qcx, qcy, 70 + k * 460, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // --- зоны ---
  const zn = s.zones || {};
  if (zn.field) {
    const f = zn.field, pul = 0.5 + 0.5 * Math.sin(now / 160);
    ctx.fillStyle = 'rgba(90,77,158,0.10)';
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(181,140,255,${0.35 + pul * 0.25})`;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([14, 10]); ctx.lineDashOffset = -now / 24;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(181,140,255,0.18)';
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.35 + 0.1 * pul), 0, 7); ctx.stroke();
    // — Приговор Луны: луна в небе, столб света, вращающиеся руны —
    const fal = clamp((f.left ?? 1) / 0.6, 0, 1);
    ctx.globalAlpha = fal;
    const moonX = f.x, moonY = Math.max(54, f.y - f.r - 115);
    const lg = ctx.createLinearGradient(moonX, moonY, moonX, f.y);
    lg.addColorStop(0, 'rgba(205,195,255,0.12)');
    lg.addColorStop(1, 'rgba(150,130,220,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(moonX - 22, moonY, 44, f.y - moonY);
    const mg = ctx.createRadialGradient(moonX - 8, moonY - 8, 4, moonX, moonY, 32);
    mg.addColorStop(0, '#f2eeff'); mg.addColorStop(0.65, '#c2b8ec'); mg.addColorStop(1, 'rgba(150,130,220,0)');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(moonX, moonY, 28, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(225,215,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(moonX, moonY, 33 + 2.5 * Math.sin(now / 280), 0, 7); ctx.stroke();
    for (let ri = 0; ri < 6; ri++) {
      const ra = now / 1100 + ri * 1.047;
      const rx = f.x + Math.cos(ra) * f.r * 0.8, ry = f.y + Math.sin(ra) * f.r * 0.8;
      ctx.save();
      ctx.translate(rx, ry); ctx.rotate(ra + 1.57);
      ctx.fillStyle = 'rgba(181,140,255,0.75)';
      ctx.fillRect(-1.8, -6, 3.6, 12);
      ctx.fillRect(-4.5, -1.2, 9, 2.4);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  for (const c of (zn.clouds || [])) {
    ctx.fillStyle = 'rgba(168,201,154,0.13)';
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(168,201,154,0.30)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r * (0.94 + 0.05 * Math.sin(now / 220)), 0, 7); ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const a = now / 700 + i * 1.26;
      ctx.fillStyle = 'rgba(200,230,180,0.35)';
      ctx.fillRect(c.x + Math.cos(a) * c.r * 0.5, c.y + Math.sin(a * 1.3) * c.r * 0.5, 2.5, 2.5);
    }
    for (let i = 0; i < 4; i++) {
      const aa = i * 1.62 + 0.7;
      const mxx = c.x + Math.cos(aa) * c.r * 0.55, myy = c.y + Math.sin(aa) * c.r * 0.42;
      const hh = 11 + 3 * Math.sin(now / 340 + i * 1.9);
      ctx.fillStyle = 'rgba(207,198,184,0.55)';
      ctx.fillRect(mxx - 1.5, myy - hh, 3, hh);
      ctx.fillStyle = 'rgba(168,201,154,0.72)';
      ctx.beginPath(); ctx.ellipse(mxx, myy - hh, 7.5, 4.2, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = 'rgba(120,160,110,0.5)';
      ctx.fillRect(mxx - 5, myy - hh, 10, 1.6);
    }
  }
  // могилы Вождя Червей — тёмная зона с черепами
  for (const g of (zn.graves || [])) {
    ctx.fillStyle = 'rgba(40,48,28,0.34)';
    ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(154,168,106,${0.30 + 0.18 * Math.sin(now / 200)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(g.x, g.y, g.r * (0.95 + 0.04 * Math.sin(now / 260)), 0, 7); ctx.stroke();
    for (let i = 0; i < 7; i++) {
      const a = now / 900 + i * 0.9;
      const rr = g.r * (0.3 + 0.6 * ((i % 3) / 3));
      ctx.fillStyle = 'rgba(180,190,150,0.4)';
      ctx.fillRect(g.x + Math.cos(a) * rr, g.y + Math.sin(a * 1.2) * rr, 3, 3);
    }
  }
  // god strike — золотисто-бирюзовый телеграф из extras
  for (const m of (s.extras || [])) {
    if (m.kind !== 'godmark') continue;
    const k = clamp(1 - m.at / 0.6, 0, 1);
    ctx.fillStyle = `rgba(168,240,224,${0.06 + 0.10 * k})`;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(200,255,240,${0.4 + 0.4 * k})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.r * (0.3 + 0.7 * k), 0, 7); ctx.stroke();
    const lg = ctx.createLinearGradient(m.x, 0, m.x, m.y);
    lg.addColorStop(0, `rgba(200,255,240,${0.18 * k})`); lg.addColorStop(1, 'rgba(200,255,240,0)');
    ctx.fillStyle = lg; ctx.fillRect(m.x - 30 * k, 0, 60 * k, m.y);
  }
  // метки Дюка — золотой крест правосудия
  for (const m of (s.extras || [])) {
    if (m.kind !== 'mark') continue;
    const k = clamp(m.at / 0.25, 0, 1);
    const pulm = 0.5 + 0.5 * Math.sin(now / 90);
    ctx.strokeStyle = `rgba(255,233,176,${0.55 + 0.4 * pulm})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.r * (0.4 + 0.6 * k), 0, 7); ctx.stroke();
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(now / 600);
    ctx.strokeStyle = 'rgba(255,233,176,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, m.r * 0.62 * (0.4 + 0.6 * k), 0, 7); ctx.setLineDash([5, 7]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,240,200,0.95)'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(m.x - 12, m.y); ctx.lineTo(m.x + 12, m.y);
    ctx.moveTo(m.x, m.y - 16); ctx.lineTo(m.x, m.y + 10);
    ctx.stroke();
  }

  // --- бойцы ---
  const fighters = [A, B, C].filter(Boolean).sort((a, b) => a.y - b.y);
  // прицельный луч Наследницы (рисуем под бойцами)
  for (const f of fighters) {
    if (f.aimAng === undefined) continue;
    const ex = f.x + Math.cos(f.aimAng) * 560, ey = f.y + Math.sin(f.aimAng) * 560;
    ctx.strokeStyle = 'rgba(255,120,120,0.5)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 8]); ctx.lineDashOffset = -now / 30;
    ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const f of fighters) drawFighter(f, now);

  // --- личинки Вождя Червей ---
  for (const l of (s.extras || [])) {
    if (l.kind !== 'larva') continue;
    const mine = l.team === youTeam;
    const col = l.awakened ? (mine ? '201,168,106' : '208,98,98') : '154,168,106';
    ctx.fillStyle = `rgba(${col},0.85)`;
    ctx.beginPath(); ctx.ellipse(l.x, l.y, 13, 10, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(${col},0.6)`; ctx.lineWidth = 2;
    for (let w = 0; w < 4; w++) {
      const a = now / 300 + w * 1.57;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.quadraticCurveTo(l.x + Math.cos(a) * 8, l.y + Math.sin(a
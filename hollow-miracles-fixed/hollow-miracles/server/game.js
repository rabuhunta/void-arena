// ============================================================
//  VOID ARENA — server/game.js
//  Авторитарная симуляция матча. Вся боевая логика тут.
// ============================================================
const { GLOBAL, TEAMS, CHARACTERS, derive } = require('./balance');

const TAU = Math.PI * 2;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function dist(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.hypot(dx, dy); }
function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return Math.abs(d); }

let EID = 1;

// ---------- Боец ----------
class Fighter {
  constructor(charId, team) {
    this.eid = EID++;
    this.charId = charId;
    this.team = team;          // 'A' | 'B'
    const d = derive(charId);
    const c = CHARACTERS[charId];
    this.def = c; this.drv = d;
    this.radius = c.radius;
    this.x = 0; this.y = 0; this.face = 0;
    this.hp = d.maxHp; this.mana = d.maxMana;
    this.alive = true;
    this.isClone = false;
    // input
    this.mx = 0; this.my = 0;
    // таймеры/кд (абсолютное игровое время)
    this.cdAtkAt = 0; this.cdSkillAt = 0; this.cdDashAt = 0;
    this.stunUntil = 0; this.staggerUntil = 0; this.invulnUntil = 0;
    this.rootedUntil = 0; this.blindUntil = 0; this.paranoiaUntil = 0;
    this.dash = null;          // {dx,dy,until}
    this.swing = null;         // {strikeAt, kind:'basic'|'cone'|'finisher', custom}
    this.channel = null;       // rabbit: {until, dmgTaken}
    this.kingDash = null;      // {dx,dy,remaining}
    this.slows = [];           // [{pct,until}]
    this.poisons = [];         // [{dps,until}]
    this.nullified = false;    // после Квазарного Обнуления
    // пассивки
    this.voidHitCounter = 0;   // rabbit
    this.tearsPrimed = false;  // veil
    this.tearsRefreshAt = 0;
    this.hitCombo = 0;         // kain / общий счётчик успешных ударов
    this.crackOn = false;      // на этом бойце висит "трещина" (повешена Каином)
    this.abshLastAt = -1e9;    // duk
    this.sporeUsed = false;    // king
    // --- новые 7 ---
    this.sighting = null;      // heir: {ang, until}
    this.parryUntil = 0;       // defender
    this.parryBuffUntil = 0;   // defender
    this.idleSince = 0;        // defender аскеза (время начала покоя)
    this.asceticPct = 0;       // defender накопленная защита
    this.awakened = false;     // chief
    this.larvaKills = 0;       // chief: счётчик добитых пробуждённых личинок
    this.statBonus = 0;        // chief: бонус ко всем статам
    this.pseudo = null;        // lucian: {target,hitsLeft,nextAt,...}
    this.overclock = null;     // spiger: {until,stacks,nextStackAt}
    this.reviveCharge = false; // chief: можно возродиться у личинки
  }
  immuneFx() { return !this.isClone && !this.isLarva && this.charId === 'reflection' && this.def.passive.immune && !this.nullified; }
  speedMult(match) {
    if (!this.alive) return 0;
    const t = match.t;
    if (t < this.stunUntil || t < this.staggerUntil || t < this.rootedUntil || this.channel || this.kingDash) return 0;
    let m = 1;
    // Спайгер: разгон складывается до x4
    if (this.overclock && t < this.overclock.until) m *= (1 + (this.overclock.stacks * this.def.skill.speedPerStack));
    if (this.immuneFx()) return m;   // Вечный Образ: на скорость не влияют чужие эффекты
    for (const s of this.slows) if (t < s.until) m *= (1 - s.pct / 100);
    // поле Каина
    const f = match.field;
    if (f && f.team !== this.team && t < f.until && dist(this.x, this.y, f.x, f.y) <= f.r) m *= (1 - f.slowPct / 100);
    // облака спор
    for (const cl of match.clouds) if (t < cl.until && cl.team !== this.team && dist(this.x, this.y, cl.x, cl.y) <= cl.r) m *= (1 - cl.slowPct / 100);
    // могилы Вождя
    for (const g of (match.graves || [])) if (t < g.until && g.team !== this.team && dist(this.x, this.y, g.x, g.y) <= g.r) m *= (1 - g.slowPct / 100);
    // туман Вейла
    const fog = match.fog;
    if (fog && fog.team !== this.team && t < fog.until) m *= (1 - fog.slowPct / 100);
    return m;
  }
  effDefPct(match) {
    let d = this.drv.defPct;
    const t = match.t;
    // Защитник: аскеза воли — накопленная защита (в долях)
    if (!this.isClone && !this.isLarva && this.charId === 'defender') d += (this.asceticPct || 0) / 100;
    if (this.immuneFx()) return Math.min(d, 0.85);
    for (const cl of match.clouds) if (t < cl.until && cl.team !== this.team && dist(this.x, this.y, cl.x, cl.y) <= cl.r) d *= (1 - cl.defCutPct / 100);
    return Math.min(d, 0.85);
  }
  canAct(match) {
    const t = match.t;
    return this.alive && t >= this.stunUntil && t >= this.staggerUntil && !this.channel && !this.kingDash && !match.paused;
  }
}

// ---------- Матч ----------
class Match {
  constructor(orders, emitFn, obstacles) {
    // orders: {A:[charId x3], B:[...]} в выбранном порядке
    this.orders = orders;
    this.emit = emitFn; // (events flushed via snapshot)
    this.obstacles = Array.isArray(obstacles) ? obstacles : []; // прямоугольники карты {x,y,w,h}
    this.t = 0;
    this.phase = 'countdown'; // countdown | fight | between | over
    this.phaseUntil = 3.2;
    this.paused = false;
    this.events = [];
    this.winner = null;
    this.idx = { A: 0, B: 0 };
    this.benchAlive = { A: [true, true, true], B: [true, true, true] };
    this.fighters = { A: null, B: null };
    this.clone = null;            // клон Короля
    this.projectiles = [];        // [{x,y,dx,dy,speed,left,dmg,team,radius,kind}]
    this.fog = null;              // {team, until, slowPct, poisonDps, missChance}
    this.field = null;            // {team,x,y,r,until,...} поле Каина
    this.clouds = [];             // споры
    this.voidTheme = false;
    this.pendingShots = [];       // duk instant shot [{at,x,y,team}]
    this.godStrikes = [];         // reflection [{at,x,y,team,r,...}]
    this.larvae = [];             // chief [{x,y,hp,team,...}]
    this.graves = [];             // chief grave zones
    this.flareUntil = 0;          // heir flare
    this.spawn('A'); this.spawn('B');
  }

  ev(e) { this.events.push(e); }

  spawn(team) {
    const charId = this.orders[team][this.idx[team]];
    const f = new Fighter(charId, team);
    f.x = team === 'A' ? GLOBAL.ARENA_W * 0.22 : GLOBAL.ARENA_W * 0.78;
    f.y = GLOBAL.ARENA_H / 2;
    f.face = team === 'A' ? 0 : Math.PI;
    f.invulnUntil = this.t + GLOBAL.SPAWN_INVULN;
    this.fighters[team] = f;
    this.ev({ k: 'swap', team, charId, name: f.def.name });
    return f;
  }

  enemyOf(team) { return this.fighters[team === 'A' ? 'B' : 'A']; }

  hostileTargets(team) {
    const out = [];
    const e = this.enemyOf(team);
    if (e && e.alive) out.push(e);
    if (this.clone && this.clone.alive && this.clone.team !== team) out.push(this.clone);
    for (const l of this.larvae) if (l.alive && l.team !== team && l.awakened) out.push(l);  // пробуждённые личинки атакуемы
    return out;
  }

  // ---------- ввод ----------
  setInput(team, mx, my) {
    const f = this.fighters[team];
    if (!f) return;
    const len = Math.hypot(mx, my) || 1;
    f.mx = clamp(mx / Math.max(1, len), -1, 1);
    f.my = clamp(my / Math.max(1, len), -1, 1);
  }

  action(team, type) {
    const f = this.fighters[team];
    if (!f || this.phase !== 'fight' || this.paused) return;
    if (type === 'attack') this.tryAttack(f);
    else if (type === 'skill') this.trySkill(f);
    else if (type === 'dash') this.tryDash(f);
  }

  tryDash(f) {
    if (!f.canAct(this) || this.t < f.cdDashAt || this.t < f.rootedUntil) return;
    if (f.charId === 'kain' && this.field && this.field.team === f.team) return; // во время поля Каин врос
    let dx = f.mx, dy = f.my;
    if (!dx && !dy) { dx = Math.cos(f.face); dy = Math.sin(f.face); }
    const len = Math.hypot(dx, dy) || 1;
    f.dash = { dx: dx / len, dy: dy / len, until: this.t + GLOBAL.DASH_TIME };
    f.cdDashAt = this.t + GLOBAL.DASH_CD;
    this.ev({ k: 'dash', eid: f.eid, x: f.x, y: f.y });
  }

  tryAttack(f) {
    if (!f.canAct(this) || f.swing || this.t < f.cdAtkAt) return;
    let cdMult = 1;
    if (this.field && this.field.team !== f.team && this.t < this.field.until &&
        dist(f.x, f.y, this.field.x, this.field.y) <= this.field.r) cdMult = this.field.atkCdMult;
    f.swing = { strikeAt: this.t + f.def.attack.windup, kind: 'basic' };
    f.cdAtkAt = this.t + f.drv.atkCd * cdMult;
    this.ev({ k: 'windup', eid: f.eid, dur: f.def.attack.windup });
  }

  // ---------- скиллы ----------
  trySkill(f) {
    if (!f.canAct(this) || this.t < f.cdSkillAt) return;
    if (f.nullified) { this.ev({ k: 'denied', eid: f.eid }); return; }
    const sk = f.def.skill;
    const cost = sk.cost === 'ALL' ? f.mana : sk.cost;
    if (sk.cost === 'ALL') { if (f.mana < sk.minMana) return; }
    else if (f.mana < cost) { if (!this.checkAbshotlution(f)) return; }

    f.mana -= cost;
    f.cdSkillAt = this.t + sk.cd;
    this.checkAbshotlution(f);

    switch (sk.key) {
      case 'blueParanoia': {
        this.fog = { team: f.team, until: this.t + sk.fogDuration, slowPct: sk.slowPct, poisonDps: sk.poisonDps, missChance: sk.missChance };
        f.tearsRefreshAt = this.t; // туман постоянно "теряет его из виду"
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'fog' });
        break;
      }
      case 'quasarNull': {
        f.channel = { until: this.t + sk.channelTime, dmgTaken: 0 };
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'channel', dur: sk.channelTime });
        break;
      }
      case 'moonVerdict': {
        this.field = {
          team: f.team, x: f.x, y: f.y, r: sk.fieldRadius, until: this.t + sk.fieldDuration,
          slowPct: sk.enemySlowPct, atkCdMult: sk.enemyAtkCdMult, bonusManaDmg: sk.bonusManaDmg,
          dmgRed: sk.selfDmgReductionPct / 100, finisher: sk.finisher, done: false,
        };
        f.rootedUntil = this.t + sk.fieldDuration + 0.1;
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'field', x: f.x, y: f.y, r: sk.fieldRadius, dur: sk.fieldDuration });
        break;
      }
      case 'darkRite': {
        f.hp = Math.max(1, f.hp - sk.selfHpCost);
        this.ev({ k: 'hit', x: f.x, y: f.y, dmg: sk.selfHpCost, self: true });
        for (const tgt of this.hostileTargets(f.team)) {
          if (this.inSector(f, tgt, sk.coneRange, sk.coneArc)) {
            this.dealDamage(f, tgt, sk.dmg, { pierceDef: false });
            if (!tgt.immuneFx()) {
              tgt.slows.push({ pct: sk.slowPct, until: this.t + sk.slowDur });
              if (!tgt.isClone) tgt.blindUntil = this.t + sk.blindDur;
            }
          }
        }
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'cone', x: f.x, y: f.y, face: f.face, range: sk.coneRange, arc: sk.coneArc });
        break;
      }
      case 'instantShot': {
        const enemy = this.enemyOf(f.team);
        const tx = enemy ? enemy.x : f.x + Math.cos(f.face) * 200;
        const ty = enemy ? enemy.y : f.y + Math.sin(f.face) * 200;
        this.pendingShots.push({ at: this.t + sk.telegraph, x: tx, y: ty, team: f.team, dmg: sk.dmg, r: sk.impactRadius });
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'mark', x: tx, y: ty, r: sk.impactRadius, dur: sk.telegraph });
        break;
      }
      case 'royalDash': {
        const e = this.nearestHostile(f);
        let dx, dy;
        if (e) { dx = e.x - f.x; dy = e.y - f.y; } else { dx = Math.cos(f.face); dy = Math.sin(f.face); }
        const len = Math.hypot(dx, dy) || 1;
        f.kingDash = { dx: dx / len, dy: dy / len, remaining: sk.dashRange, dmg: sk.dmg, kb: sk.knockback, stagger: sk.stagger };
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'royaldash' });
        break;
      }

      // ===== Барогун: шквал пуль =====
      case 'shootingDogs': {
        const base = f.face;
        const spread = sk.spreadDeg * Math.PI / 180;
        for (let i = 0; i < sk.burst; i++) {
          const a = base + (Math.random() - 0.5) * spread;
          this.projectiles.push({
            x: f.x + Math.cos(a) * (f.radius + 6), y: f.y + Math.sin(a) * (f.radius + 6),
            dx: Math.cos(a), dy: Math.sin(a), speed: sk.projSpeed * (0.8 + Math.random() * 0.4),
            left: sk.range, dmg: sk.pelletDmg, team: f.team, radius: sk.projRadius, owner: f.eid, pellet: true,
          });
        }
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'spray', x: f.x, y: f.y, face: base, arc: sk.spreadDeg });
        break;
      }

      // ===== Наследница: вращающийся прицел / выстрел =====
      case 'sighting': {
        if (!f.sighting) {
          f.sighting = { ang: f.face, until: this.t + sk.holdMax };
          this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'aim' });
        } else {
          const a = f.sighting.ang;
          f.sighting = null;
          let hit = false;
          for (const tgt of this.hostileTargets(f.team)) {
            if (this.inBeam(f.x, f.y, a, sk.beamRange, sk.beamWidth, tgt)) { this.onLandedHit(f, tgt, sk.fireDmg); hit = true; }
          }
          if (!hit) this.triggerFlare(f);
          this.ev({ k: 'beam', eid: f.eid, x: f.x, y: f.y, ang: a, range: sk.beamRange, hit });
        }
        // снять кд-блок повторного нажатия: второе нажатие не должно «доплачивать»
        f.cdSkillAt = this.t + 0.15;
        break;
      }

      // ===== Отражение: божественный удар =====
      case 'godStrike': {
        const e = this.nearestHostile(f);
        const tx = e ? e.x : f.x + Math.cos(f.face) * 200;
        const ty = e ? e.y : f.y + Math.sin(f.face) * 200;
        this.godStrikes.push({ at: this.t + sk.telegraph, x: tx, y: ty, team: f.team, r: sk.radius, dmg: sk.dmg, floorHp: sk.floorHp, healPct: sk.healPct, healDur: sk.healDur });
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'godmark', x: tx, y: ty, r: sk.radius, dur: sk.telegraph });
        break;
      }

      // ===== Защитник: парирование =====
      case 'parry': {
        f.parryUntil = this.t + sk.window;
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'parry' });
        break;
      }

      // ===== Вождь Червей: личинка / могила =====
      case 'selfRebellion': {
        if (f.awakened) {
          // после пробуждения — Глубина Могилы
          const e = this.nearestHostile(f);
          const gx = e ? e.x : f.x, gy = e ? e.y : f.y;
          this.graves.push({ team: f.team, x: gx, y: gy, r: sk.graveRadius, until: this.t + sk.graveDuration, slowPct: sk.graveSlowPct });
          this.ev({ k: 'skill', eid: f.eid, name: 'Глубина Могилы', fx: 'grave', x: gx, y: gy, r: sk.graveRadius, dur: sk.graveDuration });
        } else {
          if (this.larvae.filter(l => l.team === f.team && l.alive).length < sk.maxLarvae) {
            this.spawnLarva(f);
          }
          this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'larva' });
        }
        break;
      }

      // ===== Люциан: псевдо-копия (6 ударов) =====
      case 'pseudoGap': {
        const e = this.nearestHostile(f);
        if (e) {
          f.pseudo = { target: e.eid, hitsLeft: sk.hits, nextAt: this.t + sk.hitInterval, interval: sk.hitInterval, dmg: sk.hitDmg, until: this.t + sk.dur };
          this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'pseudo', tx: e.x, ty: e.y });
        }
        break;
      }

      // ===== Спайгер: разгон =====
      case 'overclocking': {
        f.overclock = { until: this.t + sk.duration, stacks: 1, nextStackAt: this.t + sk.stackInterval };
        this.ev({ k: 'skill', eid: f.eid, name: sk.name, fx: 'overclock' });
        break;
      }
    }
  }

  // луч Наследницы: точка-цель в полосе заданной ширины вдоль направления
  inBeam(ox, oy, ang, range, width, tgt) {
    const dx = tgt.x - ox, dy = tgt.y - oy;
    const along = dx * Math.cos(ang) + dy * Math.sin(ang);
    if (along < 0 || along > range) return false;
    const perp = Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang));
    return perp <= width / 2 + tgt.radius;
  }

  triggerFlare(f) {
    if (f.charId !== 'heir') return;
    this.flareUntil = this.t + f.def.passive.brightDur;
    // снимаем невидимость/копии у врага
    if (this.fog && this.fog.team !== f.team) this.fog.until = this.t;
    this.ev({ k: 'flare', x: f.x, y: f.y });
  }

  spawnLarva(chief) {
    const sk = chief.def.skill;
    const l = {
      isLarva: true, team: chief.team, alive: true,
      x: clamp(chief.x + (Math.random() - 0.5) * 60, 30, GLOBAL.ARENA_W - 30),
      y: clamp(chief.y + (Math.random() - 0.5) * 60, 30, GLOBAL.ARENA_H - 30),
      hp: Math.max(8, Math.round(chief.drv.maxHp * (sk.larvaHpPct / 100))),
      maxHp: Math.max(8, Math.round(chief.drv.maxHp * (sk.larvaHpPct / 100))),
      radius: 14, eid: EID++, speed: sk.larvaSpeed,
    };
    this.larvae.push(l);
    this.ev({ k: 'larvaSpawn', x: l.x, y: l.y, team: l.team });
  }

  nearestHostile(f) {
    let best = null, bd = 1e9;
    for (const t of this.hostileTargets(f.team)) {
      const d = dist(f.x, f.y, t.x, t.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  inSector(att, tgt, range, arcDeg) {
    const d = dist(att.x, att.y, tgt.x, tgt.y);
    if (d > range + tgt.radius) return false;
    const ang = Math.atan2(tgt.y - att.y, tgt.x - att.x);
    return angDiff(att.face, ang) <= (arcDeg * Math.PI / 180) / 2 + Math.atan2(tgt.radius, Math.max(1, d)) * 0.5;
  }

  // ---------- урон ----------
  dealDamage(att, tgt, raw, opts = {}) {
    if (!tgt.alive) return false;
    if (tgt.isLarva) { this.damageLarva(tgt, Math.max(1, Math.round(raw))); return true; }
    if (this.t < tgt.invulnUntil) { this.ev({ k: 'blocked', x: tgt.x, y: tgt.y }); return false; }

    // Защитник: парирование (окно 0.3с)
    if (!tgt.isClone && !tgt.isLarva && tgt.charId === 'defender' && this.t < tgt.parryUntil && !opts.dot) {
      const heavy = raw >= 70;
      tgt.parryBuffUntil = this.t + tgt.def.skill.buffDur;
      tgt.parryUntil = 0;
      if (!heavy) {
        this.ev({ k: 'parry', x: tgt.x, y: tgt.y, eid: tgt.eid });
        return false;                                          // слабый/средний урон полностью поглощён
      }
      raw *= (1 - tgt.def.skill.heavyReducePct / 100);         // сильный — снижен
      this.ev({ k: 'parry', x: tgt.x, y: tgt.y, eid: tgt.eid, heavy: true });
    }

    // пассивка Кролика: каждый 5-й удар в пустоту
    if (!tgt.isClone && !tgt.isLarva && tgt.charId === 'rabbit' && !tgt.nullified && !opts.dot) {
      tgt.voidHitCounter++;
      if (tgt.voidHitCounter >= tgt.def.passive.everyNth) {
        tgt.voidHitCounter = 0;
        this.ev({ k: 'void', x: tgt.x, y: tgt.y });
        return false;
      }
    }

    let dmg = raw * (1 - tgt.effDefPct(this));
    if (this.field && this.field.team === tgt.team && this.t < this.field.until && tgt.charId === 'kain') {
      dmg *= (1 - this.field.dmgRed);
    }
    dmg = Math.max(1, Math.round(dmg));

    // god strike: не опускаем ниже floorHp и планируем возврат части урона
    if (opts.godStrike) {
      const floor = opts.floorHp || 1;
      const applied = Math.max(0, Math.min(dmg, tgt.hp - floor));
      tgt.hp -= applied;
      if (opts.healPct && applied > 0) {
        tgt.pendingHeal = { amount: applied * (opts.healPct / 100), until: this.t + (opts.healDur || 8), rate: null };
        tgt.pendingHeal.rate = tgt.pendingHeal.amount / (opts.healDur || 8);
      }
      this.ev({ k: 'hit', x: tgt.x, y: tgt.y, dmg: applied || 1, godStrike: true });
      return true;
    }

    tgt.hp -= dmg;

    // каст Кролика сбивается уроном
    if (tgt.channel) {
      tgt.channel.dmgTaken += dmg;
      if (tgt.channel.dmgTaken >= tgt.def.skill.cancelDamage) {
        tgt.channel = null;
        this.ev({ k: 'cancel', eid: tgt.eid, x: tgt.x, y: tgt.y });
      }
    }

    this.ev({ k: 'hit', x: tgt.x, y: tgt.y, dmg, crit: !!opts.crit, dot: !!opts.dot });
    if (tgt.hp <= 0) this.onDeath(tgt);
    return true;
  }

  // успешный удар ближнего/дальнего боя (не DoT)
  onLandedHit(att, tgt, baseDmg, opts = {}) {
    let dmg = baseDmg;
    let crit = false;

    if (!att.isClone && !att.isLarva && !att.nullified) {
      const p = att.def.passive;
      // Каин: вес обета + трещина
      if (att.charId === 'kain') {
        dmg *= p.flatDmgMult;
        if (tgt.crackOn) { dmg *= p.crackBonusMult; tgt.crackOn = false; crit = true; }
        att.hitCombo++;
        if (att.hitCombo >= p.crackEveryNth) { att.hitCombo = 0; tgt.crackOn = true; this.ev({ k: 'crack', x: tgt.x, y: tgt.y }); }
      }
      // Вейл: розовые слёзы
      if (att.charId === 'veil' && att.tearsPrimed) {
        att.tearsPrimed = false;
        tgt.poisons.push({ dps: p.bonusPoisonDps, until: this.t + p.bonusPoisonDur });
        this.ev({ k: 'tears', x: tgt.x, y: tgt.y });
      }
      // Защитник: бафф урона после удачного парирования + удар щитом
      if (att.charId === 'defender' && this.t < att.parryBuffUntil) {
        dmg *= att.def.skill.buffDmgMult;
        crit = true;
      }
    }
    // бонус поля Каина
    if (this.field && this.field.team === att.team && att.charId === 'kain' && this.t < this.field.until) {
      dmg += this.field.bonusManaDmg;
    }
    this.dealDamage(att, tgt, dmg, { crit });

    // Люциан: псевдопроекция — эхо части урона (не рекурсивно)
    if (!opts.echo && !att.isClone && !att.isLarva && att.charId === 'lucian' && !att.nullified && tgt.alive) {
      const echo = Math.round(baseDmg * att.def.passive.echoPct);
      if (echo > 0) {
        this.ev({ k: 'echo', x: tgt.x, y: tgt.y });
        this.dealDamage(att, tgt, echo, { echo: true, dot: true });
      }
    }
  }

  resolveStrike(f) {
    const a = f.def.attack;
    const k = f.swing.kind;
    f.swing = null;

    if (k === 'basic' && a.type === 'proj') {
      this.projectiles.push({
        x: f.x + Math.cos(f.face) * (f.radius + 6), y: f.y + Math.sin(f.face) * (f.radius + 6),
        dx: Math.cos(f.face), dy: Math.sin(f.face), speed: a.projSpeed,
        left: a.range, dmg: f.drv.atkDmg * a.mult, team: f.team, radius: a.projRadius, owner: f.eid,
      });
      this.ev({ k: 'shoot', eid: f.eid, x: f.x, y: f.y, face: f.face });
      return;
    }

    const range = k === 'finisher' ? f.def.skill.finisher.range : a.range;
    const arc = k === 'finisher' ? f.def.skill.finisher.arc : a.arc;
    const dmgBase = k === 'finisher' ? f.def.skill.finisher.dmg : f.drv.atkDmg * a.mult;

    let landed = false;
    for (const tgt of this.hostileTargets(f.team)) {
      if (!this.inSector(f, tgt, range, arc)) continue;
      // паранойя: атакующий мажет
      const fog = this.fog;
      const paranoid = fog && fog.team !== f.team && this.t < fog.until;
      if (paranoid && Math.random() < fog.missChance) {
        this.ev({ k: 'miss', x: f.x + Math.cos(f.face) * range * 0.6, y: f.y + Math.sin(f.face) * range * 0.6, forced: true });
        this.primeTears(tgt);
        continue;
      }
      landed = true;
      this.onLandedHit(f, tgt, dmgBase);
      if (k === 'finisher' && !tgt.immuneFx()) tgt.stunUntil = this.t + f.def.skill.finisher.stun;
    }
    this.ev({ k: 'slash', eid: f.eid, x: f.x, y: f.y, face: f.face, range, arc, heavy: k === 'finisher' || f.charId === 'kain' || f.charId === 'rabbit' });
    if (!landed) {
      this.ev({ k: 'miss', x: f.x + Math.cos(f.face) * range * 0.6, y: f.y + Math.sin(f.face) * range * 0.6 });
      const e = this.enemyOf(f.team);
      if (e) this.primeTears(e);
    }
  }

  primeTears(maybeVeil) {
    if (maybeVeil && !maybeVeil.isClone && maybeVeil.charId === 'veil' && maybeVeil.alive && !maybeVeil.nullified) {
      maybeVeil.tearsPrimed = true;
    }
  }

  // ---------- смерть / свопы ----------
  onDeath(unit) {
    unit.alive = false;
    if (unit.isClone) {
      const p = CHARACTERS.king.passive;
      this.clouds.push({ x: unit.x, y: unit.y, r: p.cloudRadius, until: this.t + p.cloudDuration, team: unit.team, slowPct: p.cloudSlowPct, defCutPct: p.cloudDefCutPct });
      this.ev({ k: 'cloud', x: unit.x, y: unit.y, r: p.cloudRadius });
      this.clone = null;
      return;
    }
    this.ev({ k: 'ko', team: unit.team, name: unit.def.name, x: unit.x, y: unit.y });
    // Вождь Червей: возрождение у ближайшей живой личинки
    if (!unit.isClone && unit.charId === 'chief') {
      const mine = this.larvae.filter(l => l.alive && l.team === unit.team);
      if (mine.length) {
        let best = mine[0], bd = 1e9;
        for (const l of mine) { const d = dist(unit.x, unit.y, l.x, l.y); if (d < bd) { bd = d; best = l; } }
        unit.alive = true;
        unit.hp = Math.round(unit.drv.maxHp * 0.55);
        unit.x = best.x; unit.y = best.y;
        unit.invulnUntil = this.t + 0.8;
        best.alive = false;
        this.larvae = this.larvae.filter(l => l.alive);
        this.ev({ k: 'chiefRevive', x: unit.x, y: unit.y, team: unit.team });
        return;
      }
    }
    this.benchAlive[unit.team][this.idx[unit.team]] = false;
    // конец дуэли: чистим эффекты
    this.clearDuelEffects();
    const survivor = this.enemyOf(unit.team);
    if (survivor) survivor.nullified = false;

    this.idx[unit.team]++;
    if (this.idx[unit.team] > 2) {
      this.phase = 'over';
      this.winner = unit.team === 'A' ? 'B' : 'A';
      this.ev({ k: 'over', winner: this.winner });
    } else {
      this.phase = 'between';
      this.phaseUntil = this.t + GLOBAL.SWAP_DELAY;
      this.pendingSwapTeam = unit.team;
    }
  }

  clearDuelEffects() {
    this.fog = null; this.field = null; this.clouds = []; this.voidTheme = false;
    this.projectiles = []; this.pendingShots = [];
    this.godStrikes = []; this.larvae = []; this.graves = []; this.flareUntil = 0;
    if (this.clone) { this.clone = null; }
    for (const tm of ['A', 'B']) {
      const f = this.fighters[tm];
      if (!f) continue;
      f.slows = []; f.poisons = []; f.blindUntil = 0; f.paranoiaUntil = 0;
      f.crackOn = false; f.channel = null; f.kingDash = null; f.rootedUntil = 0;
      f.sighting = null; f.parryUntil = 0; f.parryBuffUntil = 0; f.pseudo = null;
      f.overclock = null; f.pendingHeal = null; f.asceticPct = 0;
    }
  }

  checkAbshotlution(f) {
    if (f.charId !== 'duk' || f.nullified) return false;
    if (f.mana < f.def.skill.cost && this.t - f.abshLastAt >= f.def.passive.cooldown) {
      f.abshLastAt = this.t;
      f.mana = f.drv.maxMana;
      this.ev({ k: 'absh', eid: f.eid, x: f.x, y: f.y });
      return true;
    }
    return false;
  }

  // ---------- тик ----------
  tick(dt) {
    if (this.paused || this.phase === 'over') return;
    this.t += dt;

    if (this.phase === 'countdown') {
      if (this.t >= this.phaseUntil) { this.phase = 'fight'; this.ev({ k: 'fight' }); }
      return;
    }
    if (this.phase === 'between') {
      if (this.t >= this.phaseUntil) {
        this.spawn(this.pendingSwapTeam);
        this.phase = 'fight';
      }
      return;
    }

    const list = [this.fighters.A, this.fighters.B];
    if (this.clone) list.push(this.clone);

    // движение + автоповорот
    for (const f of list) {
      if (!f || !f.alive) continue;

      // лицом к ближайшему врагу
      const tgt = this.nearestHostile(f);
      if (tgt) f.face = Math.atan2(tgt.y - f.y, tgt.x - f.x);

      let vx = 0, vy = 0;
      if (f.dash && this.t < f.dash.until) {
        const sp = f.drv.moveSpeed * GLOBAL.DASH_MULT;
        vx = f.dash.dx * sp; vy = f.dash.dy * sp;
      } else {
        f.dash = null;
        const sp = f.drv.moveSpeed * f.speedMult(this);
        vx = f.mx * sp; vy = f.my * sp;
        const fld = this.field;
        if (fld && fld.team !== f.team && this.t < fld.until) {
          const fd = dist(f.x, f.y, fld.x, fld.y);
          if (fd <= fld.r && fd > 10) {
            vx += (fld.x - f.x) / fd * 46;
            vy += (fld.y - f.y) / fd * 46;
          }
        }
      }

      // рывок Короля
      if (f.kingDash) {
        const kd = f.kingDash;
        
        const sx = kd.dx * CHARACTERS.king.skill.dashSpeed * dt;
        const sy = kd.dy * CHARACTERS.king.skill.dashSpeed * dt;
        f.x += sx; f.y += sy;
        kd.remaining -= Math.hypot(sx, sy);
        // столкновение
        let hitSomeone = false;
        for (const tg of this.hostileTargets(f.team)) {
          if (dist(f.x, f.y, tg.x, tg.y) <= f.radius + tg.radius + 4) {
            hitSomeone = true;
            this.onLandedHit(f, tg, kd.dmg);
            if (!tg.immuneFx()) {
              tg.staggerUntil = this.t + kd.stagger;
              tg.kbx = kd.dx * kd.kb; tg.kby = kd.dy * kd.kb; tg.kbUntil = this.t + 0.18;
            }
            this.ev({ k: 'shake', mag: 9 });
          }
        }
        const wall = f.x < f.radius || f.x > GLOBAL.ARENA_W - f.radius || f.y < f.radius || f.y > GLOBAL.ARENA_H - f.radius;
        if (hitSomeone || wall || kd.remaining <= 0) f.kingDash = null;
      } else {
        f.x += vx * dt; f.y += vy * dt;
      }

      // отбрасывание
      if (f.kbUntil && this.t < f.kbUntil) { f.x += f.kbx * dt; f.y += f.kby * dt; }

      f.x = clamp(f.x, f.radius, GLOBAL.ARENA_W - f.radius);
      f.y = clamp(f.y, f.radius, GLOBAL.ARENA_H - f.radius);
      this.resolveObstacles(f);

      // удар по таймингу
      if (f.swing && this.t >= f.swing.strikeAt) this.resolveStrike(f);

      // каналинг Кролика
      if (f.channel && this.t >= f.channel.until) {
        f.channel = null;
        this.quasarNullification(f);
      }

      // мана-реген
      if (f.alive && !f.isClone) {
        f.mana = Math.min(f.drv.maxMana, f.mana + GLOBAL.MANA_REGEN_PER_S * dt);
      }

      // Наследница: прицел вращается по часовой, авто-сброс по истечении
      if (f.sighting) {
        if (this.t >= f.sighting.until) { f.sighting = null; }
        else f.sighting.ang += f.def.skill.rotSpeed * dt;
      }

      // пассивная регенерация Сектанта
      if (!f.isClone && f.charId === 'sectarian' && !f.nullified && f.alive) {
        f.hp = Math.min(f.drv.maxHp, f.hp + f.def.passive.regenPerS * dt);
      }

      // яды
      let dotAcc = 0;
      for (const p of f.poisons) if (this.t < p.until) dotAcc += p.dps * dt;
      f.poisons = f.poisons.filter(p => this.t < p.until);
      // туман травит
      const fog = this.fog;
      if (fog && fog.team !== f.team && this.t < fog.until && !f.isClone) dotAcc += fog.poisonDps * dt;
      if (dotAcc > 0 && f.alive) {
        f.dotPool = (f.dotPool || 0) + dotAcc;
        if (f.dotPool >= 3) { // тикаем порциями чтобы не спамить
          const chunk = Math.round(f.dotPool); f.dotPool = 0;
          f.hp -= chunk;
          this.ev({ k: 'hit', x: f.x, y: f.y, dmg: chunk, dot: true });
          if (f.channel) {
            f.channel.dmgTaken += chunk;
            if (f.channel.dmgTaken >= f.def.skill.cancelDamage) { f.channel = null; this.ev({ k: 'cancel', eid: f.eid, x: f.x, y: f.y }); }
          }
          if (f.hp <= 0) this.onDeath(f);
        }
      }
      f.slows = f.slows.filter(s => this.t < s.until);

      // спавн клона Короля
      if (!f.isClone && f.charId === 'king' && !f.sporeUsed && !f.nullified && f.alive &&
          f.hp <= f.drv.maxHp * (f.def.passive.triggerHpPct / 100)) {
        f.sporeUsed = true;
        this.spawnClone(f);
      }
    }

    // туман: Вейл постоянно "теряется из виду" -> поддерживаем прайм слёз
    if (this.fog && this.t < this.fog.until) {
      const veil = this.fighters[this.fog.team];
      if (veil && veil.charId === 'veil' && this.t - veil.tearsRefreshAt > 1.5) {
        veil.tearsRefreshAt = this.t; this.primeTears(veil);
      }
    } else this.fog = null;

    // поле Каина: финишер
    if (this.field && this.t >= this.field.until && !this.field.done) {
      this.field.done = true;
      const kain = this.fighters[this.field.team];
      if (kain && kain.alive && kain.charId === 'kain') {
        kain.swing = { strikeAt: this.t + 0.05, kind: 'finisher' };
        this.ev({ k: 'finisher', eid: kain.eid });
      }
      const fld = this.field;
      this._fieldExpireAt = this.t + 0.35;
    }
    if (this.field && this._fieldExpireAt && this.t >= this._fieldExpireAt) { this.field = null; this._fieldExpireAt = 0; }

    // отложенные выстрелы Дюка
    for (const s of this.pendingShots) {
      if (this.t < s.at) continue;
      s.done = true;
      const duk = this.fighters[s.team];
      let hit = false;
      for (const tg of this.hostileTargets(s.team)) {
        if (dist(s.x, s.y, tg.x, tg.y) <= s.r + tg.radius * 0.4) {
          hit = true;
          if (duk) this.onLandedHit(duk, tg, s.dmg);
          this.ev({ k: 'impact', x: s.x, y: s.y });
        }
      }
      if (!hit && duk && duk.alive && duk.canAct(this)) {
        duk.x = clamp(s.x, duk.radius, GLOBAL.ARENA_W - duk.radius);
        duk.y = clamp(s.y, duk.radius, GLOBAL.ARENA_H - duk.radius);
        this.ev({ k: 'tp', eid: duk.eid, x: duk.x, y: duk.y });
      }
    }
    this.pendingShots = this.pendingShots.filter(s => !s.done);

    // ===== god strike Отражения (отложенный) =====
    for (const g of this.godStrikes) {
      if (this.t < g.at) continue;
      g.done = true;
      const owner = this.fighters[g.team];
      for (const tg of this.hostileTargets(g.team)) {
        if (dist(g.x, g.y, tg.x, tg.y) <= g.r + tg.radius) {
          this.dealDamage(owner || tg, tg, g.dmg, { godStrike: true, floorHp: g.floorHp, healPct: g.healPct, healDur: g.healDur });
        }
      }
      this.ev({ k: 'godhit', x: g.x, y: g.y, r: g.r });
      this.ev({ k: 'shake', mag: 12 });
    }
    this.godStrikes = this.godStrikes.filter(g => !g.done);

    // ===== отложенное лечение от god strike =====
    for (const f of list) {
      if (!f || !f.alive || !f.pendingHeal) continue;
      if (this.t >= f.pendingHeal.until) { f.pendingHeal = null; continue; }
      f.hp = Math.min(f.drv.maxHp, f.hp + f.pendingHeal.rate * dt);
    }

    // ===== Защитник: аскеза воли + затухание баффа =====
    for (const f of list) {
      if (!f || !f.alive || f.isClone || f.isLarva || f.charId !== 'defender') continue;
      const moving = Math.abs(f.mx) > 0.05 || Math.abs(f.my) > 0.05;
      const acting = f.swing || this.t < f.parryUntil || (this.t < f.cdSkillAt && this.t > f.cdSkillAt - 0.2);
      if (moving || acting) {
        f.asceticPct = Math.max(0, f.asceticPct - f.def.passive.resetPct);
        f.idleSince = this.t;
      } else {
        if (this.t - f.idleSince >= 1) { f.idleSince = this.t; f.asceticPct = Math.min(f.def.passive.maxPct, f.asceticPct + f.def.passive.perSecPct); }
      }
    }

    // ===== Спайгер: накопление стэков разгона, бёрст на максимуме =====
    for (const f of list) {
      if (!f || !f.alive || !f.overclock) continue;
      const oc = f.overclock, sk = f.def.skill;
      if (this.t >= oc.until) {
        // финальный бёрст по врагу при максимальных стэках
        if (oc.stacks >= sk.maxStack) {
          for (const tg of this.hostileTargets(f.team)) {
            if (dist(f.x, f.y, tg.x, tg.y) < 260) {
              for (let h = 0; h < 5; h++) this.onLandedHit(f, tg, sk.burstHitDmg);
              this.ev({ k: 'spigerBurst', x: tg.x, y: tg.y });
            }
          }
        }
        f.overclock = null;
        continue;
      }
      if (this.t >= oc.nextStackAt && oc.stacks < sk.maxStack) {
        oc.stacks++; oc.nextStackAt = this.t + sk.stackInterval;
        this.ev({ k: 'spigerStack', eid: f.eid, n: oc.stacks });
      }
      // на максимуме враг почти замирает
      if (oc.stacks >= sk.maxStack) {
        const e = this.enemyOf(f.team);
        if (e && e.alive && !e.immuneFx()) e.slows.push({ pct: sk.enemySlowPctAtMax, until: this.t + 0.2 });
      }
    }

    // ===== Люциан: серия ударов псевдо-копии =====
    for (const f of list) {
      if (!f || !f.alive || !f.pseudo) continue;
      const ps = f.pseudo;
      const tgt = this.hostileTargets(f.team).find(x => x.eid === ps.target) || this.nearestHostile(f);
      if (this.t >= ps.until || ps.hitsLeft <= 0 || !tgt) { f.pseudo = null; continue; }
      if (this.t >= ps.nextAt) {
        ps.nextAt = this.t + ps.interval; ps.hitsLeft--;
        this.dealDamage(f, tgt, ps.dmg, { crit: true });
        this.ev({ k: 'pseudoHit', x: tgt.x, y: tgt.y });
      }
    }

    // ===== Вождь Червей: личинки =====
    this.updateLarvae(dt);

    // протухшие могилы
    this.graves = this.graves.filter(g => this.t < g.until);
    if (this.flareUntil && this.t >= this.flareUntil) this.flareUntil = 0;

    // снаряды
    for (const p of this.projectiles) {
      const step = p.speed * dt;
      p.x += p.dx * step; p.y += p.dy * step; p.left -= step;
      for (const tg of this.hostileTargets(p.team)) {
        if (dist(p.x, p.y, tg.x, tg.y) <= p.radius + tg.radius) {
          p.left = -1;
          const owner = this.fighters[p.team];
          // паранойя действует и на стрельбу
          const fog = this.fog;
          if (fog && fog.team !== p.team && this.t < fog.until && Math.random() < fog.missChance) {
            this.ev({ k: 'miss', x: p.x, y: p.y, forced: true });
            this.primeTears(tg);
          } else if (owner) {
            this.onLandedHit(owner, tg, p.dmg);
          }
          break;
        }
      }
      if (p.left <= 0 && p.left > -0.5) {
        // снаряд долетел в никуда = промах
        this.ev({ k: 'miss', x: p.x, y: p.y });
        const e = this.enemyOf(p.team);
        this.primeTears(e);
      }
      if (p.x < 0 || p.x > GLOBAL.ARENA_W || p.y < 0 || p.y > GLOBAL.ARENA_H) p.left = -1;
    }
    this.projectiles = this.projectiles.filter(p => p.left > -0.5 ? p.left > 0 : false);

    // клон-ИИ
    if (this.clone && this.clone.alive) this.cloneAI(this.clone, dt);

    // протухшие облака
    this.clouds = this.clouds.filter(c => this.t < c.until);
  }

  spawnClone(king) {
    const p = king.def.passive;
    const c = new Fighter('king', king.team);
    c.isClone = true;
    c.hp = Math.round(c.drv.maxHp * (p.cloneHpPct / 100));
    // разлетаемся: обоих раскидывает в стороны
    const baseX = king.x, baseY = king.y;
    const a1 = Math.random() * TAU, a2 = a1 + Math.PI * (0.6 + Math.random() * 0.8);
    king.x = clamp(baseX + Math.cos(a1) * p.scatterDist, king.radius, GLOBAL.ARENA_W - king.radius);
    king.y = clamp(baseY + Math.sin(a1) * p.scatterDist, king.radius, GLOBAL.ARENA_H - king.radius);
    c.x = clamp(baseX + Math.cos(a2) * p.scatterDist, c.radius, GLOBAL.ARENA_W - c.radius);
    c.y = clamp(baseY + Math.sin(a2) * p.scatterDist, c.radius, GLOBAL.ARENA_H - c.radius);
    this.clone = c;
    const e1 = EID++, e2 = EID++;
    if (Math.random() < 0.5) { king.eid = e1; c.eid = e2; } else { king.eid = e2; c.eid = e1; }
    this.ev({ k: 'clone', x: baseX, y: baseY });
  }

  cloneAI(c, dt) {
    const tgt = this.enemyOf(c.team);
    if (!tgt || !tgt.alive) { c.mx = 0; c.my = 0; return; }
    const d = dist(c.x, c.y, tgt.x, tgt.y);
    const a = c.def.attack;
    if (d > a.range * 0.8) {
      const ang = Math.atan2(tgt.y - c.y, tgt.x - c.x);
      c.mx = Math.cos(ang); c.my = Math.sin(ang);
    } else {
      c.mx = 0; c.my = 0;
      if (!c.swing && this.t >= c.cdAtkAt && c.canAct(this)) {
        c.swing = { strikeAt: this.t + a.windup, kind: 'basic' };
        c.cdAtkAt = this.t + c.drv.atkCd;
        this.ev({ k: 'windup', eid: c.eid, dur: a.windup });
      }
    }
  }

  // ---------- Вождь Червей: личинки ----------
  updateLarvae(dt) {
    if (!this.larvae.length) return;
    for (const tm of ['A', 'B']) {
      const chief = this.fighters[tm];
      const mine = this.larvae.filter(l => l.team === tm && l.alive);
      // пробуждение при 10 личинках
      if (chief && chief.charId === 'chief' && !chief.awakened && mine.length >= chief.def.skill.awakenAt) {
        chief.awakened = true;
        const sk = chief.def.skill;
        for (const l of mine) {
          l.awakened = true;
          l.maxHp = Math.round(l.maxHp * (1 + sk.awakenHpBonus / 100));
          l.hp = l.maxHp;
        }
        this.ev({ k: 'awaken', team: tm, x: chief.x, y: chief.y });
        this.ev({ k: 'shake', mag: 10 });
      }
    }

    for (const l of this.larvae) {
      if (!l.alive) continue;
      const chief = this.fighters[l.team];
      const enemy = this.enemyOf(l.team);
      if (l.awakened && enemy && enemy.alive) {
        // пробуждённая: преследует и кусает
        const d = dist(l.x, l.y, enemy.x, enemy.y);
        if (d > 30) { const a = Math.atan2(enemy.y - l.y, enemy.x - l.x); l.x += Math.cos(a) * l.speed * 1.4 * dt; l.y += Math.sin(a) * l.speed * 1.4 * dt; }
        else { l.biteAt = l.biteAt || 0; if (this.t >= l.biteAt) { l.biteAt = this.t + 0.8; this.dealDamage(chief || l, enemy, 6, { dot: true }); } }
      } else if (enemy && enemy.alive) {
        // не пробуждённая: убегает от ближайшего врага
        const a = Math.atan2(l.y - enemy.y, l.x - enemy.x);
        l.x += Math.cos(a) * l.speed * dt; l.y += Math.sin(a) * l.speed * dt;
      }
      l.x = clamp(l.x, l.radius, GLOBAL.ARENA_W - l.radius);
      l.y = clamp(l.y, l.radius, GLOBAL.ARENA_H - l.radius);
    }
    this.larvae = this.larvae.filter(l => l.alive);
  }

  // урон по личинке (вызывается из снарядов/секторов через hostileTargets)
  damageLarva(l, dmg) {
    l.hp -= dmg;
    if (l.hp <= 0) {
      l.alive = false;
      this.ev({ k: 'larvaDie', x: l.x, y: l.y });
      const chief = this.fighters[l.team];
      if (chief && chief.alive && l.awakened) {
        chief.larvaKills++;
        chief.statBonus += chief.def.skill.statBonusPerKill;
      }
    }
  }

  quasarNullification(rabbit) {
    this.voidTheme = true;
    this.clearDuelEffects();
    for (const tm of ['A', 'B']) {
      const f = this.fighters[tm];
      if (!f || !f.alive) continue;
      f.hp = f.drv.maxHp;
      f.nullified = true;
    }
    this.ev({ k: 'quasar' });
    this.ev({ k: 'shake', mag: 18 });
  }

  // ---------- снапшот (персонально для каждого игрока) ----------
  snapshotFor(team) {
    const enemyTeam = team === 'A' ? 'B' : 'A';
    const pack = (f, viewerTeam) => {
      if (!f) return null;
      const mine = f.team === viewerTeam;
      const ghost = this.fog && this.fog.team === f.team && this.t < this.fog.until && f.charId === 'veil' && !mine;
      const hideHp = this.clone && f.charId === 'king' && !mine;
      return {
        eid: f.eid, id: f.charId, team: f.team, clone: mine ? !!f.isClone : false,
        x: Math.round(f.x), y: Math.round(f.y), face: +f.face.toFixed(2),
        hp: hideHp ? null : Math.max(0, Math.round(f.hp)), maxHp: f.drv.maxHp,
        mana: hideHp ? null : Math.round(f.mana), maxMana: f.drv.maxMana,
        alive: f.alive, r: f.radius,
        canMove: f.speedMult(this) > 0,
        spdMult: +f.speedMult(this).toFixed(2),
        ghost, isReal: mine && f.charId === 'king' && this.clone ? !f.isClone : undefined,
        st: {
          stun: this.t < f.stunUntil || this.t < f.staggerUntil,
          rooted: this.t < f.rootedUntil,
          channel: !!f.channel,
          blind: this.t < f.blindUntil && mine,
          invuln: this.t < f.invulnUntil,
          nullified: f.nullified,
          poisoned: f.poisons.length > 0 || (this.fog && this.fog.team !== f.team && this.t < this.fog.until),
          crack: f.crackOn,
        },
        cd: mine ? {
          atk: this.cdFrac(f.cdAtkAt, f.drv.atkCd),
          skill: this.cdFrac(f.cdSkillAt, f.def.skill.cd),
          dash: this.cdFrac(f.cdDashAt, GLOBAL.DASH_CD),
          skillReady: f.mana >= (f.def.skill.cost === 'ALL' ? f.def.skill.minMana : f.def.skill.cost) && !f.nullified,
        } : undefined,
        aimAng: (f.sighting && this.t < f.sighting.until) ? +f.sighting.ang.toFixed(2) : undefined,
      };
    };
    const extras = [];
    if (this.clone) extras.push(pack(this.clone, team));
    for (const p of this.projectiles) extras.push({ kind: 'proj', x: Math.round(p.x), y: Math.round(p.y), team: p.team, pellet: !!p.pellet });
    for (const s of this.pendingShots) extras.push({ kind: 'mark', x: Math.round(s.x), y: Math.round(s.y), r: s.r, at: +(s.at - this.t).toFixed(2) });
    for (const g of this.godStrikes) extras.push({ kind: 'godmark', x: Math.round(g.x), y: Math.round(g.y), r: g.r, at: +(g.at - this.t).toFixed(2), team: g.team });
    for (const l of this.larvae) if (l.alive) extras.push({ kind: 'larva', x: Math.round(l.x), y: Math.round(l.y), team: l.team, awakened: !!l.awakened });

    return {
      t: +this.t.toFixed(3),
      phase: this.phase,
      winner: this.winner,
      you: team,
      A: pack(this.fighters.A, team),
      B: pack(this.fighters.B, team),
      extras,
      bench: this.benchAlive,
      idx: this.idx,
      zones: {
        fog: this.fog && this.t < this.fog.until ? { team: this.fog.team, left: +(this.fog.until - this.t).toFixed(2) } : null,
        field: this.field ? { x: Math.round(this.field.x), y: Math.round(this.field.y), r: this.field.r, team: this.field.team, left: +(Math.max(0, this.field.until - this.t)).toFixed(2) } : null,
        clouds: this.clouds.map(c => ({ x: Math.round(c.x), y: Math.round(c.y), r: c.r, team: c.team })),
        graves: this.graves.map(g => ({ x: Math.round(g.x), y: Math.round(g.y), r: g.r, team: g.team })),
        flare: this.flareUntil && this.t < this.flareUntil ? +(this.flareUntil - this.t).toFixed(2) : 0,
        voidTheme: this.voidTheme,
      },
      events: this.events,
    };
  }

  flushEvents() { this.events = []; }

  // Круг бойца vs прямоугольники карты: выталкиваем по оси наименьшего проникновения.
  // Чисто позиционная коррекция — урон, скиллы и тайминги не трогает.
  resolveObstacles(f) {
    for (const o of this.obstacles) {
      const cx = clamp(f.x, o.x, o.x + o.w);
      const cy = clamp(f.y, o.y, o.y + o.h);
      const dx = f.x - cx, dy = f.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= f.radius * f.radius) continue;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        f.x = cx + (dx / d) * f.radius;
        f.y = cy + (dy / d) * f.radius;
      } else {
        // центр внутри прямоугольника — выходим через ближайшую грань
        const left = f.x - o.x, right = o.x + o.w - f.x;
        const top = f.y - o.y, bottom = o.y + o.h - f.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) f.x = o.x - f.radius;
        else if (m === right) f.x = o.x + o.w + f.radius;
        else if (m === top) f.y = o.y - f.radius;
        else f.y = o.y + o.h + f.radius;
      }
      f.x = clamp(f.x, f.radius, GLOBAL.ARENA_W - f.radius);
      f.y = clamp(f.y, f.radius, GLOBAL.ARENA_H - f.radius);
      if (f.kingDash) f.kingDash = null; // рывок Короля обрывается о препятствие, как о стену
    }
  }

  cdFrac(at, total) {
    if (this.t >= at) return 1;
    return clamp(1 - (at - this.t) / total, 0, 1);
  }
}



module.exports = { Match };

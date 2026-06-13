// ============================================================
//  VOID ARENA — balance.js
//  Все числа баланса в одном месте. Крути их, не трогая логику.
//  Статы по шкале 0..9, у каждого персонажа сумма = 30.
// ============================================================

const GLOBAL = {
  ARENA_W: 1200,
  ARENA_H: 700,
  TICK_RATE: 30,          // герц симуляции на сервере
  SNAP_RATE: 15,          // герц рассылки снапшотов
  HP_PER_POINT: 20,
  ATK_PER_POINT: 8,
  DEF_PCT_PER_POINT: 5,   // %
  DEF_CAP_PCT: 45,        // %
  MANA_PER_POINT: 15,
  MANA_REGEN_PER_S: 6,
  BASE_MOVE_SPEED: 185,   // ед/с при SPD 5
  SPD_MOVE_FACTOR: 0.085, // +-8.5% скорости за пункт SPD от 5
  SPD_CD_FACTOR: 0.05,    // влияние SPD на кулдаун атаки
  DASH_MULT: 3.1,
  DASH_TIME: 0.18,        // сек
  DASH_CD: 1.25,          // сек
  FIGHTER_RADIUS: 26,
  SWAP_DELAY: 2.4,        // пауза между бойцами, сек
  SPAWN_INVULN: 1.2,      // сек неуязвимости нового бойца
  RECONNECT_GRACE: 25,    // сек на переподключение
};

// ---- Команды ----
// Полный ростер 13: каждая фракция собирает родственных по духу бойцов.
// Игрок выбирает любых ТРОИХ из ростера своей стороны.
const TEAMS = {
  A: { name: 'Орден Пустоты', roster: ['veil', 'rabbit', 'kain', 'reflection', 'heir', 'lucian', 'spiger'] },
  B: { name: 'Культ Бегемота', roster: ['sectarian', 'duk', 'king', 'chief', 'barogun', 'defender'] },
};

// ---- Персонажи ----
// attack.type: 'melee' (сектор) | 'proj' (снаряд)
// windup/cd в секундах, mult — множитель к ATK-урону
const CHARACTERS = {
  // ================= КОМАНДА A =================
  veil: {
    id: 'veil', name: 'Вейл', title: 'Игла Голубого Тумана', archetype: 'Ассасин',
    color: '#e84d7a', glow: '#5aa7c9',
    stats: { hp: 4, atk: 9, def: 5, spd: 7, mana: 5 },
    radius: 24,
    attack: { type: 'melee', range: 72, arc: 70, windup: 0.12, cd: 0.45, mult: 0.9 },
    skill: {
      key: 'blueParanoia', name: 'Голубая паранойя', cost: 55, cd: 4,
      fogDuration: 6, poisonDps: 6, slowPct: 25, missChance: 0.30, ghostAlpha: 0.12,
    },
    passive: {
      key: 'pinkTears', name: 'Розовые слёзы',
      bonusPoisonDps: 7, bonusPoisonDur: 3, // доп. яд на следующий удар после промаха врага
    },
  },

  rabbit: {
    id: 'rabbit', name: 'Квазарный Кролик', title: 'Маг Катастрофы', archetype: 'Маг',
    color: '#b58cff', glow: '#cfd6ff',
    stats: { hp: 8, atk: 9, def: 2, spd: 2, mana: 9 },
    radius: 27,
    attack: { type: 'melee', range: 88, arc: 80, windup: 0.42, cd: 1.1, mult: 1.0 },
    skill: {
      key: 'quasarNull', name: 'Квазарное Обнуление', cost: 'ALL', minMana: 120, cd: 6,
      channelTime: 2.0, cancelDamage: 25, // суммарный урон, сбивающий каст
    },
    passive: {
      key: 'voidStep', name: 'Удар в пустоту',
      everyNth: 5, // каждый 5-й входящий удар = 0 урона
    },
  },

  kain: {
    id: 'kain', name: 'Каин', title: 'Нулевой Паломник', archetype: 'Воин',
    color: '#d9c188', glow: '#fff3d6',
    stats: { hp: 6, atk: 8, def: 6, spd: 1, mana: 9 },
    radius: 28,
    attack: { type: 'melee', range: 112, arc: 110, windup: 0.55, cd: 1.5, mult: 1.05 },
    skill: {
      key: 'moonVerdict', name: 'Приговор Луны', cost: 80, cd: 5,
      fieldRadius: 175, fieldDuration: 5, enemySlowPct: 45, enemyAtkCdMult: 1.5,
      bonusManaDmg: 20, selfDmgReductionPct: 30,
      finisher: { range: 135, arc: 140, dmg: 95, stun: 0.8 },
    },
    passive: {
      key: 'oathWeight', name: 'Тяжесть обета',
      flatDmgMult: 1.2,    // бонус за почти нулевую скорость
      crackEveryNth: 3,    // каждый 3-й удар вешает трещину
      crackBonusMult: 1.5, // следующий удар по треснувшему — x1.5
    },
  },

  // ================= КОМАНДА B =================
  sectarian: {
    id: 'sectarian', name: 'Сектант Бегемота', title: 'Behemoth Sectarian', archetype: 'Колдун',
    color: '#a33b3b', glow: '#ff6b6b',
    stats: { hp: 7, atk: 6, def: 5, spd: 5, mana: 7 },
    radius: 26,
    attack: { type: 'melee', range: 78, arc: 90, windup: 0.2, cd: 0.6, mult: 0.85 },
    skill: {
      key: 'darkRite', name: 'Dark Rite of Behemoth', cost: 15, cd: 1.5,
      selfHpCost: 10, coneRange: 165, coneArc: 60, dmg: 30, slowPct: 30, slowDur: 2,
      blindDur: 2.2, blindRadius: 230, // радиус видимости у ослеплённого
    },
    passive: {
      key: 'behemothBlood', name: 'Blood of Behemoth',
      regenPerS: 3,
    },
  },

  duk: {
    id: 'duk', name: 'Святой Дюк', title: 'Saint Duk', archetype: 'Следопыт',
    color: '#caa84f', glow: '#ffe9b0',
    stats: { hp: 6, atk: 7, def: 2, spd: 6, mana: 9 },
    radius: 24,
    attack: { type: 'proj', range: 430, projSpeed: 640, projRadius: 9, windup: 0.15, cd: 0.7, mult: 0.8 },
    skill: {
      key: 'instantShot', name: 'Instant Shot', cost: 40, cd: 2.5,
      telegraph: 0.25, impactRadius: 68, dmg: 50,
    },
    passive: {
      key: 'abshotlution', name: 'Abshotlution',
      cooldown: 60, // раз в 60 сек: мана упала до 0 -> восстановить 100%
    },
  },

  king: {
    id: 'king', name: 'Грибной Король', title: 'Mushroom King', archetype: 'Гигант',
    color: '#cfc6b8', glow: '#e8ddc8',
    stats: { hp: 9, atk: 7, def: 7, spd: 2, mana: 5 },
    radius: 33,
    attack: { type: 'melee', range: 132, arc: 50, windup: 0.48, cd: 1.3, mult: 1.0 },
    skill: {
      key: 'royalDash', name: 'Royal Dash', cost: 35, cd: 3,
      dashSpeed: 720, dashRange: 400, dmg: 60, knockback: 220, stagger: 0.35,
    },
    passive: {
      key: 'sporeMinistry', name: 'Spore Ministry',
      triggerHpPct: 50, cloneHpPct: 35, scatterDist: 140,
      cloudRadius: 135, cloudDuration: 4, cloudSlowPct: 50, cloudDefCutPct: 50,
    },
  },

  // ================= НОВЫЕ 7 =================
  barogun: {
    id: 'barogun', name: 'Барогун Гилзкернес', title: 'Barogun Gilzkernes', archetype: 'Тяжёлый стрелок',
    color: '#c9a04f', glow: '#ffd98a',
    stats: { hp: 8, atk: 4, def: 5, spd: 2, mana: 2 },
    radius: 30,
    attack: { type: 'proj', range: 360, projSpeed: 600, projRadius: 7, windup: 0.18, cd: 0.5, mult: 0.55 },
    skill: {
      key: 'shootingDogs', name: 'Свора Стволов', cost: 18, cd: 4,
      burst: 16, spreadDeg: 70, pelletDmg: 6, projSpeed: 560, range: 330, projRadius: 5,
    },
    passive: {
      key: 'investSecurity', name: 'Вклад в безопасность',
      cooldown: 30, triggerRange: 95, ringDelay: 0.55, ringDmg: 38, knockback: 230,
    },
  },

  heir: {
    id: 'heir', name: 'Наследница Видения', title: 'Heir of the Vision', archetype: 'Снайпер',
    color: '#d05a5a', glow: '#ff9d9d',
    stats: { hp: 3, atk: 9, def: 2, spd: 6, mana: 4 },
    radius: 24,
    attack: { type: 'proj', range: 520, projSpeed: 760, projRadius: 7, windup: 0.32, cd: 1.2, mult: 1.1 },
    skill: {
      key: 'sighting', name: 'Прицеливание', cost: 30, cd: 1.2,
      rotSpeed: 1.4, fireDmg: 70, beamRange: 560, beamWidth: 16, holdMax: 6,
    },
    passive: {
      key: 'flare', name: 'Осветительная',
      brightDur: 4,
    },
  },

  reflection: {
    id: 'reflection', name: 'Отражение Бога', title: 'Reflection of God', archetype: 'Маг/Анти-контроль',
    color: '#cfe4dd', glow: '#a8f0e0',
    stats: { hp: 7, atk: 2, def: 6, spd: 6, mana: 9 },
    radius: 26,
    attack: { type: 'melee', range: 92, arc: 80, windup: 0.22, cd: 0.7, mult: 0.7 },
    skill: {
      key: 'godStrike', name: 'GGGGod Strike', cost: 'ALL', minMana: 135, cd: 9,
      telegraph: 0.6, radius: 200, dmg: 130, floorHp: 1, healPct: 70, healDur: 8,
    },
    passive: {
      key: 'eternalPicture', name: 'Вечный Образ',
      immune: true,
    },
  },

  defender: {
    id: 'defender', name: 'Защитник Храмов', title: 'Defender of the Temples', archetype: 'Танк',
    color: '#d8cdb0', glow: '#fff0c8',
    stats: { hp: 8, atk: 5, def: 8, spd: 5, mana: 4 },
    radius: 28,
    attack: { type: 'melee', range: 96, arc: 70, windup: 0.26, cd: 0.75, mult: 0.95 },
    skill: {
      key: 'parry', name: 'Парирование', cost: 20, cd: 3,
      window: 0.3, buffDur: 4, buffDmgMult: 1.5, shieldRange: 120, shieldArc: 110, heavyReducePct: 50,
    },
    passive: {
      key: 'asceticism', name: 'Аскеза Воли',
      perSecPct: 3, maxPct: 35, resetPct: 15,
    },
  },

  chief: {
    id: 'chief', name: 'Вождь Червей', title: 'Chief of Worms', archetype: 'Призыватель',
    color: '#9aa86a', glow: '#cfe08a',
    stats: { hp: 3, atk: 2, def: 0, spd: 4, mana: 2 },
    radius: 25,
    attack: { type: 'melee', range: 70, arc: 80, windup: 0.2, cd: 0.6, mult: 0.7 },
    skill: {
      key: 'selfRebellion', name: 'Самовырождение', cost: 12, cd: 2,
      larvaHpPct: 100, larvaSpeed: 90, maxLarvae: 10,
      awakenAt: 10, awakenHpBonus: 100, awakenDefBonus: 30, statBonusPerKill: 0.4,
      graveRadius: 200, graveDuration: 5, graveSlowPct: 25,
    },
    passive: { key: 'awakening', name: 'Пробуждение Вождя' },
  },

  lucian: {
    id: 'lucian', name: 'Люциан Вальмонт', title: 'Lucian Valmont', archetype: 'Дуэлянт',
    color: '#c9d4f0', glow: '#dfe8ff',
    stats: { hp: 4, atk: 7, def: 2, spd: 9, mana: 8 },
    radius: 24,
    attack: { type: 'melee', range: 78, arc: 55, windup: 0.12, cd: 0.4, mult: 0.85 },
    skill: {
      key: 'pseudoGap', name: 'Псевдореальный Разрыв', cost: 45, cd: 5,
      hits: 6, hitInterval: 0.16, hitDmg: 16, dur: 1.1,
    },
    passive: {
      key: 'pseudoProjection', name: 'Псевдопроекция',
      echoPct: 0.4,
    },
  },

  spiger: {
    id: 'spiger', name: 'Спайгер', title: 'Spiger', archetype: 'Скоростной боец',
    color: '#a7c6e0', glow: '#d6ecff',
    stats: { hp: 3, atk: 5, def: 2, spd: 9, mana: 4 },
    radius: 24,
    attack: { type: 'melee', range: 74, arc: 60, windup: 0.12, cd: 0.42, mult: 0.8 },
    skill: {
      key: 'overclocking', name: 'Разгон', cost: 20, cd: 5,
      duration: 4, speedPerStack: 0.6, maxStack: 4, stackInterval: 0.7,
      enemySlowPctAtMax: 55, burstHitDmg: 14,
    },
    passive: {
      key: 'underpressure', name: 'Под давлением',
    },
  },
};

// ---- Карты ----
// obstacles: прямоугольники {x,y,w,h} в координатах арены (1200×700).
// Арена Пустоты — чистая (бесконечная пустота), геометрия только в Храме и Лесу.
// Препятствия расставлены вне линии спавна (y≈350) и стартовых точек (x≈264 / x≈936).
const MAPS = {
  void: {
    id: 'void', name: 'Арена Пустоты', tagline: 'Бесконечная пустота. Ничто не спасёт от обнуления.',
    background: 'assets/maps/void.jpg', bgFallback: '#0a0a12',
    accent: '#9a7fd6', moteStyle: 'void',
    obstacles: [],
  },
  temple: {
    id: 'temple', name: 'Забытый Храм', tagline: 'Руины древнего святилища. Эхо молитв и шёпот павших рыцарей.',
    background: 'assets/maps/temple.jpg', bgFallback: '#14100c',
    accent: '#d8a85f', moteStyle: 'temple',
    obstacles: [
      { x: 330, y: 130, w: 76, h: 76 },
      { x: 794, y: 130, w: 76, h: 76 },
      { x: 330, y: 494, w: 76, h: 76 },
      { x: 794, y: 494, w: 76, h: 76 },
    ],
  },
  forest: {
    id: 'forest', name: 'Гнилой Лес', tagline: 'Царство спор и плесени. Здесь природа давно перестала быть доброй.',
    background: 'assets/maps/forest.jpg', bgFallback: '#120c0a',
    accent: '#c96a4f', moteStyle: 'forest',
    obstacles: [
      { x: 540, y: 110, w: 120, h: 64 },
      { x: 540, y: 526, w: 120, h: 64 },
      { x: 180, y: 150, w: 58, h: 58 },
      { x: 962, y: 492, w: 58, h: 58 },
    ],
  },
};

// ---- Производные значения ----
function derive(charId) {
  const c = CHARACTERS[charId];
  const s = c.stats;
  return {
    maxHp: s.hp * GLOBAL.HP_PER_POINT,
    atkDmg: s.atk * GLOBAL.ATK_PER_POINT,
    defPct: Math.min(s.def * GLOBAL.DEF_PCT_PER_POINT, GLOBAL.DEF_CAP_PCT) / 100,
    maxMana: s.mana * GLOBAL.MANA_PER_POINT,
    moveSpeed: GLOBAL.BASE_MOVE_SPEED * (1 + (s.spd - 5) * GLOBAL.SPD_MOVE_FACTOR),
    atkCd: c.attack.cd / (0.8 + s.spd * GLOBAL.SPD_CD_FACTOR),
  };
}

module.exports = { GLOBAL, TEAMS, CHARACTERS, MAPS, derive };

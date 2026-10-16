// Авторитетная симуляция мира. Клиенты присылают только нажатые клавиши,
// всё остальное (движение, стрельба, попадания, бонусы, волны) считает сервер
// и 30 раз в секунду рассылает снимок состояния всем участникам.

import { randomBytes, randomUUID } from 'node:crypto';
import {
  BULLET_SPEED, DT, FIRE_COOLDOWN, INVULN_SECONDS, KEY, MAX_WEAPON_LEVEL, OFFLINE_GRACE_MS,
  PLAYER_MAX_HP, PLAYER_RADIUS, RESPAWN_SECONDS, SHIELD_SECONDS, SHIP_COLORS, TICK_RATE, WORLD_H, WORLD_W,
  sanitizeName,
} from '../public/js/shared/constants.js';
import { applyOp, createEmblem, isValidOp } from '../public/js/shared/emblem.js';
import { applyMovement } from '../public/js/shared/physics.js';

export const ENEMY_TYPES = ['drone', 'fighter', 'tank', 'boss'];
export const POWERUP_TYPES = ['weapon', 'heal', 'shield'];

const ENEMY = {
  drone: { hp: 1, r: 5, score: 10 },
  fighter: { hp: 3, r: 7, score: 30 },
  tank: { hp: 10, r: 8, score: 80 },
  boss: { hp: 140, r: 22, score: 600 },
};

const MAX_INPUT_QUEUE = 60;
const MAX_PAINT_OPS = 256;
const MAX_LAMPORT_JUMP = 100_000;
const SAVE_EVERY_TICKS = TICK_RATE * 2;
const ROSTER_EVERY_TICKS = TICK_RATE;
const PING_EVERY_TICKS = TICK_RATE * 2;
const DROP_CHANCE = 0.12;

export class Player {
  constructor({ token, id, name, color, totalKills = 0, best = 0 }) {
    this.token = token;
    this.id = id;
    this.name = name;
    this.color = color;
    this.totalKills = totalKills;
    this.best = best;
    this.conn = null;
    this.online = false;
    this.offlineSince = 0;
    this.ping = 0;
    this.inputs = [];
    this.ackSeq = 0;
    this.cooldown = 0;
    this.resetShip();
  }

  resetShip() {
    this.x = 40;
    this.y = 40 + Math.round(Math.random() * (WORLD_H - 80));
    this.hp = PLAYER_MAX_HP;
    this.score = 0;
    this.kills = 0;
    this.power = 1;
    this.shieldT = 0;
    this.invulnT = 2;
    this.alive = true;
    this.respawnT = 0;
  }

  persistentState() {
    return {
      x: this.x, y: this.y, hp: this.hp, score: this.score, kills: this.kills, power: this.power,
      shieldT: this.shieldT, alive: this.alive, respawnT: this.respawnT,
    };
  }

  restoreState(s) {
    if (!s) return;
    Object.assign(this, {
      x: num(s.x, this.x), y: num(s.y, this.y), hp: num(s.hp, this.hp), score: num(s.score, 0),
      kills: num(s.kills, 0), power: num(s.power, 1), shieldT: num(s.shieldT, 0),
      alive: s.alive !== false, respawnT: num(s.respawnT, 0),
    });
  }

  // Активен ли корабль в бою: офлайн-«призраки» неуязвимы и не мешают.
  get active() {
    return this.online && this.alive;
  }
}

export class Game {
  constructor({ store, now = () => Date.now(), random = Math.random } = {}) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.players = new Map();
    this.byToken = new Map();
    this.enemies = [];
    this.bullets = [];
    this.powerups = [];
    this.events = [];
    this.tick = 0;
    this.nextId = 1;
    this.wave = 0;
    this.waveState = 'break';
    this.waveTimer = 3;
    this.spawnQueue = [];
    this.totalKills = 0;
    this.emblem = createEmblem();
    this.leaderboard = [];
    this.load();
  }

  // ---------- сохранение ----------

  load() {
    if (!this.store) return;
    const world = this.store.getJson('world');
    if (world) {
      this.tick = world.tick ?? 0;
      this.nextId = world.nextId ?? 1;
      this.wave = world.wave ?? 0;
      this.waveState = world.waveState ?? 'break';
      this.waveTimer = world.waveTimer ?? 3;
      this.spawnQueue = world.spawnQueue ?? [];
      this.enemies = world.enemies ?? [];
      this.powerups = world.powerups ?? [];
      this.totalKills = world.totalKills ?? 0;
    }
    const emblem = this.store.getJson('emblem');
    if (emblem?.cells?.length === this.emblem.cells.length) this.emblem = emblem;
    this.leaderboard = this.store.topRuns();
  }

  save() {
    if (!this.store) return;
    this.store.transaction(() => {
      this.store.setJson('world', {
        tick: this.tick, nextId: this.nextId, wave: this.wave, waveState: this.waveState,
        waveTimer: this.waveTimer, spawnQueue: this.spawnQueue, enemies: this.enemies,
        powerups: this.powerups, totalKills: this.totalKills,
      });
      this.store.setJson('emblem', this.emblem);
      for (const p of this.players.values()) this.store.savePlayer(p);
    });
  }

  // ---------- подключения ----------

  // conn: { send(msgOrString), close(code, reason) }
  join(conn, hello) {
    const token = typeof hello.token === 'string' && hello.token.length <= 64 ? hello.token : null;
    let player = token ? this.byToken.get(token) : null;

    if (player) {
      // Тот же игрок переподключился (обрыв связи или вторая вкладка с тем же токеном).
      if (player.conn && player.conn !== conn) {
        player.conn.send({ t: 'kicked', reason: 'Сессия открыта в другом окне' });
        player.conn.close(4000, 'replaced');
      }
    } else {
      const row = token ? this.store?.getPlayer(token) : null;
      if (row) {
        player = new Player({ token, id: row.id, name: row.name, color: row.color, totalKills: row.total_kills, best: row.best_score });
        player.restoreState(row.state);
      } else {
        const fresh = { token: randomUUID(), id: randomBytes(4).toString('hex') };
        player = new Player({ ...fresh, name: 'Пилот', color: SHIP_COLORS[0] });
        this.store?.createPlayer(fresh.token, fresh.id, player.name, player.color);
      }
      this.players.set(player.id, player);
      this.byToken.set(player.token, player);
    }

    if (hello.name) player.name = sanitizeName(hello.name);
    if (SHIP_COLORS.includes(hello.color)) player.color = hello.color;

    const wasOffline = !player.online;
    player.conn = conn;
    player.online = true;
    player.offlineSince = 0;
    player.inputs = [];
    player.ackSeq = 0;
    if (wasOffline) {
      // Короткая неуязвимость после возвращения, чтобы не умереть сразу.
      player.invulnT = Math.max(player.invulnT, INVULN_SECONDS);
      this.feed(`${player.name} в строю`);
    }

    conn.send({
      t: 'welcome',
      token: player.token,
      id: player.id,
      tickRate: TICK_RATE,
      tick: this.tick,
      emblem: this.emblem,
      roster: this.roster(),
      leaderboard: this.leaderboard,
      totalKills: this.totalKills,
    });
    this.broadcast({ t: 'roster', players: this.roster() });
    return player;
  }

  leave(player, conn) {
    if (player.conn !== conn) return; // соединение уже заменено новым
    player.conn = null;
    player.online = false;
    player.offlineSince = this.now();
    player.inputs = [];
    this.store?.savePlayer(player);
    this.feed(`${player.name} потерял связь`);
    this.broadcast({ t: 'roster', players: this.roster() });
  }

  handle(player, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'in': {
        const { s, k } = msg;
        if (!Number.isInteger(s) || !Number.isInteger(k) || k < 0 || k > 31) return;
        const last = player.inputs.length ? player.inputs[player.inputs.length - 1].s : player.ackSeq;
        if (s <= last) return;
        if (player.inputs.length >= MAX_INPUT_QUEUE) player.inputs.shift();
        player.inputs.push({ s, k });
        break;
      }
      case 'paint':
        this.paint(player, msg.ops);
        break;
      case 'pong':
        if (Number.isFinite(msg.ts)) player.ping = Math.max(0, Math.min(9999, this.now() - msg.ts));
        break;
      case 'profile':
        if (msg.name) player.name = sanitizeName(msg.name);
        if (SHIP_COLORS.includes(msg.color)) player.color = msg.color;
        this.broadcast({ t: 'roster', players: this.roster() });
        break;
    }
  }

  // Правки эмблемы. Каждая правка либо побеждает и рассылается всем,
  // либо проигрывает — тогда автору возвращается актуальное значение клетки.
  paint(player, ops) {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_PAINT_OPS) return;
    const accepted = [];
    const rejected = [];
    for (const raw of ops) {
      const op = { i: raw?.i, c: raw?.c, t: raw?.t, by: player.id };
      if (!isValidOp(op) || op.t > this.emblem.lamport + MAX_LAMPORT_JUMP) continue;
      if (applyOp(this.emblem, op)) accepted.push(op);
      else rejected.push({ i: op.i, ...this.emblem.cells[op.i] });
    }
    if (accepted.length) this.broadcast({ t: 'paint', ops: accepted, lamport: this.emblem.lamport });
    if (rejected.length) {
      const winners = [...new Set(rejected.map((r) => this.players.get(r.by)?.name ?? 'другой пилот'))];
      player.conn?.send({ t: 'paintReject', cells: rejected, lamport: this.emblem.lamport, winners });
    }
  }

  // ---------- игровой цикл ----------

  step() {
    this.tick++;
    this.events = [];
    const now = this.now();

    for (const p of this.players.values()) {
      if (!p.online && now - p.offlineSince > OFFLINE_GRACE_MS) {
        this.store?.savePlayer(p);
        this.players.delete(p.id);
        this.byToken.delete(p.token);
        this.broadcast({ t: 'roster', players: this.roster() });
      }
    }

    const online = this.onlineCount();
    if (online > 0) {
      this.updatePlayers();
      this.updateWave(online);
      this.updateEnemies();
      this.updateBullets();
      this.updatePowerups();
      this.broadcast(this.snapshot());
    }

    if (this.tick % ROSTER_EVERY_TICKS === 0 && online > 0) this.broadcast({ t: 'roster', players: this.roster() });
    if (this.tick % PING_EVERY_TICKS === 0) this.broadcast({ t: 'ping', ts: now });
    if (this.tick % SAVE_EVERY_TICKS === 0) this.save();
  }

  onlineCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.online) n++;
    return n;
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => p.active);
  }

  updatePlayers() {
    for (const p of this.players.values()) {
      if (!p.online) continue;
      p.invulnT = Math.max(0, p.invulnT - DT);
      p.shieldT = Math.max(0, p.shieldT - DT);

      if (!p.alive) {
        p.inputs = [];
        p.respawnT -= DT;
        if (p.respawnT <= 0) {
          p.resetShip();
          this.feed(`${p.name} снова в бою`);
        }
        continue;
      }

      // Обычно одно нажатие на тик; при накопившейся очереди (лаг) догоняем по два.
      const count = p.inputs.length > 4 ? 2 : 1;
      for (let i = 0; i < count && p.inputs.length; i++) {
        const input = p.inputs.shift();
        applyMovement(p, input.k);
        p.cooldown = Math.max(0, p.cooldown - DT);
        if (input.k & KEY.FIRE && p.cooldown === 0) {
          this.fire(p);
          p.cooldown = FIRE_COOLDOWN;
        }
        p.ackSeq = input.s;
      }
    }
  }

  fire(p) {
    const spreads = p.power >= 3 ? [-0.18, 0, 0.18] : p.power === 2 ? [-0.05, 0.05] : [0];
    const offsets = p.power === 2 ? [-3, 3] : spreads.map(() => 0);
    spreads.forEach((a, idx) => {
      this.bullets.push({
        id: this.nextId++, x: p.x + 8, y: p.y + offsets[idx],
        vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED, owner: p.id, enemy: false,
      });
    });
    this.events.push({ k: 'shot', id: p.id });
  }

  updateWave(online) {
    if (this.waveState === 'break') {
      this.waveTimer -= DT;
      if (this.waveTimer <= 0) this.startWave(online);
      return;
    }
    const due = this.spawnQueue.filter((s) => s.at <= this.tick);
    if (due.length) {
      this.spawnQueue = this.spawnQueue.filter((s) => s.at > this.tick);
      for (const s of due) this.spawnEnemy(s.type, s.y, online);
    }
    if (this.spawnQueue.length === 0 && this.enemies.length === 0) {
      this.waveState = 'break';
      this.waveTimer = 4;
      this.events.push({ k: 'clear', n: this.wave });
      this.feed(`Волна ${this.wave} отбита!`);
    }
  }

  startWave(online) {
    this.wave++;
    this.waveState = 'active';
    const n = this.wave;
    const factor = 1 + 0.35 * (online - 1);
    const queue = [];
    const add = (type, count, gap) => {
      let at = this.tick + TICK_RATE * (queue.length ? 1 : 0.5);
      for (let i = 0; i < Math.round(count); i++) {
        at += Math.round(gap * TICK_RATE * (0.6 + this.random() * 0.8));
        queue.push({ type, at, y: 24 + Math.round(this.random() * (WORLD_H - 48)) });
      }
    };
    if (n % 5 === 0) {
      queue.push({ type: 'boss', at: this.tick + TICK_RATE * 2, y: WORLD_H / 2 });
      add('drone', (4 + n) * factor, 1.4);
    } else {
      add('drone', (5 + n * 2) * factor, 0.7);
      add('fighter', Math.floor(n * 0.8) * factor, 1.6);
      add('tank', Math.floor((n - 1) / 2) * factor, 3.5);
    }
    this.spawnQueue = queue;
    this.events.push({ k: 'wave', n });
    this.feed(n % 5 === 0 ? `Волна ${n}: флагман противника!` : `Волна ${n}`);
  }

  spawnEnemy(type, y, online) {
    const def = ENEMY[type];
    const scale = type === 'boss' || type === 'tank' ? (1 + 0.5 * (online - 1)) * (1 + this.wave / 10) : 1;
    const hp = Math.round(def.hp * scale);
    this.enemies.push({
      id: this.nextId++, type, x: WORLD_W + def.r + 4, y, baseY: y, hp, maxHp: hp,
      age: 0, fireT: 1 + this.random() * 1.5, phase: this.random() * Math.PI * 2, dmg: {},
    });
  }

  nearestPlayer(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (!p.active) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  enemyShot(e, angle, speed) {
    this.bullets.push({ id: this.nextId++, x: e.x - 6, y: e.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, owner: null, enemy: true });
  }

  aimAt(e, target) {
    return target ? Math.atan2(target.y - e.y, target.x - e.x) : Math.PI;
  }

  updateEnemies() {
    for (const e of this.enemies) {
      e.age += DT;
      e.fireT -= DT;
      const target = this.nearestPlayer(e.x, e.y);
      switch (e.type) {
        case 'drone':
          e.x -= 58 * DT;
          e.y = e.baseY + Math.sin(e.age * 3 + e.phase) * 18;
          break;
        case 'fighter':
          if (e.age > 14) e.x -= 70 * DT;
          else if (e.x > WORLD_W * 0.78) e.x -= 70 * DT;
          else if (target) e.y += Math.sign(target.y - e.y) * Math.min(40 * DT, Math.abs(target.y - e.y));
          if (e.fireT <= 0 && target && e.x < WORLD_W) {
            this.enemyShot(e, this.aimAt(e, target), 120);
            e.fireT = 1.5 + this.random();
          }
          break;
        case 'tank':
          e.x -= 18 * DT;
          if (e.fireT <= 0 && e.x < WORLD_W) {
            for (const a of [-0.3, 0, 0.3]) this.enemyShot(e, Math.PI + a, 90);
            e.fireT = 2.6;
          }
          break;
        case 'boss': {
          if (e.x > WORLD_W - 70) e.x -= 30 * DT;
          e.y = WORLD_H / 2 + Math.sin(e.age * 0.7) * 75;
          if (e.fireT <= 0) {
            e.phase = (Math.floor(e.phase) + 1) % 3;
            if (e.phase === 0) {
              for (let i = 0; i < 14; i++) this.enemyShot(e, (i / 14) * Math.PI * 2 + e.age, 85);
              e.fireT = 1.8;
            } else {
              const a = this.aimAt(e, target);
              for (const d of [-0.15, 0, 0.15]) this.enemyShot(e, a + d, 140);
              e.fireT = 0.9;
            }
          }
          break;
        }
      }
      // Таран.
      for (const p of this.players.values()) {
        if (p.active && hit(p.x, p.y, PLAYER_RADIUS, e.x, e.y, ENEMY[e.type].r)) {
          this.damagePlayer(p);
          if (e.type === 'drone') this.damageEnemy(e, 99, p);
        }
      }
    }
    this.enemies = this.enemies.filter((e) => e.hp > 0 && e.x > -40);
  }

  updateBullets() {
    // Пули обрабатываются в порядке создания (по id), поэтому если два игрока
    // попали в одного врага в один тик, убийство детерминированно засчитывается
    // первой пуле, а остальные получают «помощь».
    for (const b of this.bullets) {
      b.x += b.vx * DT;
      b.y += b.vy * DT;
      if (b.enemy) {
        for (const p of this.players.values()) {
          if (p.active && hit(b.x, b.y, 2, p.x, p.y, PLAYER_RADIUS - 1)) {
            this.damagePlayer(p);
            b.dead = true;
            break;
          }
        }
      } else {
        for (const e of this.enemies) {
          if (e.hp > 0 && hit(b.x, b.y, 2, e.x, e.y, ENEMY[e.type].r)) {
            this.damageEnemy(e, 1, this.players.get(b.owner));
            b.dead = true;
            break;
          }
        }
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead && b.x > -10 && b.x < WORLD_W + 10 && b.y > -10 && b.y < WORLD_H + 10);
  }

  damageEnemy(e, amount, by) {
    if (e.hp <= 0) return;
    e.hp -= amount;
    if (by) e.dmg[by.id] = (e.dmg[by.id] ?? 0) + amount;
    this.events.push({ k: 'hit', id: e.id, x: Math.round(e.x), y: Math.round(e.y) });
    if (e.hp > 0) return;

    const def = ENEMY[e.type];
    this.totalKills++;
    this.events.push({ k: 'boom', x: Math.round(e.x), y: Math.round(e.y), s: def.r });
    if (by) {
      by.score += def.score;
      by.kills++;
      by.totalKills++;
      by.best = Math.max(by.best, by.score);
    }
    // Помощь: остальные, кто наносил урон, получают четверть очков.
    for (const [id, dmg] of Object.entries(e.dmg)) {
      const p = this.players.get(id);
      if (p && p !== by && dmg > 0) {
        p.score += Math.round(def.score / 4);
        p.best = Math.max(p.best, p.score);
      }
    }
    if (e.type === 'boss') {
      this.feed(`${by?.name ?? 'Эскадрилья'} уничтожил флагман!`);
      for (let i = 0; i < 3; i++) this.dropPowerup(e.x - 10 * i, e.y + (i - 1) * 20, POWERUP_TYPES[i]);
    } else if (this.random() < DROP_CHANCE) {
      this.dropPowerup(e.x, e.y);
    }
  }

  dropPowerup(x, y, type) {
    type ??= POWERUP_TYPES[Math.floor(this.random() * POWERUP_TYPES.length)];
    this.powerups.push({ id: this.nextId++, type, x, y });
  }

  damagePlayer(p) {
    if (p.invulnT > 0 || !p.alive) return;
    if (p.shieldT > 0) {
      p.shieldT = 0;
      p.invulnT = 0.6;
      this.events.push({ k: 'shield', id: p.id });
      return;
    }
    p.hp--;
    p.invulnT = INVULN_SECONDS;
    this.events.push({ k: 'hurt', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
    if (p.hp <= 0) this.killPlayer(p);
  }

  killPlayer(p) {
    p.alive = false;
    p.respawnT = RESPAWN_SECONDS;
    this.events.push({ k: 'boom', x: Math.round(p.x), y: Math.round(p.y), s: 12, id: p.id });
    this.feed(`${p.name} сбит (${p.score} очк.)`);
    if (p.score > 0) {
      this.store?.addRun({ playerId: p.id, name: p.name, score: p.score, kills: p.kills, wave: this.wave });
      this.store?.savePlayer(p);
      if (this.store) {
        this.leaderboard = this.store.topRuns();
        this.broadcast({ t: 'leaderboard', top: this.leaderboard });
      }
    }
  }

  // Бонус может одновременно задеть несколько кораблей. Сервер разрешает спор
  // атомарно в одном тике: забирает ближайший, при равенстве — меньший id.
  updatePowerups() {
    for (const u of this.powerups) {
      u.x -= 25 * DT;
      const contenders = [];
      for (const p of this.players.values()) {
        if (!p.active) continue;
        const d = Math.hypot(p.x - u.x, p.y - u.y);
        if (d < PLAYER_RADIUS + 7) contenders.push({ p, d });
      }
      if (!contenders.length) continue;
      contenders.sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
      const winner = contenders[0].p;
      this.applyPowerup(winner, u.type);
      u.taken = true;
      this.events.push({ k: 'pick', id: winner.id, u: u.type, x: Math.round(u.x), y: Math.round(u.y) });
      if (contenders.length > 1) {
        this.feed(`${winner.name} перехватил бонус у ${contenders.slice(1).map((c) => c.p.name).join(', ')}`);
      }
    }
    this.powerups = this.powerups.filter((u) => !u.taken && u.x > -10);
  }

  applyPowerup(p, type) {
    if (type === 'weapon') p.power = Math.min(MAX_WEAPON_LEVEL, p.power + 1);
    else if (type === 'heal') p.hp = Math.min(PLAYER_MAX_HP, p.hp + 1);
    else if (type === 'shield') p.shieldT = SHIELD_SECONDS;
    p.score += 5;
  }

  feed(m) {
    this.events.push({ k: 'feed', m });
  }

  // ---------- сериализация ----------

  // Формат компактный: массивы вместо объектов, индексы описаны в public/js/game.js.
  snapshot() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      t: 's',
      n: this.tick,
      p: [...this.players.values()].map((p) => [
        p.id, p.x, p.y, p.hp,
        (p.alive ? 1 : 0) | (p.online ? 2 : 0) | (p.invulnT > 0 ? 4 : 0) | (p.shieldT > 0 ? 8 : 0),
        p.power, p.score, p.ackSeq, Math.ceil(p.respawnT),
      ]),
      e: this.enemies.map((e) => [e.id, ENEMY_TYPES.indexOf(e.type), r1(e.x), r1(e.y), e.hp, e.maxHp]),
      b: this.bullets.map((b) => [b.id, r1(b.x), r1(b.y), b.enemy ? 1 : 0]),
      u: this.powerups.map((u) => [u.id, POWERUP_TYPES.indexOf(u.type), r1(u.x), r1(u.y)]),
      w: [this.wave, this.waveState === 'active' ? 1 : 0, Math.ceil(this.waveTimer), this.spawnQueue.length + this.enemies.length],
      k: this.totalKills,
      ev: this.events,
    };
  }

  roster() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, online: p.online, score: p.score, kills: p.kills, best: p.best, ping: p.ping }))
      .sort((a, b) => b.score - a.score);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) p.conn?.send(data);
  }
}

function hit(x1, y1, r1, x2, y2, r2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy < (r1 + r2) * (r1 + r2);
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

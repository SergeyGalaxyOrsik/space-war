// Клиентская модель мира: буфер снимков сервера, интерполяция чужих объектов
// и предсказание собственного корабля со сверкой по подтверждённому вводу.
//
// Формат снимка (см. server/game.js → snapshot):
//   p: [id, x, y, hp, flags, power, score, ackSeq, respawnSec]   flags: 1 жив, 2 онлайн, 4 неуязвим, 8 щит
//   e: [id, typeIdx, x, y, hp, maxHp]
//   b: [id, x, y, isEnemy]
//   u: [id, typeIdx, x, y]
//   w: [wave, active, breakSec, enemiesLeft]

import { TICK_MS } from './shared/constants.js';
import { applyMovement } from './shared/physics.js';

const INTERP_TICKS = 3; // ~100 мс задержки отображения ради плавности
const BUFFER = 40;

export const ENEMY_TYPES = ['drone', 'fighter', 'tank', 'boss'];
export const POWERUP_TYPES = ['weapon', 'heal', 'shield'];

export class World {
  constructor() {
    this.snapshots = [];
    this.myId = null;
    this.me = null; // предсказанное состояние своего корабля
    this.pending = [];
    this.seq = 0;
    this.renderTick = 0;
    this.frozen = false;
    this.latest = null;
  }

  reset() {
    this.snapshots = [];
    this.pending = [];
    this.seq = 0;
    this.me = null;
    this.latest = null;
    this.renderTick = 0;
  }

  // Возвращает распакованный снимок (для обработки событий).
  push(raw, recvAt = performance.now()) {
    const snap = unpack(raw, recvAt);
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snap.n <= last.n) return snap;
    this.snapshots.push(snap);
    if (this.snapshots.length > BUFFER) this.snapshots.shift();
    this.latest = snap;
    this.reconcile(snap);
    return snap;
  }

  reconcile(snap) {
    const server = snap.players.get(this.myId);
    if (!server) {
      this.me = null;
      return;
    }
    this.pending = this.pending.filter((input) => input.s > server.ack);
    const me = { ...server };
    if (server.alive) {
      for (const input of this.pending) applyMovement(me, input.k);
    }
    this.me = me;
  }

  // Вызывается с частотой тика сервера, пока есть связь.
  localInput(keys) {
    if (!this.me?.alive) return null;
    const input = { s: ++this.seq, k: keys };
    this.pending.push(input);
    if (this.pending.length > 90) this.pending.shift();
    applyMovement(this.me, keys);
    return input;
  }

  // Оценка текущего тика сервера с плавной подстройкой.
  advance(now) {
    if (!this.latest) return;
    if (this.frozen) return;
    const estimate = this.latest.n + (now - this.latest.recvAt) / TICK_MS - INTERP_TICKS;
    const target = Math.min(estimate, this.latest.n);
    if (!this.renderTick || Math.abs(target - this.renderTick) > 10) this.renderTick = target;
    else this.renderTick += (target - this.renderTick) * 0.2;
  }

  // Интерполированный кадр для отрисовки.
  frame() {
    const snaps = this.snapshots;
    if (!snaps.length) return null;
    let a = snaps[0];
    let b = snaps[0];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].n <= this.renderTick) {
        a = snaps[i];
        b = snaps[i + 1] ?? snaps[i];
        break;
      }
    }
    const alpha = b.n === a.n ? 0 : Math.max(0, Math.min(1, (this.renderTick - a.n) / (b.n - a.n)));
    return {
      players: lerpMap(a.players, b.players, alpha),
      enemies: lerpMap(a.enemies, b.enemies, alpha),
      bullets: lerpMap(a.bullets, b.bullets, alpha),
      powerups: lerpMap(a.powerups, b.powerups, alpha),
      wave: b.wave,
      totalKills: b.totalKills,
      me: this.me,
      myId: this.myId,
    };
  }
}

function lerpMap(a, b, t) {
  const out = [];
  for (const [id, eb] of b) {
    const ea = a.get(id);
    out.push(ea ? { ...eb, x: ea.x + (eb.x - ea.x) * t, y: ea.y + (eb.y - ea.y) * t } : eb);
  }
  return out;
}

export function unpack(raw, recvAt) {
  const players = new Map();
  for (const [id, x, y, hp, flags, power, score, ack, respawn] of raw.p) {
    players.set(id, {
      id, x, y, hp, power, score, ack, respawn,
      alive: !!(flags & 1), online: !!(flags & 2), invuln: !!(flags & 4), shield: !!(flags & 8),
    });
  }
  const enemies = new Map();
  for (const [id, type, x, y, hp, maxHp] of raw.e) enemies.set(id, { id, type: ENEMY_TYPES[type], x, y, hp, maxHp });
  const bullets = new Map();
  for (const [id, x, y, enemy] of raw.b) bullets.set(id, { id, x, y, enemy: !!enemy });
  const powerups = new Map();
  for (const [id, type, x, y] of raw.u) powerups.set(id, { id, type: POWERUP_TYPES[type], x, y });
  const [wave, active, breakSec, left] = raw.w;
  return {
    n: raw.n, recvAt, players, enemies, bullets, powerups,
    wave: { n: wave, active: !!active, breakSec, left },
    totalKills: raw.k,
    events: raw.ev ?? [],
  };
}

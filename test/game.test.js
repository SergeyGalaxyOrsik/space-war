import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../server/game.js';
import { Store } from '../server/store.js';
import { KEY, OFFLINE_GRACE_MS } from '../public/js/shared/constants.js';

function fakeConn() {
  const sent = [];
  return {
    sent,
    closed: null,
    send(msg) { sent.push(typeof msg === 'string' ? JSON.parse(msg) : msg); },
    close(code) { this.closed = code; },
    last(type) { return sent.filter((m) => m.t === type).at(-1); },
  };
}

test('сервер применяет ввод игрока по порядку и подтверждает его', () => {
  const game = new Game();
  const conn = fakeConn();
  const p = game.join(conn, { t: 'hello', name: 'Ann' });
  const x0 = p.x;
  for (let s = 1; s <= 3; s++) game.handle(p, { t: 'in', s, k: KEY.RIGHT });
  game.handle(p, { t: 'in', s: 2, k: KEY.LEFT }); // устаревший — игнорируется
  for (let i = 0; i < 3; i++) game.step();
  assert.ok(p.x > x0);
  assert.equal(p.ackSeq, 3);
  const snap = conn.last('s');
  assert.equal(snap.p[0][7], 3);
});

test('бонус, который задели двое, достаётся ближайшему', () => {
  const game = new Game();
  const a = game.join(fakeConn(), { t: 'hello', name: 'A' });
  const b = game.join(fakeConn(), { t: 'hello', name: 'B' });
  Object.assign(a, { x: 100, y: 100 });
  Object.assign(b, { x: 104, y: 100 });
  game.powerups.push({ id: 999, type: 'weapon', x: 103, y: 100 });
  game.updatePowerups();
  assert.equal(b.power, 2);
  assert.equal(a.power, 1);
  assert.equal(game.powerups.length, 0);
});

test('одновременное попадание: убийство первому, помощь второму', () => {
  const game = new Game({ random: () => 0.99 });
  const a = game.join(fakeConn(), { t: 'hello', name: 'A' });
  const b = game.join(fakeConn(), { t: 'hello', name: 'B' });
  game.enemies.push({ id: 50, type: 'drone', x: 300, y: 100, baseY: 100, hp: 1, maxHp: 1, age: 0, fireT: 9, phase: 0, dmg: {} });
  game.bullets.push({ id: 51, x: 300, y: 100, vx: 0, vy: 0, owner: a.id, enemy: false });
  game.bullets.push({ id: 52, x: 300, y: 100, vx: 0, vy: 0, owner: b.id, enemy: false });
  game.updateBullets();
  assert.equal(a.kills, 1);
  assert.equal(b.kills, 0);
  assert.equal(game.totalKills, 1);
});

test('конфликт правок эмблемы: проигравшему возвращается версия победителя', () => {
  const game = new Game();
  const ca = fakeConn();
  const cb = fakeConn();
  const a = game.join(ca, { t: 'hello', name: 'A' });
  const b = game.join(cb, { t: 'hello', name: 'B' });
  game.handle(a, { t: 'paint', ops: [{ i: 10, c: 8, t: 5 }] });
  game.handle(b, { t: 'paint', ops: [{ i: 10, c: 12, t: 4 }] }); // b не видел правку a
  assert.equal(game.emblem.cells[10].c, 8);
  const reject = cb.last('paintReject');
  assert.equal(reject.cells[0].c, 8);
  assert.deepEqual(reject.winners, ['A']);
  assert.equal(ca.last('paint').ops[0].by, a.id);
});

test('отключившийся игрок остаётся призраком и возвращается с тем же состоянием', () => {
  let now = 1_000_000;
  const game = new Game({ now: () => now });
  const conn = fakeConn();
  const p = game.join(conn, { t: 'hello', name: 'A' });
  p.score = 420;
  game.leave(p, conn);
  assert.equal(p.online, false);
  now += 10_000;
  game.step();
  const again = game.join(fakeConn(), { t: 'hello', token: p.token });
  assert.equal(again, p);
  assert.equal(again.score, 420);
  assert.equal(again.online, true);
});

test('мир, игроки и эмблема переживают перезапуск сервера', () => {
  const store = new Store(':memory:');
  let now = 1_000_000;
  const game = new Game({ store, now: () => now });
  const conn = fakeConn();
  const p = game.join(conn, { t: 'hello', name: 'Persist' });
  Object.assign(p, { score: 777, power: 3, x: 123 });
  game.wave = 4;
  game.handle(p, { t: 'paint', ops: [{ i: 0, c: 7, t: 1 }] });
  game.leave(p, conn);
  now += OFFLINE_GRACE_MS + 1;
  game.step(); // призрак удалён из мира, состояние в БД
  assert.equal(game.players.size, 0);
  game.save();

  const restarted = new Game({ store });
  assert.equal(restarted.wave, 4);
  assert.equal(restarted.emblem.cells[0].c, 7);
  const back = restarted.join(fakeConn(), { t: 'hello', token: p.token });
  assert.equal(back.id, p.id);
  assert.equal(back.name, 'Persist');
  assert.equal(back.score, 777);
  assert.equal(back.power, 3);
  assert.equal(back.x, 123);
  store.close();
});

test('смерть записывает забег в таблицу рекордов', () => {
  const store = new Store(':memory:');
  const game = new Game({ store });
  const p = game.join(fakeConn(), { t: 'hello', name: 'Ace' });
  p.score = 300;
  p.hp = 1;
  p.invulnT = 0;
  game.damagePlayer(p);
  assert.equal(p.alive, false);
  assert.equal(game.leaderboard[0].name, 'Ace');
  assert.equal(game.leaderboard[0].score, 300);
  store.close();
});

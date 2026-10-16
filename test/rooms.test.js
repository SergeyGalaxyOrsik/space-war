import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomManager } from '../server/rooms.js';
import { Store } from '../server/store.js';

const conn = () => ({ send() {}, close() {} });

test('в публичную комнату входят без пароля, миры комнат независимы', () => {
  const store = new Store(':memory:');
  const rooms = new RoomManager({ store });
  const room = rooms.create({ name: '  Орбита <7>  ', isPrivate: false });
  assert.equal(room.name, 'Орбита 7');
  const me = rooms.identify({ name: 'Ann' });
  const a = rooms.enter(room.id, me);
  const main = rooms.enter('main', me);
  assert.notEqual(a, main);
  a.wave = 3;
  a.handle(a.join(conn(), me), { t: 'paint', ops: [{ i: 1, c: 5, t: 1 }] });
  assert.equal(main.wave, 0);
  assert.equal(main.emblem.cells[1].c, 0);
  assert.deepEqual(rooms.list().map((r) => r.id), ['main', room.id]);
  store.close();
});

test('приватная комната: без пароля и с неверным паролем не пускает, потом помнит пилота', () => {
  const store = new Store(':memory:');
  const rooms = new RoomManager({ store });
  const room = rooms.create({ name: 'Секрет', isPrivate: true, password: 'p4ss' });
  const me = rooms.identify({ name: 'Bob' });
  assert.throws(() => rooms.enter(room.id, me), { code: 'password' });
  assert.throws(() => rooms.enter(room.id, me, 'wrong'), { code: 'password' });
  assert.ok(rooms.enter(room.id, me, 'p4ss'));
  assert.ok(rooms.enter(room.id, me), 'повторный вход без пароля');
  const stranger = rooms.identify({ name: 'Eve' });
  assert.throws(() => rooms.enter(room.id, stranger), { code: 'password' });
  assert.equal(rooms.list().find((r) => r.id === room.id).isPrivate, true);
  assert.throws(() => rooms.create({ name: 'Без пароля', isPrivate: true, password: '' }), { code: 'password' });
  assert.throws(() => rooms.enter('nope', me), { code: 'notfound' });
  store.close();
});

test('пароль хранится только в виде хеша', () => {
  const store = new Store(':memory:');
  const rooms = new RoomManager({ store });
  const room = rooms.create({ name: 'Секрет', isPrivate: true, password: 'hunter2' });
  const row = store.getRoom(room.id);
  assert.notEqual(row.password_hash, 'hunter2');
  assert.equal(row.password_hash.length, 64);
  store.close();
});

test('база первой версии переносится в «Общий сектор»', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pss-mig-'));
  const file = join(dir, 'game.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE players (token TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL,
      best_score INTEGER NOT NULL DEFAULT 0, total_kills INTEGER NOT NULL DEFAULT 0, state TEXT, last_seen INTEGER NOT NULL);
    CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, name TEXT NOT NULL,
      score INTEGER NOT NULL, kills INTEGER NOT NULL, wave INTEGER NOT NULL, ended_at INTEGER NOT NULL);
    INSERT INTO kv VALUES ('world', '{"wave":6}');
    INSERT INTO players VALUES ('t1', 'p1', 'Old', '#41a6f6', 50, 3, '{"score":42,"x":99}', 1);
    INSERT INTO runs (player_id, name, score, kills, wave, ended_at) VALUES ('p1', 'Old', 50, 3, 2, 1);
  `);
  old.close();

  const store = new Store(file);
  const rooms = new RoomManager({ store });
  const me = rooms.identify({ token: 't1', name: 'Old' });
  const main = rooms.enter('main', me);
  assert.equal(main.wave, 6);
  assert.equal(main.leaderboard[0].score, 50);
  assert.equal(main.join(conn(), me).score, 42);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

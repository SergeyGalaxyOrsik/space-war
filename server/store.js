// Хранилище на встроенном SQLite (node:sqlite): переживает перезапуск сервера.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAIN_ROOM = 'main';

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS players (
        token TEXT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        best_score INTEGER NOT NULL DEFAULT 0,
        total_kills INTEGER NOT NULL DEFAULT 0,
        state TEXT,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        wave INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        password_salt TEXT,
        password_hash TEXT,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      );
      -- Состояние пилота в конкретной комнате. Наличие строки — ещё и пропуск
      -- в приватную комнату: при переподключении пароль второй раз не нужен.
      CREATE TABLE IF NOT EXISTS room_players (
        room_id TEXT NOT NULL,
        token TEXT NOT NULL,
        state TEXT,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (room_id, token)
      );
    `);
    this.migrate();
    this.q = {
      getKv: this.db.prepare('SELECT value FROM kv WHERE key = ?'),
      setKv: this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      delKvPrefix: this.db.prepare('DELETE FROM kv WHERE key IN (?, ?)'),
      getPlayer: this.db.prepare('SELECT * FROM players WHERE token = ?'),
      insertPlayer: this.db.prepare('INSERT INTO players (token, id, name, color, last_seen) VALUES (?, ?, ?, ?, ?)'),
      updateIdentity: this.db.prepare('UPDATE players SET name = ?, color = ?, last_seen = ? WHERE token = ?'),
      savePlayer: this.db.prepare(`UPDATE players SET name = ?, color = ?, best_score = MAX(best_score, ?),
        total_kills = MAX(total_kills, ?), last_seen = ? WHERE token = ?`),
      getRoomPlayer: this.db.prepare('SELECT state FROM room_players WHERE room_id = ? AND token = ?'),
      saveRoomPlayer: this.db.prepare(`INSERT INTO room_players (room_id, token, state, last_seen) VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id, token) DO UPDATE SET state = COALESCE(excluded.state, state), last_seen = excluded.last_seen`),
      insertRun: this.db.prepare('INSERT INTO runs (player_id, name, score, kills, wave, ended_at, room_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      topRuns: this.db.prepare(`SELECT name, score, kills, wave, ended_at AS endedAt FROM runs
        WHERE room_id = ? ORDER BY score DESC, id ASC LIMIT ?`),
      listRooms: this.db.prepare('SELECT id, name, is_private, created_at FROM rooms ORDER BY id = ? DESC, last_active DESC'),
      getRoom: this.db.prepare('SELECT * FROM rooms WHERE id = ?'),
      countRooms: this.db.prepare('SELECT COUNT(*) AS n FROM rooms'),
      insertRoom: this.db.prepare(`INSERT INTO rooms (id, name, is_private, password_salt, password_hash, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      touchRoom: this.db.prepare('UPDATE rooms SET last_active = ? WHERE id = ?'),
      staleRooms: this.db.prepare('SELECT id FROM rooms WHERE id != ? AND last_active < ?'),
      deleteRoom: this.db.prepare('DELETE FROM rooms WHERE id = ?'),
      deleteRoomPlayers: this.db.prepare('DELETE FROM room_players WHERE room_id = ?'),
      deleteRoomRuns: this.db.prepare('DELETE FROM runs WHERE room_id = ?'),
    };
  }

  // Первая версия хранила один общий мир — переносим его в комнату «Общий сектор».
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    if (!columns.includes('room_id')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN room_id TEXT NOT NULL DEFAULT '${MAIN_ROOM}'`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS runs_room_score ON runs (room_id, score DESC)');
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO rooms (id, name, is_private, created_at, last_active) VALUES (?, ?, 0, ?, ?)`)
      .run(MAIN_ROOM, 'Общий сектор', now, now);
    this.db.exec(`
      UPDATE kv SET key = 'world:${MAIN_ROOM}' WHERE key = 'world' AND NOT EXISTS (SELECT 1 FROM kv WHERE key = 'world:${MAIN_ROOM}');
      UPDATE kv SET key = 'emblem:${MAIN_ROOM}' WHERE key = 'emblem' AND NOT EXISTS (SELECT 1 FROM kv WHERE key = 'emblem:${MAIN_ROOM}');
      INSERT OR IGNORE INTO room_players (room_id, token, state, last_seen)
        SELECT '${MAIN_ROOM}', token, state, last_seen FROM players WHERE state IS NOT NULL;
      UPDATE players SET state = NULL WHERE state IS NOT NULL;
    `);
  }

  getJson(key) {
    const row = this.q.getKv.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setJson(key, value) {
    this.q.setKv.run(key, JSON.stringify(value));
  }

  // ---------- пилоты ----------

  getPlayer(token) {
    const row = this.q.getPlayer.get(token);
    return row ? { ...row } : null;
  }

  createPlayer(token, id, name, color) {
    this.q.insertPlayer.run(token, id, name, color, Date.now());
  }

  updateIdentity(token, name, color) {
    this.q.updateIdentity.run(name, color, Date.now(), token);
  }

  getRoomState(roomId, token) {
    const row = this.q.getRoomPlayer.get(roomId, token);
    if (!row) return { granted: false, state: null };
    return { granted: true, state: row.state ? JSON.parse(row.state) : null };
  }

  grantRoom(roomId, token) {
    this.q.saveRoomPlayer.run(roomId, token, null, Date.now());
  }

  savePlayer(p, roomId) {
    const now = Date.now();
    this.q.savePlayer.run(p.name, p.color, p.best, p.totalKills, now, p.token);
    this.q.saveRoomPlayer.run(roomId, p.token, JSON.stringify(p.persistentState()), now);
  }

  addRun(run) {
    this.q.insertRun.run(run.playerId, run.name, run.score, run.kills, run.wave, Date.now(), run.roomId);
  }

  topRuns(roomId, limit = 10) {
    return this.q.topRuns.all(roomId, limit).map((r) => ({ ...r }));
  }

  // ---------- комнаты ----------

  listRooms() {
    return this.q.listRooms.all(MAIN_ROOM).map((r) => ({ id: r.id, name: r.name, isPrivate: !!r.is_private, createdAt: r.created_at }));
  }

  getRoom(id) {
    const row = this.q.getRoom.get(id);
    return row ? { ...row, is_private: !!row.is_private } : null;
  }

  countRooms() {
    return this.q.countRooms.get().n;
  }

  createRoom({ id, name, isPrivate, salt, hash }) {
    const now = Date.now();
    this.q.insertRoom.run(id, name, isPrivate ? 1 : 0, salt ?? null, hash ?? null, now, now);
  }

  touchRoom(id) {
    this.q.touchRoom.run(Date.now(), id);
  }

  // Удаляет пользовательские комнаты, в которые давно никто не заходил.
  deleteStaleRooms(olderThanMs) {
    const ids = this.q.staleRooms.all(MAIN_ROOM, Date.now() - olderThanMs).map((r) => r.id);
    if (!ids.length) return [];
    this.transaction(() => {
      for (const id of ids) {
        this.q.deleteRoom.run(id);
        this.q.deleteRoomPlayers.run(id);
        this.q.deleteRoomRuns.run(id);
        this.q.delKvPrefix.run(`world:${id}`, `emblem:${id}`);
      }
    });
    return ids;
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}

// Хранилище на встроенном SQLite (node:sqlite): переживает перезапуск сервера.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
      CREATE INDEX IF NOT EXISTS runs_score ON runs (score DESC);
    `);
    this.q = {
      getKv: this.db.prepare('SELECT value FROM kv WHERE key = ?'),
      setKv: this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      getPlayer: this.db.prepare('SELECT * FROM players WHERE token = ?'),
      insertPlayer: this.db.prepare('INSERT INTO players (token, id, name, color, last_seen) VALUES (?, ?, ?, ?, ?)'),
      savePlayer: this.db.prepare(`UPDATE players SET name = ?, color = ?, best_score = MAX(best_score, ?),
        total_kills = ?, state = ?, last_seen = ? WHERE token = ?`),
      insertRun: this.db.prepare('INSERT INTO runs (player_id, name, score, kills, wave, ended_at) VALUES (?, ?, ?, ?, ?, ?)'),
      topRuns: this.db.prepare('SELECT name, score, kills, wave, ended_at AS endedAt FROM runs ORDER BY score DESC, id ASC LIMIT ?'),
    };
  }

  getJson(key) {
    const row = this.q.getKv.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setJson(key, value) {
    this.q.setKv.run(key, JSON.stringify(value));
  }

  getPlayer(token) {
    const row = this.q.getPlayer.get(token);
    if (!row) return null;
    return { ...row, state: row.state ? JSON.parse(row.state) : null };
  }

  createPlayer(token, id, name, color) {
    this.q.insertPlayer.run(token, id, name, color, Date.now());
  }

  savePlayer(p) {
    this.q.savePlayer.run(p.name, p.color, p.score, p.totalKills, JSON.stringify(p.persistentState()), Date.now(), p.token);
  }

  addRun(run) {
    this.q.insertRun.run(run.playerId, run.name, run.score, run.kills, run.wave, Date.now());
  }

  topRuns(limit = 10) {
    return this.q.topRuns.all(limit).map((r) => ({ ...r }));
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

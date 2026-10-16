// Комнаты: у каждой свой мир (Game), эмблема и рекорды.
// Миры грузятся из БД при первом входе и выгружаются, когда в них никого нет.

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { SHIP_COLORS, sanitizeName } from '../public/js/shared/constants.js';
import { Game } from './game.js';
import { MAIN_ROOM } from './store.js';

export const ROOM_NAME_MAX = 24;
export const PASSWORD_MAX = 64;
const MAX_ROOMS = 100;
const MAX_CREATES_PER_MINUTE = 10;
const UNLOAD_AFTER_MS = 60_000;
const STALE_ROOM_MS = 7 * 24 * 3600_000;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function sanitizeRoomName(name) {
  return String(name ?? '').replace(/[^\p{L}\p{N} _\-.!?#]/gu, '').replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString('hex');
}

export class RoomManager {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.games = new Map();
    this.memoryRooms = new Map(); // без БД (тесты)
    this.emptySince = new Map();
    this.creates = [];
    if (!store) this.memoryRooms.set(MAIN_ROOM, { id: MAIN_ROOM, name: 'Общий сектор', is_private: false });
  }

  // ---------- пилоты ----------

  // Опознаёт пилота по токену или заводит нового. Имя и цвет берутся из hello.
  identify(hello) {
    const token = typeof hello.token === 'string' && hello.token.length <= 64 ? hello.token : null;
    const name = sanitizeName(hello.name);
    const color = SHIP_COLORS.includes(hello.color) ? hello.color : SHIP_COLORS[0];
    const row = token ? this.store?.getPlayer(token) : null;
    if (row) {
      this.store.updateIdentity(token, name, color);
      return { token, id: row.id, name, color, best: row.best_score, totalKills: row.total_kills };
    }
    const fresh = { token: randomUUID(), id: randomBytes(4).toString('hex'), name, color, best: 0, totalKills: 0 };
    this.store?.createPlayer(fresh.token, fresh.id, name, color);
    return fresh;
  }

  // ---------- комнаты ----------

  room(id) {
    if (typeof id !== 'string' || id.length > 32) return null;
    return this.store ? this.store.getRoom(id) : this.memoryRooms.get(id) ?? null;
  }

  list() {
    const rooms = this.store
      ? this.store.listRooms()
      : [...this.memoryRooms.values()].map((r) => ({ id: r.id, name: r.name, isPrivate: r.is_private }));
    return rooms.map((r) => {
      const game = this.games.get(r.id);
      return { id: r.id, name: r.name, isPrivate: r.isPrivate, online: game?.onlineCount() ?? 0, wave: game?.wave ?? null };
    });
  }

  create({ name, isPrivate, password }) {
    const cleanName = sanitizeRoomName(name);
    if (!cleanName) throw new RoomError('name', 'Введите название комнаты');
    if (isPrivate && (typeof password !== 'string' || password.length < 1 || password.length > PASSWORD_MAX)) {
      throw new RoomError('password', `Пароль: от 1 до ${PASSWORD_MAX} символов`);
    }
    const now = this.now();
    this.creates = this.creates.filter((t) => now - t < 60_000);
    if (this.creates.length >= MAX_CREATES_PER_MINUTE) throw new RoomError('rate', 'Слишком много новых комнат, попробуйте через минуту');
    const count = this.store ? this.store.countRooms() : this.memoryRooms.size;
    if (count >= MAX_ROOMS) throw new RoomError('full', 'Достигнут предел числа комнат');
    this.creates.push(now);

    const id = randomBytes(4).toString('hex');
    const salt = isPrivate ? randomBytes(16).toString('hex') : null;
    const hash = isPrivate ? hashPassword(password, salt) : null;
    if (this.store) this.store.createRoom({ id, name: cleanName, isPrivate: !!isPrivate, salt, hash });
    else this.memoryRooms.set(id, { id, name: cleanName, is_private: !!isPrivate, password_salt: salt, password_hash: hash });
    return { id, name: cleanName, isPrivate: !!isPrivate };
  }

  // Проверяет доступ и возвращает мир комнаты. В приватную пускает по паролю
  // либо если этот пилот уже входил в неё раньше.
  enter(roomId, identity, password) {
    const room = this.room(roomId);
    if (!room) throw new RoomError('notfound', 'Комната не найдена — возможно, её удалили');
    if (room.is_private) {
      const granted = this.store ? this.store.getRoomState(room.id, identity.token).granted : this.memoryGrants?.has(`${room.id}:${identity.token}`);
      if (!granted) {
        if (typeof password !== 'string' || !password) throw new RoomError('password', 'Комната закрыта паролем');
        const expected = Buffer.from(room.password_hash, 'hex');
        const actual = Buffer.from(hashPassword(password.slice(0, PASSWORD_MAX), room.password_salt), 'hex');
        if (!timingSafeEqual(expected, actual)) throw new RoomError('password', 'Неверный пароль');
        if (this.store) this.store.grantRoom(room.id, identity.token);
        else (this.memoryGrants ??= new Set()).add(`${room.id}:${identity.token}`);
      }
    }
    return this.game(room);
  }

  game(room) {
    let game = this.games.get(room.id);
    if (!game) {
      game = new Game({ store: this.store, room: { id: room.id, name: room.name, isPrivate: !!room.is_private }, now: this.now });
      this.games.set(room.id, game);
    }
    this.emptySince.delete(room.id);
    return game;
  }

  // ---------- цикл ----------

  step() {
    const now = this.now();
    for (const [id, game] of this.games) {
      game.step();
      if (game.players.size > 0) {
        this.emptySince.delete(id);
        continue;
      }
      if (!this.emptySince.has(id)) this.emptySince.set(id, now);
      else if (now - this.emptySince.get(id) > UNLOAD_AFTER_MS) {
        game.save();
        this.games.delete(id);
        this.emptySince.delete(id);
      }
    }
  }

  cleanup() {
    if (!this.store) return;
    const loaded = new Set(this.games.keys());
    for (const id of this.store.deleteStaleRooms(STALE_ROOM_MS)) if (loaded.has(id)) this.games.delete(id);
  }

  saveAll() {
    for (const game of this.games.values()) game.save();
  }
}

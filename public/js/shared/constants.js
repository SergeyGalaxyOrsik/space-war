// Общие константы клиента и сервера. Сервер импортирует этот файл напрямую.

export const WORLD_W = 480;
export const WORLD_H = 270;

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const PLAYER_SPEED = 130;
export const PLAYER_MAX_HP = 3;
export const PLAYER_MAX_X = Math.round(WORLD_W * 0.62);
export const PLAYER_RADIUS = 6;
export const FIRE_COOLDOWN = 0.16;
export const BULLET_SPEED = 320;
export const RESPAWN_SECONDS = 3;
export const INVULN_SECONDS = 1.5;
export const SHIELD_SECONDS = 8;
export const MAX_WEAPON_LEVEL = 3;

// Сколько корабль отключившегося игрока остаётся в мире «призраком».
export const OFFLINE_GRACE_MS = 90_000;

export const KEY = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16 };

export const SHIP_COLORS = ['#41a6f6', '#38b764', '#ffcd75', '#ef7d57', '#b13e53', '#a7f070', '#f4f4f4', '#c08cff'];

export const EMBLEM_SIZE = 16;

// Палитра PICO-8 — используется для эмблемы эскадрильи.
export const PALETTE = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
];

export const NAME_MAX = 14;

export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, NAME_MAX);
  return clean || 'Пилот';
}

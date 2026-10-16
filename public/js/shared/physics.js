// Детерминированное движение корабля: одна и та же функция работает
// на сервере (авторитетно) и на клиенте (предсказание + сверка).

import { DT, KEY, PLAYER_SPEED, PLAYER_MAX_X, WORLD_H } from './constants.js';

const DIAG = Math.SQRT1_2;

export function applyMovement(ship, keys) {
  let dx = 0;
  let dy = 0;
  if (keys & KEY.LEFT) dx -= 1;
  if (keys & KEY.RIGHT) dx += 1;
  if (keys & KEY.UP) dy -= 1;
  if (keys & KEY.DOWN) dy += 1;
  if (dx && dy) {
    dx *= DIAG;
    dy *= DIAG;
  }
  ship.x = clamp(ship.x + dx * PLAYER_SPEED * DT, 8, PLAYER_MAX_X);
  ship.y = clamp(ship.y + dy * PLAYER_SPEED * DT, 10, WORLD_H - 10);
  // Округляем, чтобы клиент и сервер не расходились из-за накопления ошибки.
  ship.x = Math.round(ship.x * 100) / 100;
  ship.y = Math.round(ship.y * 100) / 100;
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

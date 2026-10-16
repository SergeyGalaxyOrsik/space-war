// Личность игрока — секретный токен, который сервер выдаёт при первом входе.
// Токены хранятся в localStorage, поэтому прогресс переживает закрытие браузера.
// Чтобы две вкладки одного браузера были разными пилотами, вкладка захватывает
// токен через Web Locks API: занятый токен другая вкладка не возьмёт.

import { load, save, sessionLoad, sessionSave } from './storage.js';

const LIST_KEY = 'tokens';

function tryLock(token) {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request(`pss-token-${token}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise(() => {}); // держим замок, пока открыта вкладка
    });
  });
}

export async function acquireToken() {
  const own = sessionLoad('token');
  const tokens = load(LIST_KEY, []).filter((t) => typeof t === 'string');
  const ordered = own ? [own, ...tokens.filter((t) => t !== own)] : tokens;
  for (const token of ordered) {
    if (await tryLock(token)) {
      sessionSave('token', token);
      return token;
    }
  }
  return null;
}

export async function adoptToken(token) {
  const tokens = load(LIST_KEY, []);
  if (!tokens.includes(token)) save(LIST_KEY, [...tokens, token].slice(-8));
  sessionSave('token', token);
  await tryLock(token);
}

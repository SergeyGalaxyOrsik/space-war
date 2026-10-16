// Сборка для статического хостинга (Vercel): записывает адрес игрового сервера
// из переменной окружения GAME_SERVER_URL в public/config.js.

import { writeFileSync } from 'node:fs';

const url = (process.env.GAME_SERVER_URL ?? '').trim().replace(/\/+$/, '');
if (url && !/^https?:\/\//.test(url)) {
  console.error('GAME_SERVER_URL должен начинаться с http:// или https://');
  process.exit(1);
}
writeFileSync(
  new URL('../public/config.js', import.meta.url),
  `// Сгенерировано scripts/write-config.js. Пусто — сервер на том же домене.\nwindow.PSS_SERVER = ${JSON.stringify(url)};\n`,
);
console.log(url ? `Игровой сервер: ${url}` : 'Игровой сервер: тот же домен');

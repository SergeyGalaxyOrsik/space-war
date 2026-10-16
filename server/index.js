// HTTP-сервер статики + WebSocket-сервер игры на одном порту.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { TICK_MS } from '../public/js/shared/constants.js';
import { Game } from './game.js';
import { Store } from './store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const HELLO_TIMEOUT_MS = 5000;
const MAX_MESSAGES_PER_SECOND = 120;
const MAX_BUFFERED_BYTES = 1 << 20;

export function startServer({ port = 3000, host = '0.0.0.0', dbFile = join(ROOT, 'data', 'game.db') } = {}) {
  const store = new Store(dbFile);
  const game = new Game({ store });

  const server = createServer((req, res) => serveStatic(req, res, game));
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  let closing = false;

  wss.on('connection', (ws) => {
    let player = null;
    let messages = 0;
    let windowStart = Date.now();
    ws.isAlive = true;

    const conn = {
      send(msg) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Медленному клиенту не копим очередь снимков — следующий всё равно свежее.
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
        ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };

    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), HELLO_TIMEOUT_MS);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        messages = 0;
      }
      if (++messages > MAX_MESSAGES_PER_SECOND) {
        ws.close(4008, 'rate limit');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!player) {
        if (msg?.t !== 'hello') return;
        clearTimeout(helloTimer);
        player = game.join(conn, msg);
        return;
      }
      game.handle(player, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (player && !closing) game.leave(player, conn);
    });
    ws.on('error', () => {});
  });

  // Обрывы без закрытия TCP (пропал Wi-Fi) находим по ping/pong протокола WebSocket.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 5000);

  // Фиксированный шаг симуляции с компенсацией дрейфа таймера.
  let next = performance.now();
  let loop;
  const scheduleTick = () => {
    const now = performance.now();
    let steps = 0;
    while (now >= next && steps < 5) {
      game.step();
      next += TICK_MS;
      steps++;
    }
    if (now - next > TICK_MS * 5) next = now;
    loop = setTimeout(scheduleTick, Math.max(0, next - performance.now()));
  };
  scheduleTick();

  server.listen(port, host);

  const close = () =>
    new Promise((done) => {
      closing = true;
      clearTimeout(loop);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => {
        game.save();
        store.close();
        done();
      });
    });

  return { server, wss, game, store, close };
}

async function serveStatic(req, res, game) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: game.onlineCount(), wave: game.wave }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(PUBLIC_DIR, '.' + normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = startServer({ port, dbFile: process.env.DB_FILE || undefined });
  app.server.on('listening', () => console.log(`Pixel Space Shooter: http://localhost:${port}`));
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

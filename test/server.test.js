import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startServer } from '../server/index.js';

let app;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pss-'));
  app = startServer({ port: 0, host: '127.0.0.1', dbFile: join(dir, 'game.db') });
  await new Promise((r) => app.server.once('listening', r));
  base = `127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  };
  const opened = new Promise((r) => (ws.onopen = r));
  return {
    ws,
    opened,
    send: (m) => ws.send(JSON.stringify(m)),
    wait(match, ms = 3000) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error('timeout')), ms);
      });
    },
  };
}

test('отдаёт статику и health', async () => {
  const html = await fetch(`http://${base}/`).then((r) => r.text());
  assert.match(html, /SPACE WAR/);
  const shared = await fetch(`http://${base}/js/shared/constants.js`);
  assert.equal(shared.status, 200);
  const escape = await fetch(`http://${base}/..%2fpackage.json`);
  assert.notEqual(escape.status, 200);
  assert.equal((await fetch(`http://${base}/health`).then((r) => r.json())).ok, true);
});

test('API комнат: список, создание, ошибки', async () => {
  const list = await fetch(`http://${base}/api/rooms`).then((r) => r.json());
  assert.equal(list.rooms[0].id, 'main');
  const bad = await fetch(`http://${base}/api/rooms`, { method: 'POST', body: '{"name":""}' });
  assert.equal(bad.status, 400);
  const res = await fetch(`http://${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Приват', isPrivate: true, password: 'secret' }),
  });
  assert.equal(res.status, 201);
  const { room } = await res.json();

  const c = client();
  await c.opened;
  c.send({ t: 'hello', name: 'Guest', room: room.id, password: 'nope' });
  const denied = await c.wait((m) => m.t === 'denied');
  assert.equal(denied.code, 'password');

  const ok = client();
  await ok.opened;
  ok.send({ t: 'hello', token: denied.token, name: 'Guest', room: room.id, password: 'secret' });
  const welcome = await ok.wait((m) => m.t === 'welcome');
  assert.equal(welcome.room.id, room.id);
  assert.equal(welcome.room.isPrivate, true);
  ok.ws.close();

  // Тот же пилот возвращается без пароля.
  const back = client();
  await back.opened;
  back.send({ t: 'hello', token: denied.token, room: room.id });
  assert.equal((await back.wait((m) => m.t === 'welcome')).room.id, room.id);
  back.ws.close();
});

test('два игрока видят друг друга и правки эмблемы в реальном времени', async () => {
  const a = client();
  const b = client();
  await Promise.all([a.opened, b.opened]);
  a.send({ t: 'hello', name: 'Alpha' });
  const wa = await a.wait((m) => m.t === 'welcome');
  b.send({ t: 'hello', name: 'Bravo' });
  const wb = await b.wait((m) => m.t === 'welcome');

  const snap = await a.wait((m) => m.t === 's' && m.p.some((p) => p[0] === wb.id));
  assert.ok(snap.p.some((p) => p[0] === wa.id));

  a.send({ t: 'paint', ops: [{ i: 5, c: 9, t: wa.emblem.lamport + 1 }] });
  const painted = await b.wait((m) => m.t === 'paint' && m.ops.some((o) => o.i === 5));
  assert.equal(painted.ops[0].by, wa.id);

  // Переподключение с тем же токеном возвращает того же игрока.
  a.ws.close();
  await b.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === wa.id && !p.online));
  const a2 = client();
  await a2.opened;
  a2.send({ t: 'hello', token: wa.token });
  const again = await a2.wait((m) => m.t === 'welcome');
  assert.equal(again.id, wa.id);
  assert.equal(again.emblem.cells[5].c, 9);
  a2.ws.close();
  b.ws.close();
});

import { isMuted, sfx, toggleMute } from './audio.js';
import { EmblemEditor } from './emblem-editor.js';
import { acquireToken, adoptToken } from './identity.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Renderer } from './render.js';
import { SHIP_COLORS, TICK_MS, sanitizeName } from './shared/constants.js';
import { load, save } from './storage.js';
import { World } from './world.js';

const $ = (sel) => document.querySelector(sel);

const canvas = $('#game');
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const world = new World();
const roster = new Map();
const emblem = new EmblemEditor({
  canvas: $('#emblem'),
  palette: $('#palette'),
  info: $('#emblem-info'),
  notice: $('#emblem-notice'),
});
emblem.addEventListener('change', (e) => renderer.setEmblem(e.detail));
renderer.setEmblem(emblem.view.cells);

let profile = load('profile', null);
let token = null;
let net = null;

// ---------- профиль ----------

const joinDialog = $('#join');
const nameInput = $('#name');
const colorsRoot = $('#colors');
let chosenColor = profile?.color ?? SHIP_COLORS[Math.floor(Math.random() * SHIP_COLORS.length)];

colorsRoot.replaceChildren(
  ...SHIP_COLORS.map((color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch ship';
    btn.style.background = color;
    btn.setAttribute('aria-label', color);
    btn.addEventListener('click', () => {
      chosenColor = color;
      markColor();
    });
    return btn;
  }),
);
function markColor() {
  [...colorsRoot.children].forEach((el, i) => el.classList.toggle('active', SHIP_COLORS[i] === chosenColor));
}

function openProfile() {
  nameInput.value = profile?.name ?? '';
  markColor();
  joinDialog.hidden = false;
  nameInput.focus();
}

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  profile = { name: sanitizeName(nameInput.value), color: chosenColor };
  save('profile', profile);
  joinDialog.hidden = true;
  $('#pilot-name').textContent = profile.name;
  if (net) net.send({ t: 'profile', ...profile });
  else start();
});
$('#edit-profile').addEventListener('click', openProfile);

// ---------- звук ----------

const muteBtn = $('#mute');
const renderMute = () => {
  muteBtn.textContent = isMuted() ? 'Звук: выкл' : 'Звук: вкл';
};
muteBtn.addEventListener('click', () => {
  toggleMute();
  renderMute();
});
renderMute();

// ---------- сеть ----------

async function start() {
  $('#pilot-name').textContent = profile.name;
  token = await acquireToken();
  net = new Net({ getHello: () => ({ t: 'hello', token, name: profile.name, color: profile.color }) });
  emblem.send = (msg) => net.send(msg);
  net.addEventListener('status', (e) => onStatus(e.detail));
  net.addEventListener('message', (e) => onMessage(e.detail));
  net.connect();
}

let lastSavedAt = 0;

function onMessage(msg) {
  switch (msg.t) {
    case 's': {
      const snap = world.push(msg);
      for (const ev of snap.events) handleEvent(ev);
      const now = performance.now();
      if (now - lastSavedAt > 1000) {
        lastSavedAt = now;
        save('last', { id: world.myId, raw: msg, roster: [...roster.values()], at: Date.now() });
      }
      break;
    }
    case 'welcome':
      if (msg.token !== token) {
        token = msg.token;
        adoptToken(token);
      }
      world.myId = msg.id;
      world.reset();
      setRoster(msg.roster);
      setLeaderboard(msg.leaderboard);
      emblem.welcome(msg.id, msg.emblem);
      break;
    case 'roster':
      setRoster(msg.players);
      break;
    case 'leaderboard':
      setLeaderboard(msg.top);
      break;
    case 'paint':
      emblem.remote(msg.ops, msg.lamport);
      break;
    case 'paintReject':
      emblem.rejected(msg.cells, msg.winners);
      break;
    case 'ping':
      net.send({ t: 'pong', ts: msg.ts });
      break;
    case 'kicked':
      $('#kicked-reason').textContent = msg.reason;
      break;
  }
}

function handleEvent(ev) {
  renderer.event(ev, world.myId);
  switch (ev.k) {
    case 'shot':
      if (ev.id === world.myId) sfx.shot();
      break;
    case 'boom':
      sfx.boom(ev.s >= 12);
      break;
    case 'hurt':
      if (ev.id === world.myId) sfx.hurt();
      break;
    case 'pick':
      if (ev.id === world.myId) sfx.pick();
      break;
    case 'wave':
      sfx.wave();
      break;
    case 'feed':
      addFeed(ev.m);
      break;
  }
}

function onStatus(state) {
  world.frozen = state !== 'online';
  const badge = $('#status');
  badge.dataset.state = state;
  badge.textContent = { connecting: 'Подключение…', online: 'В сети', offline: 'Нет связи', kicked: 'Отключено' }[state] ?? state;
  $('#offline').hidden = state !== 'offline' && state !== 'connecting';
  $('#kicked').hidden = state !== 'kicked';
  if (state === 'online') addFeed('Связь установлена');
}

setInterval(() => {
  if (!net || net.state !== 'offline') {
    $('#retry-in').textContent = net?.state === 'connecting' ? 'Подключаемся…' : '';
    return;
  }
  const sec = Math.max(0, Math.ceil((net.retryAt - performance.now()) / 1000));
  const reason = navigator.onLine ? '' : ' Интернет недоступен.';
  $('#retry-in').textContent = `Повтор через ${sec} с (попытка ${net.attempt}).${reason}`;
}, 250);
$('#retry').addEventListener('click', () => net?.reconnectNow());
$('#reclaim').addEventListener('click', () => net?.reconnectNow());

// ---------- панели ----------

function setRoster(players) {
  roster.clear();
  for (const p of players) roster.set(p.id, p);
  emblem.names = new Map(players.map((p) => [p.id, p.name]));
  const list = $('#roster');
  list.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement('li');
      li.className = p.online ? '' : 'off';
      if (p.id === world.myId) li.classList.add('me');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = p.online ? `${p.score} · ${p.ping}мс` : `${p.score} · нет связи`;
      li.append(dot, name, meta);
      return li;
    }),
  );
  $('#online-count').textContent = players.filter((p) => p.online).length;
}

function setLeaderboard(top) {
  const list = $('#leaderboard');
  if (!top.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Пока пусто — станьте первым';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...top.map((r) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${r.score} · в${r.wave}`;
      li.append(name, meta);
      return li;
    }),
  );
}

function addFeed(text) {
  const list = $('#feed');
  const li = document.createElement('li');
  li.textContent = text;
  list.prepend(li);
  while (list.children.length > 8) list.lastChild.remove();
}

// ---------- игровой цикл ----------

let last = performance.now();
let acc = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * 1000;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    if (net?.online) {
      const inp = world.localInput(input.read(world.me));
      if (inp) net.send({ t: 'in', s: inp.s, k: inp.k });
    }
  }
  if (acc > TICK_MS * 4) acc = 0;
  world.advance(now);
  renderer.draw(world.frame(), { dt, roster, status: net?.state ?? 'idle', myName: profile?.name });
  requestAnimationFrame(frame);
}

// ---------- старт ----------

// Последнее известное состояние: показываем его сразу, даже если сервер недоступен.
const lastState = load('last', null);
if (lastState?.raw) {
  try {
    world.myId = lastState.id;
    world.push(lastState.raw);
    world.renderTick = lastState.raw.n;
    world.frozen = true;
    setRoster(lastState.roster ?? []);
  } catch {
    world.reset();
  }
}

requestAnimationFrame(frame);
if (profile) start();
else openProfile();

// Для отладки из консоли браузера.
window.__pss = { world, roster, input, get net() { return net; } };

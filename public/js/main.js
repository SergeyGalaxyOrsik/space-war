import { isMuted, sfx, toggleMute } from './audio.js';
import { EmblemEditor } from './emblem-editor.js';
import { acquireToken, adoptToken } from './identity.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Renderer } from './render.js';
import { SHIP_COLORS, TICK_MS, sanitizeName } from './shared/constants.js';
import { load, save, sessionLoad, sessionSave } from './storage.js';
import { World } from './world.js';

const $ = (sel) => document.querySelector(sel);

const canvas = $('#game');
const screenEl = $('#screen');
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
let chosenColor = profile?.color ?? SHIP_COLORS[Math.floor(Math.random() * SHIP_COLORS.length)];
let token = null;
let currentRoom = null; // { id, name }
let joinPassword = null;
let promptRoom = null; // комната, для которой открыто поле пароля
let focusPrompt = false;

const net = new Net({
  getHello: () => ({
    t: 'hello',
    token,
    name: profile?.name,
    color: profile?.color,
    room: currentRoom?.id,
    password: joinPassword ?? undefined,
  }),
});
emblem.send = (msg) => net.send(msg);
net.addEventListener('status', (e) => onStatus(e.detail));
net.addEventListener('message', (e) => onMessage(e.detail));

// ---------- профиль ----------

const nameInput = $('#name');
nameInput.value = profile?.name ?? '';
const colorsRoot = $('#colors');
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
      saveProfile();
    });
    return btn;
  }),
);
function markColor() {
  [...colorsRoot.children].forEach((el, i) => el.classList.toggle('active', SHIP_COLORS[i] === chosenColor));
}
markColor();
nameInput.addEventListener('change', saveProfile);

function saveProfile() {
  profile = { name: sanitizeName(nameInput.value), color: chosenColor };
  save('profile', profile);
}

// ---------- лобби ----------

const lobbyEl = $('#lobby');
const gameEl = $('#game-view');
const lobbyError = $('#lobby-error');
let rooms = [];

function showLobby(error) {
  lobbyEl.hidden = false;
  gameEl.hidden = true;
  $('#to-lobby').hidden = true;
  $('#room-label').hidden = true;
  lobbyError.hidden = !error;
  lobbyError.textContent = error ?? '';
  refreshRooms();
}

function showGame() {
  lobbyEl.hidden = true;
  gameEl.hidden = false;
  $('#to-lobby').hidden = false;
}

async function refreshRooms() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    rooms = (await res.json()).rooms;
    renderRooms();
  } catch {
    // нет связи — оставляем прошлый список
  }
}
setInterval(() => {
  if (!lobbyEl.hidden && document.visibilityState === 'visible') refreshRooms();
}, 4000);
$('#refresh-rooms').addEventListener('click', refreshRooms);

function renderRooms() {
  const list = $('#rooms');
  if (!rooms.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Комнат пока нет';
    list.replaceChildren(li);
    return;
  }
  // Список обновляется по таймеру — не теряем пароль, который человек сейчас вводит.
  const typing = list.querySelector('.password-row input');
  const draft = typing?.value ?? '';
  const focused = typing && document.activeElement === typing;
  list.replaceChildren(...rooms.map(roomItem));
  const fresh = list.querySelector('.password-row input');
  if (fresh) {
    fresh.value = draft;
    if (focused || focusPrompt) fresh.focus();
    focusPrompt = false;
  }
}

function roomItem(room) {
  const li = document.createElement('li');
  li.className = 'room';
  if (room.id === promptRoom) li.classList.add('open');

  const title = document.createElement('div');
  title.className = 'room-title';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = room.name;
  const badge = document.createElement('span');
  badge.className = room.isPrivate ? 'tag private' : 'tag';
  badge.textContent = room.isPrivate ? 'приватная' : 'публичная';
  title.append(name, badge);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${room.online} в игре${room.wave ? ` · волна ${room.wave}` : ''}`;

  const join = document.createElement('button');
  join.type = 'button';
  join.className = 'btn small';
  join.textContent = 'Войти';
  join.addEventListener('click', () => {
    // Сначала пробуем без пароля: если пилот уже бывал в комнате, сервер пустит.
    enterRoom(room, null);
  });

  li.append(title, meta, join);

  if (room.id === promptRoom) {
    const form = document.createElement('form');
    form.className = 'password-row';
    const pass = document.createElement('input');
    pass.type = 'password';
    pass.placeholder = 'Пароль комнаты';
    pass.maxLength = 64;
    pass.autocomplete = 'current-password';
    pass.required = true;
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'btn small';
    ok.textContent = 'OK';
    form.append(pass, ok);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      enterRoom(room, pass.value);
    });
    li.append(form);
  }
  return li;
}

const passwordField = $('#room-password-field');
document.querySelectorAll('input[name="visibility"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    passwordField.hidden = $('input[name="visibility"]:checked').value !== 'private';
    $('#room-password').required = !passwordField.hidden;
  });
});

$('#create-room').addEventListener('submit', async (e) => {
  e.preventDefault();
  const isPrivate = $('input[name="visibility"]:checked').value === 'private';
  const password = $('#room-password').value;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('#room-name').value, isPrivate, password: isPrivate ? password : undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Не удалось создать комнату');
    e.target.reset();
    passwordField.hidden = true;
    enterRoom(data.room, isPrivate ? password : null);
  } catch (err) {
    lobbyError.textContent = err.message === 'Failed to fetch' ? 'Нет связи с сервером' : err.message;
    lobbyError.hidden = false;
  }
});

// ---------- вход и выход ----------

function enterRoom(room, password) {
  saveProfile();
  currentRoom = { id: room.id, name: room.name ?? '' };
  joinPassword = password || null;
  promptRoom = null;
  world.myId = null;
  world.reset();
  roster.clear();
  setRoster([]);
  setLeaderboard([]);
  $('#feed').replaceChildren();
  emblem.setRoom(room.id);
  restoreLastState(room.id);
  setRoomLabel();
  showGame();
  net.open();
}

function leaveRoom(error) {
  net.close();
  exitFullscreen();
  currentRoom = null;
  joinPassword = null;
  sessionSave('room', '');
  history.replaceState(null, '', location.pathname);
  showLobby(error);
}
$('#to-lobby').addEventListener('click', () => leaveRoom());

function setRoomLabel() {
  const label = $('#room-label');
  label.hidden = !currentRoom;
  label.textContent = currentRoom ? currentRoom.name : '';
}

// Последнее известное состояние комнаты: показываем сразу, даже если сервер недоступен.
function restoreLastState(roomId) {
  const last = load(`last.${roomId}`, null);
  if (!last?.raw) return;
  try {
    world.myId = last.id;
    world.push(last.raw);
    world.renderTick = last.raw.n;
    world.frozen = true;
    setRoster(last.roster ?? []);
  } catch {
    world.reset();
  }
}

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

// ---------- сообщения сервера ----------

let lastSavedAt = 0;

function onMessage(msg) {
  switch (msg.t) {
    case 's': {
      const snap = world.push(msg);
      for (const ev of snap.events) handleEvent(ev);
      const now = performance.now();
      if (currentRoom && now - lastSavedAt > 1000) {
        lastSavedAt = now;
        save(`last.${currentRoom.id}`, { id: world.myId, raw: msg, roster: [...roster.values()], at: Date.now() });
      }
      break;
    }
    case 'welcome':
      adopt(msg.token);
      currentRoom = msg.room;
      joinPassword = null;
      sessionSave('room', msg.room.id);
      history.replaceState(null, '', `#room=${encodeURIComponent(msg.room.id)}`);
      setRoomLabel();
      world.myId = msg.id;
      world.reset();
      setRoster(msg.roster);
      setLeaderboard(msg.leaderboard);
      emblem.welcome(msg.id, msg.emblem);
      break;
    case 'denied': {
      adopt(msg.token);
      const roomId = currentRoom?.id;
      leaveRoom(msg.message);
      if (msg.code === 'password') {
        promptRoom = roomId;
        focusPrompt = true;
        renderRooms();
      }
      break;
    }
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

function adopt(newToken) {
  if (newToken && newToken !== token) {
    token = newToken;
    adoptToken(token);
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
  badge.textContent = {
    idle: 'Лобби', connecting: 'Подключение…', online: 'В сети', offline: 'Нет связи', kicked: 'Отключено', denied: 'Нет доступа',
  }[state] ?? state;
  $('#offline').hidden = state !== 'offline' && state !== 'connecting';
  $('#kicked').hidden = state !== 'kicked';
  if (state === 'online') addFeed('Связь установлена');
}

setInterval(() => {
  if (net.state !== 'offline') {
    $('#retry-in').textContent = net.state === 'connecting' ? 'Подключаемся…' : '';
    return;
  }
  const sec = Math.max(0, Math.ceil((net.retryAt - performance.now()) / 1000));
  const reason = navigator.onLine ? '' : ' Интернет недоступен.';
  $('#retry-in').textContent = `Повтор через ${sec} с (попытка ${net.attempt}).${reason}`;
}, 250);
$('#retry').addEventListener('click', () => net.reconnectNow());
$('#reclaim').addEventListener('click', () => net.reconnectNow());

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

// ---------- полный экран ----------
// Fullscreen API там, где он есть (Android, десктоп, iPad); на iPhone Safari
// его для обычных элементов нет — растягиваем поле стилями поверх страницы.

const nativeFsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

function isFullscreen() {
  return nativeFsElement() === screenEl || screenEl.classList.contains('pseudo-fs');
}

async function enterFullscreen() {
  const request = screenEl.requestFullscreen ?? screenEl.webkitRequestFullscreen;
  if (request) {
    try {
      await request.call(screenEl, { navigationUI: 'hide' });
      await screen.orientation?.lock?.('landscape').catch(() => {});
      return;
    } catch {
      // браузер отказал — используем запасной вариант
    }
  }
  screenEl.classList.add('pseudo-fs');
  document.body.classList.add('no-scroll');
  syncFullscreen();
}

function exitFullscreen() {
  if (nativeFsElement()) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  screenEl.classList.remove('pseudo-fs');
  document.body.classList.remove('no-scroll');
  screen.orientation?.unlock?.();
  syncFullscreen();
}

function syncFullscreen() {
  const on = isFullscreen();
  screenEl.classList.toggle('is-fs', on);
  const btn = $('#fullscreen');
  btn.setAttribute('aria-label', on ? 'Выйти из полноэкранного режима' : 'На весь экран');
  btn.title = btn.getAttribute('aria-label');
  btn.classList.toggle('active', on);
}

$('#fullscreen').addEventListener('click', () => (isFullscreen() ? exitFullscreen() : enterFullscreen()));
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && screenEl.classList.contains('pseudo-fs')) exitFullscreen();
});

// ---------- игровой цикл ----------

let last = performance.now();
let acc = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * 1000;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    if (net.online) {
      const inp = world.localInput(input.read(world.me));
      if (inp) net.send({ t: 'in', s: inp.s, k: inp.k });
    }
  }
  if (acc > TICK_MS * 4) acc = 0;
  if (!gameEl.hidden) {
    world.advance(now);
    renderer.draw(world.frame(), { dt, roster, status: net.state, roomName: currentRoom?.name });
  }
  requestAnimationFrame(frame);
}

// ---------- старт ----------

// Комната из ссылки (#room=…) или та, в которой вкладка была до перезагрузки.
function roomFromUrl() {
  const match = /room=([^&]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

async function boot() {
  token = await acquireToken();
  requestAnimationFrame(frame);
  const target = roomFromUrl() || sessionLoad('room');
  if (target && profile) {
    enterRoom({ id: target, name: '' }, null);
  } else {
    showLobby();
    if (!profile) nameInput.focus();
  }
}

boot();

// Для отладки из консоли браузера.
window.__pss = { world, roster, input, net };

// Редактор общей эмблемы эскадрильи.
// Правки применяются сразу (оптимистично) и копятся в очереди pending,
// пока сервер их не подтвердит. Очередь лежит в localStorage, поэтому
// рисовать можно и без связи — правки уйдут после переподключения.

import { EMBLEM_SIZE, PALETTE } from './shared/constants.js';
import { applyOp, cloneEmblem, createEmblem, isNewer } from './shared/emblem.js';
import { load, save } from './storage.js';

const CELL = 12;
const BATCH = 200;

export class EmblemEditor extends EventTarget {
  constructor({ canvas, palette, info, notice }) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    canvas.width = EMBLEM_SIZE * CELL;
    canvas.height = EMBLEM_SIZE * CELL;
    this.info = info;
    this.notice = notice;
    this.send = () => false;
    this.myId = null;
    this.names = new Map();

    const cached = load('emblem', null);
    this.confirmed = cached?.cells?.length === EMBLEM_SIZE * EMBLEM_SIZE ? cached : createEmblem();
    this.pending = load('emblemPending', []).map((op) => ({ ...op, sent: false }));
    this.lamport = Math.max(this.confirmed.lamport, ...this.pending.map((op) => op.t), 0);
    this.color = load('emblemColor', 8);
    this.flash = new Map();
    this.hover = -1;
    this.drawing = false;

    this.buildPalette(palette);
    this.bindPointer();
    this.rebuild();
    requestAnimationFrame(() => this.loop());
  }

  buildPalette(root) {
    root.replaceChildren(
      ...PALETTE.map((hex, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch';
        btn.style.background = hex;
        btn.title = hex;
        btn.setAttribute('aria-label', `Цвет ${idx + 1}`);
        btn.addEventListener('click', () => this.pick(idx));
        return btn;
      }),
    );
    this.swatches = [...root.children];
    this.pick(this.color);
  }

  pick(idx) {
    this.color = idx;
    save('emblemColor', idx);
    this.swatches.forEach((el, i) => el.classList.toggle('active', i === idx));
  }

  bindPointer() {
    const cellAt = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * EMBLEM_SIZE);
      const y = Math.floor(((e.clientY - r.top) / r.height) * EMBLEM_SIZE);
      return x >= 0 && y >= 0 && x < EMBLEM_SIZE && y < EMBLEM_SIZE ? y * EMBLEM_SIZE + x : -1;
    };
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      const i = cellAt(e);
      if (i < 0) return;
      if (e.button === 2) {
        this.pick(this.view.cells[i].c); // пипетка
        return;
      }
      this.drawing = true;
      this.lastCell = i;
      this.canvas.setPointerCapture(e.pointerId);
      this.paint(i);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const i = cellAt(e);
      this.hover = i;
      this.updateInfo();
      if (this.drawing && i >= 0) {
        // Быстрое движение мыши пропускает клетки — дорисовываем отрезок.
        for (const cell of line(this.lastCell, i)) this.paint(cell);
        this.lastCell = i;
      }
    });
    const stop = () => {
      this.drawing = false;
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.updateInfo();
    });
  }

  paint(i) {
    if (this.view.cells[i].c === this.color) return;
    this.lamport = Math.max(this.lamport, this.confirmed.lamport) + 1;
    this.pending.push({ i, c: this.color, t: this.lamport, by: this.myId ?? '~', sent: false });
    this.persist();
    this.rebuild();
    queueMicrotask(() => this.flush());
  }

  flush() {
    const unsent = this.pending.filter((op) => !op.sent);
    for (let start = 0; start < unsent.length; start += BATCH) {
      const chunk = unsent.slice(start, start + BATCH);
      if (!this.send({ t: 'paint', ops: chunk.map(({ i, c, t }) => ({ i, c, t })) })) return;
      chunk.forEach((op) => {
        op.sent = true;
      });
    }
  }

  // ---------- события сервера ----------

  welcome(myId, emblem) {
    this.myId = myId;
    this.confirmed = emblem;
    this.lamport = Math.max(this.lamport, emblem.lamport);
    // Всё неподтверждённое (в т.ч. нарисованное офлайн) отправляем заново.
    this.pending.forEach((op) => {
      op.by = myId;
      op.sent = false;
    });
    this.persist();
    this.rebuild();
    this.flush();
  }

  remote(ops, lamport) {
    for (const op of ops) {
      applyOp(this.confirmed, op);
      if (op.by === this.myId) this.pending = this.pending.filter((p) => !(p.i === op.i && p.t === op.t));
      else this.flash.set(op.i, performance.now());
    }
    this.lamport = Math.max(this.lamport, lamport ?? 0);
    this.persist();
    this.rebuild();
  }

  // Сервер отклонил правки: в клетке уже лежит более новая чужая правка.
  rejected(cells, winners) {
    let conflicts = 0;
    for (const cell of cells) {
      const ownDuplicate = cell.by === this.myId && this.pending.some((p) => p.i === cell.i && p.t === cell.t);
      if (!ownDuplicate) conflicts++;
      this.confirmed.cells[cell.i] = { c: cell.c, t: cell.t, by: cell.by };
      this.pending = this.pending.filter((p) => p.i !== cell.i || isNewer(p, cell));
      this.flash.set(cell.i, performance.now());
    }
    if (conflicts) {
      const who = winners?.length ? winners.join(', ') : 'другой пилот';
      this.say(`Конфликт: ${conflicts} кл. уже изменил(а) ${who} позже вас — оставлена его версия`);
    }
    this.persist();
    this.rebuild();
  }

  // ---------- вид ----------

  rebuild() {
    const view = cloneEmblem(this.confirmed);
    for (const op of this.pending) applyOp(view, op);
    this.view = view;
    this.dispatchEvent(new CustomEvent('change', { detail: view.cells }));
    this.updateInfo();
  }

  persist() {
    save('emblem', this.confirmed);
    save('emblemPending', this.pending.map(({ i, c, t, by }) => ({ i, c, t, by })));
  }

  say(text) {
    this.notice.textContent = text;
    this.notice.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice.hidden = true;
    }, 5000);
  }

  updateInfo() {
    const pending = this.pending.length ? ` · не отправлено: ${this.pending.length}` : '';
    if (this.hover < 0) {
      this.info.textContent = `ЛКМ — рисовать, ПКМ — пипетка${pending}`;
      return;
    }
    const cell = this.view.cells[this.hover];
    const x = this.hover % EMBLEM_SIZE;
    const y = Math.floor(this.hover / EMBLEM_SIZE);
    const author = !cell.t ? 'никто' : cell.by === this.myId || cell.by === '~' ? 'вы' : this.names.get(cell.by) ?? cell.by;
    this.info.textContent = `(${x},${y}) автор: ${author}${pending}`;
  }

  loop() {
    const { ctx } = this;
    const now = performance.now();
    this.view.cells.forEach((cell, i) => {
      const x = (i % EMBLEM_SIZE) * CELL;
      const y = Math.floor(i / EMBLEM_SIZE) * CELL;
      ctx.fillStyle = PALETTE[cell.c];
      ctx.fillRect(x, y, CELL, CELL);
      const flashed = this.flash.get(i);
      if (flashed && now - flashed < 900) {
        ctx.strokeStyle = `rgba(255, 236, 39, ${1 - (now - flashed) / 900})`;
        ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
      } else if (flashed) {
        this.flash.delete(i);
      }
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let k = 1; k < EMBLEM_SIZE; k++) {
      ctx.beginPath();
      ctx.moveTo(k * CELL + 0.5, 0);
      ctx.lineTo(k * CELL + 0.5, EMBLEM_SIZE * CELL);
      ctx.moveTo(0, k * CELL + 0.5);
      ctx.lineTo(EMBLEM_SIZE * CELL, k * CELL + 0.5);
      ctx.stroke();
    }
    if (this.hover >= 0) {
      ctx.strokeStyle = '#fff1e8';
      ctx.strokeRect((this.hover % EMBLEM_SIZE) * CELL + 0.5, Math.floor(this.hover / EMBLEM_SIZE) * CELL + 0.5, CELL - 1, CELL - 1);
    }
    requestAnimationFrame(() => this.loop());
  }
}

function line(from, to) {
  let x0 = from % EMBLEM_SIZE;
  let y0 = Math.floor(from / EMBLEM_SIZE);
  const x1 = to % EMBLEM_SIZE;
  const y1 = Math.floor(to / EMBLEM_SIZE);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const cells = [];
  for (;;) {
    cells.push(y0 * EMBLEM_SIZE + x0);
    if (x0 === x1 && y0 === y1) return cells;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

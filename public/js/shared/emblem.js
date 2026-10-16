// Эмблема эскадрильи — общий пиксель-арт 16×16, который игроки рисуют одновременно.
//
// Разрешение конфликтов: каждая клетка — LWW-регистр (last-writer-wins) с меткой
// (lamport, author). Правка выигрывает, если её метка больше метки клетки:
// сначала сравниваются часы Лэмпорта, при равенстве — id автора.
// Правка, сделанная после того, как автор увидел чужую, всегда имеет больший
// lamport и поэтому побеждает; по-настоящему одновременные правки упорядочиваются
// по id. Порядок, в котором правки доходят до сервера, на результат не влияет,
// поэтому все участники (и офлайн-правки после переподключения) сходятся к одному состоянию.

import { EMBLEM_SIZE, PALETTE } from './constants.js';

export const CELL_COUNT = EMBLEM_SIZE * EMBLEM_SIZE;

export function createEmblem() {
  const cells = [];
  for (let i = 0; i < CELL_COUNT; i++) cells.push({ c: 0, t: 0, by: '' });
  return { cells, lamport: 0 };
}

export function isNewer(op, cell) {
  if (op.t !== cell.t) return op.t > cell.t;
  return op.by > cell.by;
}

export function isValidOp(op) {
  return (
    op &&
    Number.isInteger(op.i) && op.i >= 0 && op.i < CELL_COUNT &&
    Number.isInteger(op.c) && op.c >= 0 && op.c < PALETTE.length &&
    Number.isInteger(op.t) && op.t > 0 && op.t < Number.MAX_SAFE_INTEGER &&
    typeof op.by === 'string' && op.by.length > 0 && op.by.length <= 32
  );
}

// Применяет правку. Возвращает true, если правка победила.
export function applyOp(emblem, op) {
  emblem.lamport = Math.max(emblem.lamport, op.t);
  const cell = emblem.cells[op.i];
  if (!isNewer(op, cell)) return false;
  emblem.cells[op.i] = { c: op.c, t: op.t, by: op.by };
  return true;
}

export function cloneEmblem(emblem) {
  return { lamport: emblem.lamport, cells: emblem.cells.map((cell) => ({ ...cell })) };
}

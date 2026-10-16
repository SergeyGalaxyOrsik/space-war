import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOp, createEmblem } from '../public/js/shared/emblem.js';

function shuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('порядок доставки правок не влияет на итог', () => {
  const ops = [];
  for (let k = 0; k < 300; k++) ops.push({ i: k % 7, c: k % 16, t: 1 + (k % 13), by: ['a', 'b', 'c'][k % 3] });
  const reference = createEmblem();
  ops.forEach((op) => applyOp(reference, op));
  for (let seed = 1; seed < 20; seed++) {
    const replica = createEmblem();
    shuffle(ops, seed).forEach((op) => applyOp(replica, op));
    assert.deepEqual(replica.cells, reference.cells);
  }
});

test('правка, сделанная после чужой, побеждает; одновременные — по id автора', () => {
  const e = createEmblem();
  assert.equal(applyOp(e, { i: 0, c: 3, t: 5, by: 'bob' }), true);
  assert.equal(applyOp(e, { i: 0, c: 4, t: 6, by: 'alice' }), true);
  assert.equal(e.cells[0].c, 4);
  assert.equal(applyOp(e, { i: 0, c: 9, t: 6, by: 'aaa' }), false);
  assert.equal(applyOp(e, { i: 0, c: 9, t: 6, by: 'zed' }), true);
  assert.equal(e.lamport, 6);
});

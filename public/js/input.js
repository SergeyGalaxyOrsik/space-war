// Клавиатура (стрелки/WASD + пробел) и сенсорное управление:
// корабль летит к пальцу и стреляет, пока экран касаются.

import { KEY, WORLD_H, WORLD_W } from './shared/constants.js';

const BINDINGS = {
  ArrowUp: KEY.UP, KeyW: KEY.UP,
  ArrowDown: KEY.DOWN, KeyS: KEY.DOWN,
  ArrowLeft: KEY.LEFT, KeyA: KEY.LEFT,
  ArrowRight: KEY.RIGHT, KeyD: KEY.RIGHT,
  Space: KEY.FIRE, KeyJ: KEY.FIRE, KeyK: KEY.FIRE,
};

export class Input {
  constructor(canvas) {
    this.keys = 0;
    this.touch = null;

    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      const bit = BINDINGS[e.code];
      if (!bit) return;
      e.preventDefault();
      this.keys |= bit;
    });
    window.addEventListener('keyup', (e) => {
      const bit = BINDINGS[e.code];
      if (bit) this.keys &= ~bit;
    });
    window.addEventListener('blur', () => {
      this.keys = 0;
    });

    const toWorld = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * WORLD_W, y: ((e.clientY - r.top) / r.height) * WORLD_H };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      canvas.setPointerCapture(e.pointerId);
      this.touch = toWorld(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.touch && e.pointerType !== 'mouse') this.touch = toWorld(e);
    });
    const end = () => {
      this.touch = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  read(me) {
    let keys = this.keys;
    if (this.touch && me) {
      const dx = this.touch.x - (me.x + 30); // палец чуть правее корабля, чтобы его было видно
      const dy = this.touch.y - me.y;
      if (dx < -3) keys |= KEY.LEFT;
      if (dx > 3) keys |= KEY.RIGHT;
      if (dy < -3) keys |= KEY.UP;
      if (dy > 3) keys |= KEY.DOWN;
      keys |= KEY.FIRE;
    }
    return keys;
  }
}

function isTyping(el) {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

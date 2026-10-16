// Отрисовка мира в низком разрешении; CSS растягивает canvas без сглаживания.

import { PALETTE, PLAYER_MAX_HP, WORLD_H, WORLD_W, EMBLEM_SIZE } from './shared/constants.js';
import { enemySprite, playerSprite, powerupSprite } from './sprites.js';

const FONT = '8px "Press Start 2P", monospace';
const SMALL = '5px "Press Start 2P", monospace';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = WORLD_W;
    canvas.height = WORLD_H;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.particles = [];
    this.flashes = new Map(); // id → время до конца белой вспышки
    this.shake = 0;
    this.banner = null;
    this.stars = Array.from({ length: 90 }, (_, i) => ({
      x: Math.random() * WORLD_W,
      y: Math.random() * WORLD_H,
      layer: i % 3,
    }));
    this.emblemCanvas = document.createElement('canvas');
    this.emblemCanvas.width = EMBLEM_SIZE;
    this.emblemCanvas.height = EMBLEM_SIZE;
  }

  setEmblem(cells) {
    const ctx = this.emblemCanvas.getContext('2d');
    cells.forEach((cell, i) => {
      ctx.fillStyle = PALETTE[cell.c];
      ctx.fillRect(i % EMBLEM_SIZE, Math.floor(i / EMBLEM_SIZE), 1, 1);
    });
  }

  event(ev, myId) {
    switch (ev.k) {
      case 'boom':
        this.explode(ev.x, ev.y, ev.s);
        if (ev.s >= 12) this.shake = Math.max(this.shake, ev.id === myId || ev.s > 15 ? 6 : 2);
        break;
      case 'hit':
        this.flashes.set(ev.id, 0.06);
        this.sparks(ev.x, ev.y, 3, ['#ffffff', '#ffec27']);
        break;
      case 'hurt':
        this.flashes.set(ev.id, 0.15);
        this.sparks(ev.x, ev.y, 8, ['#ff004d', '#ffa300']);
        if (ev.id === myId) this.shake = Math.max(this.shake, 4);
        break;
      case 'pick':
        this.sparks(ev.x, ev.y, 10, ['#a7f070', '#29adff', '#ffec27']);
        break;
      case 'wave':
        this.banner = { text: ev.n % 5 === 0 ? `ВОЛНА ${ev.n}: ФЛАГМАН` : `ВОЛНА ${ev.n}`, t: 2.2 };
        break;
      case 'clear':
        this.banner = { text: 'ВОЛНА ОТБИТА', t: 2 };
        break;
    }
  }

  explode(x, y, size) {
    const count = Math.min(60, 8 + size * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 15 + Math.random() * size * 6;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + Math.random() * 0.6, max: 1, kind: 'fire' });
    }
  }

  sparks(x, y, count, colors) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 20 + Math.random() * 50;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.2, max: 0.45, color: colors[i % colors.length] });
    }
  }

  draw(frame, { dt, roster, status, roomName }) {
    const { ctx } = this;
    ctx.save();
    if (this.shake > 0) {
      ctx.translate(Math.round((Math.random() - 0.5) * this.shake), Math.round((Math.random() - 0.5) * this.shake));
      this.shake = Math.max(0, this.shake - dt * 20);
    }
    ctx.fillStyle = '#0b0d1a';
    ctx.fillRect(-8, -8, WORLD_W + 16, WORLD_H + 16);
    this.drawStars(status === 'online' ? dt : 0);

    if (frame) {
      for (const u of frame.powerups) this.blit(powerupSprite(u.type), u.x, u.y + Math.sin(performance.now() / 150 + u.id) * 1.5);
      for (const e of frame.enemies) this.drawEnemy(e);
      for (const b of frame.bullets) this.drawBullet(b);
      for (const p of frame.players) {
        const isMe = p.id === frame.myId;
        const pos = isMe && frame.me ? frame.me : p;
        this.drawPlayer({ ...p, x: pos.x, y: pos.y }, roster.get(p.id), isMe);
      }
    }
    this.drawParticles(dt);
    ctx.restore();

    for (const [id, t] of this.flashes) {
      if (t - dt <= 0) this.flashes.delete(id);
      else this.flashes.set(id, t - dt);
    }

    if (frame) this.drawHud(frame, roomName);
    if (this.banner) {
      this.banner.t -= dt;
      if (this.banner.t <= 0) this.banner = null;
      else this.text(this.banner.text, WORLD_W / 2, 70, '#ffec27', 'center', FONT, true);
    }
  }

  drawStars(dt) {
    const { ctx } = this;
    const speeds = [8, 18, 40];
    const colors = ['#333c57', '#566c86', '#94b0c2'];
    for (const s of this.stars) {
      s.x -= speeds[s.layer] * dt;
      if (s.x < 0) {
        s.x += WORLD_W;
        s.y = Math.random() * WORLD_H;
      }
      ctx.fillStyle = colors[s.layer];
      ctx.fillRect(Math.round(s.x), Math.round(s.y), s.layer === 2 ? 2 : 1, 1);
    }
  }

  blit(sprite, x, y, scale = 1) {
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    this.ctx.drawImage(sprite, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
  }

  drawEnemy(e) {
    const flash = this.flashes.has(e.id);
    this.blit(enemySprite(e.type, flash), e.x, e.y, e.type === 'boss' ? 2 : 1);
    if (e.maxHp > 1 && e.hp < e.maxHp) {
      const w = e.type === 'boss' ? 50 : 14;
      const top = e.y - (e.type === 'boss' ? 28 : 10);
      this.ctx.fillStyle = '#333c57';
      this.ctx.fillRect(Math.round(e.x - w / 2), Math.round(top), w, 2);
      this.ctx.fillStyle = '#ff004d';
      this.ctx.fillRect(Math.round(e.x - w / 2), Math.round(top), Math.round((w * e.hp) / e.maxHp), 2);
    }
  }

  drawBullet(b) {
    const { ctx } = this;
    const x = Math.round(b.x);
    const y = Math.round(b.y);
    if (b.enemy) {
      ctx.fillStyle = '#ff004d';
      ctx.fillRect(x - 2, y - 1, 4, 2);
      ctx.fillRect(x - 1, y - 2, 2, 4);
      ctx.fillStyle = '#ffccaa';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    } else {
      ctx.fillStyle = '#ffec27';
      ctx.fillRect(x - 3, y, 6, 1);
      ctx.fillStyle = '#fff1e8';
      ctx.fillRect(x + 1, y, 2, 1);
    }
  }

  drawPlayer(p, info, isMe) {
    const { ctx } = this;
    if (!p.alive) return;
    const color = info?.color ?? '#41a6f6';
    ctx.save();
    if (!p.online) ctx.globalAlpha = 0.35;
    else if (p.invuln && Math.floor(performance.now() / 80) % 2) ctx.globalAlpha = 0.45;
    this.blit(playerSprite(color, this.flashes.has(p.id)), p.x, p.y);
    if (p.shield) {
      ctx.strokeStyle = '#29adff';
      ctx.globalAlpha *= 0.6 + Math.sin(performance.now() / 100) * 0.3;
      ctx.beginPath();
      ctx.arc(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    const label = p.online ? info?.name ?? '' : `${info?.name ?? ''} [нет связи]`;
    this.text(label, p.x, p.y - 12, isMe ? '#ffec27' : color, 'center', SMALL);
  }

  drawParticles(dt) {
    const { ctx } = this;
    const fire = ['#ffffff', '#ffec27', '#ffa300', '#ff004d', '#7e2553'];
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      const k = 1 - p.life / p.max;
      ctx.fillStyle = p.color ?? fire[Math.min(fire.length - 1, Math.floor(k * fire.length))];
      const size = p.kind === 'fire' && k < 0.3 ? 2 : 1;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), size, size);
    }
  }

  drawHud(frame, roomName) {
    const { ctx } = this;
    const me = frame.players.find((p) => p.id === frame.myId);
    ctx.fillStyle = 'rgba(11, 13, 26, 0.7)';
    ctx.fillRect(0, 0, WORLD_W, 14);

    if (me) {
      for (let i = 0; i < PLAYER_MAX_HP; i++) this.heart(4 + i * 10, 3, i < me.hp);
      this.text(`ОЧКИ ${String(me.score).padStart(5, '0')}`, 40, 3, '#fff1e8');
      this.text('ОРУЖИЕ', 150, 3, '#ffa300');
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i < me.power ? '#ffa300' : '#333c57';
        ctx.fillRect(200 + i * 5, 3, 3, 8);
      }
      if (me.shield) this.text('ЩИТ', 250, 3, '#29adff');
    }
    const w = frame.wave;
    const waveText = w.active ? `ВОЛНА ${w.n} · ВРАГОВ ${w.left}` : `ДО ВОЛНЫ ${w.n + 1}: ${w.breakSec}`;
    this.text(waveText, WORLD_W - 22, 3, '#a7f070', 'right');
    ctx.drawImage(this.emblemCanvas, WORLD_W - 18, 0, 14, 14);

    if (me && !me.alive) {
      ctx.fillStyle = 'rgba(11, 13, 26, 0.55)';
      ctx.fillRect(0, WORLD_H / 2 - 22, WORLD_W, 44);
      this.text('КОРАБЛЬ СБИТ', WORLD_W / 2, WORLD_H / 2 - 12, '#ff004d', 'center', FONT, true);
      this.text(`Возвращение через ${me.respawn}`, WORLD_W / 2, WORLD_H / 2 + 4, '#fff1e8', 'center');
    }
    this.text(`СБИТО ЭСКАДРИЛЬЕЙ: ${frame.totalKills}`, 4, WORLD_H - 9, '#566c86', 'left', SMALL);
    if (roomName) this.text(`КОМНАТА: ${roomName}`, WORLD_W / 2, WORLD_H - 9, '#566c86', 'center', SMALL);
  }

  heart(x, y, full) {
    const rows = ['.xx.xx.', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..', '...x...'];
    this.ctx.fillStyle = full ? '#ff004d' : '#333c57';
    rows.forEach((row, dy) => [...row].forEach((ch, dx) => ch === 'x' && this.ctx.fillRect(x + dx, y + dy + 1, 1, 1)));
  }

  text(str, x, y, color, align = 'left', font = FONT, shadow = false) {
    const { ctx } = this;
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    if (shadow) {
      ctx.fillStyle = '#000000';
      ctx.fillText(str, Math.round(x) + 1, Math.round(y) + 1);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, Math.round(x), Math.round(y));
  }
}

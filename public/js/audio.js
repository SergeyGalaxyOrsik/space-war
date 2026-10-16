// 8-битные звуки, синтезированные Web Audio API — никаких файлов.

import { load, save } from './storage.js';

let ctx = null;
let muted = load('muted', false);

function audio() {
  if (muted) return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ type = 'square', from, to, duration, volume = 0.05 }) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(to, ac.currentTime + duration);
  gain.gain.setValueAtTime(volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + duration);
}

function noise(duration, volume) {
  const ac = audio();
  if (!ac) return;
  const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * duration), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = volume;
  src.buffer = buffer;
  src.connect(gain).connect(ac.destination);
  src.start();
}

export const sfx = {
  shot: () => tone({ from: 880, to: 220, duration: 0.08, volume: 0.025 }),
  boom: (big) => noise(big ? 0.6 : 0.25, big ? 0.2 : 0.08),
  hurt: () => tone({ type: 'sawtooth', from: 300, to: 60, duration: 0.25, volume: 0.06 }),
  pick: () => {
    tone({ from: 520, to: 1040, duration: 0.12, volume: 0.04 });
    setTimeout(() => tone({ from: 780, to: 1560, duration: 0.12, volume: 0.04 }), 70);
  },
  wave: () => tone({ type: 'triangle', from: 220, to: 660, duration: 0.5, volume: 0.08 }),
};

export function isMuted() {
  return muted;
}

export function toggleMute() {
  muted = !muted;
  save('muted', muted);
  return muted;
}

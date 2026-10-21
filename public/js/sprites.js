// Пиксельные спрайты задаются строками; каждый символ — цвет из таблицы.
// Готовые спрайты кэшируются в offscreen-canvas.

const cache = new Map();

const PLAYER = [
  '..bb............',
  '..bab...........',
  '.fbaab..........',
  'ffbaaaab........',
  'ffaaawwaaabfffff',
  'ffbaaaab........',
  '.fbaab..........',
  '..bab...........',
  '..bb............',
];

const DRONE = [
  '...rrr...',
  '.rrRRRrr.',
  'rRRyyRRRr',
  'rRRyyRRRr',
  '.rrRRRrr.',
  '...rrr...',
];

const FIGHTER = [
  '........ppp..',
  '......pPPp...',
  '..ccPPPPPp...',
  'ccyyPPPPPPPpp',
  '..ccPPPPPp...',
  '......pPPp...',
  '........ppp..',
];

const TANK = [
  '.....gggggggg....',
  '...ggGGGGGGGGg...',
  '..gGGGgggggGGGg..',
  'kkkGGgyyyyygGGGgg',
  'kkkGGgyyyyygGGGgg',
  '..gGGGgggggGGGg..',
  '...ggGGGGGGGGg...',
  '.....gggggggg....',
];

// Флагман симметричен — задаём верхнюю половину, нижняя отражается.
const BOSS_HALF = [
  '..............mmmmmmmm....',
  '...........mmmMMMMMMMMm...',
  '.........mmMMMMmmmmMMMMm..',
  '.......mmMMMmmMMMMMMmmMMm.',
  '.....mmMMMMMMMMMMMMMMMMMMm',
  '...kkMMMMMmmmmmmMMMMMMMMMm',
  '.kkkkMMMMmyyyyyymMMMMMMMMm',
  'kkkkkMMMMmyywwyymMMMMMMMMm',
  '..kkkMMMMmyywwyymMMMMMMMMm',
  '....mMMMMMmmmmmmMMMMMMMMm.',
  '.....mMMMMMMMMMMMMMMMMMm..',
];
const BOSS = [...BOSS_HALF, ...BOSS_HALF.slice().reverse()];

const POWERUP = {
  weapon: ['.ooooooo.', 'oOOOOOOOo', 'oOwOwOwOo', 'oOwOwOwOo', 'oOwOwOwOo', 'oOOwOwOOo', 'oOOOOOOOo', '.ooooooo.'],
  heal: ['.ggggggg.', 'gGGGGGGGg', 'gGGGwGGGg', 'gGGwwwGGg', 'gGGGwGGGg', 'gGGGGGGGg', 'gGGGGGGGg', '.ggggggg.'],
  shield: ['.bbbbbbb.', 'bBBBBBBBb', 'bBBwwwBBb', 'bBwBBBBBb', 'bBBwwBBBb', 'bBBBBwBBb', 'bBwwwBBBb', '.bbbbbbb.'],
};

const BASE_COLORS = {
  w: '#f4f4f4', f: '#ffa300', y: '#ffec27', k: '#ff6c24',
  r: '#7e2553', R: '#ff004d',
  p: '#5d275d', P: '#b13e53', c: '#29adff',
  g: '#257179', G: '#38b764',
  m: '#333c57', M: '#566c86',
  o: '#ab5236', O: '#ffa300',
  b: '#1d2b53', B: '#29adff',
};

function build(rows, colors) {
  const canvas = document.createElement('canvas');
  canvas.width = rows[0].length;
  canvas.height = rows.length;
  const ctx = canvas.getContext('2d');
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = colors[ch];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  return canvas;
}

function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

export function playerSprite(color, flash = false) {
  return cached(`player:${color}:${flash}`, () =>
    build(PLAYER, flash
      ? { a: '#ffffff', b: '#ffffff', w: '#ffffff', f: '#ffffff' }
      : { a: color, b: shade(color, -0.4), w: '#f4f4f4', f: '#ffa300' }));
}

export function enemySprite(type, flash = false) {
  const rows = { drone: DRONE, fighter: FIGHTER, tank: TANK, boss: BOSS }[type];
  return cached(`enemy:${type}:${flash}`, () => build(rows, flash ? whiteOut(BASE_COLORS) : BASE_COLORS));
}

export function powerupSprite(type) {
  return cached(`pu:${type}`, () => build(POWERUP[type], BASE_COLORS));
}

function whiteOut(colors) {
  return Object.fromEntries(Object.keys(colors).map((k) => [k, '#ffffff']));
}

export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

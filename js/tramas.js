// Trames : tuiles 1-bit (1 = encre) qui se répètent depuis le coin de la page,
// bibliothèque personnalisable, et dithering d'image (Floyd–Steinberg, Bayer, seuil).
import { BAYER4, BAYER8 } from './dither.js';
import { kvGet, kvSet } from './store.js';

const make = (id, name, group, w, h, fn) => {
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = fn(x, y) ? 1 : 0;
  return { id, name, group, w, h, bits, builtin: true };
};

const bayer = n => (x, y) => BAYER4[y & 3][x & 3] < n;

// Points d'un écran de similigravure : un disque centré dans la cellule, d'aire proportionnelle au niveau.
function halftone(size, level) {
  const c = (size - 1) / 2, r = Math.sqrt(level * size * size / Math.PI);
  return (x, y) => Math.hypot((x % size) - c, (y % size) - c) <= r;
}

// Grain : bruit déterministe, pour que la trame soit la même partout.
function grain(size, level) {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const cells = Array.from({ length: size * size }, () => rnd() < level);
  return (x, y) => cells[(y % size) * size + (x % size)];
}

export const BUILTIN_TRAMAS = [
  ...[[6, 1], [12, 2], [25, 4], [37, 6], [50, 8], [62, 10], [75, 12], [87, 14]]
    .map(([p, n]) => make('g' + p, p + ' %', 'Gris', 4, 4, bayer(n))),
  make('pt15', 'Points 15 %', 'Points', 8, 8, halftone(8, 0.15)),
  make('pt30', 'Points 30 %', 'Points', 8, 8, halftone(8, 0.30)),
  make('pt50', 'Points 50 %', 'Points', 8, 8, halftone(8, 0.50)),
  make('pt70', 'Points 70 %', 'Points', 8, 8, halftone(8, 0.70)),
  make('gr20', 'Grain 20 %', 'Points', 16, 16, grain(16, 0.20)),
  make('gr45', 'Grain 45 %', 'Points', 16, 16, grain(16, 0.45)),
  make('hh', 'Lignes horizontales', 'Lignes', 4, 4, (x, y) => y === 0),
  make('hv', 'Lignes verticales', 'Lignes', 4, 4, (x, y) => x === 0),
  make('hd', 'Hachures /', 'Lignes', 4, 4, (x, y) => (x + y) % 4 === 0),
  make('hd2', 'Hachures \\', 'Lignes', 4, 4, (x, y) => (x - y + 4) % 4 === 0),
  make('hdl', 'Hachures larges /', 'Lignes', 8, 8, (x, y) => (x + y) % 8 < 2),
  make('hx', 'Hachures croisées', 'Lignes', 4, 4, (x, y) => (x + y) % 4 === 0 || (x - y + 4) % 4 === 0),
  make('hhh', 'Traits épais', 'Lignes', 6, 6, (x, y) => y < 2),
  make('dam', 'Damier', 'Motifs', 2, 2, (x, y) => (x + y) % 2 === 0),
  make('dam4', 'Grand damier', 'Motifs', 8, 8, (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0),
  make('bri', 'Briques', 'Motifs', 8, 8, (x, y) => y % 4 === 0 || x % 8 === (y < 4 ? 0 : 4)),
  make('vag', 'Vagues', 'Motifs', 8, 4, (x, y) => y === [0, 1, 2, 1, 0, 1, 2, 1][x % 8]),
];

const SOLID = { id: 'plein', name: 'Plein', group: 'Plein', w: 1, h: 1, bits: new Uint8Array([1]), builtin: true, solid: true };

// Bibliothèque personnelle : trames enregistrées sur cet appareil, disponibles dans tous les projets.
let library = [];
export const getLibrary = () => library;
const setLibrary = list => { library = list.map(t => ({ ...decodeTrama(t), group: 'Ma bibliothèque', lib: true })); };
export async function loadTramaLibrary() { setLibrary((await kvGet('tramaLib')) || []); }
export async function saveToLibrary(t) {
  const list = (await kvGet('tramaLib')) || [], enc = encodeTrama(t), i = list.findIndex(x => x.id === t.id);
  if (i >= 0) list[i] = enc; else list.push(enc);
  await kvSet('tramaLib', list); setLibrary(list);
}
export async function removeFromLibrary(id) {
  const list = ((await kvGet('tramaLib')) || []).filter(x => x.id !== id);
  await kvSet('tramaLib', list); setLibrary(list);
}

export function allTramas(project) {
  const custom = (project?.tramas || []).map(decodeTrama);
  return [SOLID, ...BUILTIN_TRAMAS, ...library, ...custom];
}

export function tramaById(project, id) {
  return allTramas(project).find(t => t.id === id) || SOLID;
}

// Une trame personnalisée est stockée en texte (lignes de 0 et de 1) dans le projet.
export function encodeTrama(t) {
  const rows = [];
  for (let y = 0; y < t.h; y++) rows.push(Array.from(t.bits.slice(y * t.w, (y + 1) * t.w)).join(''));
  return { id: t.id, name: t.name, w: t.w, h: t.h, rows };
}
export function decodeTrama(s) {
  if (s.bits) return s;
  const bits = new Uint8Array(s.w * s.h);
  s.rows.forEach((r, y) => { for (let x = 0; x < s.w; x++) bits[y * s.w + x] = r[x] === '1' ? 1 : 0; });
  return { id: s.id, name: s.name, group: 'Perso', w: s.w, h: s.h, bits, builtin: false };
}

// Aperçu d'une trame sur un canevas (pour la bibliothèque).
export function drawTramaSwatch(canvas, t, scale = 1) {
  const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = t.bits[(((y / scale) | 0) % t.h) * t.w + (((x / scale) | 0) % t.w)];
    const i = (y * w + x) * 4, v = on ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ───────────────────────── Dithering d'image ─────────────────────────

export const DITHER_METHODS = [
  { id: 'floyd', name: 'Floyd–Steinberg (grain organique)' },
  { id: 'bayer4', name: 'Bayer 4 × 4 (trame régulière)' },
  { id: 'bayer8', name: 'Bayer 8 × 8 (trame fine)' },
  { id: 'seuil', name: 'Seuil (noir et blanc dur)' },
];

// gray : Float32Array 0..255 (modifié sur place). Renvoie Uint8Array où 1 = encre.
export function ditherGray(gray, w, h, method, threshold = 128) {
  const out = new Uint8Array(w * h);
  if (method === 'floyd') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = gray[i], on = old < threshold ? 1 : 0, err = old - (on ? 0 : 255);
      out[i] = on;
      if (x + 1 < w) gray[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += err * 3 / 16;
        gray[i + w] += err * 5 / 16;
        if (x + 1 < w) gray[i + w + 1] += err * 1 / 16;
      }
    }
  } else if (method === 'seuil') {
    for (let i = 0; i < out.length; i++) out[i] = gray[i] < threshold ? 1 : 0;
  } else {
    const M = method === 'bayer8' ? BAYER8 : BAYER4, n = M.length;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = ((M[y % n][x % n] + 0.5) / (n * n)) * 255;
      out[y * w + x] = gray[y * w + x] - (threshold - 128) < t ? 1 : 0;
    }
  }
  return out;
}

// Image (bitmap) → grille de gris w × h, « contain » ou « cover », avec luminosité et contraste.
export function imageToGray(bitmap, w, h, { fit = 'contain', brightness = 0, contrast = 0 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  const bw = bitmap.width, bh = bitmap.height;
  const k = fit === 'cover' ? Math.max(w / bw, h / bh) : Math.min(w / bw, h / bh);
  const dw = bw * k, dh = bh * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const px = ctx.getImageData(0, 0, w, h).data, gray = new Float32Array(w * h);
  const f = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let i = 0; i < gray.length; i++) {
    let g = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    g = f * (g - 128 + brightness) + 128;
    gray[i] = Math.max(0, Math.min(255, g));
  }
  return gray;
}

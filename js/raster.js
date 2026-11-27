// Moteur raster 1-bit : annuler par différences de tuiles, pinceaux, formes, remplissage, composition.
// Repris de Pixel Studio (pointeur, remplissage, tramage par Bayer), refait pour de grands canevas :
// un calque est un tampon d'octets, et l'historique ne garde que les tuiles modifiées.
import { ensureData, DRAFT_COLORS, bppOf, gradientLut } from './model.js';
import { BAYER8 } from './dither.js';

export const TILE = 64;
export const INK = 1, PAPER = 2;

// ───────────────────────── Annuler / rétablir par différences ─────────────────────────

export class UndoStack {
  constructor(limitBytes = 96 * 1024 * 1024) {
    this.stack = []; this.ptr = 0; this.bytes = 0; this.limit = limitBytes;
    this.cur = null; this.onApply = () => {}; this.onChange = () => {}; this.onSelect = () => {};
  }
  get canUndo() { return this.ptr > 0; }
  get canRedo() { return this.ptr < this.stack.length; }
  get label() { return this.ptr > 0 ? this.stack[this.ptr - 1].label : ''; }
  clear() { this.stack = []; this.ptr = 0; this.bytes = 0; this.cur = null; this.onChange(); }

  begin(label) { this.cur = { label, tiles: new Map() }; }
  get active() { return !!this.cur; }

  // Avant d'écrire dans le rectangle [x0,x1[ × [y0,y1[ du calque : garde l'état d'origine des tuiles touchées.
  touch(layer, x0, y0, x1, y1) {
    if (!this.cur) return;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(layer.w, x1); y1 = Math.min(layer.h, y1);
    if (x1 <= x0 || y1 <= y0) return;
    const data = ensureData(layer), b = bppOf(layer), W = layer.w * b;
    layer.dirty = true;
    for (let ty = (y0 / TILE) | 0; ty <= ((y1 - 1) / TILE) | 0; ty++) {
      for (let tx = (x0 / TILE) | 0; tx <= ((x1 - 1) / TILE) | 0; tx++) {
        const key = layer.id + ':' + tx + ',' + ty;
        if (this.cur.tiles.has(key)) continue;
        const px = tx * TILE, py = ty * TILE, tw = Math.min(TILE, layer.w - px), th = Math.min(TILE, layer.h - py);
        const before = new Uint8Array(tw * th * b);
        for (let y = 0; y < th; y++) before.set(data.subarray((py + y) * W + px * b, (py + y) * W + (px + tw) * b), y * tw * b);
        this.cur.tiles.set(key, { layer, px, py, tw, th, before });
      }
    }
  }

  // Termine l'action : ne garde que les tuiles réellement modifiées.
  // sel = { before, after } : la sélection fait partie de la même entrée (annuler / rétablir la remettent avec les pixels).
  commit(sel) {
    const cur = this.cur; this.cur = null;
    if (!cur) return null;
    const ops = [];
    for (const t of cur.tiles.values()) {
      const data = t.layer.data, b = bppOf(t.layer), W = t.layer.w * b, rw = t.tw * b, after = new Uint8Array(rw * t.th);
      let same = true;
      for (let y = 0; y < t.th; y++) {
        const row = data.subarray((t.py + y) * W + t.px * b, (t.py + y) * W + t.px * b + rw);
        after.set(row, y * rw);
        if (same) for (let x = 0; x < rw; x++) if (row[x] !== t.before[y * rw + x]) { same = false; break; }
      }
      if (!same) ops.push({ ...t, after });
    }
    if (!ops.length) return null;
    return this._push({ label: cur.label, ops, sel, bytes: ops.reduce((s, o) => s + o.before.length * 2, 0) });
  }

  // Annule l'action en cours (geste interrompu) : remet les tuiles d'origine sans rien empiler.
  rollback() {
    const cur = this.cur; this.cur = null;
    if (!cur) return;
    for (const t of cur.tiles.values()) this._write(t, t.before);
  }

  // Action structurelle (ajout de calque, de page…) : deux fonctions suffisent.
  pushAction(label, undo, redo) { return this._push({ label, undo, redo, bytes: 0 }); }

  _push(entry) {
    this.stack.length = this.ptr;
    this.stack.push(entry); this.ptr = this.stack.length;
    this.bytes = this.stack.reduce((s, e) => s + e.bytes, 0);
    while (this.bytes > this.limit && this.stack.length > 1) { this.bytes -= this.stack.shift().bytes; this.ptr--; }
    this.onChange();
    return entry;
  }

  _write(t, src) {
    const data = ensureData(t.layer), b = bppOf(t.layer), rw = t.tw * b;
    for (let y = 0; y < t.th; y++) data.set(src.subarray(y * rw, (y + 1) * rw), ((t.py + y) * t.layer.w + t.px) * b);
    t.layer.dirty = true;
    this.onApply(t.layer, { x: t.px, y: t.py, w: t.tw, h: t.th });
  }

  undo() {
    if (!this.canUndo) return null;
    const e = this.stack[--this.ptr];
    if (e.ops) for (const t of e.ops) this._write(t, t.before); else e.undo();
    if (e.sel) this.onSelect(e.sel.before);
    this.onChange();
    return e;
  }
  redo() {
    if (!this.canRedo) return null;
    const e = this.stack[this.ptr++];
    if (e.ops) for (const t of e.ops) this._write(t, t.after); else e.redo();
    if (e.sel) this.onSelect(e.sel.after);
    this.onChange();
    return e;
  }
}

// ───────────────────────── Valeur d'un pixel selon le motif ─────────────────────────

// paint : { v: 0|1|2, trame: {w,h,bits}|null, scale, opaque }
// (px, py) en coordonnées de PAGE, pour que les trames se raccordent d'une case à l'autre.
export function paintValue(paint, px, py) {
  const t = paint.trame;
  if (!t || paint.v === 0) return paint.v;
  const s = paint.scale || 1;
  const bit = t.bits[(((py / s) | 0) % t.h) * t.w + (((px / s) | 0) % t.w)];
  if (bit) return paint.v;
  return paint.opaque && paint.v === INK ? PAPER : -1;
}

// ctx : { layer, undo, paint, mask: {data, mode}|null, ox, oy, dirty }
// mask.mode : 'in' peint seulement dans la zone du masque, 'out' seulement en dehors.
function writable(ctx, x, y) {
  if (x < 0 || y < 0 || x >= ctx.layer.w || y >= ctx.layer.h) return false;
  const c = ctx.clip;   // cadre visible de la case : on ne dessine pas dans la réserve hors cadre
  if (c && (x < c.x0 || y < c.y0 || x >= c.x1 || y >= c.y1)) return false;
  const m = ctx.mask;
  if (!m) return true;
  const inside = m.data[y * ctx.layer.w + x] !== 0;
  return m.mode === 'in' ? inside : !inside;
}

function grow(ctx, x0, y0, x1, y1) {
  const d = ctx.dirty;
  if (!d) { ctx.dirty = { x0, y0, x1, y1 }; return; }
  if (x0 < d.x0) d.x0 = x0; if (y0 < d.y0) d.y0 = y0;
  if (x1 > d.x1) d.x1 = x1; if (y1 > d.y1) d.y1 = y1;
}

// Opacité d'un trait (paint.alpha < 1) : seuil de Bayer 8 × 8 accroché à la page, donc un gris tramé régulier
// qui ne fonce pas quand les tampons se recouvrent ; le même rendu que l'opacité d'un calque à l'export.
const bayerKeep = (alpha, px, py) => alpha * 64 > BAYER8[py & 7][px & 7];
function put(ctx, data, x, y, m = 1) {
  if (!writable(ctx, x, y)) return;
  let a = ctx.paint.alpha;
  if (m < 1) a = (a ?? 1) * m;   // m : opacité propre au pixel (aquarelle, gouache, acrylique)
  if (ctx.alphaLock) {   // verrouillage alpha : seuls les pixels déjà peints changent, et la gomme ne fait rien
    if (ctx.paint.v === 0) return;
    const k = y * ctx.layer.w + x;
    if (ctx.rgba ? !data[k * 4 + 3] : !data[k]) return;
  }
  if (ctx.rgba) { putRGBA(ctx, data, x, y, a ?? 1); return; }
  if (a !== undefined && a < 1 && !bayerKeep(a, x + ctx.ox, y + ctx.oy)) return;
  const v = paintValue(ctx.paint, x + ctx.ox, y + ctx.oy);
  if (v < 0) return;
  data[y * ctx.layer.w + x] = v;
}

// Calque de couleur : vraie opacité. Au cours d'un trait, un pixel garde l'opacité la plus forte qu'il a reçue
// (ctx.seen, 0–255) : un trait à 40 % reste à 40 % là où ses tampons se recouvrent, et un pinceau dont
// l'opacité varie d'un pixel à l'autre (aquarelle) ne fonce pas à chaque tampon.
function putRGBA(ctx, data, x, y, a) {
  const k = y * ctx.layer.w + x;
  const v = paintValue(ctx.paint, x + ctx.ox, y + ctx.oy);
  if (v < 0) return;
  if (a < 1 && !ctx.seen) ctx.seen = new Uint8Array(ctx.layer.w * ctx.layer.h);
  if (ctx.seen) {
    const s = ctx.seen[k] / 255;
    if (a <= s + 0.003) return;
    ctx.seen[k] = Math.round(a * 255);
    if (s > 0) a = 1 - (1 - a) / (1 - s);   // complément : le pixel atteint l'opacité a, pas a + s
  }
  const i = k * 4, da = data[i + 3] / 255;
  if (v === 0) {   // gomme
    const na = da * (1 - a);
    if (na <= 0.002) { data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0; } else data[i + 3] = Math.round(na * 255);
    return;
  }
  const c = v === INK ? ctx.paint.rgb || [0, 0, 0] : [255, 255, 255];
  if (ctx.alphaLock) {   // garde la transparence du pixel, ne change que sa couleur
    for (let j = 0; j < 3; j++) data[i + j] = Math.round(c[j] * a + data[i + j] * (1 - a));
    return;
  }
  if (a >= 1 || da === 0) { data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = Math.max(Math.round(a * 255), a >= 1 ? 255 : 0); return; }
  const oa = a + da * (1 - a);
  data[i] = Math.round((c[0] * a + data[i] * da * (1 - a)) / oa);
  data[i + 1] = Math.round((c[1] * a + data[i + 1] * da * (1 - a)) / oa);
  data[i + 2] = Math.round((c[2] * a + data[i + 2] * da * (1 - a)) / oa);
  data[i + 3] = Math.round(oa * 255);
}
export const hexToRgb = h => (/^#[0-9a-f]{6}$/i.test(h || '') ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : [0, 0, 0]);

// ───────────────────────── Pinceau rond ─────────────────────────

const discCache = new Map();
function discRows(d) {
  let rows = discCache.get(d);
  if (rows) return rows;
  rows = [];
  if (d <= 1) rows.push([0, 0, 0]);
  else if (d === 2) { rows.push([0, 0, 1], [1, 0, 1]); }
  else {
    const r = d / 2, lo = -Math.floor(r), hi = Math.ceil(r) - 1;
    for (let dy = lo; dy <= hi; dy++) {
      const cy = dy + (d % 2 ? 0 : 0.5);
      const half = Math.sqrt(Math.max(0, r * r - cy * cy));
      const a = Math.round((d % 2 ? 0 : 0.5) - half + 0.0001), b = Math.round((d % 2 ? 0 : 0.5) + half - 0.0001);
      rows.push([dy, a, b]);
    }
  }
  discCache.set(d, rows);
  return rows;
}

export function stampDisc(ctx, cx, cy, d) {
  d = Math.max(1, Math.round(d));
  const rows = discRows(d);
  const data = ensureData(ctx.layer);
  const half = Math.ceil(d / 2) + 1;
  ctx.undo.touch(ctx.layer, cx - half, cy - half, cx + half + 1, cy + half + 1);
  for (const [dy, a, b] of rows) {
    const y = cy + dy;
    for (let x = cx + a; x <= cx + b; x++) put(ctx, data, x, y);
  }
  grow(ctx, cx - half, cy - half, cx + half + 1, cy + half + 1);
}

// ───────────────────────── Pinceaux ─────────────────────────
// Un pinceau est un ensemble de paramètres (forme, pression, effilage, grain, dispersion, stabilisation) :
// les pinceaux livrés et ceux que l'utilisateur enregistre sont de simples variantes de ces réglages.

export const BRUSH_DEFAULTS = {
  shape: 'round',      // round | square | nib (ellipse) | rect
  ratio: 1,            // finesse de nib / rect : 1 = aussi large que long
  angle: 0,            // degrés
  follow: false,       // l'axe long reste perpendiculaire au geste
  sizeMm: 0.5,
  press: 1,            // 0 à 1 : effet de la pression du stylet sur la taille (par défaut 100 %)
  pressMin: 0.1,       // taille relative à pression nulle (par défaut 10 %)
  speed: 0,            // 0 à 1 : le trait s'affine quand le geste va vite
  start: 0,            // départ effilé, en diamètres
  grain: 1,            // couverture 0 à 1 (1 = plein)
  grainType: 'none',   // none | noise | paper | bristle | spray | wash (aquarelle) | gouache | acrylic
  grainScale: 1,       // taille d'un grain, en pixels
  scatter: 0,          // dispersion du tampon, en fraction du diamètre
  spacing: 0.2,        // écart des tampons, en diamètres
  smooth: 0,           // stabilisation 0 à 1
};

export const BRUSH_GROUPS = ['Encrage', 'Esquisse', 'Pinceaux', 'Peinture', 'Calligraphie', 'Texture'];
const B = (id, name, group, o) => ({ id, name, group, ...o });
export const BUILTIN_BRUSHES = [
  B('stylo', 'Stylo rond', 'Encrage', { sizeMm: 0.5 }),
  B('technique', 'Stylo technique', 'Encrage', { sizeMm: 0.3, press: 0, smooth: 0.25 }),
  B('plume', 'Plume d\'encrage', 'Encrage', { sizeMm: 0.5, speed: 0.25, smooth: 0.15 }),
  B('plumeg', 'Plume G (manga)', 'Encrage', { sizeMm: 0.8, speed: 0.6, start: 3, smooth: 0.35 }),
  B('brushpen', 'Brush pen', 'Encrage', { sizeMm: 1.5, speed: 0.8, start: 4, smooth: 0.4 }),
  B('hb', 'Crayon HB', 'Esquisse', { sizeMm: 0.6, grain: 0.75, grainType: 'paper', scatter: 0.12, spacing: 0.18 }),
  B('6b', 'Crayon 6B', 'Esquisse', { sizeMm: 1.6, grain: 0.6, grainType: 'paper', grainScale: 2, scatter: 0.2 }),
  B('couleur', 'Crayon de couleur', 'Esquisse', { sizeMm: 1.2, grain: 0.7, grainType: 'paper', grainScale: 1.5, scatter: 0.08, spacing: 0.15, pressMin: 0.3 }),
  B('mine', 'Mine à plat', 'Esquisse', { sizeMm: 3.5, shape: 'rect', ratio: 0.25, angle: 20, grain: 0.55, grainType: 'paper' }),
  B('rond', 'Pinceau rond', 'Pinceaux', { sizeMm: 2.5, speed: 0.5, start: 2.5, smooth: 0.3 }),
  B('plat', 'Pinceau plat', 'Pinceaux', { sizeMm: 4, shape: 'rect', ratio: 0.35, follow: true }),
  B('sec', 'Pinceau sec', 'Pinceaux', { sizeMm: 4, grainType: 'bristle', grain: 0.55, smooth: 0.2 }),
  B('feutre', 'Feutre carré', 'Pinceaux', { sizeMm: 2, shape: 'square' }),
  B('aquarelle', 'Aquarelle ronde', 'Peinture', { sizeMm: 6, grainType: 'wash', grain: 0.5, grainScale: 2, spacing: 0.25, smooth: 0.3, pressMin: 0.3 }),
  B('lavis', 'Lavis (aquarelle large)', 'Peinture', { sizeMm: 14, grainType: 'wash', grain: 0.32, grainScale: 4, spacing: 0.25, smooth: 0.35, pressMin: 0.5 }),
  B('aquagrain', 'Aquarelle granuleuse', 'Peinture', { sizeMm: 8, grainType: 'wash', grain: 0.55, grainScale: 1, spacing: 0.25, scatter: 0.06, smooth: 0.25, pressMin: 0.35 }),
  B('gouache', 'Gouache', 'Peinture', { sizeMm: 5, grainType: 'gouache', grain: 0.95, grainScale: 2, spacing: 0.25, speed: 0.2, smooth: 0.3, pressMin: 0.35 }),
  B('acrylique', 'Acrylique', 'Peinture', { sizeMm: 7, shape: 'rect', ratio: 0.45, follow: true, grainType: 'acrylic', grain: 0.85, grainScale: 1.5, spacing: 0.2, smooth: 0.25, pressMin: 0.4 }),
  B('plate', 'Plume plate 40°', 'Calligraphie', { sizeMm: 3, shape: 'nib', ratio: 0.16, angle: 40 }),
  B('plate2', 'Plume plate suivie', 'Calligraphie', { sizeMm: 2.5, shape: 'nib', ratio: 0.2, follow: true }),
  B('fusain', 'Fusain', 'Texture', { sizeMm: 5, grainType: 'noise', grain: 0.6, scatter: 0.15 }),
  B('craie', 'Craie', 'Texture', { sizeMm: 6, grainType: 'paper', grain: 0.5, grainScale: 2, scatter: 0.05 }),
  B('spray', 'Aérographe', 'Texture', { sizeMm: 8, grainType: 'spray', grain: 0.5 }),
  B('point', 'Pointillé', 'Texture', { sizeMm: 1.2, press: 0, spacing: 2.4 }),
];
export const brushSpec = (id, custom = []) => ({ ...BRUSH_DEFAULTS, ...(BUILTIN_BRUSHES.concat(custom).find(b => b.id === id) || BUILTIN_BRUSHES[0]) });

// Bruit déterministe 0..1 d'un point : le grain est le même à chaque passage et se raccorde d'une case à l'autre.
const hash2 = (x, y) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
// Bruit de valeur lissé (grain « papier » : reliefs étalés plutôt que points isolés)
const smooth01 = t => t * t * (3 - 2 * t);
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = smooth01(x - xi), fy = smooth01(y - yi);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// Grain en tables : le bruit d'un pixel ne dépend que de sa place sur la page, on le lit donc dans une tuile
// de 1024 × 1024 calculée une fois (bruit de valeur périodique, sans raccord visible), au lieu de le recalculer
// à chaque tampon (un pixel est touché par 5 à 10 tampons successifs). Indice : ((py & 1023) << 10) | (px & 1023).
const NT = 1024, NM = NT - 1;
const noiseTabs = new Map();
function noiseTab(scale) {
  const P = Math.max(1, Math.min(NT, Math.round(NT / scale)));   // nombre de mailles sur la tuile : la période tombe juste
  let t = noiseTabs.get(P);
  if (t) return t;
  const lat = new Float32Array(P * P);
  for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) lat[j * P + i] = hash2(i + 131, j + 977);
  t = new Uint8Array(NT * NT);
  const k = P / NT;
  for (let y = 0; y < NT; y++) {
    const fy0 = y * k, yi = fy0 | 0, fy = smooth01(fy0 - yi), r0 = (yi % P) * P, r1 = ((yi + 1) % P) * P;
    for (let x = 0; x < NT; x++) {
      const fx0 = x * k, xi = fx0 | 0, fx = smooth01(fx0 - xi), c0 = xi % P, c1 = (xi + 1) % P;
      const a = lat[r0 + c0], b = lat[r0 + c1], c = lat[r1 + c0], d = lat[r1 + c1];
      t[y * NT + x] = Math.round(255 * ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy));
    }
  }
  noiseTabs.set(P, t);
  if (noiseTabs.size > 16) noiseTabs.delete(noiseTabs.keys().next().value);
  return t;
}
let whiteTabCache = null;
function whiteTab() {
  if (whiteTabCache) return whiteTabCache;
  const t = new Uint8Array(NT * NT);
  for (let y = 0; y < NT; y++) for (let x = 0; x < NT; x++) t[y * NT + x] = Math.round(255 * hash2(x, y));
  return (whiteTabCache = t);
}
const I255 = 1 / 255;

const isPlain = sp => sp.shape === 'round' && sp.grainType === 'none' && sp.grain >= 1 && !sp.scatter;

// Tampon d'un pinceau à (cx, cy). `dir` : sens du geste. ctx.brush : { spec, seed, n, pr } (pr : pression 0..1).
export function stampBrush(ctx, cx, cy, d, dir) {
  const br = ctx.brush, sp = br ? br.spec : BRUSH_DEFAULTS;
  if (!br || isPlain(sp)) return stampDisc(ctx, cx, cy, d);
  d = Math.max(1, Math.round(d));
  br.n = (br.n || 0) + 1;
  if (sp.scatter) {   // dispersion : le tampon est décalé un peu au hasard (crayon, fusain)
    cx += Math.round((hash2(cx * 3 + br.n, cy + br.seed) - 0.5) * sp.scatter * d);
    cy += Math.round((hash2(cx + br.n * 5, cy * 7 + br.seed) - 0.5) * sp.scatter * d);
  }
  const data = ensureData(ctx.layer), half = Math.ceil(d / 2) + 3, ra = d / 2;
  ctx.undo.touch(ctx.layer, cx - half, cy - half, cx + half + 1, cy + half + 1);
  const pressureGrain = sp.press > 0 ? 0.55 + 0.9 * (br.pr ?? 0.5) : 1;
  const cov = Math.max(0, Math.min(1, sp.grain * (sp.grainType === 'none' ? 1 : pressureGrain)));
  const gs = Math.max(1, sp.grainScale);
  const ang = (sp.follow && dir ? Math.atan2(dir.y, dir.x) + Math.PI / 2 : sp.angle * Math.PI / 180), ca = Math.cos(ang), sa = Math.sin(ang);
  const rb = sp.shape === 'round' || sp.shape === 'square' ? ra : Math.max(0.6, ra * sp.ratio);

  if (sp.grainType === 'spray') {
    const n = Math.max(1, Math.round(Math.PI * ra * ra * cov * 0.1));
    for (let k = 0; k < n; k++) {
      br.n++;
      const a = hash2(cx * 7 + k, cy * 13 + br.n + br.seed) * Math.PI * 2, rad = Math.sqrt(hash2(cx * 3 + br.n, cy * 5 + k + br.seed)) * ra;
      put(ctx, data, Math.round(cx + Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad));
    }
    grow(ctx, cx - half, cy - half, cx + half + 1, cy + half + 1);
    return;
  }
  const dx = dir ? dir.x : 1, dy = dir ? dir.y : 0, gt = sp.grainType, ox = ctx.ox, oy = ctx.oy;
  // tables du grain de ce pinceau (lues par indice, voir noiseTab)
  const WT = gt === 'none' || gt === 'bristle' ? null : whiteTab();
  const TA = gt === 'paper' || gt === 'gouache' ? noiseTab(gs * 2.5) : gt === 'wash' ? noiseTab(gs * 4) : gt === 'acrylic' ? noiseTab(gs * 3) : null;
  const TB = gt === 'wash' ? noiseTab(gs * 12) : gt === 'gouache' ? noiseTab(gs * 2) : null;
  const TC = gt === 'gouache' ? noiseTab(gs * 8) : null;
  // pixels déjà au plus fort pendant ce trait : on ne recalcule pas leur grain
  const L = ctx.layer, W = L.w, rgba = !!ctx.rgba, seen = rgba ? ctx.seen : null;
  const plainInk = !rgba && ctx.paint.v === 1 && !ctx.paint.trame && (ctx.paint.alpha ?? 1) >= 1;
  // calque RVBA, trait opaque sans trame à grain tout-ou-rien : un pixel déjà de cette couleur, opaque, ne changerait pas
  const rgb = ctx.paint.rgb || [0, 0, 0];
  const plainRGBA = rgba && !ctx.alphaLock && ctx.paint.v === 1 && !ctx.paint.trame && (ctx.paint.alpha ?? 1) >= 1 && (gt === 'none' || gt === 'noise' || gt === 'paper' || gt === 'bristle');
  const top = Math.round(255 * Math.min(1, (ctx.paint.alpha ?? 1) * (gt === 'wash' ? cov : gt === 'gouache' ? cov + 0.05 : 1)));
  const round = sp.shape === 'round', square = sp.shape === 'square', rect = sp.shape === 'rect', needRR = gt === 'wash' || gt === 'gouache';
  // Aquarelle et gouache : la valeur d'un pixel ne dépend que de sa place et de la pression ; à pression égale ou
  // moindre, le cœur du tampon précédent (en deçà du bord irrégulier) est déjà peint au moins aussi fort : on le saute.
  const pv = br.prev, inner = (gt === 'wash' ? 0.7 : gt === 'gouache' ? 0.86 : 0) * (pv ? pv.r : 0);
  const skip2 = round && pv && pv.round && pv.layer === L && cov <= pv.cov + 1e-6 ? inner * inner : 0;
  br.prev = { x: cx, y: cy, r: ra, cov, round, layer: L };
  const ra2 = ra * ra, ira = 1 / ra, ira2 = 1 / (ra * ra), irb2 = 1 / (rb * rb), irb = 1 / rb;
  for (let y = -half; y <= half; y++) {
    let xa = -half, xb = half;
    if (round) { const w2 = ra2 + 0.25 - y * y; if (w2 < 0) continue; const w = Math.floor(Math.sqrt(w2)); xa = -w; xb = w; }   // le disque, ligne par ligne
    const ly = cy + y, py = ly + oy;
    if (ly < 0 || ly >= L.h) continue;
    for (let x = xa; x <= xb; x++) {
      const lx = cx + x;
      if (lx < 0 || lx >= W) continue;
      // forme
      let rr = 0;   // distance au centre rapportée au bord (0 au centre, 1 au bord)
      if (round) { if (needRR) rr = Math.sqrt(x * x + y * y) * ira; }
      else if (square) { if (Math.abs(x) > ra || Math.abs(y) > ra) continue; rr = Math.max(Math.abs(x), Math.abs(y)) * ira; }
      else {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (rect ? Math.abs(u) > ra || Math.abs(v) > rb : u * u * ira2 + v * v * irb2 > 1) continue;
        rr = rect ? Math.max(Math.abs(u) * ira, Math.abs(v) * irb) : Math.sqrt(u * u * ira2 + v * v * irb2);
      }
      if (skip2) { const ex = lx - pv.x, ey = ly - pv.y; if (ex * ex + ey * ey < skip2) continue; }
      const k = ly * W + lx;
      if (plainInk ? data[k] === 1 : plainRGBA ? data[k * 4 + 3] === 255 && data[k * 4] === rgb[0] && data[k * 4 + 1] === rgb[1] && data[k * 4 + 2] === rgb[2] : seen && seen[k] >= top) continue;   // rien ne changerait
      // grain
      const px = lx + ox;
      if (gt === 'noise') {
        const edge = (x * x + y * y) / (ra2 + 1), qx = Math.floor(px / gs), qy = Math.floor(py / gs);
        if (WT[((qy & NM) << 10) | (qx & NM)] * I255 >= cov * (1 - 0.5 * edge)) continue;
      } else if (gt === 'paper') {
        const i = ((py & NM) << 10) | (px & NM);
        if (TA[i] * I255 * 0.65 + WT[i] * I255 * 0.35 >= cov) continue;
      } else if (gt === 'bristle') {
        const bristle = Math.floor((x * -dy + y * dx) / (1.4 * gs));
        if (hash2(bristle, br.seed) >= cov) continue;
      } else if (gt === 'wash') {
        // aquarelle : bord irrégulier et pigment en nappes, accrochés à la page (les traits se raccordent),
        // granulation fine ; transparente, elle fonce en repassant (un pixel par trait, puis glacis)
        if (rr > 0.7 + 0.3 * TA[((py & NM) << 10) | (px & NM)] * I255) continue;
        const qx = Math.floor(px / gs), qy = Math.floor(py / gs);
        const pig = TB[(((py + 211) & NM) << 10) | ((px + 389) & NM)] * I255, gran = WT[((qy & NM) << 10) | (qx & NM)] * I255;
        put(ctx, data, lx, ly, Math.min(1, cov * (0.5 + 0.5 * pig) * (0.78 + 0.22 * gran)));
        continue;
      } else if (gt === 'gouache') {
        // gouache : couvrante et mate, bord un peu sec, le papier transparaît quand on appuie peu
        const i = ((py & NM) << 10) | (px & NM);
        if (rr > 0.86 + 0.14 * TB[i] * I255) continue;
        if (TA[i] * I255 * 0.65 + WT[i] * I255 * 0.35 > cov + 0.35) continue;
        put(ctx, data, lx, ly, Math.min(1, cov * (0.93 + 0.07 * TC[i] * I255) + 0.05));
        continue;
      } else if (gt === 'acrylic') {
        // acrylique : traces de poils dans le sens du geste, épaisseur inégale d'un poil à l'autre
        const bristle = Math.floor((x * -dy + y * dx) / (1.4 * gs)), hb = hash2(bristle, br.seed);
        if (hb > cov + 0.12 || rr > 0.9 + 0.1 * hash2(bristle * 3 + 1, br.seed)) continue;
        put(ctx, data, lx, ly, Math.min(1, (0.62 + 0.38 * hash2(bristle * 7 + 2, br.seed + 3)) * (0.88 + 0.12 * TA[((py & NM) << 10) | (px & NM)] * I255)));
        continue;
      }
      put(ctx, data, lx, ly);
    }
  }
  grow(ctx, cx - half, cy - half, cx + half + 1, cy + half + 1);
}

// Segment avec diamètre interpolé (pression du stylet), tamponné avec ctx.brush s'il y en a un.
export function strokeSegment(ctx, x0, y0, x1, y1, d0, d1 = d0) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const spacing = ctx.smudge ? 0.18 : ctx.brush ? Math.max(0.05, ctx.brush.spec.spacing) : 0.25;
  const step = Math.max(1, Math.min(d0, d1) * spacing);
  const n = Math.max(1, Math.ceil(dist / step));
  const dir = dist > 0 ? { x: (x1 - x0) / dist, y: (y1 - y0) / dist } : null;
  let lx = null, ly = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    if (x === lx && y === ly) continue;
    lx = x; ly = y;
    if (ctx.smudge) smudgeStamp(ctx, x, y, d0 + (d1 - d0) * t);
    else stampBrush(ctx, x, y, d0 + (d1 - d0) * t, dir);
  }
}

// Estompe (calque RVBA) : le tampon emporte la peinture qu'il traverse et la dépose plus loin, comme un doigt.
// ctx.smudge = { strength 0–1, buf } : `buf` garde les pixels (prémultipliés) du tampon précédent, à la même place
// relative ; chaque pixel du tampon va vers eux selon la force, plus au centre qu'au bord, puis ils deviennent la nouvelle charge.
export function smudgeStamp(ctx, cx, cy, d) {
  const sm = ctx.smudge, L = ctx.layer, data = ensureData(L), W = L.w;
  const r = Math.max(1, d / 2), R = Math.ceil(r), S = 2 * R + 1, r2 = r * r;
  ctx.undo.touch(L, cx - R, cy - R, cx + R + 1, cy + R + 1);
  // deux tampons de charge échangés d'un tampon au suivant (pas d'allocation à chaque tampon)
  const old = sm.buf, oR = sm.R, k = old ? oR / R : 0, oS = 2 * oR + 1;
  let nb = sm.spare;
  if (!nb || nb.length < S * S * 4) nb = new Float32Array(S * S * 4); else nb.fill(0, 0, S * S * 4);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const q2 = dx * dx + dy * dy;
    if (q2 > r2) continue;
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= W || y >= L.h) continue;
    const i = (y * W + x) * 4, a = data[i + 3] / 255, j = ((dy + R) * S + dx + R) * 4;
    let c0 = data[i] * a, c1 = data[i + 1] * a, c2 = data[i + 2] * a, c3 = a;
    if (old) {
      const ox = Math.max(-oR, Math.min(oR, Math.round(dx * k))), oy = Math.max(-oR, Math.min(oR, Math.round(dy * k)));
      const o = ((oy + oR) * oS + ox + oR) * 4;
      const w = sm.strength * (1 - q2 / r2);   // bord doux : le doigt appuie surtout au centre
      if (w > 0.002 && writable(ctx, x, y)) {
        c0 += (old[o] - c0) * w; c1 += (old[o + 1] - c1) * w; c2 += (old[o + 2] - c2) * w;
        const na = ctx.alphaLock ? a : c3 + (old[o + 3] - c3) * w;   // alpha verrouillé : seule la couleur se mélange
        if (ctx.alphaLock && c3 + (old[o + 3] - c3) * w > 0) { const f = 1 / (c3 + (old[o + 3] - c3) * w); c0 *= f * na; c1 *= f * na; c2 *= f * na; }
        c3 = na;
        if (c3 <= 0.004) { data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0; c0 = c1 = c2 = c3 = 0; }
        else { data[i] = Math.min(255, Math.round(c0 / c3)); data[i + 1] = Math.min(255, Math.round(c1 / c3)); data[i + 2] = Math.min(255, Math.round(c2 / c3)); data[i + 3] = Math.round(c3 * 255); }
      }
    }
    nb[j] = c0; nb[j + 1] = c1; nb[j + 2] = c2; nb[j + 3] = c3;
  }
  sm.spare = old; sm.buf = nb; sm.R = R;
  grow(ctx, cx - R, cy - R, cx + R + 1, cy + R + 1);
}

// Aperçu d'un pinceau : un trait ondulé tracé avec le vrai moteur, en pression qui monte puis redescend.
export const PAINT_GRAINS = ['wash', 'gouache', 'acrylic'];   // grains à opacité variable : aperçu en vraie transparence
export function previewBrush(canvas, spec, sizePx, alpha = 1, trame = null, scale = 1, color = null) {
  const w = canvas.width, h = canvas.height;
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? [1, 3, 5].map(k => parseInt(color.slice(k, k + 2), 16)) : null;
  // une couleur (ni noir ni blanc) ou un pinceau de peinture se peint en RVBA : vraie transparence, pas de gris tramé
  const soft = (!!c && !/^#(000000|ffffff)$/i.test(color)) || PAINT_GRAINS.includes(spec.grainType);
  const layer = { id: 'preview', w, h, data: new Uint8Array(w * h * (soft ? 4 : 1)), dirty: false };
  const ctx = { layer, undo: { touch() {} }, paint: { v: INK, alpha, trame, scale, rgb: c || [0x14, 0x17, 0x1A] }, rgba: soft, mask: null, ox: 0, oy: 0, clip: null, dirty: null, brush: { spec, seed: 11, n: 0, pr: 0.6 } };
  let last = null;
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, x = 10 + t * (w - 20), y = h / 2 + Math.sin(t * Math.PI * 2) * h * 0.22, p = Math.pow(Math.sin(Math.PI * t), 0.6);
    ctx.brush.pr = p;
    let f = 1;
    if (spec.press > 0) f *= (1 - spec.press) + spec.press * (spec.pressMin + (1.6 - spec.pressMin) * p);
    if (spec.start > 0) f *= Math.min(1, 0.3 + t * 25 / spec.start / 3);
    const d = Math.max(1, Math.round(sizePx * f));
    if (last) strokeSegment(ctx, last.x, last.y, x, y, last.d, d); else stampBrush(ctx, Math.round(x), Math.round(y), d, null);
    last = { x, y, d };
  }
  const cx = canvas.getContext('2d'), img = cx.createImageData(w, h), u = new Uint32Array(img.data.buffer);
  if (soft) {
    const o = img.data, dd = layer.data;
    for (let i = 0; i < w * h; i++) {
      const a = dd[i * 4 + 3] / 255, j = i * 4;
      o[j] = Math.round(dd[j] * a + 255 * (1 - a)); o[j + 1] = Math.round(dd[j + 1] * a + 255 * (1 - a)); o[j + 2] = Math.round(dd[j + 2] * a + 255 * (1 - a)); o[j + 3] = 255;
    }
  } else {
    const ink = c ? (0xFF000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0 : 0xFF1A1714;
    for (let i = 0; i < u.length; i++) u[i] = layer.data[i] === 1 ? ink : 0xFFFFFFFF;
  }
  cx.putImageData(img, 0, 0);
}

// ───────────────────────── Formes ─────────────────────────

export function drawRect(ctx, x0, y0, x1, y1, d, filled) {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0], [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  if (filled) { fillBox(ctx, ax, ay, bx, by); return; }
  strokeSegment(ctx, ax, ay, bx, ay, d); strokeSegment(ctx, bx, ay, bx, by, d);
  strokeSegment(ctx, bx, by, ax, by, d); strokeSegment(ctx, ax, by, ax, ay, d);
}

function fillBox(ctx, x0, y0, x1, y1) {
  const data = ensureData(ctx.layer);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(ctx.layer.w - 1, x1); y1 = Math.min(ctx.layer.h - 1, y1);
  ctx.undo.touch(ctx.layer, x0, y0, x1 + 1, y1 + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(ctx, data, x, y);
  grow(ctx, x0, y0, x1 + 1, y1 + 1);
}

export function drawEllipse(ctx, x0, y0, x1, y1, d, filled) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (filled) {
    const data = ensureData(ctx.layer);
    const ya = Math.max(0, Math.floor(cy - ry)), yb = Math.min(ctx.layer.h - 1, Math.ceil(cy + ry));
    const xa = Math.max(0, Math.floor(cx - rx)), xb = Math.min(ctx.layer.w - 1, Math.ceil(cx + rx));
    ctx.undo.touch(ctx.layer, xa, ya, xb + 1, yb + 1);
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const nx = rx ? (x - cx) / rx : 0, ny = ry ? (y - cy) / ry : 0;
      if (nx * nx + ny * ny <= 1) put(ctx, data, x, y);
    }
    grow(ctx, xa, ya, xb + 1, yb + 1);
    return;
  }
  const steps = Math.max(24, Math.ceil(Math.PI * (rx + ry) / Math.max(1, d * 0.5)));
  let px = cx + rx, py = cy;
  for (let i = 1; i <= steps; i++) {
    const a = i / steps * Math.PI * 2, x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
    strokeSegment(ctx, Math.round(px), Math.round(py), Math.round(x), Math.round(y), d);
    px = x; py = y;
  }
}

// ───────────────────────── Remplissage ─────────────────────────

// Région connexe du « même type » que le point de départ : encre (1) ou non-encre (0 ou 2).
// src : valeurs composées de la case (0/1/2), w × h. Renvoie { mask, x0, y0, x1, y1 } ou null.
// gap : largeur en pixels des trous d'un contour qu'on accepte de traverser (0 = contour fermé exigé).
export function floodRegion(src, w, h, sx, sy, gap = 0) {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const isInk = v => v === INK ? 1 : 0;
  const target = isInk(src[sy * w + sx]);
  const r = Math.floor(gap / 2);
  if (r > 0 && !target) return floodClosed(src, w, h, sx, sy, r);
  const mask = new Uint8Array(w * h);
  const stack = [sx, sy];
  let x0 = sx, x1 = sx, y0 = sy, y1 = sy;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (mask[y * w + x] || isInk(src[y * w + x]) !== target) continue;
    let l = x, r = x;
    while (l > 0 && !mask[y * w + l - 1] && isInk(src[y * w + l - 1]) === target) l--;
    while (r < w - 1 && !mask[y * w + r + 1] && isInk(src[y * w + r + 1]) === target) r++;
    for (let i = l; i <= r; i++) mask[y * w + i] = 1;
    if (l < x0) x0 = l; if (r > x1) x1 = r; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inRun = false;
      for (let i = l; i <= r; i++) {
        const ok = !mask[ny * w + i] && isInk(src[ny * w + i]) === target;
        if (ok && !inRun) { stack.push(i, ny); inRun = true; } else if (!ok) inRun = false;
      }
    }
  }
  return { mask, x0, y0, x1, y1 };
}

// Dilatation carrée de rayon r d'un masque 0/1 (fenêtre glissante, une passe par axe).
function dilate(m, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let n = 0; const o = y * w;
    for (let x = 0; x < Math.min(r, w); x++) n += m[o + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) n += m[o + x + r];
      if (x - r - 1 >= 0) n -= m[o + x - r - 1];
      tmp[o + x] = n > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(r, h); y++) n += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) n += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) n -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = n > 0 ? 1 : 0;
    }
  }
  return out;
}

// Remplissage qui traverse les trous : l'encre est épaissie de r pour boucher les contours ouverts, on remplit la zone libre
// atteinte, puis on la regonfle de r (sans entrer dans l'encre) pour qu'elle rejoigne les traits.
function floodClosed(src, w, h, sx, sy, r) {
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = src[i] === INK ? 1 : 0;
  const wall = dilate(ink, w, h, r);
  let seed = sy * w + sx;
  if (wall[seed]) {
    // le clic est tout près d'un trait : on part du point libre le plus proche, mais dans la zone touchée (jamais de
    // l'autre côté du trait) ; une zone plus étroite que le trou à boucher se remplit telle quelle
    const plain = floodRegion(src, w, h, sx, sy, 0);
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, sy - 3 * r); y <= Math.min(h - 1, sy + 3 * r); y++) for (let x = Math.max(0, sx - 3 * r); x <= Math.min(w - 1, sx + 3 * r); x++) {
      const d = (x - sx) ** 2 + (y - sy) ** 2, i = y * w + x;
      if (!wall[i] && plain.mask[i] && d < bd) { bd = d; best = i; }
    }
    if (best < 0) return plain;
    seed = best;
  }
  const core = floodRegion(wall.map(v => v ? INK : 0), w, h, seed % w, (seed / w) | 0, 0);
  const grown = dilate(core.mask, w, h, r);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (grown[i] && !ink[i]) { grown[i] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } else grown[i] = 0;
  }
  return x1 < 0 ? null : { mask: grown, x0, y0, x1, y1 };
}

export function applyRegion(ctx, region) {
  const data = ensureData(ctx.layer), w = ctx.layer.w;
  ctx.undo.touch(ctx.layer, region.x0, region.y0, region.x1 + 1, region.y1 + 1);
  for (let y = region.y0; y <= region.y1; y++) for (let x = region.x0; x <= region.x1; x++) {
    if (region.mask[y * w + x]) put(ctx, data, x, y);
  }
  grow(ctx, region.x0, region.y0, region.x1 + 1, region.y1 + 1);
}

// ───────────────────────── Composition ─────────────────────────

const C_MASK = 0x802B39C0;

// Valeurs composées (0/1/2) d'une case, sans les brouillons : sert au remplissage et à l'export.
// Hors du cadre visible, la valeur est 1 (encre) : un remplissage s'arrête au bord de la case.
// inside : zone où l'on peut remplir, en coordonnées de calque (le cadre par défaut ; avec le fond perdu, un peu plus).
export function compositeValues(panel, includeDraft = false, inside = null) {
  const out = new Uint8Array(panel.ew * panel.eh);
  // calques « référence » visibles : eux seuls guident le remplissage (le dessin de l'auteur reste séparé des aplats)
  const refs = panel.layers.filter(l => l.reference && l.visible && l.data);
  for (const l of refs.length ? refs : panel.layers) {
    if (!l.visible || !l.data || (!l.reference && ((l.draft && !includeDraft) || l.kind === 'color'))) continue;   // le calque « Couleur » ne fait pas barrière au remplissage
    const d = l.data;
    if (bppOf(l) === 4) {   // encre ou trame en couleur : pixel opaque = trait (blanc pur = blanc)
      for (let i = 0, j = 0; i < out.length; i++, j += 4) if (d[j + 3] >= 128) out[i] = d[j] > 240 && d[j + 1] > 240 && d[j + 2] > 240 ? PAPER : INK;
      continue;
    }
    for (let i = 0; i < d.length; i++) if (d[i]) out[i] = d[i];
  }
  const f = inside || { x: panel.x - panel.ex, y: panel.y - panel.ey, w: panel.w, h: panel.h }, x0 = f.x, y0 = f.y;
  for (let y = 0; y < panel.eh; y++) for (let x = 0; x < panel.ew; x++) {
    if (x < x0 || y < y0 || x >= x0 + f.w || y >= y0 + f.h) out[y * panel.ew + x] = INK;
  }
  return out;
}

// Peint le rectangle `r` de la case dans une ImageData (RGBA 32 bits).
//  draft : montrer les brouillons ; opts.solo : id d'un calque à voir seul ;
//  opts.export : l'opacité d'un calque d'encre devient un gris tramé (Bayer 8 × 8), car l'impression est en 1 bit.
// Couleur libre d'un calque d'encre ou de trame : `color` = « #rrggbb » (les brouillons gardent un nom de la palette).
const HEX = /^#[0-9a-f]{6}$/i;
export const tintOf = l => (!l.draft && bppOf(l) === 1 && typeof l.color === 'string' && HEX.test(l.color) ? [1, 3, 5].map(i => parseInt(l.color.slice(i, i + 2), 16)) : null);

// Modes de fusion d'un calque (`l.blend`) : la couleur du calque se combine à ce qu'il recouvre (calques du dessous
// posés sur le papier blanc), puis se pose avec son opacité.
export const BLEND_MODES = [['normal', 'Normal'], ['multiply', 'Produit'], ['screen', 'Écran'], ['overlay', 'Incrustation'], ['darken', 'Obscurcir'], ['lighten', 'Éclaircir'], ['difference', 'Différence']];
function blendCh(m, s, b) {
  switch (m) {
    case 'multiply': return s * b / 255;
    case 'screen': return 255 - (255 - s) * (255 - b) / 255;
    case 'overlay': return b < 128 ? 2 * s * b / 255 : 255 - 2 * (255 - s) * (255 - b) / 255;
    case 'darken': return Math.min(s, b);
    case 'lighten': return Math.max(s, b);
    case 'difference': return Math.abs(s - b);
    default: return s;
  }
}
function paintOver(px, i, cr, cg, cb, a, mode) {
  if (mode && mode !== 'normal') {
    const da = px[i + 3] / 255;   // fond = calques du dessous sur le papier blanc
    cr = blendCh(mode, cr, px[i] * da + 255 * (1 - da)); cg = blendCh(mode, cg, px[i + 1] * da + 255 * (1 - da)); cb = blendCh(mode, cb, px[i + 2] * da + 255 * (1 - da));
  }
  if (a >= 1) { px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = 255; return; }
  const da = px[i + 3] / 255, oa = a + da * (1 - a);
  px[i] = (cr * a + px[i] * da * (1 - a)) / oa; px[i + 1] = (cg * a + px[i + 1] * da * (1 - a)) / oa;
  px[i + 2] = (cb * a + px[i + 2] * da * (1 - a)) / oa; px[i + 3] = oa * 255;
}

// opts.out = { stride, ox, oy } : l'image de sortie ne couvre qu'une partie de l'étendue (le cadre, à l'écran et à l'export) ;
// le pixel (x, y) du calque va en (x − ox, y − oy) d'une image de largeur stride. Sans opts.out : image de la taille de l'étendue.
export function compositeRect(panel, u32, r, draft = true, opts = {}) {
  const w = panel.ew, px = new Uint8ClampedArray(u32.buffer);
  const o = opts.out || { stride: w, ox: 0, oy: 0 }, S = o.stride;
  for (let y = r.y; y < r.y + r.h; y++) u32.fill(0, (y - o.oy) * S + r.x - o.ox, (y - o.oy) * S + r.x - o.ox + r.w);
  const solo = opts.solo ? panel.layers.find(l => l.id === opts.solo) : null;
  for (const l of panel.layers) {
    if (l.kind === 'gradmap') { if (!solo && l.visible) gradientMap(l, px, r, o); continue; }
    if (!l.data || (solo ? l !== solo : !l.visible) || (l.draft && !draft)) continue;
    const alpha = (l.opacity ?? 100) / 100;
    if (alpha <= 0) continue;
    if (bppOf(l) === 4) { compositeColor(l, px, w, r, alpha, o); continue; }
    const rgb = l.draft ? (DRAFT_COLORS[l.color] || DRAFT_COLORS.blue).rgb : (tintOf(l) || [0, 0, 0]);
    const ditherOut = opts.export && !l.draft && alpha < 1, d = l.data;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * w, orow = (y - o.oy) * S - o.ox;
      for (let x = r.x; x < r.x + r.w; x++) {
        const v = d[row + x];
        if (!v) continue;
        let a = alpha;
        if (ditherOut) { if (alpha * 64 <= BAYER8[(y + panel.ey) & 7][(x + panel.ex) & 7]) continue; a = 1; }
        const i = (orow + x) * 4;
        if (v !== INK && l.draft) { if (a >= 1) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; } continue; }   // le blanc d'un brouillon gomme ce qu'il recouvre
        paintOver(px, i, v === INK ? rgb[0] : 255, v === INK ? rgb[1] : 255, v === INK ? rgb[2] : 255, a, l.blend);
      }
    }
  }
}

// Carte de dégradé : ce qui est déjà composé (posé sur le papier blanc) est remplacé par la couleur du dégradé qui
// correspond à sa luminosité, mélangée selon l'opacité et le mode de fusion du calque. Le résultat est opaque.
const lutCache = new WeakMap();
function lutOf(l) {
  const key = JSON.stringify(l.gradient && l.gradient.stops), c = lutCache.get(l);
  if (c && c.key === key) return c.lut;
  const lut = gradientLut((l.gradient && l.gradient.stops) || [[0, '#000000'], [1, '#FFFFFF']]);
  lutCache.set(l, { key, lut });
  return lut;
}
function gradientMap(l, px, r, o) {
  const alpha = (l.opacity ?? 100) / 100, lut = lutOf(l);
  if (alpha <= 0) return;
  for (let y = r.y; y < r.y + r.h; y++) {
    const orow = (y - o.oy) * o.stride - o.ox;
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (orow + x) * 4, a = px[i + 3] / 255;
      const R = px[i] * a + 255 * (1 - a), G = px[i + 1] * a + 255 * (1 - a), B = px[i + 2] * a + 255 * (1 - a);
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;   // aplati sur le papier
      const L = (R * 77 + G * 150 + B * 29) >> 8;
      paintOver(px, i, lut[L * 3], lut[L * 3 + 1], lut[L * 3 + 2], alpha, l.blend);
    }
  }
}

// Calque de couleur : mélange « par-dessus » de ses pixels RVBA, avec l'opacité du calque.
function compositeColor(l, px, w, r, alpha, o) {
  const d = l.data;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const j = (y * w + x) * 4, sa = d[j + 3];
      if (!sa) continue;
      paintOver(px, ((y - o.oy) * o.stride + x - o.ox) * 4, d[j], d[j + 1], d[j + 2], sa / 255 * alpha, l.blend);
    }
  }
}

export function maskRect(mask, u32, r, w, o = { stride: w, ox: 0, oy: 0 }) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    u32[(y - o.oy) * o.stride + x - o.ox] = mask.data && mask.data[y * w + x] ? C_MASK : 0;
  }
}

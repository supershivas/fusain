// Moteur raster 1-bit : annuler par différences de tuiles, pinceaux, formes, remplissage, composition.
// Repris de Pixel Studio (pointeur, remplissage, tramage par Bayer), refait pour de grands canevas :
// un calque est un tampon d'octets, et l'historique ne garde que les tuiles modifiées.
import { ensureData, DRAFT_COLORS } from './model.js';
import { BAYER8 } from './dither.js';

export const TILE = 64;
export const INK = 1, PAPER = 2;

// ───────────────────────── Annuler / rétablir par différences ─────────────────────────

export class UndoStack {
  constructor(limitBytes = 96 * 1024 * 1024) {
    this.stack = []; this.ptr = 0; this.bytes = 0; this.limit = limitBytes;
    this.cur = null; this.onApply = () => {}; this.onChange = () => {};
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
    const data = ensureData(layer);
    layer.dirty = true;
    for (let ty = (y0 / TILE) | 0; ty <= ((y1 - 1) / TILE) | 0; ty++) {
      for (let tx = (x0 / TILE) | 0; tx <= ((x1 - 1) / TILE) | 0; tx++) {
        const key = layer.id + ':' + tx + ',' + ty;
        if (this.cur.tiles.has(key)) continue;
        const px = tx * TILE, py = ty * TILE, tw = Math.min(TILE, layer.w - px), th = Math.min(TILE, layer.h - py);
        const before = new Uint8Array(tw * th);
        for (let y = 0; y < th; y++) before.set(data.subarray((py + y) * layer.w + px, (py + y) * layer.w + px + tw), y * tw);
        this.cur.tiles.set(key, { layer, px, py, tw, th, before });
      }
    }
  }

  // Termine l'action : ne garde que les tuiles réellement modifiées.
  commit() {
    const cur = this.cur; this.cur = null;
    if (!cur) return null;
    const ops = [];
    for (const t of cur.tiles.values()) {
      const data = t.layer.data, after = new Uint8Array(t.tw * t.th);
      let same = true;
      for (let y = 0; y < t.th; y++) {
        const row = data.subarray((t.py + y) * t.layer.w + t.px, (t.py + y) * t.layer.w + t.px + t.tw);
        after.set(row, y * t.tw);
        if (same) for (let x = 0; x < t.tw; x++) if (row[x] !== t.before[y * t.tw + x]) { same = false; break; }
      }
      if (!same) ops.push({ ...t, after });
    }
    if (!ops.length) return null;
    return this._push({ label: cur.label, ops, bytes: ops.reduce((s, o) => s + o.before.length * 2, 0) });
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
    const data = ensureData(t.layer);
    for (let y = 0; y < t.th; y++) data.set(src.subarray(y * t.tw, (y + 1) * t.tw), (t.py + y) * t.layer.w + t.px);
    t.layer.dirty = true;
    this.onApply(t.layer, { x: t.px, y: t.py, w: t.tw, h: t.th });
  }

  undo() {
    if (!this.canUndo) return null;
    const e = this.stack[--this.ptr];
    if (e.ops) for (const t of e.ops) this._write(t, t.before); else e.undo();
    this.onChange();
    return e;
  }
  redo() {
    if (!this.canRedo) return null;
    const e = this.stack[this.ptr++];
    if (e.ops) for (const t of e.ops) this._write(t, t.after); else e.redo();
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

function put(ctx, data, x, y) {
  if (!writable(ctx, x, y)) return;
  const v = paintValue(ctx.paint, x + ctx.ox, y + ctx.oy);
  if (v < 0) return;
  data[y * ctx.layer.w + x] = v;
}

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
  press: 0,            // 0 à 1 : effet de la pression du stylet sur la taille
  pressMin: 0.25,      // taille relative à pression nulle (quand press = 1)
  speed: 0,            // 0 à 1 : le trait s'affine quand le geste va vite
  start: 0,            // départ effilé, en diamètres
  grain: 1,            // couverture 0 à 1 (1 = plein)
  grainType: 'none',   // none | noise | paper | bristle | spray
  grainScale: 1,       // taille d'un grain, en pixels
  scatter: 0,          // dispersion du tampon, en fraction du diamètre
  spacing: 0.2,        // écart des tampons, en diamètres
  smooth: 0,           // stabilisation 0 à 1
};

export const BRUSH_GROUPS = ['Encrage', 'Esquisse', 'Pinceaux', 'Calligraphie', 'Texture'];
const B = (id, name, group, o) => ({ id, name, group, ...o });
export const BUILTIN_BRUSHES = [
  B('stylo', 'Stylo rond', 'Encrage', { sizeMm: 0.5, press: 0.6, pressMin: 0.3 }),
  B('technique', 'Stylo technique', 'Encrage', { sizeMm: 0.3, smooth: 0.25 }),
  B('plume', 'Plume d\'encrage', 'Encrage', { sizeMm: 0.5, press: 0.6, pressMin: 0.35, speed: 0.25, smooth: 0.15 }),
  B('plumeg', 'Plume G (manga)', 'Encrage', { sizeMm: 0.8, press: 0.9, pressMin: 0.1, speed: 0.6, start: 3, smooth: 0.35 }),
  B('brushpen', 'Brush pen', 'Encrage', { sizeMm: 1.5, press: 1, pressMin: 0.08, speed: 0.8, start: 4, smooth: 0.4 }),
  B('hb', 'Crayon HB', 'Esquisse', { sizeMm: 0.6, grain: 0.75, grainType: 'paper', scatter: 0.12, press: 0.4, pressMin: 0.5, spacing: 0.18 }),
  B('6b', 'Crayon 6B', 'Esquisse', { sizeMm: 1.6, grain: 0.6, grainType: 'paper', grainScale: 2, scatter: 0.2, press: 0.5, pressMin: 0.4 }),
  B('mine', 'Mine à plat', 'Esquisse', { sizeMm: 3.5, shape: 'rect', ratio: 0.25, angle: 20, grain: 0.55, grainType: 'paper' }),
  B('rond', 'Pinceau rond', 'Pinceaux', { sizeMm: 2.5, press: 1, pressMin: 0.1, speed: 0.5, start: 2.5, smooth: 0.3 }),
  B('plat', 'Pinceau plat', 'Pinceaux', { sizeMm: 4, shape: 'rect', ratio: 0.35, follow: true }),
  B('sec', 'Pinceau sec', 'Pinceaux', { sizeMm: 4, grainType: 'bristle', grain: 0.55, press: 0.5, pressMin: 0.5, smooth: 0.2 }),
  B('feutre', 'Feutre carré', 'Pinceaux', { sizeMm: 2, shape: 'square', press: 0.3, pressMin: 0.6 }),
  B('plate', 'Plume plate 40°', 'Calligraphie', { sizeMm: 3, shape: 'nib', ratio: 0.16, angle: 40, press: 0.4, pressMin: 0.5 }),
  B('plate2', 'Plume plate suivie', 'Calligraphie', { sizeMm: 2.5, shape: 'nib', ratio: 0.2, follow: true }),
  B('fusain', 'Fusain', 'Texture', { sizeMm: 5, grainType: 'noise', grain: 0.6, scatter: 0.15, press: 0.6, pressMin: 0.4 }),
  B('craie', 'Craie', 'Texture', { sizeMm: 6, grainType: 'paper', grain: 0.5, grainScale: 2, scatter: 0.05, press: 0.5, pressMin: 0.5 }),
  B('spray', 'Aérographe', 'Texture', { sizeMm: 8, grainType: 'spray', grain: 0.5, press: 0.7, pressMin: 0.3 }),
  B('point', 'Pointillé', 'Texture', { sizeMm: 1.2, spacing: 2.4 }),
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
  const dx = dir ? dir.x : 1, dy = dir ? dir.y : 0;
  for (let y = -half; y <= half; y++) for (let x = -half; x <= half; x++) {
    // forme
    let inside;
    if (sp.shape === 'round') inside = x * x + y * y <= ra * ra + 0.25;
    else if (sp.shape === 'square') inside = Math.abs(x) <= ra && Math.abs(y) <= ra;
    else {
      const u = x * ca + y * sa, v = -x * sa + y * ca;
      inside = sp.shape === 'rect' ? Math.abs(u) <= ra && Math.abs(v) <= rb : (u * u) / (ra * ra) + (v * v) / (rb * rb) <= 1;
    }
    if (!inside) continue;
    // grain
    const px = cx + x + ctx.ox, py = cy + y + ctx.oy;
    if (sp.grainType === 'noise') {
      const edge = (x * x + y * y) / (ra * ra + 1);
      if (hash2(Math.floor(px / gs), Math.floor(py / gs)) >= cov * (1 - 0.5 * edge)) continue;
    } else if (sp.grainType === 'paper') {
      const tooth = vnoise(px / (gs * 2.5), py / (gs * 2.5)) * 0.65 + hash2(px, py) * 0.35;
      if (tooth >= cov) continue;
    } else if (sp.grainType === 'bristle') {
      const bristle = Math.floor((x * -dy + y * dx) / (1.4 * gs));
      if (hash2(bristle, br.seed) >= cov) continue;
    }
    put(ctx, data, cx + x, cy + y);
  }
  grow(ctx, cx - half, cy - half, cx + half + 1, cy + half + 1);
}

// Segment avec diamètre interpolé (pression du stylet), tamponné avec ctx.brush s'il y en a un.
export function strokeSegment(ctx, x0, y0, x1, y1, d0, d1 = d0) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const spacing = ctx.brush ? Math.max(0.05, ctx.brush.spec.spacing) : 0.25;
  const step = Math.max(1, Math.min(d0, d1) * spacing);
  const n = Math.max(1, Math.ceil(dist / step));
  const dir = dist > 0 ? { x: (x1 - x0) / dist, y: (y1 - y0) / dist } : null;
  let lx = null, ly = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    if (x === lx && y === ly) continue;
    lx = x; ly = y;
    stampBrush(ctx, x, y, d0 + (d1 - d0) * t, dir);
  }
}

// Aperçu d'un pinceau : un trait ondulé tracé avec le vrai moteur, en pression qui monte puis redescend.
export function previewBrush(canvas, spec, sizePx) {
  const w = canvas.width, h = canvas.height, layer = { id: 'preview', w, h, data: new Uint8Array(w * h), dirty: false };
  const ctx = { layer, undo: { touch() {} }, paint: { v: INK }, mask: null, ox: 0, oy: 0, clip: null, dirty: null, brush: { spec, seed: 11, n: 0, pr: 0.6 } };
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
  for (let i = 0; i < u.length; i++) u[i] = layer.data[i] ? 0xFF1A1714 : 0xFFFFFFFF;
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
  if (wall[seed]) {   // le clic est tout près d'un trait : on part du point libre le plus proche
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, sy - 3 * r); y <= Math.min(h - 1, sy + 3 * r); y++) for (let x = Math.max(0, sx - 3 * r); x <= Math.min(w - 1, sx + 3 * r); x++) {
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (!wall[y * w + x] && d < bd) { bd = d; best = y * w + x; }
    }
    if (best < 0) return floodRegion(src, w, h, sx, sy, 0);
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
export function compositeValues(panel, includeDraft = false) {
  const out = new Uint8Array(panel.ew * panel.eh);
  for (const l of panel.layers) {
    if (!l.visible || !l.data || (l.draft && !includeDraft)) continue;
    const d = l.data;
    for (let i = 0; i < d.length; i++) if (d[i]) out[i] = d[i];
  }
  const x0 = panel.x - panel.ex, y0 = panel.y - panel.ey;
  for (let y = 0; y < panel.eh; y++) for (let x = 0; x < panel.ew; x++) {
    if (x < x0 || y < y0 || x >= x0 + panel.w || y >= y0 + panel.h) out[y * panel.ew + x] = INK;
  }
  return out;
}

// Peint le rectangle `r` de la case dans une ImageData (RGBA 32 bits).
//  draft : montrer les brouillons ; opts.solo : id d'un calque à voir seul ;
//  opts.export : l'opacité d'un calque d'encre devient un gris tramé (Bayer 8 × 8), car l'impression est en 1 bit.
export function compositeRect(panel, u32, r, draft = true, opts = {}) {
  const w = panel.ew, px = new Uint8ClampedArray(u32.buffer);
  for (let y = r.y; y < r.y + r.h; y++) u32.fill(0, y * w + r.x, y * w + r.x + r.w);
  const solo = opts.solo ? panel.layers.find(l => l.id === opts.solo) : null;
  for (const l of panel.layers) {
    if (!l.data || (solo ? l !== solo : !l.visible) || (l.draft && !draft)) continue;
    const alpha = (l.opacity ?? 100) / 100;
    if (alpha <= 0) continue;
    const rgb = l.draft ? (DRAFT_COLORS[l.color] || DRAFT_COLORS.blue).rgb : [0, 0, 0];
    const ditherOut = opts.export && !l.draft && alpha < 1, d = l.data;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * w;
      for (let x = r.x; x < r.x + r.w; x++) {
        const v = d[row + x];
        if (!v) continue;
        let a = alpha;
        if (ditherOut) { if (alpha * 64 <= BAYER8[(y + panel.ey) & 7][(x + panel.ex) & 7]) continue; a = 1; }
        const i = (row + x) * 4;
        if (v !== INK && l.draft) { if (a >= 1) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; } continue; }   // le blanc d'un brouillon gomme ce qu'il recouvre
        const cr = v === INK ? rgb[0] : 255, cg = v === INK ? rgb[1] : 255, cb = v === INK ? rgb[2] : 255;
        if (a >= 1) { px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = 255; continue; }
        const da = px[i + 3] / 255, oa = a + da * (1 - a);
        px[i] = (cr * a + px[i] * da * (1 - a)) / oa; px[i + 1] = (cg * a + px[i + 1] * da * (1 - a)) / oa;
        px[i + 2] = (cb * a + px[i + 2] * da * (1 - a)) / oa; px[i + 3] = oa * 255;
      }
    }
  }
}

export function maskRect(mask, u32, r, w) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    u32[y * w + x] = mask.data && mask.data[y * w + x] ? C_MASK : 0;
  }
}

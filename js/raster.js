// Moteur raster 1-bit : annuler par différences de tuiles, pinceaux, formes, remplissage, composition.
// Repris de Pixel Studio (pointeur, remplissage, tramage par Bayer), refait pour de grands canevas :
// un calque est un tampon d'octets, et l'historique ne garde que les tuiles modifiées.
import { ensureData } from './model.js';

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

// Segment avec diamètre interpolé (pression du stylet).
export function strokeSegment(ctx, x0, y0, x1, y1, d0, d1 = d0) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(1, Math.min(d0, d1) * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  let lx = null, ly = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    if (x === lx && y === ly) continue;
    lx = x; ly = y;
    stampDisc(ctx, x, y, d0 + (d1 - d0) * t);
  }
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
export function floodRegion(src, w, h, sx, sy) {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const isInk = v => v === INK ? 1 : 0;
  const target = isInk(src[sy * w + sx]);
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

export function applyRegion(ctx, region) {
  const data = ensureData(ctx.layer), w = ctx.layer.w;
  ctx.undo.touch(ctx.layer, region.x0, region.y0, region.x1 + 1, region.y1 + 1);
  for (let y = region.y0; y <= region.y1; y++) for (let x = region.x0; x <= region.x1; x++) {
    if (region.mask[y * w + x]) put(ctx, data, x, y);
  }
  grow(ctx, region.x0, region.y0, region.x1 + 1, region.y1 + 1);
}

// ───────────────────────── Composition ─────────────────────────

const C_INK = 0xFF000000, C_PAPER = 0xFFFFFFFF, C_DRAFT = 0xFFDC8C5A, C_MASK = 0x802B39C0;

// Valeurs composées (0/1/2) d'une case, sans les brouillons : sert au remplissage et à l'export.
export function compositeValues(panel, includeDraft = false) {
  const out = new Uint8Array(panel.w * panel.h);
  for (const l of panel.layers) {
    if (!l.visible || !l.data || (l.draft && !includeDraft)) continue;
    const d = l.data;
    for (let i = 0; i < d.length; i++) if (d[i]) out[i] = d[i];
  }
  return out;
}

// Peint le rectangle `r` de la case dans une ImageData (RGBA 32 bits) ; `draft` : montrer les brouillons.
export function compositeRect(panel, u32, r, draft = true) {
  const w = panel.w;
  for (let y = r.y; y < r.y + r.h; y++) {
    const row = y * w;
    for (let x = r.x; x < r.x + r.w; x++) u32[row + x] = 0;
  }
  for (const l of panel.layers) {
    if (!l.visible || !l.data || (l.draft && !draft)) continue;
    const d = l.data, ink = l.draft ? C_DRAFT : C_INK;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * w;
      for (let x = r.x; x < r.x + r.w; x++) {
        const v = d[row + x];
        if (v) u32[row + x] = v === INK ? ink : (l.draft ? 0 : C_PAPER);
      }
    }
  }
}

export function maskRect(mask, u32, r, w) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    u32[y * w + x] = mask.data && mask.data[y * w + x] ? C_MASK : 0;
  }
}

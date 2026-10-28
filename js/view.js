// Vue : une seule toile affiche la page (papier, cases, bulles, aides). Chaque case garde son propre
// canevas, recomposé seulement là où on a dessiné.
import { ed, page, gutterHandles } from './editor.js';
import { pageSize } from './model.js';
import { compositeRect, maskRect } from './raster.js';
import { drawBubble, lineWidth } from './bubbles.js';

export const view = { s: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
let canvas, ctx, raf = 0;
const overlay = { cursor: null, shape: null, free: null, guide: null };
const caches = new WeakMap();

export function attach(el) {
  canvas = el; ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(canvas.parentElement);
  if (document.fonts) document.fonts.addEventListener('loadingdone', requestRender);   // une police de bulle vient d'arriver
  resize();
}

export function resize() {
  if (!canvas) return;
  const r = canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const first = view.w === 0;
  view.w = r.width; view.h = r.height; view.dpr = dpr;
  canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
  if (first && ed.project) fit();
  requestRender();
}

export const pageDims = () => pageSize(ed.project);

export function fit() {
  if (!ed.project || !view.w) return;
  const { w, h } = pageDims(), pad = view.w < 700 ? 8 : 24;
  view.s = Math.min((view.w - pad * 2) / w, (view.h - pad * 2) / h);
  view.ox = (view.w - w * view.s) / 2; view.oy = (view.h - h * view.s) / 2;
  requestRender();
}

export const toPage = (sx, sy) => ({ x: (sx - view.ox) / view.s, y: (sy - view.oy) / view.s });
export const toScreen = (px, py) => ({ x: px * view.s + view.ox, y: py * view.s + view.oy });

export function clampView() {
  const { w, h } = pageDims(), m = 80;
  view.ox = Math.min(view.w - m, Math.max(m - w * view.s, view.ox));
  view.oy = Math.min(view.h - m, Math.max(m - h * view.s, view.oy));
}

export function zoomAt(sx, sy, factor) {
  const { w } = pageDims(), minS = Math.min(view.w / w, 0.5) * 0.4, maxS = 16;
  const s = Math.max(minS, Math.min(maxS, view.s * factor)), k = s / view.s;
  view.ox = sx - (sx - view.ox) * k; view.oy = sy - (sy - view.oy) * k; view.s = s;
  clampView(); requestRender();
}

export function panBy(dx, dy) { view.ox += dx; view.oy += dy; clampView(); requestRender(); }
export function setView(s, ox, oy) {
  const { w } = pageDims(), minS = Math.min(view.w / w, 0.5) * 0.4;
  view.s = Math.max(minS, Math.min(16, s)); view.ox = ox; view.oy = oy; clampView(); requestRender();
}

export function setOverlay(o) { Object.assign(overlay, o); requestRender(); }

// ───────────────────────── Cache des cases ─────────────────────────

function cacheOf(panel) {
  let c = caches.get(panel);
  if (!c || c.w !== panel.w || c.h !== panel.h) {
    const canvasEl = document.createElement('canvas'); canvasEl.width = panel.w; canvasEl.height = panel.h;
    const cx = canvasEl.getContext('2d'), img = cx.createImageData(panel.w, panel.h);
    c = { w: panel.w, h: panel.h, canvas: canvasEl, cx, img, u32: new Uint32Array(img.data.buffer), dirty: { x: 0, y: 0, w: panel.w, h: panel.h },
      mcanvas: null, mcx: null, mimg: null, mu32: null, mdirty: null };
    caches.set(panel, c);
  }
  return c;
}

const union = (a, b) => {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

export function invalidate(panel, rect) {
  const c = cacheOf(panel);
  const r = rect ? { x: Math.max(0, rect.x), y: Math.max(0, rect.y), w: rect.w, h: rect.h } : { x: 0, y: 0, w: panel.w, h: panel.h };
  r.w = Math.min(panel.w - r.x, r.w); r.h = Math.min(panel.h - r.y, r.h);
  if (r.w <= 0 || r.h <= 0) return;
  c.dirty = union(c.dirty, r);
  c.mdirty = union(c.mdirty, r);
  requestRender();
}

export function invalidateLayer(layer, rect) {
  const p = ed.project && page().panels.find(pn => pn.layers.includes(layer) || pn.mask === layer);
  if (p) invalidate(p, rect);
}

export function dropCaches(pg) { for (const p of pg.panels) caches.delete(p); }

function refresh(panel) {
  const c = cacheOf(panel);
  if (c.dirty) {
    compositeRect(panel, c.u32, c.dirty, true);
    c.cx.putImageData(c.img, 0, 0, c.dirty.x, c.dirty.y, c.dirty.w, c.dirty.h);
    c.dirty = null;
  }
  return c;
}

function refreshMask(panel) {
  const c = cacheOf(panel);
  if (!c.mcanvas) {
    c.mcanvas = document.createElement('canvas'); c.mcanvas.width = panel.w; c.mcanvas.height = panel.h;
    c.mcx = c.mcanvas.getContext('2d'); c.mimg = c.mcx.createImageData(panel.w, panel.h);
    c.mu32 = new Uint32Array(c.mimg.data.buffer); c.mdirty = { x: 0, y: 0, w: panel.w, h: panel.h };
  }
  if (c.mdirty) {
    maskRect(panel.mask, c.mu32, c.mdirty, panel.w);
    c.mcx.putImageData(c.mimg, 0, 0, c.mdirty.x, c.mdirty.y, c.mdirty.w, c.mdirty.h);
    c.mdirty = null;
  }
  return c.mcanvas;
}

// ───────────────────────── Dessin ─────────────────────────

export function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function render() {
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css('--stage-bg') || '#e9e7e2';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ed.project) return;
  const pg = page(), { w, h } = pageDims(), s = view.s, dpr = view.dpr;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.ox, dpr * view.oy);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 14 * dpr / s; ctx.shadowOffsetY = 3 * dpr / s;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.restore();

  ctx.imageSmoothingEnabled = s < 1;
  const lw = lineWidth(ed.project.dpi);
  for (const p of pg.panels) {
    const c = refresh(p);
    ctx.drawImage(c.canvas, p.x, p.y);
    if (p.mask && ed.maskMode !== 'off' || (p.mask && ed.tool === 'mask')) {
      if (p.id === ed.panelId) { ctx.imageSmoothingEnabled = s < 1; ctx.drawImage(refreshMask(p), p.x, p.y); }
    }
    ctx.strokeStyle = '#000'; ctx.lineWidth = lw * 1.5; ctx.strokeRect(p.x, p.y, p.w, p.h);
  }
  for (const b of pg.bubbles) drawBubble(ctx, b, ed.project.dpi);

  // aides, en pixels d'écran
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const accent = css('--accent') || '#C0392B';
  const active = pg.panels.find(p => p.id === ed.panelId);
  if (active && ed.tool !== 'bubble') {
    const a = toScreen(active.x, active.y);
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.strokeRect(a.x - 3, a.y - 3, active.w * s + 6, active.h * s + 6);
  }
  if (ed.showNotes) drawNotes(pg);
  drawBubbleSelection(pg, accent);
  drawShapePreview(accent);
  if (ed.tool === 'layout') drawGutters(pg, accent);
  if (overlay.free && overlay.free.length > 1) {
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath();
    overlay.free.forEach((q, i) => { const a = toScreen(q.x, q.y); i ? ctx.lineTo(a.x, a.y) : ctx.moveTo(a.x, a.y); });
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  }
  if (overlay.cursor && overlay.cursor.r > 0) {
    const c = overlay.cursor;
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(c.x, c.y, c.r + 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(c.x, c.y, c.r - 0.5, 0, Math.PI * 2); ctx.stroke();
  }
}

// Plan et description de la case (aide au dessin, jamais exportés).
function drawNotes(pg) {
  ctx.font = "500 12px 'Inter', sans-serif"; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const p of pg.panels) {
    const label = [p.note.plan, p.note.description].filter(Boolean).join(' — ');
    if (!label) continue;
    const a = toScreen(p.x, p.y), maxW = Math.max(40, p.w * view.s - 16);
    let t = label;
    while (t.length > 3 && ctx.measureText(t).width > maxW - 14) t = t.slice(0, -2);
    if (t !== label) t = t.trimEnd() + '…';
    const tw = ctx.measureText(t).width + 14;
    ctx.fillStyle = 'rgba(28,28,30,.78)'; ctx.beginPath(); ctx.roundRect(a.x + 6, a.y + 6, tw, 22, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(t, a.x + 13, a.y + 17.5);
  }
}

function drawBubbleSelection(pg, accent) {
  const b = pg.bubbles.find(x => x.id === ed.bubbleId);
  if (!b) return;
  const tl = toScreen(b.x, b.y), br = toScreen(b.x + b.w, b.y + b.h);
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  ctx.strokeRect(tl.x - 4, tl.y - 4, br.x - tl.x + 8, br.y - tl.y + 8); ctx.setLineDash([]);
  const handle = (p, icon) => {
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    if (icon) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
  };
  handle(br, true);
  if (b.tail) handle(toScreen(b.tail.x, b.tail.y), true);
}

function drawShapePreview(accent) {
  const sh = overlay.shape;
  if (!sh) return;
  const a = toScreen(sh.x0, sh.y0), b = toScreen(sh.x1, sh.y1);
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
  if (sh.kind === 'line') { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  else if (sh.kind === 'rect') ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
  ctx.stroke(); ctx.setLineDash([]);
}

// Poignées des gouttières : un trait le long de chaque gouttière et une tirette en son milieu.
function drawGutters(pg, accent) {
  const g = overlay.guide;
  for (const h of gutterHandles()) {
    const v = h.axis === 'v', a = toScreen(v ? h.pos : h.span[0], v ? h.span[0] : h.pos), b = toScreen(v ? h.pos : h.span[1], v ? h.span[1] : h.pos);
    ctx.strokeStyle = accent; ctx.globalAlpha = 0.35; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, w = v ? 16 : 44, hh = v ? 44 : 16;
    ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect(mx - w / 2, my - hh / 2, w, hh, 8); ctx.fill();
    ctx.fillStyle = '#fff';
    for (const k of [-1, 0, 1]) { ctx.beginPath(); ctx.arc(v ? mx : mx + k * 10, v ? my + k * 10 : my, 2, 0, Math.PI * 2); ctx.fill(); }
  }
  if (g) {
    const v = g.axis === 'v', a = toScreen(v ? g.pos : g.s0, v ? g.s0 : g.pos), b = toScreen(v ? g.pos : g.s1, v ? g.s1 : g.pos);
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
  }
}

export const canvasEl = () => canvas;

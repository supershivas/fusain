// Vue : une seule toile affiche la page (papier, cases, bulles, aides). Chaque case garde son propre
// canevas, recomposé seulement là où on a dessiné.
import { ed, page, gutterHandles, splitRects, mergeCandidates } from './editor.js';
import { pageSize, panelStroke, mmToPx } from './model.js';
import { compositeRect, maskRect } from './raster.js';
import { drawPageBubble, tailOrigin, bubbleToPage } from './bubbles.js';
import { drawFolio } from './export.js';
import { guideMode, guideHandles, ISO_DIRS } from './guides.js';

// r : rotation de la page à l'écran (radians, autour de l'origine ox, oy) ; moved : l'utilisateur a zoomé, tourné ou déplacé la page
export const view = { s: 1, ox: 0, oy: 0, r: 0, w: 0, h: 0, dpr: 1, moved: false };
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
  if ((first || !view.moved) && ed.project) fit();   // tant qu'on n'a pas bougé la page, elle suit la taille de la zone
  requestRender();
}

export const pageDims = () => pageSize(ed.project);

// Mode case (ed.focus) : la case ouverte est le seul canevas ; la vue s'ajuste et se borne à son cadre.
export const focusPanel = () => (ed.focus && ed.project ? page().panels.find(p => p.id === ed.panelId) || null : null);
export function viewBounds() {
  const f = focusPanel();
  if (f) return { x: f.x, y: f.y, w: f.w, h: f.h };
  const { w, h } = pageDims();
  return { x: 0, y: 0, w, h };
}
const minScale = () => Math.min(view.w / viewBounds().w, 0.5) * 0.4;
export { minScale };

export function fit() {
  if (!ed.project || !view.w) return;
  const b = viewBounds(), pad = view.w < 700 ? 8 : 24;
  view.moved = false; view.r = 0;
  view.s = Math.min((view.w - pad * 2) / b.w, (view.h - pad * 2) / b.h);
  view.ox = (view.w - b.w * view.s) / 2 - b.x * view.s; view.oy = (view.h - b.h * view.s) / 2 - b.y * view.s;
  requestRender();
}

export const toPage = (sx, sy) => {
  const dx = (sx - view.ox) / view.s, dy = (sy - view.oy) / view.s;
  if (!view.r) return { x: dx, y: dy };
  const c = Math.cos(view.r), s = Math.sin(view.r);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
};
export const toScreen = (px, py) => {
  if (!view.r) return { x: px * view.s + view.ox, y: py * view.s + view.oy };
  const c = Math.cos(view.r), s = Math.sin(view.r);
  return { x: (px * c - py * s) * view.s + view.ox, y: (px * s + py * c) * view.s + view.oy };
};

export function clampView() {
  const { x: bx, y: by, w, h } = viewBounds(), m = 80;
  if (view.r) {   // page tournée : comme sans rotation, la page doit rester visible (marge m) ; on ne la déplace que si elle est perdue
    const c = Math.cos(view.r), sn = Math.sin(view.r), pc = toPage(view.w / 2, view.h / 2);
    const hx = Math.max(0, view.w / 2 - m) / view.s, hy = Math.max(0, view.h / 2 - m) / view.s;   // zone visible réduite de m, exprimée dans la page
    const dx = pc.x - bx - w / 2, dy = pc.y - by - h / 2, ux = c, uy = -sn, vx = sn, vy = c;   // axes de l'écran dans la page
    const apart = Math.abs(dx) > w / 2 + hx * Math.abs(ux) + hy * Math.abs(vx)
      || Math.abs(dy) > h / 2 + hx * Math.abs(uy) + hy * Math.abs(vy)
      || Math.abs(dx * ux + dy * uy) > w / 2 * Math.abs(ux) + h / 2 * Math.abs(uy) + hx
      || Math.abs(dx * vx + dy * vy) > w / 2 * Math.abs(vx) + h / 2 * Math.abs(vy) + hy;
    if (apart) {   // page perdue : on ramène le centre de la zone sur la page
      const a = toScreen(Math.min(bx + w, Math.max(bx, pc.x)), Math.min(by + h, Math.max(by, pc.y)));
      view.ox += view.w / 2 - a.x; view.oy += view.h / 2 - a.y;
    }
    return;
  }
  view.ox = Math.min(view.w - m - bx * view.s, Math.max(m - (bx + w) * view.s, view.ox));
  view.oy = Math.min(view.h - m - by * view.s, Math.max(m - (by + h) * view.s, view.oy));
}

export function zoomAt(sx, sy, factor) {
  const minS = minScale(), maxS = 16;
  const s = Math.max(minS, Math.min(maxS, view.s * factor)), k = s / view.s;
  view.ox = sx - (sx - view.ox) * k; view.oy = sy - (sy - view.oy) * k; view.s = s;
  view.moved = true;
  clampView(); requestRender();
}

// Tourne la page d'un quart de tour (ou de `rad`) autour du centre de la zone ; sans argument, remet la page droite.
export function rotateView(rad) {
  const cx = view.w / 2, cy = view.h / 2, p = toPage(cx, cy);
  let r = rad === undefined ? 0 : view.r + rad;
  r = ((r + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const c = Math.cos(r), s = Math.sin(r);
  view.r = r; view.ox = cx - (p.x * c - p.y * s) * view.s; view.oy = cy - (p.x * s + p.y * c) * view.s; view.moved = true;
  clampView(); requestRender();
}

export function panBy(dx, dy) { view.ox += dx; view.oy += dy; view.moved = true; clampView(); requestRender(); }
export function setView(s, ox, oy, r = view.r) {
  const minS = minScale();
  view.r = r;
  view.s = Math.max(minS, Math.min(16, s)); view.ox = ox; view.oy = oy; view.moved = true; clampView(); requestRender();
}

export function setOverlay(o) { Object.assign(overlay, o); requestRender(); }

// ───────────────────────── Cache des cases ─────────────────────────

function cacheOf(panel) {
  let c = caches.get(panel);
  if (!c || c.w !== panel.ew || c.h !== panel.eh) {
    const canvasEl = document.createElement('canvas'); canvasEl.width = panel.ew; canvasEl.height = panel.eh;
    const cx = canvasEl.getContext('2d'), img = cx.createImageData(panel.ew, panel.eh);
    c = { w: panel.ew, h: panel.eh, canvas: canvasEl, cx, img, u32: new Uint32Array(img.data.buffer), dirty: { x: 0, y: 0, w: panel.ew, h: panel.eh },
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
  const r = rect ? { x: Math.max(0, rect.x), y: Math.max(0, rect.y), w: rect.w, h: rect.h } : { x: 0, y: 0, w: panel.ew, h: panel.eh };
  r.w = Math.min(panel.ew - r.x, r.w); r.h = Math.min(panel.eh - r.y, r.h);
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
    compositeRect(panel, c.u32, c.dirty, true, { solo: ed.solo });
    c.cx.putImageData(c.img, 0, 0, c.dirty.x, c.dirty.y, c.dirty.w, c.dirty.h);
    c.dirty = null;
  }
  return c;
}

function refreshMask(panel) {
  const c = cacheOf(panel);
  if (!c.mcanvas) {
    c.mcanvas = document.createElement('canvas'); c.mcanvas.width = panel.ew; c.mcanvas.height = panel.eh;
    c.mcx = c.mcanvas.getContext('2d'); c.mimg = c.mcx.createImageData(panel.ew, panel.eh);
    c.mu32 = new Uint32Array(c.mimg.data.buffer); c.mdirty = { x: 0, y: 0, w: panel.ew, h: panel.eh };
  }
  if (c.mdirty) {
    maskRect(panel.mask, c.mu32, c.mdirty, panel.ew);
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

// Éléments HTML posés sur la page (barre flottante des bulles, saisie du texte) : repositionnés après chaque image.
export const hooks = {};
export function render() { renderFrame(); if (hooks.afterRender) hooks.afterRender(); }
function renderFrame() {
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css('--stage-bg') || '#e9e7e2';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ed.project) return;
  const pg = page(), { w, h } = pageDims(), s = view.s, dpr = view.dpr;
  const cr = Math.cos(view.r), sr = Math.sin(view.r);
  ctx.setTransform(dpr * s * cr, dpr * s * sr, -dpr * s * sr, dpr * s * cr, dpr * view.ox, dpr * view.oy);

  const fp = focusPanel(), bounds = viewBounds();
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 14 * dpr / s; ctx.shadowOffsetY = 3 * dpr / s;
  ctx.fillStyle = '#fff'; ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  ctx.restore();

  ctx.imageSmoothingEnabled = s < 1;
  for (const p of fp ? [fp] : pg.panels) {
    const c = refresh(p);
    ctx.drawImage(c.canvas, p.x - p.ex, p.y - p.ey, p.w, p.h, p.x, p.y, p.w, p.h);
    if (p.mask && ed.maskMode !== 'off' || (p.mask && ed.tool === 'mask')) {
      if (p.id === ed.panelId) { ctx.imageSmoothingEnabled = s < 1; ctx.drawImage(refreshMask(p), p.x - p.ex, p.y - p.ey, p.w, p.h, p.x, p.y, p.w, p.h); }
    }
    if (ed.sel && ed.sel.panelId === p.id) drawSelection(p, ed.sel);
    const bw = mmToPx(panelStroke(p), ed.project.dpi);
    if (bw > 0) { ctx.strokeStyle = '#000'; ctx.lineWidth = bw; ctx.strokeRect(p.x, p.y, p.w, p.h); }
  }
  if (!pg.bubblesHidden) {
    // mode case : seules les bulles qui touchent la case, rognées à son cadre
    if (fp) { ctx.save(); ctx.beginPath(); ctx.rect(fp.x, fp.y, fp.w, fp.h); ctx.clip(); }
    for (const b of pg.bubbles) if (!b.hidden && (!fp || b.panel === fp.id)) drawPageBubble(ctx, b, ed.project.dpi, pg.panels);
    if (fp) {
      ctx.restore();
      const bw = mmToPx(panelStroke(fp), ed.project.dpi);
      if (bw > 0) { ctx.strokeStyle = '#000'; ctx.lineWidth = bw; ctx.strokeRect(fp.x, fp.y, fp.w, fp.h); }
    }
  }

  if (!fp) drawFolio(ctx, ed.project, ed.pageIdx);
  drawSymmetry(fp || pg.panels.find(p => p.id === ed.panelId));
  drawGuides(pg);

  // aides, en pixels d'écran
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const accent = css('--accent') || '#C0392B';
  const active = pg.panels.find(p => p.id === ed.panelId);
  if (active && ed.tool !== 'bubble' && !fp) {
    const m = toScreen(active.x + active.w / 2, active.y + active.h / 2);
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(view.r);
    ctx.strokeRect(-active.w * s / 2 - 3, -active.h * s / 2 - 3, active.w * s + 6, active.h * s + 6); ctx.restore();
  }
  const selPanel = ed.sel && pg.panels.find(q => q.id === ed.sel.panelId);
  if (selPanel && ed.tool === 'select') {   // cadre pointillé autour de la sélection
    const S = ed.sel, sc = S.scale, bx0 = selPanel.ex + (sc ? sc.x : S.x0 + S.dx), by0 = selPanel.ey + (sc ? sc.y : S.y0 + S.dy);
    const bx1 = bx0 + (sc ? sc.w : S.x1 - S.x0), by1 = by0 + (sc ? sc.h : S.y1 - S.y0);
    const corners = [toScreen(bx0, by0), toScreen(bx1, by0), toScreen(bx1, by1), toScreen(bx0, by1)];   // la page peut être tournée
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath();
    corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    if (!S.dx && !S.dy) {   // poignées : coins et milieux des côtés
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const hs = [...corners, mid(corners[0], corners[1]), mid(corners[1], corners[2]), mid(corners[2], corners[3]), mid(corners[3], corners[0])];
      ctx.fillStyle = '#fff'; ctx.lineWidth = 2;
      for (const q of hs) { ctx.beginPath(); ctx.rect(q.x - 6, q.y - 6, 12, 12); ctx.fill(); ctx.stroke(); }
    }
  }
  if (ed.showNotes) drawNotes(pg, fp);
  drawBubbleSelection(pg, accent);
  drawShapePreview(accent);
  if (ed.tool === 'layout') drawGutters(pg, accent);
  if (overlay.free && overlay.free.length > 1) {
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath();
    overlay.free.forEach((q, i) => { const a = toScreen(q.x, q.y); i ? ctx.lineTo(a.x, a.y) : ctx.moveTo(a.x, a.y); });
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  }
  if (overlay.free && overlay.dots) {   // sommets d'un polygone en cours
    ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2;
    for (const q of overlay.free) { const a = toScreen(q.x, q.y); ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }
  if (overlay.cursor && overlay.cursor.r > 0) {
    const c = overlay.cursor;
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(c.x, c.y, c.r + 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(c.x, c.y, c.r - 0.5, 0, Math.PI * 2); ctx.stroke();
  }
}

// Axes de symétrie de la case active (dessin en miroir), en pointillés : jamais exportés.
const SYM_TOOLS = ['pencil', 'eraser', 'shape'];
function drawSymmetry(p) {
  if (!p || !ed.symmetry || ed.symmetry === 'off' || !SYM_TOOLS.includes(ed.tool)) return;
  const s = view.s, cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  ctx.save();
  ctx.strokeStyle = css('--accent') || '#C0392B'; ctx.lineWidth = 1.5 / s; ctx.setLineDash([8 / s, 6 / s]);
  ctx.beginPath();
  if (ed.symmetry.includes('v')) { ctx.moveTo(cx, p.y); ctx.lineTo(cx, p.y + p.h); }
  if (ed.symmetry.includes('h')) { ctx.moveTo(p.x, cy); ctx.lineTo(p.x + p.w, cy); }
  ctx.stroke();
  ctx.restore();
}

// Guides de tracé (règle, points de fuite) : lignes fines et poignées, jamais exportés.
function drawGuides(pg) {
  const mode = guideMode(pg);
  if (mode === 'off' || !SYM_TOOLS.includes(ed.tool)) return;
  const g = pg.guide, s = view.s, { w, h } = pageDims(), L = Math.hypot(w, h) * 2, accent = css('--accent') || '#C0392B';
  const line = (x, y, ux, uy) => { ctx.moveTo(x - ux * L, y - uy * L); ctx.lineTo(x + ux * L, y + uy * L); };
  ctx.save();
  ctx.beginPath(); ctx.rect(-w, -h, 3 * w, 3 * h); ctx.clip();
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5 / s;
  if (mode === 'ruler') {
    const r = g.ruler, n = Math.hypot(r.x1 - r.x0, r.y1 - r.y0) || 1;
    ctx.globalAlpha = 0.5; ctx.setLineDash([10 / s, 6 / s]); ctx.beginPath(); line(r.x0, r.y0, (r.x1 - r.x0) / n, (r.y1 - r.y0) / n); ctx.stroke();
    ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineWidth = 3 / s; ctx.beginPath(); ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); ctx.stroke();
  } else if (mode === 'iso') {   // grille isométrique au pas de 10 mm
    const step = mmToPx(10, ed.project.dpi);
    ctx.globalAlpha = 0.22; ctx.lineWidth = 1 / s; ctx.beginPath();
    for (const u of ISO_DIRS) {
      const nx = -u.y, ny = u.x, span = Math.abs(nx) * w + Math.abs(ny) * h;   // pas mesuré perpendiculairement aux lignes
      for (let t = -span; t <= span; t += step) line(w / 2 + nx * t, h / 2 + ny * t, u.x, u.y);
    }
    ctx.stroke();
  } else {
    const vps = mode === 'persp1' ? [g.vps[0]] : mode === 'persp2' ? g.vps.slice(0, 2) : g.vps;
    ctx.globalAlpha = 0.5; ctx.setLineDash([10 / s, 6 / s]); ctx.beginPath();   // ligne d'horizon
    if (mode === 'persp1') line(vps[0].x, vps[0].y, 1, 0);   // persp2 et persp3 : la ligne passe par les deux premiers points
    else { const n = Math.hypot(vps[1].x - vps[0].x, vps[1].y - vps[0].y) || 1; line(vps[0].x, vps[0].y, (vps[1].x - vps[0].x) / n, (vps[1].y - vps[0].y) / n); }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 0.18; ctx.lineWidth = 1 / s; ctx.beginPath();   // rayons de fuite
    for (const v of vps) for (let k = 0; k < 24; k++) { const a = k * Math.PI / 12; ctx.moveTo(v.x, v.y); ctx.lineTo(v.x + Math.cos(a) * L, v.y + Math.sin(a) * L); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 2 / s; ctx.fillStyle = '#fff';
  for (const hd of guideHandles(pg)) { ctx.beginPath(); ctx.arc(hd.x, hd.y, (hd.key === 'rm' ? 7 : 10) / s, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}

// Pipette : couleur composée de la case sous le point d'écran (sx, sy), sur fond blanc ; null hors des cases.
export function colorAt(sx, sy) {
  if (!ed.project) return null;
  const q = toPage(sx, sy), fp = focusPanel();
  const p = (fp ? [fp] : page().panels).find(c => q.x >= c.x && q.y >= c.y && q.x < c.x + c.w && q.y < c.y + c.h);
  if (!p) return null;
  // un doigt vise mal un trait fin : on regarde un petit voisinage (3 px d'écran) et on prend le pixel le plus couvert
  const r = Math.max(1, Math.round(3 / view.s)), cx = Math.floor(q.x - p.ex), cy = Math.floor(q.y - p.ey);
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r), w = Math.min(p.ew, cx + r + 1) - x0, h = Math.min(p.eh, cy + r + 1) - y0;
  if (w <= 0 || h <= 0) return null;
  const d = refresh(p).cx.getImageData(x0, y0, w, h).data;
  let best = -1, bd = Infinity;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const px = (i / 4) % w + x0 - cx, py = Math.floor(i / 4 / w) + y0 - cy, score = (255 - d[i + 3]) * 4 + px * px + py * py;   // le plus opaque, puis le plus proche
    if (score < bd) { bd = score; best = i; }
  }
  if (best < 0) return '#FFFFFF';
  const a = d[best + 3] / 255, ch = k => Math.round(d[best + k] * a + 255 * (1 - a)).toString(16).padStart(2, '0');
  return ('#' + ch(0) + ch(1) + ch(2)).toUpperCase();
}

// Sélection : voile et contour (octets 0/1 → pixels), mis en cache sur l'objet sélection ; le contenu soulevé se montre par-dessus.
function selTint(sel) {
  if (sel.tint) return sel.tint;
  const bw = sel.x1 - sel.x0, bh = sel.y1 - sel.y0, W = sel.ew, cv = document.createElement('canvas');
  cv.width = bw; cv.height = bh;
  const cx = cv.getContext('2d'), img = cx.createImageData(bw, bh), u = new Uint32Array(img.data.buffer);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = (sel.y0 + y) * W + sel.x0 + x;
    if (!sel.mask[i]) continue;
    const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1 || !sel.mask[i - 1] || !sel.mask[i + 1] || !sel.mask[i - W] || !sel.mask[i + W];
    u[y * bw + x] = edge ? 0xFF2B39C0 : 0x302B39C0;
  }
  cx.putImageData(img, 0, 0);
  return (sel.tint = cv);
}

function drawSelection(p, sel) {
  ctx.save();
  ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  const f = ed.selFloat;
  const sc = sel.scale;   // redimensionnement en cours : le contenu soulevé et la teinte remplissent le nouveau rectangle
  if (f && sc) ctx.drawImage(f.canvas, p.ex + sc.x, p.ey + sc.y, sc.w, sc.h);
  else if (f) ctx.drawImage(f.canvas, p.ex + f.bx + sel.dx, p.ey + f.by + sel.dy);
  if (ed.tool === 'select' && sc) ctx.drawImage(selTint(sel), p.ex + sc.x, p.ey + sc.y, sc.w, sc.h);
  else if (ed.tool === 'select') ctx.drawImage(selTint(sel), p.ex + sel.x0 + sel.dx, p.ey + sel.y0 + sel.dy);
  ctx.restore();
}

// Plan et description de la case (aide au dessin, jamais exportés).
function drawNotes(pg, fp) {
  ctx.font = "500 12px 'Inter', sans-serif"; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const p of fp ? [fp] : pg.panels) {
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

// Position écran de la croix de suppression d'une bulle : au-dessus de son coin haut droit.
export function bubbleCross(b) { const c = bubbleToPage(b, b.x + b.w, b.y), q = toScreen(c.x, c.y); return { x: q.x + 4, y: q.y - 22 }; }
// Coin bas droit (taille) et poignée de rotation (au-dessus du milieu du bord haut, dans l'axe de la bulle), en pixels d'écran.
export function bubbleCorner(b) { const c = bubbleToPage(b, b.x + b.w, b.y + b.h); return toScreen(c.x, c.y); }
export function bubbleRotHandle(b) {
  const c = bubbleToPage(b, b.x + b.w / 2, b.y), q = toScreen(c.x, c.y), a = (b.rot || 0) * Math.PI / 180 + view.r;
  return { x: q.x + Math.sin(a) * 34, y: q.y - Math.cos(a) * 34 };
}

function drawBubbleSelection(pg, accent) {
  const b = pg.bubbles.find(x => x.id === ed.bubbleId);
  if (!b || b.hidden || pg.bubblesHidden) return;
  const mc = toScreen(b.x + b.w / 2, b.y + b.h / 2), sw = b.w * view.s, sh = b.h * view.s;
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  ctx.save(); ctx.translate(mc.x, mc.y); ctx.rotate((b.rot || 0) * Math.PI / 180 + view.r);
  ctx.strokeRect(-sw / 2 - 4, -sh / 2 - 4, sw + 8, sh + 8); ctx.restore(); ctx.setLineDash([]);
  const handle = (p, icon) => {
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    if (icon) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
  };
  handle(bubbleCorner(b), true);
  const rh = bubbleRotHandle(b), top = toScreen(...Object.values(bubbleToPage(b, b.x + b.w / 2, b.y)));   // poignée de rotation, reliée au bord haut
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(rh.x, rh.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(rh.x, rh.y, 4.5, -2.4, 1.2); ctx.stroke();
  if (b.tail) handle(toScreen(b.tail.x, b.tail.y), true);
  const x = bubbleCross(b);   // petite croix : supprimer la bulle
  ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x.x, x.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x.x - 4, x.y - 4); ctx.lineTo(x.x + 4, x.y + 4); ctx.moveTo(x.x + 4, x.y - 4); ctx.lineTo(x.x - 4, x.y + 4); ctx.stroke();
  const o = tailOrigin(b);   // origine de la queue : carré, à faire glisser le long du contour
  if (o) {
    const q = toScreen(o.x, o.y);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.roundRect(q.x - 7, q.y - 7, 14, 14, 3); ctx.fill(); ctx.stroke();
  }
}

function drawShapePreview(accent) {
  const sh = overlay.shape;
  if (!sh) return;
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
  const pts = [];   // contour en coordonnées de page, tracé en pixels d'écran (la page peut être tournée)
  if (sh.kind === 'line') pts.push([sh.x0, sh.y0], [sh.x1, sh.y1]);
  else if (sh.kind === 'rect') pts.push([sh.x0, sh.y0], [sh.x1, sh.y0], [sh.x1, sh.y1], [sh.x0, sh.y1], [sh.x0, sh.y0]);
  else for (let i = 0; i <= 48; i++) { const t = i / 48 * Math.PI * 2; pts.push([(sh.x0 + sh.x1) / 2 + Math.cos(t) * (sh.x1 - sh.x0) / 2, (sh.y0 + sh.y1) / 2 + Math.sin(t) * (sh.y1 - sh.y0) / 2]); }
  pts.forEach(([x, y], i) => { const q = toScreen(x, y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
  ctx.stroke(); ctx.setLineDash([]);
}

// Les quatre « + » de la case active : un par bord, posés dans la case, au milieu du bord, pour y ajouter une case de ce côté.
const SIDES = { left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1] };
export function edgePluses(p) {
  const c = toScreen(p.x + p.w / 2, p.y + p.h / 2);
  return Object.entries(SIDES).map(([side, [fx, fy]]) => {
    const e = toScreen(p.x + p.w * fx, p.y + p.h * fy), d = Math.hypot(c.x - e.x, c.y - e.y) || 1, k = Math.min(30, d * 0.45);
    return { side, x: e.x + (c.x - e.x) / d * k, y: e.y + (c.y - e.y) / d * k, r: 15 };
  });
}

// Boutons de fusion : un par case voisine absorbable, posé au centre de cette case (la case active l'absorbe). Flèche vers la case active.
export function mergeButtons(ap) {
  const ps = page().panels, c = toScreen(ap.x + ap.w / 2, ap.y + ap.h / 2);
  return mergeCandidates(ap).map(m => {
    const b = ps.find(p => p.id === m.id), q = toScreen(b.x + b.w / 2, b.y + b.h / 2), dx = c.x - q.x, dy = c.y - q.y, d = Math.hypot(dx, dy) || 1;
    return { id: m.id, x: q.x, y: q.y, r: 22, ux: dx / d, uy: dy / d, index: m.index };
  });
}

// Aperçu d'ajout de case : poignée sur la ligne pointillée (elle règle la part de la nouvelle case) et pilule ✕ ✓ au centre de la nouvelle case
// (au centre de la case coupée si la nouvelle est trop étroite à l'écran). Positions en pixels d'écran ; `line` = position de la ligne dans la page.
export function previewControls(ap) {
  const pv = ed.addPreview;
  if (!pv || pv.panelId !== ap.id) return null;
  const sp = splitRects(ap, pv.side, ed.addRatio / 100);
  if (!sp) return null;
  const f = sp.fresh, horiz = pv.side === 'left' || pv.side === 'right';
  const line = { right: f.x, left: f.x + f.w, bottom: f.y, top: f.y + f.h }[pv.side];
  const hp = horiz ? toScreen(line, f.y + f.h / 2) : toScreen(f.x + f.w / 2, line);
  const room = f.w * view.s >= 130 && f.h * view.s >= 70, r = room ? f : sp.old;
  const c = toScreen(r.x + r.w / 2, r.y + r.h / 2);
  return { side: pv.side, horiz, line, fresh: f, handle: { x: hp.x, y: hp.y, r: 22 }, ok: { x: c.x + 27, y: c.y, r: 22 }, no: { x: c.x - 27, y: c.y, r: 22 } };
}

// Poignées des gouttières : un trait le long de chaque gouttière, une tirette en son milieu et un « + » pour ajouter une case.
function drawGutters(pg, accent) {
  const g = overlay.guide;
  const adding = !!(ed.addPreview && ed.addPreview.panelId === ed.panelId);   // pendant un ajout de case, les poignées de gouttière sont masquées
  for (const h of adding ? [] : gutterHandles()) {
    const v = h.axis === 'v', a = toScreen(v ? h.pos : h.span[0], v ? h.span[0] : h.pos), b = toScreen(v ? h.pos : h.span[1], v ? h.span[1] : h.pos);
    ctx.strokeStyle = accent; ctx.globalAlpha = 0.35; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, w = v ? 16 : 44, hh = v ? 44 : 16;
    ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect(mx - w / 2, my - hh / 2, w, hh, 8); ctx.fill();
    ctx.fillStyle = '#fff';
    for (const k of [-1, 0, 1]) { ctx.beginPath(); ctx.arc(v ? mx : mx + k * 10, v ? my + k * 10 : my, 2, 0, Math.PI * 2); ctx.fill(); }
  }
  const ap = pg.panels.find(p => p.id === ed.panelId);
  if (ap && !g) {   // pas de « + » pendant qu'on déplace une gouttière
    const pv = ed.addPreview && ed.addPreview.panelId === ap.id ? ed.addPreview : null, sp = pv && splitRects(ap, pv.side, ed.addRatio / 100);
    if (sp) {   // aperçu : la future case en pointillés, la case coupée en fond
      const poly = r => { ctx.beginPath(); [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].forEach(([x, y], i) => { const q = toScreen(x, y); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); };
      ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = accent; poly(sp.fresh); ctx.fill(); ctx.restore();
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([7, 5]); poly(sp.fresh); ctx.stroke(); ctx.setLineDash([]);
    }
    if (!pv) for (const m of mergeButtons(ap)) {   // fusion : bouton au centre de chaque case voisine absorbable
      ctx.save(); ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; const L = 8, ex = m.x + m.ux * L, ey = m.y + m.uy * L, sx = m.x - m.ux * L, sy = m.y - m.uy * L;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.moveTo(ex - m.ux * 6 - m.uy * 5, ey - m.uy * 6 + m.ux * 5); ctx.lineTo(ex, ey); ctx.lineTo(ex - m.ux * 6 + m.uy * 5, ey - m.uy * 6 - m.ux * 5); ctx.stroke();
      ctx.font = "600 11px 'Inter', sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const t = 'Fusionner', tw = ctx.measureText(t).width + 14;
      ctx.fillStyle = 'rgba(28,28,30,.85)'; ctx.beginPath(); ctx.roundRect(m.x - tw / 2, m.y + m.r + 5, tw, 20, 6); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(t, m.x, m.y + m.r + 15);
      ctx.restore();
    }
    const pc = pv && sp ? previewControls(ap) : null;
    if (pc) {
      // poignée de la ligne pointillée
      const hd = pc.handle, w = pc.horiz ? 18 : 48, hh = pc.horiz ? 48 : 18;
      ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect(hd.x - w / 2, hd.y - hh / 2, w, hh, 9); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
      if (pc.horiz) { ctx.moveTo(hd.x - 3, hd.y - 6); ctx.lineTo(hd.x - 6, hd.y); ctx.lineTo(hd.x - 3, hd.y + 6); ctx.moveTo(hd.x + 3, hd.y - 6); ctx.lineTo(hd.x + 6, hd.y); ctx.lineTo(hd.x + 3, hd.y + 6); }
      else { ctx.moveTo(hd.x - 6, hd.y - 3); ctx.lineTo(hd.x, hd.y - 6); ctx.lineTo(hd.x + 6, hd.y - 3); ctx.moveTo(hd.x - 6, hd.y + 3); ctx.lineTo(hd.x, hd.y + 6); ctx.lineTo(hd.x + 6, hd.y + 3); }
      ctx.stroke();
      ctx.font = "600 12px 'Inter', sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = Math.round(ed.addRatio) + ' %', lx = pc.horiz ? hd.x + (pc.side === 'right' ? -34 : 34) : hd.x + 40, ly = pc.horiz ? hd.y - 40 : hd.y + (pc.side === 'bottom' ? -18 : 18);
      ctx.fillStyle = 'rgba(28,28,30,.85)'; ctx.beginPath(); ctx.roundRect(lx - 22, ly - 11, 44, 22, 6); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(label, lx, ly);
      // pilule ✕ ✓
      const mx = (pc.ok.x + pc.no.x) / 2, my = pc.ok.y;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(mx - 52, my - 26, 104, 52, 26); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#555'; ctx.beginPath(); ctx.moveTo(pc.no.x - 7, my - 7); ctx.lineTo(pc.no.x + 7, my + 7); ctx.moveTo(pc.no.x + 7, my - 7); ctx.lineTo(pc.no.x - 7, my + 7); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(pc.ok.x, my, 20, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(pc.ok.x - 8, my); ctx.lineTo(pc.ok.x - 2, my + 7); ctx.lineTo(pc.ok.x + 9, my - 7); ctx.stroke();
    } else {
      for (const pl of edgePluses(ap)) {
        const ok = !!splitRects(ap, pl.side, ed.addRatio / 100);
        ctx.globalAlpha = ok ? 1 : 0.35;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pl.x, pl.y, pl.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pl.x - 6, pl.y); ctx.lineTo(pl.x + 6, pl.y); ctx.moveTo(pl.x, pl.y - 6); ctx.lineTo(pl.x, pl.y + 6); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
  if (g) {
    const v = g.axis === 'v', a = toScreen(v ? g.pos : g.s0, v ? g.s0 : g.pos), b = toScreen(v ? g.pos : g.s1, v ? g.s1 : g.pos);
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    // les cases touchées : nouveau cadre et dimensions en direct (en mm)
    const mmOf = px => Math.round(px / ed.project.dpi * 25.4);
    for (const { rect: r } of g.panels || []) {
      const c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => toScreen(x, y));
      ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = accent; ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
      const m = toScreen(r.x + r.w / 2, r.y + r.h / 2), t = `${mmOf(r.w)} × ${mmOf(r.h)} mm`;
      ctx.font = "600 12px 'Inter', sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(t).width + 16;
      ctx.fillStyle = 'rgba(28,28,30,.85)'; ctx.beginPath(); ctx.roundRect(m.x - tw / 2, m.y - 12, tw, 24, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(t, m.x, m.y);
    }
  }
}

export const canvasEl = () => canvas;

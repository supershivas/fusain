// Sélection : une région de pixels d'une case (octets 0/1, en coordonnées de calque) et le déplacement de son contenu.
// Une seule sélection à la fois, dans une seule case. Elle n'existe que tant que l'outil Sélection est actif.
import { ed, panel, activeLayer, markChanged, notify } from './editor.js';
import { ensureData } from './model.js';
import { floodRegion, compositeValues, compositeRect } from './raster.js';
import { invalidate, requestRender, setOverlay } from './view.js';
import { toast } from './toast.js';

const frameOf = p => ({ x0: p.x - p.ex, y0: p.y - p.ey, x1: p.x - p.ex + p.w, y1: p.y - p.ey + p.h });

// La sélection de cette case, ou null (elle appartient à une autre case, ou la case a changé de taille).
export function currentSelection(p = panel()) {
  const s = ed.sel;
  return s && s.panelId === p.id && s.ew === p.ew && s.eh === p.eh ? s : null;
}

function setSel(sel) { ed.sel = sel; notify('sel'); requestRender(); }
export function clearSelection() { if (ed.sel) setSel(null); }

function boundsOf(mask, ew, box) {
  let x0 = ew, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
    if (!mask[y * ew + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

function build(p, mask, box) {
  const b = boundsOf(mask, p.ew, box);
  return b ? { panelId: p.id, ew: p.ew, eh: p.eh, mask, ...b, dx: 0, dy: 0, tint: null } : null;
}

// On ne sélectionne que dans le cadre visible : ce qui est hors cadre est mis à zéro.
function clipToFrame(p, mask, box) {
  const f = frameOf(p), b = { x0: Math.max(box.x0, f.x0), y0: Math.max(box.y0, f.y0), x1: Math.min(box.x1, f.x1), y1: Math.min(box.y1, f.y1) };
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
    if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) mask[y * p.ew + x] = 0;
  }
  return b;
}

// Combine une nouvelle région avec la sélection : op = 'new' (remplace), 'add' (ajoute) ou 'sub' (retire).
function combine(p, mask, box, op) {
  const b = clipToFrame(p, mask, box), cur = currentSelection(p);
  if (!cur || op === 'new') { setSel(build(p, mask, b)); return; }
  const out = new Uint8Array(cur.mask), W = p.ew;
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) if (mask[y * W + x]) out[y * W + x] = op === 'add' ? 1 : 0;
  const hull = op === 'add' ? { x0: Math.min(cur.x0, b.x0), y0: Math.min(cur.y0, b.y0), x1: Math.max(cur.x1, b.x1), y1: Math.max(cur.y1, b.y1) } : cur;
  setSel(build(p, out, hull));
}

// Zone fermée sous le doigt (comme le seau) : encre connexe, ou papier connexe.
export function selectAuto(p, lx, ly, op) {
  const r = floodRegion(compositeValues(p, false), p.ew, p.eh, lx, ly);
  if (!r) return false;
  combine(p, r.mask, { x0: r.x0, y0: r.y0, x1: r.x1 + 1, y1: r.y1 + 1 }, op);
  return true;
}

// Forme tracée : 'poly' (liste de points), 'rect' ou 'ellipse' (deux coins). Points en coordonnées de PAGE.
export function selectShape(p, kind, pts, op) {
  const L = pts.map(q => ({ x: q.x - p.ex, y: q.y - p.ey }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of L) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(p.ew, Math.ceil(x1)); y1 = Math.min(p.eh, Math.ceil(y1));
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 2 || bh < 2) return false;
  const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.translate(-x0, -y0); c.fillStyle = '#000'; c.beginPath();
  if (kind === 'poly') { L.forEach((q, i) => i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)); c.closePath(); }
  else {
    const [a, b] = L, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (kind === 'rect') c.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), rx * 2, ry * 2);
    else c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, rx, ry, 0, 0, Math.PI * 2);
  }
  c.fill();
  const img = c.getImageData(0, 0, bw, bh).data, mask = new Uint8Array(p.ew * p.eh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (img[(y * bw + x) * 4 + 3] >= 128) mask[(y0 + y) * p.ew + x0 + x] = 1;
  combine(p, mask, { x0, y0, x1, y1 }, op);
  return true;
}

export function selectAll(p = panel()) {
  const f = frameOf(p), mask = new Uint8Array(p.ew * p.eh);
  for (let y = f.y0; y < f.y1; y++) mask.fill(1, y * p.ew + f.x0, y * p.ew + f.x1);
  const s = build(p, mask, f);
  setSel(s);
  return s;
}

export function invertSelection(p = panel()) {
  const cur = currentSelection(p), f = frameOf(p), mask = new Uint8Array(p.ew * p.eh);
  for (let y = f.y0; y < f.y1; y++) for (let x = f.x0; x < f.x1; x++) mask[y * p.ew + x] = cur && cur.mask[y * p.ew + x] ? 0 : 1;
  setSel(build(p, mask, f));
}

// ── Polygone : les sommets se posent un à un, le dernier ferme la forme ──
let poly = null;   // { p, pts } en coordonnées de page
export const polyCount = () => (poly ? poly.pts.length : 0);
export const polyFirst = () => (poly && poly.pts[0]) || null;
export function polyAdd(p, pt) {
  if (!poly) poly = { p, pts: [] };
  poly.pts.push({ x: pt.x, y: pt.y });
  setOverlay({ free: poly.pts, dots: true }); notify('sel');
}
export function polyCancel() { if (!poly) return; poly = null; setOverlay({ free: null, dots: false }); notify('sel'); }
export function polyFinish() {
  if (!poly || poly.pts.length < 3) return false;
  const { p, pts } = poly; poly = null;
  setOverlay({ free: null, dots: false });
  selectShape(p, 'poly', pts, ed.selOp);
  return true;
}

// ── Contenu ──

// Calques touchés : le calque actif, ou tous les calques visibles et déverrouillés.
function targets(p) {
  if (ed.selScope === 'active') { const l = activeLayer(p); return l.visible && !l.locked ? [l] : []; }
  return p.layers.filter(l => l.visible && !l.locked);
}

export function clearSelectionContent(p = panel()) {
  const s = currentSelection(p);
  if (!s) return 'none';
  const ls = targets(p).filter(l => l.data);
  if (!ls.length) return 'locked';
  const W = p.ew;
  let any = false;
  ed.undo.begin('Effacer la sélection');
  for (const l of ls) {
    ed.undo.touch(l, s.x0, s.y0, s.x1, s.y1);
    for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) {
      const i = y * W + x;
      if (s.mask[i] && l.data[i]) { l.data[i] = 0; any = true; }
    }
  }
  ed.undo.commit();
  if (!any) return 'empty';
  invalidate(p, { x: s.x0, y: s.y0, w: s.x1 - s.x0, h: s.y1 - s.y0 }); markChanged();
  return 'ok';
}

// Déplacement : on soulève les pixels sélectionnés (un tampon par calque), on les montre flottants, on les repose au relâchement.
// Sans sélection, c'est tout le contenu de la case qui se déplace.
export function beginMove(p, pt) {
  let s = currentSelection(p), implicit = false;
  if (!s) { s = selectAll(p); implicit = true; }
  const ls = targets(p);
  if (!ls.length) { toast('Aucun calque visible et déverrouillé à déplacer.'); if (implicit) clearSelection(); return null; }
  const bw = s.x1 - s.x0, bh = s.y1 - s.y0, W = p.ew, floats = [];
  for (const l of ls) {
    if (!l.data) continue;
    const buf = new Uint8Array(bw * bh);
    let any = false;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (s.y0 + y) * W + s.x0 + x;
      if (s.mask[i] && l.data[i]) { buf[y * bw + x] = l.data[i]; any = true; }
    }
    if (any) floats.push({ layer: l, buf });
  }
  // étendue réelle du contenu soulevé : le déplacement est borné pour qu'aucun pixel ne sorte de la case (rien ne se perd)
  let cx0 = bw, cy0 = bh, cx1 = 0, cy1 = 0;
  for (const f of floats) for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!f.buf[y * bw + x]) continue;
    if (x < cx0) cx0 = x; if (x >= cx1) cx1 = x + 1; if (y < cy0) cy0 = y; if (y >= cy1) cy1 = y + 1;
  }
  const limit = { x0: -(s.x0 + cx0), x1: p.ew - (s.x0 + cx1), y0: -(s.y0 + cy0), y1: p.eh - (s.y0 + cy1) };
  if (!floats.length) { toast('Rien à déplacer dans la sélection.', { duration: 1600 }); if (implicit) clearSelection(); return null; }
  ed.undo.begin(ed.selCopy ? 'Copier la sélection' : 'Déplacer');
  if (!ed.selCopy) {
    for (const f of floats) {
      ed.undo.touch(f.layer, s.x0, s.y0, s.x1, s.y1);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (f.buf[y * bw + x]) f.layer.data[(s.y0 + y) * W + s.x0 + x] = 0;
    }
  }
  // aperçu flottant : les tampons composés comme des calques d'une case de la taille de la sélection
  const fake = { ew: bw, eh: bh, ex: 0, ey: 0, layers: floats.map(f => ({ data: f.buf, visible: true, opacity: f.layer.opacity, draft: f.layer.draft, color: f.layer.color })) };
  const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
  const cx = cv.getContext('2d'), img = cx.createImageData(bw, bh);
  compositeRect(fake, new Uint32Array(img.data.buffer), { x: 0, y: 0, w: bw, h: bh }, true, {});
  cx.putImageData(img, 0, 0);
  ed.selFloat = { canvas: cv, bx: s.x0, by: s.y0 };
  invalidate(p, { x: s.x0, y: s.y0, w: bw, h: bh });
  return { kind: 'selmove', p, s, floats, bw, bh, implicit, limit, x0: pt.x, y0: pt.y };
}

export function moveMove(m, pt) {
  const l = m.limit;
  m.s.dx = Math.max(l.x0, Math.min(l.x1, Math.round(pt.x - m.x0))); m.s.dy = Math.max(l.y0, Math.min(l.y1, Math.round(pt.y - m.y0)));
  requestRender();
}

export function endMove(m) {
  const { p, s, floats, bw, bh } = m, dx = s.dx, dy = s.dy;
  for (const f of floats) {
    const l = f.layer, data = ensureData(l);
    ed.undo.touch(l, s.x0 + dx, s.y0 + dy, s.x1 + dx, s.y1 + dy);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const v = f.buf[y * bw + x];
      if (!v) continue;
      const tx = s.x0 + x + dx, ty = s.y0 + y + dy;
      if (tx >= 0 && ty >= 0 && tx < l.w && ty < l.h) data[ty * l.w + tx] = v;
    }
  }
  ed.undo.commit();
  ed.selFloat = null;
  invalidate(p, { x: Math.min(s.x0, s.x0 + dx), y: Math.min(s.y0, s.y0 + dy), w: bw + Math.abs(dx), h: bh + Math.abs(dy) });
  markChanged();
  if (m.implicit) { setSel(null); return; }
  // la sélection suit son contenu
  const W = p.ew, mask = new Uint8Array(W * p.eh);
  for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) {
    if (!s.mask[y * W + x]) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < p.eh) mask[ny * W + nx] = 1;
  }
  const box = { x0: Math.max(0, s.x0 + dx), y0: Math.max(0, s.y0 + dy), x1: Math.min(W, s.x1 + dx), y1: Math.min(p.eh, s.y1 + dy) };
  setSel(build(p, mask, box));
}

// Geste interrompu : tout revient en place, sans rien empiler.
export function cancelMove(m) {
  ed.undo.rollback();
  ed.selFloat = null; m.s.dx = m.s.dy = 0;
  invalidate(m.p, { x: m.s.x0, y: m.s.y0, w: m.bw, h: m.bh });
  if (m.implicit) setSel(null); else requestRender();
}

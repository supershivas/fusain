// Sélection : une région de pixels d'une case (octets 0/1, en coordonnées de calque) et le déplacement de son contenu.
// Une seule sélection à la fois, dans une seule case. Elle n'existe que tant que l'outil Sélection est actif.
import { ed, panel, activeLayer, markChanged, notify, growExtent } from './editor.js';
import { ensureData, pageSize } from './model.js';
import { floodRegion, compositeValues, compositeRect } from './raster.js';
import { invalidate, requestRender, setOverlay } from './view.js';
import { toast } from './toast.js';
import { kvGet, kvSet } from './store.js';

const frameOf = p => ({ x0: p.x - p.ex, y0: p.y - p.ey, x1: p.x - p.ex + p.w, y1: p.y - p.ey + p.h });

// La sélection de cette case, ou null (elle appartient à une autre case, ou la case a changé de taille).
export function currentSelection(p = panel()) {
  const s = ed.sel;
  return s && s.panelId === p.id && s.ew === p.ew && s.eh === p.eh ? s : null;
}

// Un changement de sélection voulu par l'utilisateur est une entrée d'historique (annuler / rétablir) ; record = false pour les effacements automatiques.
function applySel(sel) { ed.sel = sel; notify('sel'); requestRender(); }
ed.undo.onSelect = sel => { if (ed.tool === 'select') applySel(sel); };   // hors de l'outil Sélection, elle n'existe pas
function setSel(sel, record = true) {
  const before = ed.sel;
  applySel(sel);
  if (record && before !== sel) ed.undo.pushAction('Sélection', () => ed.undo.onSelect(before), () => ed.undo.onSelect(sel));
}
export function clearSelection(record = true) { if (ed.sel) setSel(null, record); }

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

export function selectAll(p = panel(), record = true) {
  const f = frameOf(p), mask = new Uint8Array(p.ew * p.eh);
  for (let y = f.y0; y < f.y1; y++) mask.fill(1, y * p.ew + f.x0, y * p.ew + f.x1);
  const s = build(p, mask, f);
  setSel(s, record);
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
    const b = (l.kind === 'color' || l.rgba) ? 4 : 1;
    for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) {
      const i = y * W + x;
      if (!s.mask[i]) continue;
      if (b === 4) { if (l.data[i * 4 + 3]) { l.data.fill(0, i * 4, i * 4 + 4); any = true; } }
      else if (l.data[i]) { l.data[i] = 0; any = true; }
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
  if (!s) { s = selectAll(p, false); implicit = true; }
  const ls = targets(p);
  if (!ls.length) { toast('Aucun calque visible et déverrouillé à déplacer.'); if (implicit) clearSelection(false); return null; }
  const bw = s.x1 - s.x0, bh = s.y1 - s.y0, W = p.ew, floats = [];
  for (const l of ls) {
    if (!l.data) continue;
    const b = (l.kind === 'color' || l.rgba) ? 4 : 1, buf = new Uint8Array(bw * bh * b);
    let any = false;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (s.y0 + y) * W + s.x0 + x;
      if (!s.mask[i]) continue;
      if (b === 4) { if (l.data[i * 4 + 3]) { buf.set(l.data.subarray(i * 4, i * 4 + 4), (y * bw + x) * 4); any = true; } }
      else if (l.data[i]) { buf[y * bw + x] = l.data[i]; any = true; }
    }
    if (any) floats.push({ layer: l, buf, b });
  }
  // étendue réelle du contenu soulevé : le déplacement est borné pour qu'aucun pixel ne sorte de la case (rien ne se perd)
  let cx0 = bw, cy0 = bh, cx1 = 0, cy1 = 0;
  for (const f of floats) for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!f.buf[f.b === 4 ? (y * bw + x) * 4 + 3 : y * bw + x]) continue;
    if (x < cx0) cx0 = x; if (x >= cx1) cx1 = x + 1; if (y < cy0) cy0 = y; if (y >= cy1) cy1 = y + 1;
  }
  // le contenu peut sortir du cadre et de la case (il reste dans la page) : au lâcher, la réserve de la case s'agrandit
  const pgs = pageSize(ed.project);
  const limit = { x0: -(p.ex + s.x0 + cx0), x1: pgs.w - (p.ex + s.x0 + cx1), y0: -(p.ey + s.y0 + cy0), y1: pgs.h - (p.ey + s.y0 + cy1) };
  if (!floats.length) { toast('Rien à déplacer dans la sélection.', { duration: 1600 }); if (implicit) clearSelection(false); return null; }
  ed.undo.begin(ed.selCopy ? 'Copier la sélection' : 'Déplacer');
  if (!ed.selCopy) {
    for (const f of floats) {
      ed.undo.touch(f.layer, s.x0, s.y0, s.x1, s.y1);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const i = (s.y0 + y) * W + s.x0 + x;
        if (f.b === 4) { if (f.buf[(y * bw + x) * 4 + 3]) f.layer.data.fill(0, i * 4, i * 4 + 4); }
        else if (f.buf[y * bw + x]) f.layer.data[i] = 0;
      }
    }
  }
  // aperçu flottant : les tampons composés comme des calques d'une case de la taille de la sélection
  const fake = { ew: bw, eh: bh, ex: 0, ey: 0, layers: floats.map(f => ({ data: f.buf, visible: true, kind: f.layer.kind, rgba: f.layer.rgba, blend: f.layer.blend, opacity: f.layer.opacity, draft: f.layer.draft, color: f.layer.color })) };
  const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
  const cx = cv.getContext('2d'), img = cx.createImageData(bw, bh);
  compositeRect(fake, new Uint32Array(img.data.buffer), { x: 0, y: 0, w: bw, h: bh }, true, {});
  cx.putImageData(img, 0, 0);
  ed.selFloat = { canvas: cv, bx: s.x0, by: s.y0 };
  invalidate(p, { x: s.x0, y: s.y0, w: bw, h: bh });
  return { kind: 'selmove', p, s, floats, bw, bh, implicit, limit, x0: pt.x, y0: pt.y, content: { x0: cx0, y0: cy0, x1: cx1, y1: cy1 } };
}

export function moveMove(m, pt) {
  const l = m.limit;
  m.s.dx = Math.max(l.x0, Math.min(l.x1, Math.round(pt.x - m.x0))); m.s.dy = Math.max(l.y0, Math.min(l.y1, Math.round(pt.y - m.y0)));
  requestRender();
}

export function endMove(m) {
  const { p, s, floats, bw, bh } = m, dx = s.dx, dy = s.dy, c = m.content;
  // contenu posé hors de la réserve de la case : on la remet en place, on agrandit la réserve, puis on refait le déplacement
  const need = { x: p.ex + s.x0 + c.x0 + dx, y: p.ey + s.y0 + c.y0 + dy, w: c.x1 - c.x0, h: c.y1 - c.y0 };
  if (!m.regrown && (need.x < p.ex || need.y < p.ey || need.x + need.w > p.ex + p.ew || need.y + need.h > p.ey + p.eh)) {
    s.dx = s.dy = 0; ed.undo.rollback(); ed.selFloat = null;
    const np = growExtent(p, need);
    if (!m.implicit) {   // la sélection passe dans les coordonnées de la réserve agrandie
      const ox = p.ex - np.ex, oy = p.ey - np.ey, mask = new Uint8Array(np.ew * np.eh);
      for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) if (s.mask[y * p.ew + x]) mask[(y + oy) * np.ew + x + ox] = 1;
      applySel(build(np, mask, { x0: s.x0 + ox, y0: s.y0 + oy, x1: s.x1 + ox, y1: s.y1 + oy }));
    }
    const m2 = beginMove(np, { x: 0, y: 0 });
    if (!m2) return;
    m2.regrown = true; m2.s.dx = dx; m2.s.dy = dy;
    endMove(m2);
    return;
  }
  s.dx = s.dy = 0;   // l'ancienne sélection, rétablie par « annuler », doit être à sa place d'origine
  for (const f of floats) {
    const l = f.layer, data = ensureData(l);
    ed.undo.touch(l, s.x0 + dx, s.y0 + dy, s.x1 + dx, s.y1 + dy);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const tx = s.x0 + x + dx, ty = s.y0 + y + dy;
      if (tx < 0 || ty < 0 || tx >= l.w || ty >= l.h) continue;
      if (f.b === 4) { const k = (y * bw + x) * 4; if (f.buf[k + 3]) data.set(f.buf.subarray(k, k + 4), (ty * l.w + tx) * 4); continue; }
      const v = f.buf[y * bw + x];
      if (v) data[ty * l.w + tx] = v;
    }
  }
  // la sélection suit son contenu, dans la même entrée d'historique que les pixels
  let next = null;
  if (!m.implicit) {
    const W = p.ew, mask = new Uint8Array(W * p.eh);
    for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) {
      if (!s.mask[y * W + x]) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < p.eh) mask[ny * W + nx] = 1;
    }
    next = build(p, mask, { x0: Math.max(0, s.x0 + dx), y0: Math.max(0, s.y0 + dy), x1: Math.min(W, s.x1 + dx), y1: Math.min(p.eh, s.y1 + dy) });
  }
  ed.undo.commit(m.implicit ? undefined : { before: s, after: next });
  ed.selFloat = null;
  invalidate(p, { x: Math.min(s.x0, s.x0 + dx), y: Math.min(s.y0, s.y0 + dy), w: bw + Math.abs(dx), h: bh + Math.abs(dy) });
  markChanged();
  applySel(next);   // pour une sélection implicite : next vaut null, la case entière n'était qu'un moyen
}

// Geste interrompu : tout revient en place, sans rien empiler.
export function cancelMove(m) {
  ed.undo.rollback();
  ed.selFloat = null; m.s.dx = m.s.dy = 0;
  invalidate(m.p, { x: m.s.x0, y: m.s.y0, w: m.bw, h: m.bh });
  if (m.implicit) applySel(null); else requestRender();
}

// ── Poignées de la sélection (comme la transformation de Photoshop) ──
// Huit poignées autour du rectangle de la sélection. Par défaut le contenu garde ses proportions (homothétie) ; Maj, ou un
// second doigt posé pendant le geste, le déforme librement. Pendant le geste, le contenu est soulevé et montré à sa nouvelle
// taille (`sel.scale`) ; au lâcher, il est redimensionné pour de bon, en une entrée d'historique.
// Le point (page) est-il sur la sélection ? (glisser depuis l'intérieur déplace son contenu)
export function insideSelection(p, s, pt) {
  const x = Math.floor(pt.x - p.ex), y = Math.floor(pt.y - p.ey);
  return x >= s.x0 && y >= s.y0 && x < s.x1 && y < s.y1 && !!s.mask[y * p.ew + x];
}
export const SEL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export function selHandlePoints(p, s) {
  const x0 = p.ex + s.x0, y0 = p.ey + s.y0, x1 = p.ex + s.x1, y1 = p.ey + s.y1, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return { nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my] };
}
export function hitSelHandle(p, s, pt, radius) {
  let best = null, bd = radius;
  const pts = selHandlePoints(p, s);
  for (const h of ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']) {   // les coins d'abord : sur une petite sélection, ils l'emportent
    const d = Math.hypot(pts[h][0] - pt.x, pts[h][1] - pt.y);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}
export function beginScale(p, handle, pt) {
  const s = currentSelection(p);
  if (!s) return null;
  const copy = ed.selCopy; ed.selCopy = false;   // le contenu quitte sa place pendant le geste (il revient s'il est annulé)
  const m = beginMove(p, pt);
  ed.selCopy = copy;
  if (!m || m.implicit) { if (m) cancelMove(m); return null; }
  return { kind: 'selscale', p, s, m, handle, x0: pt.x, y0: pt.y, box: { x: s.x0, y: s.y0, w: s.x1 - s.x0, h: s.y1 - s.y0 } };
}
export function scaleMove(g, pt, free) {
  const { s, handle: h } = g, B = { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 }, W0 = B.x1 - B.x0, H0 = B.y1 - B.y0;
  const dx = pt.x - g.x0, dy = pt.y - g.y0;
  let x0 = B.x0, y0 = B.y0, x1 = B.x1, y1 = B.y1;
  if (h.includes('w')) x0 += dx; if (h.includes('e')) x1 += dx;
  if (h.includes('n')) y0 += dy; if (h.includes('s')) y1 += dy;
  const minW = Math.min(4, W0), minH = Math.min(4, H0);
  if (free) {   // déformation libre : chaque bord suit la poignée
    if (x1 - x0 < minW) { if (h.includes('w')) x0 = x1 - minW; else x1 = x0 + minW; }
    if (y1 - y0 < minH) { if (h.includes('n')) y0 = y1 - minH; else y1 = y0 + minH; }
    g.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  } else {      // homothétie : un seul facteur, ancré au coin (ou au bord) opposé
    const kx = (x1 - x0) / W0, ky = (y1 - y0) / H0;
    let k = h.length === 2 ? (Math.abs(kx - 1) > Math.abs(ky - 1) ? kx : ky) : h === 'e' || h === 'w' ? kx : ky;
    k = Math.max(k, minW / W0, minH / H0);
    const w = W0 * k, hh = H0 * k;
    const ax = h.includes('w') ? B.x1 - w : h.includes('e') ? B.x0 : (B.x0 + B.x1) / 2 - w / 2;
    const ay = h.includes('n') ? B.y1 - hh : h.includes('s') ? B.y0 : (B.y0 + B.y1) / 2 - hh / 2;
    g.box = { x: ax, y: ay, w, h: hh };
  }
  s.scale = g.box;
  requestRender();
}
export function endScale(g) {
  const { p, s, m, box } = g;
  s.scale = null;
  ed.undo.rollback(); ed.selFloat = null;   // le contenu soulevé revient, puis il est redimensionné en une seule action
  invalidate(p, { x: m.s.x0, y: m.s.y0, w: m.bw, h: m.bh });
  if (Math.round(box.w) === s.x1 - s.x0 && Math.round(box.h) === s.y1 - s.y0 && Math.round(box.x) === s.x0 && Math.round(box.y) === s.y0) { requestRender(); return; }
  transformSelection('scale', p, box);
}
export function cancelScale(g) { g.s.scale = null; cancelMove(g.m); }

// ───────────────────────── Transformer, copier / couper / coller, agrandir / rétrécir ─────────────────────────

const bppL = l => (l.kind === 'color' || l.rgba ? 4 : 1);
const hasPx = (buf, i, b) => (b === 4 ? buf[i * 4 + 3] : buf[i]);

// Miroir, quart de tour du contenu sélectionné (sans sélection : tout le contenu de la case), autour du centre de la sélection ;
// 'scale' : le contenu remplit le rectangle `to` { x, y, w, h } (coordonnées de calque, poignées de la sélection).
// Au plus proche voisin (le trait 1 bit reste net). Pixels et sélection : une entrée d'historique.
export const TRANSFORMS = { flipH: 'Miroir horizontal', flipV: 'Miroir vertical', rotCW: 'Quart de tour à droite', rotCCW: 'Quart de tour à gauche', scale: 'Redimensionner' };
export function transformSelection(kind, p = panel(), to = null) {
  let s = currentSelection(p), implicit = false;
  if (!s) { s = selectAll(p, false); implicit = true; }
  const ls = targets(p).filter(l => l.data);
  if (!s || !ls.length) { if (implicit) applySel(null); return 'locked'; }
  const W = p.ew, H = p.eh, bw = s.x1 - s.x0, bh = s.y1 - s.y0, scale = kind === 'scale' && to;
  const rot = kind === 'rotCW' || kind === 'rotCCW';
  const nw = rot ? bh : scale ? Math.max(1, Math.round(to.w)) : bw, nh = rot ? bw : scale ? Math.max(1, Math.round(to.h)) : bh;
  const nx0 = scale ? Math.round(to.x) : Math.round((s.x0 + s.x1) / 2 - nw / 2), ny0 = scale ? Math.round(to.y) : Math.round((s.y0 + s.y1) / 2 - nh / 2);
  // case d'origine (x, y) dans l'ancienne boîte, pour la case (u, v) de la nouvelle
  const src = (u, v) => kind === 'flipH' ? [bw - 1 - u, v] : kind === 'flipV' ? [u, bh - 1 - v] : kind === 'rotCW' ? [v, bh - 1 - u]
    : kind === 'rotCCW' ? [bw - 1 - v, u] : [Math.min(bw - 1, Math.floor(u * bw / nw)), Math.min(bh - 1, Math.floor(v * bh / nh))];
  const box = { x0: Math.max(0, Math.min(s.x0, nx0)), y0: Math.max(0, Math.min(s.y0, ny0)), x1: Math.min(W, Math.max(s.x1, nx0 + nw)), y1: Math.min(H, Math.max(s.y1, ny0 + nh)) };
  ed.undo.begin(TRANSFORMS[kind]);
  for (const l of ls) {
    const b = bppL(l), d = ensureData(l), buf = new Uint8Array(bw * bh * b);
    ed.undo.touch(l, box.x0, box.y0, box.x1, box.y1);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {   // on soulève le contenu sélectionné
      const i = (s.y0 + y) * W + s.x0 + x;
      if (!s.mask[i]) continue;
      buf.set(d.subarray(i * b, i * b + b), (y * bw + x) * b); d.fill(0, i * b, i * b + b);
    }
    for (let v = 0; v < nh; v++) for (let u = 0; u < nw; u++) {   // et on le repose transformé
      const tx = nx0 + u, ty = ny0 + v;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const [x, y] = src(u, v), j = y * bw + x;
      if (!s.mask[(s.y0 + y) * W + s.x0 + x] || !hasPx(buf, j, b)) continue;
      d.set(buf.subarray(j * b, j * b + b), (ty * W + tx) * b);
    }
  }
  let next = null;
  if (!implicit) {
    const mask = new Uint8Array(W * H);
    for (let v = 0; v < nh; v++) for (let u = 0; u < nw; u++) {
      const tx = nx0 + u, ty = ny0 + v; if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const [x, y] = src(u, v); if (s.mask[(s.y0 + y) * W + s.x0 + x]) mask[ty * W + tx] = 1;
    }
    next = build(p, mask, { x0: Math.max(0, nx0), y0: Math.max(0, ny0), x1: Math.min(W, nx0 + nw), y1: Math.min(H, ny0 + nh) });
  }
  ed.undo.commit(implicit ? undefined : { before: s, after: next });
  invalidate(p, { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 }); markChanged();
  applySel(next);
  return 'ok';
}

// Presse-papiers de l'éditeur : pixels du calque actif sous la sélection (sans sélection : toute la case).
// Partagé entre les onglets et les projets de cet appareil (IndexedDB, clé `clip`, signalé par BroadcastChannel) ;
// la copie part aussi dans le presse-papiers du système en PNG (autres apps, et autres appareils Apple par Handoff).
let clip = null;
export const hasClip = () => !!clip;
const clipChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fusain-clip') : null;
const loadClip = () => kvGet('clip').then(c => { if (c && c.buf && (!clip || (c.at || 0) > (clip.at || 0))) { clip = c; notify('clip'); } }).catch(() => {});
loadClip();
if (clipChannel) clipChannel.onmessage = () => loadClip();
function shareClip() {
  kvSet('clip', clip).then(() => clipChannel && clipChannel.postMessage('copied')).catch(() => {});
  try {   // presse-papiers du système : l'image se construit pendant le geste (exigence de Safari)
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return;
    const c = clip, png = new Promise(res => {
      const cv = document.createElement('canvas'); cv.width = c.w; cv.height = c.h;
      const x = cv.getContext('2d'), img = x.createImageData(c.w, c.h), d = img.data;
      for (let i = 0; i < c.w * c.h; i++) {
        if (!c.mask[i]) continue;
        if (c.b === 4) { d.set(c.buf.subarray(i * 4, i * 4 + 4), i * 4); continue; }
        const v = c.buf[i] === 2 ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = c.buf[i] ? 255 : 0;
      }
      x.putImageData(img, 0, 0); cv.toBlob(res, 'image/png');
    });
    navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(() => {});
  } catch { /* presse-papiers du système refusé : la copie reste dans Fusain */ }
}
export function copySelection(cut = false, p = panel()) {
  const cur = currentSelection(p), s = cur || selectAll(p, false), l = activeLayer(p), done = r => { if (!cur) applySel(null); return r; };
  if (!s) return 'none';
  if (!l.data) return done('empty');
  const W = p.ew, b = bppL(l), bw = s.x1 - s.x0, bh = s.y1 - s.y0, buf = new Uint8Array(bw * bh * b), mask = new Uint8Array(bw * bh);
  let any = false;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = (s.y0 + y) * W + s.x0 + x;
    if (!s.mask[i] || !hasPx(l.data, i, b)) continue;
    buf.set(l.data.subarray(i * b, i * b + b), (y * bw + x) * b); mask[y * bw + x] = 1; any = true;
  }
  if (!any) return done('empty');
  // la copie est rognée au dessin qu'elle contient (sans sélection, la case entière se réduit à son dessin)
  let cx0 = bw, cy0 = bh, cx1 = 0, cy1 = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (mask[y * bw + x]) { if (x < cx0) cx0 = x; if (x >= cx1) cx1 = x + 1; if (y < cy0) cy0 = y; if (y >= cy1) cy1 = y + 1; }
  const cw = cx1 - cx0, ch = cy1 - cy0, cbuf = new Uint8Array(cw * ch * b), cmask = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const from = (cy0 + y) * bw + cx0;
    cbuf.set(buf.subarray(from * b, (from + cw) * b), y * cw * b); cmask.set(mask.subarray(from, from + cw), y * cw);
  }
  clip = { b, w: cw, h: ch, buf: cbuf, mask: cmask, x: s.x0 + cx0 + p.ex, y: s.y0 + cy0 + p.ey, name: l.name, at: Date.now() };   // position en coordonnées de page
  shareClip();
  if (cut) {
    if (l.locked) return done('locked');
    ed.undo.begin('Couper');
    ed.undo.touch(l, s.x0, s.y0, s.x1, s.y1);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (mask[y * bw + x]) { const i = (s.y0 + y) * W + s.x0 + x; l.data.fill(0, i * b, i * b + b); }
    ed.undo.commit();
    invalidate(p, { x: s.x0, y: s.y0, w: bw, h: bh }); markChanged();
  }
  return done('ok');
}
// Coller : un nouveau calque au-dessus de l'actif, au même endroit de la page (ramené dans la case), sélectionné et prêt à déplacer.
export function pasteClip(newLayerFn, p = panel()) {
  if (!clip) return null;
  const l = newLayerFn('Collage');
  if (clip.b === 4) l.rgba = true;
  const W = p.ew, H = p.eh, b = clip.b, d = ensureData(l);
  const f = frameOf(p);
  let x0 = clip.x - p.ex, y0 = clip.y - p.ey;
  x0 = Math.max(f.x0, Math.min(f.x1 - Math.min(clip.w, f.x1 - f.x0), x0)); y0 = Math.max(f.y0, Math.min(f.y1 - Math.min(clip.h, f.y1 - f.y0), y0));
  const mask = new Uint8Array(W * H);
  ed.undo.begin('Coller');
  ed.undo.touch(l, x0, y0, x0 + clip.w, y0 + clip.h);
  for (let y = 0; y < clip.h; y++) for (let x = 0; x < clip.w; x++) {
    if (!clip.mask[y * clip.w + x]) continue;
    const tx = x0 + x, ty = y0 + y; if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const j = y * clip.w + x;
    d.set(clip.buf.subarray(j * b, j * b + b), (ty * W + tx) * b);
  }
  // la sélection collée est le rectangle de la copie (plus simple à saisir et à transformer que la forme du dessin)
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + clip.h); y++) mask.fill(1, y * W + Math.max(0, x0), y * W + Math.min(W, x0 + clip.w));
  const next = build(p, mask, { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x0 + clip.w), y1: Math.min(H, y0 + clip.h) });
  ed.undo.commit({ before: ed.sel, after: next });
  invalidate(p, { x: x0, y: y0, w: clip.w, h: clip.h }); markChanged();
  applySel(next);
  return l;
}

// Agrandir / rétrécir la sélection de r pixels (r < 0 : rétrécir).
export function growSelection(r, p = panel()) {
  const s = currentSelection(p);
  if (!s || !r) return false;
  const W = p.ew, H = p.eh, n = Math.abs(r), src = r > 0 ? s.mask : s.mask.map(v => (v ? 0 : 1));
  const box = r > 0 ? { x0: Math.max(0, s.x0 - n), y0: Math.max(0, s.y0 - n), x1: Math.min(W, s.x1 + n), y1: Math.min(H, s.y1 + n) } : { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 };
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {   // passe horizontale
    let on = 0; for (let k = Math.max(0, x - n); k <= Math.min(W - 1, x + n) && !on; k++) on = src[y * W + k];
    tmp[y * W + x] = on;
  }
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {   // puis verticale
    let on = 0; for (let k = y - n; k <= y + n && !on; k++) on = k < 0 || k >= H ? 0 : k < box.y0 || k >= box.y1 ? (r < 0 ? 1 : 0) : tmp[k * W + x];
    out[y * W + x] = r > 0 ? on : on ? 0 : 1;
  }
  if (r < 0) for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (!s.mask[y * W + x]) out[y * W + x] = 0;
  const b = clipToFrame(p, out, box);
  setSel(build(p, out, b));
  return true;
}

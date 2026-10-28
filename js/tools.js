// Outils au pointeur : crayon, pinceau trame, gomme, remplissage, formes, masque, bulles.
// `down/move/up` reçoivent des points en coordonnées de page : { x, y, pressure, type }.
import {
  ed, page, activeLayer, selectPanel, markChanged, selectBubble, commitBubbleEdit, snapshotBubble, ensureMask, addFreeBubble, notify, gutterHandles, clampGutter, resizeGutter, addCase, targetLayer, deleteBubble,
} from './editor.js';
import {
  stampBrush, strokeSegment, drawRect, drawEllipse, floodRegion, applyRegion, compositeValues,
} from './raster.js';
import { tramaById } from './tramas.js';
import { invalidate, setOverlay, toScreen, view, bubbleCross, bubbleCorner, bubbleRotHandle, gutterPlus } from './view.js';
import { hitBubble, tailOrigin, bubbleToLocal } from './bubbles.js';
import { toast } from './toast.js';

let session = null, hinted = null;   // hinted : dernier calque signalé par un toast de redirection
export const busy = () => !!session;

const panelAt = (x, y) => page().panels.find(p => x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) || null;

// Motif courant : null = encre pleine, sinon la tuile de trame.
const currentTrama = () => { const t = tramaById(ed.project, ed.tramaId); return t.solid ? null : t; };

function maskFor(p) {
  return ed.maskMode !== 'off' && p.mask && p.mask.data ? { data: p.mask.data, mode: ed.maskMode } : null;
}

function makeCtx(p, layer, paint, useMask = true) {
  const clip = { x0: p.x - p.ex, y0: p.y - p.ey, x1: p.x - p.ex + p.w, y1: p.y - p.ey + p.h };
  return { layer, undo: ed.undo, ox: p.ex, oy: p.ey, clip, paint, mask: useMask ? maskFor(p) : null, dirty: null };
}

// Pression du stylet après la courbe réglée dans les Réglages (gamma < 1 : plus sensible au toucher léger).
export const pressureOf = pt => Math.pow(Math.max(0.02, Math.min(1, pt.pressure)), ed.pressureGamma);
const diameter = pt => Math.max(1, Math.round(ed.size * (pt.type === 'pen' && ed.pressure ? 0.4 + 1.2 * pressureOf(pt) : 1)));

// Taille du tampon selon le pinceau : pression du stylet, vitesse du geste et départ effilé.
function brushDiameter(pt, s, step) {
  const sp = s.ctx.brush && s.ctx.brush.spec;
  if (!sp) return diameter(pt);
  s.travel += step; s.speed = s.speed * 0.6 + step * 0.4;
  const pen = pt.type === 'pen' && ed.pressure;
  s.pr = s.pr === undefined ? pressureOf(pt) : s.pr * 0.5 + pressureOf(pt) * 0.5;   // pressions lissées : pas de saccades de largeur
  let f = 1;
  if (pen && sp.press > 0) f *= (1 - sp.press) + sp.press * (sp.pressMin + (1.6 - sp.pressMin) * s.pr);
  if (sp.speed > 0) f *= Math.max(0.25, 1 - sp.speed * Math.min(1, s.speed / (ed.size * 2.5)) * (pen && sp.press > 0 ? 0.4 : 1));
  if (sp.start > 0) f *= Math.min(1, 0.3 + s.travel / (ed.size * sp.start));
  s.ctx.brush.pr = s.pr;
  return Math.max(1, Math.round(ed.size * f));
}

function flush(s) {
  if (!s.ctx.dirty) return;
  const d = s.ctx.dirty;
  invalidate(s.p, { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 });
  s.ctx.dirty = null;
}

export function down(pt) {
  if (session) return;
  if (ed.tool === 'bubble') { bubbleDown(pt); return; }
  if (ed.tool === 'layout') { layoutDown(pt); return; }
  const p = panelAt(pt.x, pt.y);
  if (!p) {
    // Départ hors de toute case : le geste est suivi, et il se pose dans la première case où il entre (rogné au cadre).
    if (['pencil', 'texture', 'eraser', 'mask', 'shape'].includes(ed.tool)) session = { kind: 'pre', pts: [pt] };
    return;
  }
  begin(p, pt);
}

function begin(p, pt) {
  selectPanel(p.id);
  // Chaque outil vise le calque de sa sorte : encre → calque d'encre, trame → calque de trame (créé s'il manque).
  const trame0 = currentTrama(), role = ed.tool === 'mask' ? null : ed.tool === 'eraser' ? 'any' : ed.tool === 'pencil' ? 'ink' : (trame0 ? 'tram' : 'ink');
  let layer;
  if (ed.tool === 'mask') layer = ensureMask();
  else {
    layer = role === 'any' ? activeLayer(p) : targetLayer(p, role);
    if (!layer.visible) { toast(`Le calque « ${layer.name} » est masqué : affiche-le pour dessiner.`); return; }
    if (layer.locked) { toast(`Le calque « ${layer.name} » est verrouillé.`); return; }
    if (layer !== activeLayer(p) && hinted !== layer.id) { hinted = layer.id; toast(`Dessiné dans « ${layer.name} »`, { duration: 1600 }); }
  }
  const lx = Math.floor(pt.x - p.ex), ly = Math.floor(pt.y - p.ey), tool = ed.tool;
  const trame = currentTrama();

  if (tool === 'pencil' || tool === 'texture' || tool === 'eraser' || tool === 'mask') {
    const paint = tool === 'eraser' ? { v: 0 }
      : tool === 'mask' ? { v: ed.maskErase ? 0 : 1 }
      : tool === 'texture' ? { v: ed.ink, trame, scale: ed.tramaScale, opaque: ed.tramaOpaque }
      : { v: ed.ink };
    ed.undo.begin({ pencil: 'Crayon', texture: 'Pinceau trame', eraser: 'Gomme', mask: 'Masque' }[tool]);
    const sp = tool === 'pencil' || tool === 'eraser' || tool === 'texture' ? ed.brushParams : null;
    const d = sp && sp.start > 0 ? Math.max(1, Math.round(ed.size * 0.3)) : diameter(pt);
    session = { kind: 'stroke', p, layer, ctx: makeCtx(p, layer, paint, tool !== 'mask'), last: { x: lx, y: ly, d }, travel: 0, speed: 0, pos: { x: lx, y: ly }, target: { x: lx, y: ly } };
    if (sp) session.ctx.brush = { spec: sp, seed: Math.floor(Math.random() * 1e6), n: 0, pr: pressureOf(pt) };
    stampBrush(session.ctx, lx, ly, d); flush(session);
  } else if (tool === 'fill') {
    const region = floodRegion(compositeValues(p, false), p.ew, p.eh, lx, ly, fillGapPx());
    if (!region) return;
    ed.undo.begin('Remplir');
    const ctx = makeCtx(p, layer, { v: ed.ink, trame, scale: ed.tramaScale, opaque: ed.tramaOpaque });
    applyRegion(ctx, region);
    ed.undo.commit();
    invalidate(p, { x: region.x0, y: region.y0, w: region.x1 - region.x0 + 1, h: region.y1 - region.y0 + 1 });
    markChanged();
  } else if (tool === 'shape') {
    session = { kind: 'shape', p, layer, x0: pt.x, y0: pt.y };
    setOverlay({ shape: { kind: ed.shapeKind, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y } });
  }
}

// Trou toléré dans un contour : le curseur (0–100) va jusqu'à 2,5 mm.
const fillGapPx = () => Math.round(ed.fillGap / 100 * 2.5 / 25.4 * ed.project.dpi);

export function move(pt) {
  if (!session) return;
  if (session.kind === 'pre') {
    session.pts.push(pt);
    const p = panelAt(pt.x, pt.y);
    if (p) {
      const pts = session.pts; session = null;
      begin(p, pts[0]);                                   // le début, hors cadre, est rogné : seule la partie dedans se dessine
      if (session) for (const q of pts.slice(1)) move(q);
    }
    return;
  }
  if (session.kind === 'stroke') {
    const s = session, tx = Math.floor(pt.x - s.p.ex), ty = Math.floor(pt.y - s.p.ey);
    s.target = { x: tx, y: ty };
    // stabilisation : le tampon suit le doigt avec un léger retard, ce qui lisse les tremblements
    const k = s.ctx.brush && s.ctx.brush.spec.smooth ? 1 - s.ctx.brush.spec.smooth * 0.8 : 1;
    s.pos.x += (tx - s.pos.x) * k; s.pos.y += (ty - s.pos.y) * k;
    const lx = Math.round(s.pos.x), ly = Math.round(s.pos.y);
    const d = brushDiameter(pt, s, Math.hypot(lx - s.last.x, ly - s.last.y));
    strokeSegment(s.ctx, s.last.x, s.last.y, lx, ly, s.last.d, d);
    s.last = { x: lx, y: ly, d };
    flush(s);
  } else if (session.kind === 'shape') {
    setOverlay({ shape: { kind: ed.shapeKind, x0: session.x0, y0: session.y0, x1: pt.x, y1: pt.y } });
    session.x1 = pt.x; session.y1 = pt.y;
  } else if (session.kind === 'gutter') {
    const h = session.h, v = h.axis === 'v', d = clampGutter(h, (v ? pt.x - session.x0 : pt.y - session.y0));
    session.d = d;
    setOverlay({ guide: { axis: h.axis, pos: h.pos + d, s0: h.span[0], s1: h.span[1] } });
  } else if (session.kind === 'free') {
    const l = session.pts[session.pts.length - 1];
    if (Math.hypot(pt.x - l.x, pt.y - l.y) > 3) { session.pts.push({ x: pt.x, y: pt.y }); setOverlay({ free: session.pts }); }
  } else if (session.kind === 'bubble') bubbleMove(pt);
}

export function up() {
  const s = session; session = null;
  if (!s) return;
  if (s.kind === 'stroke') {
    if (s.ctx.brush && s.ctx.brush.spec.smooth && (s.last.x !== s.target.x || s.last.y !== s.target.y)) {   // rattrape le retard de la stabilisation
      strokeSegment(s.ctx, s.last.x, s.last.y, s.target.x, s.target.y, s.last.d, Math.max(1, Math.round(s.last.d * 0.5))); flush(s);
    }
    ed.undo.commit(); markChanged();
  } else if (s.kind === 'shape') {
    setOverlay({ shape: null });
    if (s.x1 === undefined) return;
    const trame = currentTrama(), p = s.p;
    const paint = { v: ed.ink, trame, scale: ed.tramaScale, opaque: ed.tramaOpaque };
    const ctx = makeCtx(p, s.layer, paint);
    const x0 = Math.floor(s.x0 - p.ex), y0 = Math.floor(s.y0 - p.ey), x1 = Math.floor(s.x1 - p.ex), y1 = Math.floor(s.y1 - p.ey);
    ed.undo.begin({ line: 'Ligne', rect: 'Rectangle', ellipse: 'Ellipse' }[ed.shapeKind]);
    // les traits des formes suivent la même trame que les remplissages
    if (ed.shapeKind === 'line') strokeSegment(ctx, x0, y0, x1, y1, ed.size);
    else if (ed.shapeKind === 'rect') drawRect(ctx, x0, y0, x1, y1, ed.size, ed.shapeFilled);
    else drawEllipse(ctx, x0, y0, x1, y1, ed.size, ed.shapeFilled);
    ed.undo.commit();
    flush({ ctx, p });
    markChanged();
  } else if (s.kind === 'gutter') {
    setOverlay({ guide: null });
    if (s.d) resizeGutter(s.h, s.d);
  } else if (s.kind === 'free') {
    setOverlay({ free: null });
    ed.bubbleDraw = false;
    if (!addFreeBubble(s.pts)) toast('Trace une forme fermée, d\'un seul geste.');
    notify('bubbles'); notify('tool');
  } else if (s.kind === 'bubble') {
    commitBubbleEdit(s.b, s.before);
  }
}

// Geste interrompu (second doigt posé) : on défait le trait en cours sans rien empiler.
export function cancel() {
  const s = session; session = null;
  if (!s) return;
  if (s.kind === 'stroke') { ed.undo.rollback(); invalidate(s.p); }
  else if (s.kind === 'shape') setOverlay({ shape: null });
  else if (s.kind === 'free') setOverlay({ free: null });
  else if (s.kind === 'gutter') setOverlay({ guide: null });
  else if (s.kind === 'bubble') { Object.keys(s.b).forEach(k => delete s.b[k]); Object.assign(s.b, s.before); selectBubble(s.b.id); }
}

// ───────────────────────── Gouttières ─────────────────────────

// On attrape une gouttière n'importe où le long de son trait.
function layoutDown(pt) {
  const R = pt.type === 'touch' ? 28 : 18, at = toScreen(pt.x, pt.y);
  for (const h of gutterHandles()) {   // le « + » d'une gouttière ajoute une case
    const pl = gutterPlus(h);
    if (Math.hypot(at.x - pl.x, at.y - pl.y) <= pl.r + (pt.type === 'touch' ? 10 : 4)) {
      if (addCase(h.L, h.axis)) toast('Case ajoutée.', { actionLabel: 'Annuler', duration: 6000, onAction: () => ed.undo.undo() });
      else toast('Les cases sont trop petites pour en ajouter une.');
      return;
    }
  }
  let best = null;
  for (const h of gutterHandles()) {
    const v = h.axis === 'v', along = v ? pt.y : pt.x, across = Math.abs((v ? pt.x : pt.y) - h.pos) * view.s;
    if (along < h.span[0] - R / view.s || along > h.span[1] + R / view.s || across > R) continue;
    if (!best || across < best.across) best = { h, across };
  }
  if (best) { session = { kind: 'gutter', h: best.h, x0: pt.x, y0: pt.y, d: 0 }; return; }
  const p = panelAt(pt.x, pt.y);   // sinon on choisit la case touchée, pour la fusionner ou la supprimer
  if (p) selectPanel(p.id);
}

// ───────────────────────── Bulles ─────────────────────────

const near = (a, b, r) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

function bubbleDown(pt) {
  if (ed.bubbleDraw) { session = { kind: 'free', pts: [{ x: pt.x, y: pt.y }] }; setOverlay({ free: session.pts }); return; }
  const pg = page(), sel = pg.bubbles.find(b => b.id === ed.bubbleId), at = toScreen(pt.x, pt.y);
  const R = pt.type === 'touch' ? 26 : 16;
  if (sel && !sel.hidden) {
    if (near(at, bubbleCross(sel), R)) { deleteBubble(sel); return; }
    if (sel.locked) { /* verrouillée : sélectionnable, pas déplaçable */ }
    else if (near(at, bubbleRotHandle(sel), R)) { start(sel, 'rotate', pt); return; }
    else if (near(at, bubbleCorner(sel), R)) { start(sel, 'resize', pt); return; }
    if (!sel.locked && sel.tail && near(at, toScreen(sel.tail.x, sel.tail.y), R)) { start(sel, 'tail', pt); return; }
    const o = sel.locked ? null : tailOrigin(sel);
    if (o && near(at, toScreen(o.x, o.y), R)) { start(sel, 'origin', pt); return; }
  }
  for (let i = pg.bubbles.length - 1; i >= 0; i--) {
    const bb = pg.bubbles[i];
    if (bb.hidden || pg.bubblesHidden) continue;
    if (hitBubble(bb, pt.x, pt.y)) { selectBubble(bb.id); if (!bb.locked) start(bb, 'move', pt); return; }
  }
  selectBubble(null);
}

function start(b, mode, pt) {
  session = { kind: 'bubble', b, mode, before: snapshotBubble(b), x0: pt.x, y0: pt.y, orig: snapshotBubble(b) };
}

function bubbleMove(pt) {
  const s = session, b = s.b, dx = pt.x - s.x0, dy = pt.y - s.y0, o = s.orig;
  if (s.mode === 'move') {
    b.x = Math.round(o.x + dx); b.y = Math.round(o.y + dy);
    const into = panelAt(b.x + b.w / 2, b.y + b.h / 2);   // posée sur une autre case, la bulle s'y lie
    if (into) b.panel = into.id;
    if (o.tail) b.tail = { x: Math.round(o.tail.x + dx), y: Math.round(o.tail.y + dy) };
    if (o.path) b.path = o.path.map(q => ({ x: Math.round(q.x + dx), y: Math.round(q.y + dy) }));
  } else if (s.mode === 'resize') {
    // le déplacement se mesure dans l'axe de la bulle tournée ; le centre bouge de moitié, donc on recale x, y pour garder le coin haut gauche en place
    const a = (o.rot || 0) * Math.PI / 180, ld = { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
    b.w = Math.max(80, Math.round(o.w + ld.x)); b.h = Math.max(60, Math.round(o.h + ld.y)); b.auto = false;
    if (a) {
      const dw = b.w - o.w, dh = b.h - o.h, cs = Math.cos(a), sn = Math.sin(a);
      b.x = Math.round(o.x + (dw / 2) * (cs - 1) - (dh / 2) * sn); b.y = Math.round(o.y + (dw / 2) * sn + (dh / 2) * (cs - 1));
    }
    if (o.path) { const kx = b.w / o.w, ky = b.h / o.h; b.path = o.path.map(q => ({ x: Math.round(b.x + (q.x - o.x) * kx), y: Math.round(b.y + (q.y - o.y) * ky) })); }
  } else if (s.mode === 'rotate') {
    let deg = Math.atan2(pt.y - (o.y + o.h / 2), pt.x - (o.x + o.w / 2)) * 180 / Math.PI + 90;
    deg = ((Math.round(deg) % 360) + 360) % 360;
    const snap = Math.round(deg / 15) * 15;
    if (Math.abs(deg - snap) <= 3) deg = snap % 360;   // aimante aux multiples de 15°
    b.rot = deg || undefined; if (!b.rot) delete b.rot;
  } else if (s.mode === 'origin') {
    const q = bubbleToLocal(b, pt.x, pt.y);
    b.tailAngle = Math.round(((Math.atan2(q.y - (b.y + b.h / 2), q.x - (b.x + b.w / 2)) * 180 / Math.PI) + 360) % 360);
  } else if (s.mode === 'tail') b.tail = { x: Math.round(o.tail.x + dx), y: Math.round(o.tail.y + dy) };
  setOverlay({});
}

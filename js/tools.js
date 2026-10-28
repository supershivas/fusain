// Outils au pointeur : crayon, pinceau trame, gomme, remplissage, formes, masque, bulles.
// `down/move/up` reçoivent des points en coordonnées de page : { x, y, pressure, type }.
import {
  ed, page, activeLayer, selectPanel, markChanged, selectBubble, commitBubbleEdit, snapshotBubble, ensureMask, addFreeBubble, notify, gutterHandles, clampGutter, resizeGutter,
} from './editor.js';
import {
  stampDisc, strokeSegment, drawRect, drawEllipse, floodRegion, applyRegion, compositeValues,
} from './raster.js';
import { tramaById } from './tramas.js';
import { invalidate, setOverlay, toScreen, view } from './view.js';
import { hitBubble } from './bubbles.js';
import { toast } from './toast.js';

let session = null;
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

const diameter = pt => Math.max(1, Math.round(ed.size * (pt.type === 'pen' && ed.pressure ? 0.4 + 1.2 * pt.pressure : 1)));

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
  let layer;
  if (ed.tool === 'mask') layer = ensureMask();
  else {
    layer = activeLayer(p);
    if (!layer.visible) { toast('Ce calque est masqué : affiche-le pour dessiner.'); return; }
  }
  const lx = Math.floor(pt.x - p.ex), ly = Math.floor(pt.y - p.ey), tool = ed.tool;
  const trame = currentTrama();

  if (tool === 'pencil' || tool === 'texture' || tool === 'eraser' || tool === 'mask') {
    const paint = tool === 'eraser' ? { v: 0 }
      : tool === 'mask' ? { v: ed.maskErase ? 0 : 1 }
      : tool === 'texture' ? { v: ed.ink, trame, scale: ed.tramaScale, opaque: ed.tramaOpaque }
      : { v: ed.ink };
    ed.undo.begin({ pencil: 'Crayon', texture: 'Pinceau trame', eraser: 'Gomme', mask: 'Masque' }[tool]);
    const d = diameter(pt);
    session = { kind: 'stroke', p, layer, ctx: makeCtx(p, layer, paint, tool !== 'mask'), last: { x: lx, y: ly, d } };
    stampDisc(session.ctx, lx, ly, d); flush(session);
  } else if (tool === 'fill') {
    const region = floodRegion(compositeValues(p, false), p.ew, p.eh, lx, ly);
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
    const s = session, lx = Math.floor(pt.x - s.p.ex), ly = Math.floor(pt.y - s.p.ey), d = diameter(pt);
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
  const R = pt.type === 'touch' ? 28 : 18;
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
  if (sel) {
    if (near(at, toScreen(sel.x + sel.w, sel.y + sel.h), R)) { start(sel, 'resize', pt); return; }
    if (sel.tail && near(at, toScreen(sel.tail.x, sel.tail.y), R)) { start(sel, 'tail', pt); return; }
  }
  for (let i = pg.bubbles.length - 1; i >= 0; i--) {
    if (hitBubble(pg.bubbles[i], pt.x, pt.y)) { selectBubble(pg.bubbles[i].id); start(pg.bubbles[i], 'move', pt); return; }
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
    if (o.tail) b.tail = { x: Math.round(o.tail.x + dx), y: Math.round(o.tail.y + dy) };
    if (o.path) b.path = o.path.map(q => ({ x: Math.round(q.x + dx), y: Math.round(q.y + dy) }));
  } else if (s.mode === 'resize') {
    b.w = Math.max(80, Math.round(o.w + dx)); b.h = Math.max(60, Math.round(o.h + dy)); b.auto = false;
    if (o.path) { const kx = b.w / o.w, ky = b.h / o.h; b.path = o.path.map(q => ({ x: Math.round(o.x + (q.x - o.x) * kx), y: Math.round(o.y + (q.y - o.y) * ky) })); }
  } else if (s.mode === 'tail') b.tail = { x: Math.round(o.tail.x + dx), y: Math.round(o.tail.y + dy) };
  setOverlay({});
}

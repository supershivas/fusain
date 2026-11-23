// Outils au pointeur : crayon, pinceau trame, gomme, remplissage, formes, masque, bulles.
// `down/move/up` reçoivent des points en coordonnées de page : { x, y, pressure, type }.
import {
  ed, page, activeLayer, toRGBA, fillLayer, moveStrokeBelow, snapNarration, resizeBubbleWidth, selectPanel, markChanged, selectBubble, commitBubbleEdit, snapshotBubble, ensureMask, addFreeBubble, notify, gutterHandles, clampGutter, resizeGutter, gutterPreview, addTemplateBubble, mergePanels, confirmAdd, cancelAdd, splitRects, deleteBubble,
} from './editor.js';
import {
  stampBrush, strokeSegment, drawRect, drawEllipse, floodRegion, applyRegion, compositeValues, hexToRgb,
} from './raster.js';
import { tramaById } from './tramas.js';
import { invalidate, setOverlay, requestRender, toScreen, view, bubbleCross, bubbleCorner, bubbleRotHandle, edgePluses, previewControls, mergeButtons } from './view.js';
import { mmToPx } from './model.js';
import { hitBubble, tailOrigin, bubbleToLocal } from './bubbles.js';
import { toast } from './toast.js';
import { guideMode, hitHandle, dragHandle, snapStart, guidedPoint } from './guides.js';
import { currentSelection, selectAuto, selectShape, polyAdd, polyFinish, polyFirst, polyCount, beginMove, moveMove, endMove, cancelMove, clearSelection } from './selection.js';

let session = null, hinted = null;   // hinted : dernier calque d'aplat signalé (référence active)
export const busy = () => !!session;

// En mode case, seule la case ouverte reçoit les gestes.
const panelAt = (x, y) => page().panels.find(p => (!ed.focus || p.id === ed.panelId) && x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) || null;

// Motif courant : null = encre pleine, sinon la tuile de trame.
const currentTrama = () => { const t = tramaById(ed.project, ed.tramaId); return t.solid ? null : t; };

function maskFor(p) {
  return ed.maskMode !== 'off' && p.mask && p.mask.data ? { data: p.mask.data, mode: ed.maskMode } : null;
}

function makeCtx(p, layer, paint, useMask = true) {
  const clip = { x0: p.x - p.ex, y0: p.y - p.ey, x1: p.x - p.ex + p.w, y1: p.y - p.ey + p.h };
  const ctx = { layer, undo: ed.undo, ox: p.ex, oy: p.ey, clip, paint, mask: useMask ? maskFor(p) : null, dirty: null, alphaLock: !!(layer && layer.alphaLock) };
  if (layer && (layer.kind === 'color' || layer.rgba)) {   // calque RVBA : vraie opacité (chaque pixel mélangé une fois par trait)
    ctx.rgba = true;
    paint.rgb = ed.ink === 3 ? hexToRgb(ed.color) : [0, 0, 0];
    if ((paint.alpha ?? 1) < 1) ctx.seen = new Uint8Array(layer.w * layer.h);
  }
  return ctx;
}
// Valeur peinte : noir (1), blanc (2) ; la couleur (ed.ink 3) peint « encre » dans un calque de couleur.
const inkV = () => (ed.ink === 3 ? 1 : ed.ink);

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

// Symétrie (ed.symmetry : 'off', 'v' axe vertical, 'h' axe horizontal, 'vh' les deux) autour du centre du cadre de la case.
// Renvoie les transformations des points en coordonnées de calque (pixel x ↔ 2·gauche + largeur − 1 − x).
function mirrorsOf(p) {
  const m = ed.symmetry;
  if (!m || m === 'off') return [];
  const ax = 2 * (p.x - p.ex) + p.w - 1, ay = 2 * (p.y - p.ey) + p.h - 1, out = [];
  if (m.includes('v')) out.push((x, y) => [ax - x, y]);
  if (m.includes('h')) out.push((x, y) => [x, ay - y]);
  if (m === 'vh') out.push((x, y) => [ax - x, ay - y]);
  return out;
}
// Segment du trait et ses reflets.
function segment(s, x0, y0, x1, y1, d0, d1) {
  strokeSegment(s.ctx, x0, y0, x1, y1, d0, d1);
  for (const f of s.mir) { const [a, b] = f(x0, y0), [c, d] = f(x1, y1); strokeSegment(s.ctx, a, b, c, d, d0, d1); }
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
  if (ed.tool === 'select') { selectDown(pt); return; }
  if (['pencil', 'eraser', 'shape'].includes(ed.tool) && guideMode(page()) !== 'off') {
    // poignée d'un guide (règle, point de fuite) : on la déplace au lieu de dessiner
    const h = hitHandle(page(), pt, 22 / view.s);
    if (h) { session = { kind: 'guide', key: h.key, x0: pt.x, y0: pt.y, from: JSON.parse(JSON.stringify(page().guide)) }; return; }
    if (ed.tool !== 'shape') pt = snapStart(page(), pt, 18 / view.s);
  }
  const p = panelAt(pt.x, pt.y);
  if (!p) {
    // Départ hors de toute case : le geste est suivi, et il se pose dans la première case où il entre (rogné au cadre).
    if (['pencil', 'eraser', 'mask', 'shape'].includes(ed.tool)) session = { kind: 'pre', pts: [pt] };
    return;
  }
  begin(p, pt);
}

function begin(p, pt) {
  selectPanel(p.id);
  // Calques tous pareils : chaque outil dessine dans le calque actif. Seul le remplissage évite un calque de référence
  // (il pose l'aplat dans un autre calque, créé au besoin sous la référence).
  let layer;
  if (ed.tool === 'mask') layer = ensureMask();
  else {
    layer = activeLayer(p);
    if (ed.tool === 'fill' && layer.reference) {
      layer = fillLayer(p);
      if (hinted !== layer.id) { hinted = layer.id; toast(`Aplat posé dans « ${layer.name} » : « ${activeLayer(p).name} » est une référence.`, { duration: 2400 }); }
    }
    if (!layer.visible) { toast(`Le calque « ${layer.name} » est masqué : affiche-le pour dessiner.`); return; }
    if (layer.locked) { toast(`Le calque « ${layer.name} » est verrouillé.`); return; }
    if (ed.ink === 3 && ed.tool !== 'eraser' && !layer.draft) toRGBA(layer);   // la couleur s'applique au calque choisi
  }
  const lx = Math.floor(pt.x - p.ex), ly = Math.floor(pt.y - p.ey), tool = ed.tool;
  const trame = currentTrama();

  if (tool === 'pencil' || tool === 'eraser' || tool === 'mask') {
    const alpha = tool === 'mask' ? 1 : ed.alpha;   // opacité tramée du pinceau
    const paint = tool === 'eraser' ? { v: 0, alpha }
      : tool === 'mask' ? { v: ed.maskErase ? 0 : 1 }
      : { v: inkV(), trame, scale: ed.tramaScale, opaque: ed.tramaOpaque, alpha };   // pinceau : encre pleine ou trame
    ed.undo.begin({ pencil: currentTrama() ? 'Pinceau trame' : 'Pinceau', eraser: 'Gomme', mask: 'Masque' }[tool]);
    const sp = tool === 'pencil' || tool === 'eraser' ? ed.brushParams : null;
    const d = sp && sp.start > 0 ? Math.max(1, Math.round(ed.size * 0.3)) : diameter(pt);
    session = { kind: 'stroke', p, layer, ctx: makeCtx(p, layer, paint, tool !== 'mask'), last: { x: lx, y: ly, d }, travel: 0, speed: 0, pos: { x: lx, y: ly }, target: { x: lx, y: ly }, mir: tool === 'mask' ? [] : mirrorsOf(p) };
    if (tool !== 'mask' && guideMode(page()) !== 'off') session.gst = { start: { x: pt.x, y: pt.y }, dir: null };
    if (sp) session.ctx.brush = { spec: sp, seed: Math.floor(Math.random() * 1e6), n: 0, pr: pressureOf(pt) };
    stampBrush(session.ctx, lx, ly, d);
    for (const f of session.mir) stampBrush(session.ctx, ...f(lx, ly), d);
    flush(session);
  } else if (tool === 'fill') {
    const region = floodRegion(compositeValues(p, false), p.ew, p.eh, lx, ly, fillGapPx());
    if (!region) return;
    ed.undo.begin('Remplir');
    const ctx = makeCtx(p, layer, { v: inkV(), trame, scale: ed.tramaScale, opaque: ed.tramaOpaque });
    applyRegion(ctx, region);
    inkHint(p, layer, ed.undo.commit(), 'fill');
    invalidate(p, { x: region.x0, y: region.y0, w: region.x1 - region.x0 + 1, h: region.y1 - region.y0 + 1 });
    markChanged();
  } else if (tool === 'shape') {
    session = { kind: 'shape', p, layer, x0: pt.x, y0: pt.y };
    setOverlay({ shape: { kind: ed.shapeKind, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y } });
  }
}

// Glisser-déposer de la couleur (ColorDrop) : la couleur principale lâchée sur le dessin remplit la zone
// fermée sous le point, guidée par les calques de référence, dans un calque qui n'est pas une référence.
export function colorDrop(pt) {
  const p = panelAt(pt.x, pt.y);
  if (!p) return false;
  const lx = Math.floor(pt.x - p.ex), ly = Math.floor(pt.y - p.ey);
  const region = floodRegion(compositeValues(p, false), p.ew, p.eh, lx, ly, fillGapPx());
  if (!region) return false;
  selectPanel(p.id);
  const layer = fillLayer(p);
  if (ed.ink === 3) toRGBA(layer);
  ed.undo.begin('Glisser la couleur');
  applyRegion(makeCtx(p, layer, { v: inkV(), alpha: 1 }), region);
  inkHint(p, layer, ed.undo.commit(), 'drop');
  invalidate(p, { x: region.x0, y: region.y0, w: region.x1 - region.x0 + 1, h: region.y1 - region.y0 + 1 });
  markChanged();
  return layer;
}

// ── Conseil « on colorie sur l'encrage » : signes explicites seulement (référence, ou nom de calque d'encrage) ──
const INK_NAME = /dessin|encrage|encre|line|trait|ink/i;
const inkHinted = new Set();   // une fois par calque et par séance
const looksLikeInk = l => !!l && !l.draft && !l.noInkHint && (l.reference || INK_NAME.test(l.name || ''));
// geste de mise en couleur : remplissage, couleur glissée, ou pinceau en couleur, tramé ou transparent (un aplat noir reste de l'encrage)
const coloring = tool => tool === 'fill' || tool === 'drop' || (tool === 'pencil' && (ed.ink === 3 || !!currentTrama() || ed.alpha < 1));
function inkHint(p, layer, entry, tool) {
  if (!entry || !entry.ops || !looksLikeInk(layer) || inkHinted.has(layer.id) || !coloring(tool)) return;
  inkHinted.add(layer.id);
  toast(`« ${layer.name} » ressemble à un encrage. Colorier dans un calque dessous ?`, {
    duration: 9000,
    actionLabel: 'Déplacer', onAction: () => {
      const l = moveStrokeBelow(p, layer, entry);
      toast(l ? `Coloriage déplacé dans « ${l.name} », qui reste actif.` : 'Trop tard : d\'autres changements ont suivi.', { duration: 2600 });
    },
    action2Label: 'Ne plus demander', onAction2: () => { layer.noInkHint = true; markChanged(); },
  });
}

// Remplir la sélection dans le calque actif, avec la couleur principale et la trame du pinceau.
export function fillSelection() {
  const p = page().panels.find(q => q.id === ed.panelId) || page().panels[0], s = currentSelection(p);
  if (!s) return 'none';
  const layer = activeLayer(p);
  if (!layer.visible || layer.locked) return 'locked';
  if (ed.ink === 3 && !layer.draft) toRGBA(layer);
  ed.undo.begin('Remplir la sélection');
  applyRegion(makeCtx(p, layer, { v: inkV(), trame: currentTrama(), scale: ed.tramaScale, opaque: ed.tramaOpaque, alpha: 1 }), { mask: s.mask, x0: s.x0, y0: s.y0, x1: s.x1 - 1, y1: s.y1 - 1 });
  ed.undo.commit();
  invalidate(p, { x: s.x0, y: s.y0, w: s.x1 - s.x0, h: s.y1 - s.y0 }); markChanged();
  return 'ok';
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
  if (session.kind === 'guide') {
    dragHandle(page(), session.key, session.from, pt.x - session.x0, pt.y - session.y0);
    requestRender();
    return;
  }
  if (session.kind === 'stroke') {
    if (session.gst) { const q = guidedPoint(page(), session.gst, pt, 6 / view.s); if (!q) return; pt = q; }
    const s = session, tx = Math.floor(pt.x - s.p.ex), ty = Math.floor(pt.y - s.p.ey);
    s.target = { x: tx, y: ty };
    // stabilisation : le tampon suit le doigt avec un léger retard, ce qui lisse les tremblements
    const k = s.ctx.brush && s.ctx.brush.spec.smooth ? 1 - s.ctx.brush.spec.smooth * 0.8 : 1;
    s.pos.x += (tx - s.pos.x) * k; s.pos.y += (ty - s.pos.y) * k;
    const lx = Math.round(s.pos.x), ly = Math.round(s.pos.y);
    const d = brushDiameter(pt, s, Math.hypot(lx - s.last.x, ly - s.last.y));
    segment(s, s.last.x, s.last.y, lx, ly, s.last.d, d);
    s.last = { x: lx, y: ly, d };
    flush(s);
  } else if (session.kind === 'shape') {
    setOverlay({ shape: { kind: ed.shapeKind, x0: session.x0, y0: session.y0, x1: pt.x, y1: pt.y } });
    session.x1 = pt.x; session.y1 = pt.y;
  } else if (session.kind === 'gutter') {
    const h = session.h, v = h.axis === 'v', d = clampGutter(h, (v ? pt.x - session.x0 : pt.y - session.y0));
    session.d = d;
    setOverlay({ guide: { axis: h.axis, pos: h.pos + d, s0: h.span[0], s1: h.span[1], panels: gutterPreview(h, d) } });
  } else if (session.kind === 'ratio') {
    ratioMove(pt);
  } else if (session.kind === 'free') {
    const l = session.pts[session.pts.length - 1];
    if (Math.hypot(pt.x - l.x, pt.y - l.y) > 3) { session.pts.push({ x: pt.x, y: pt.y }); setOverlay({ free: session.pts }); }
  } else if (session.kind === 'bubble') bubbleMove(pt);
  else if (session.kind === 'selmove') moveMove(session, pt);
  else if (session.kind === 'selfree') {
    const l = session.pts[session.pts.length - 1];
    if (Math.hypot(pt.x - l.x, pt.y - l.y) > 3) { session.pts.push({ x: pt.x, y: pt.y }); setOverlay({ free: session.pts }); }
  } else if (session.kind === 'selshape') {
    session.x1 = pt.x; session.y1 = pt.y;
    setOverlay({ shape: { kind: ed.selMode, x0: session.x0, y0: session.y0, x1: pt.x, y1: pt.y } });
  }
}

export function up() {
  const s = session; session = null;
  if (!s) return;
  if (s.kind === 'guide') { markChanged(); requestRender(); return; }
  if (s.kind === 'stroke') {
    if (s.ctx.brush && s.ctx.brush.spec.smooth && (s.last.x !== s.target.x || s.last.y !== s.target.y)) {   // rattrape le retard de la stabilisation
      segment(s, s.last.x, s.last.y, s.target.x, s.target.y, s.last.d, Math.max(1, Math.round(s.last.d * 0.5))); flush(s);
    }
    const entry = ed.undo.commit(); markChanged();
    inkHint(s.p, s.layer, entry, ed.tool);
  } else if (s.kind === 'shape') {
    setOverlay({ shape: null });
    if (s.x1 === undefined) return;
    const trame = currentTrama(), p = s.p;
    const paint = { v: inkV(), trame, scale: ed.tramaScale, opaque: ed.tramaOpaque };
    const ctx = makeCtx(p, s.layer, paint);
    const x0 = Math.floor(s.x0 - p.ex), y0 = Math.floor(s.y0 - p.ey), x1 = Math.floor(s.x1 - p.ex), y1 = Math.floor(s.y1 - p.ey);
    ed.undo.begin({ line: 'Ligne', rect: 'Rectangle', ellipse: 'Ellipse' }[ed.shapeKind]);
    // les traits des formes suivent la même trame que les remplissages
    const draw = (x0, y0, x1, y1) => {
      if (ed.shapeKind === 'line') strokeSegment(ctx, x0, y0, x1, y1, ed.size);
      else if (ed.shapeKind === 'rect') drawRect(ctx, x0, y0, x1, y1, ed.size, ed.shapeFilled);
      else drawEllipse(ctx, x0, y0, x1, y1, ed.size, ed.shapeFilled);
    };
    draw(x0, y0, x1, y1);
    for (const f of mirrorsOf(p)) draw(...f(x0, y0), ...f(x1, y1));
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
  } else if (s.kind === 'selmove') endMove(s);
  else if (s.kind === 'selfree') {
    setOverlay({ free: null });
    if (!(s.pts.length >= 3 && selectShape(s.p, 'poly', s.pts, ed.selOp)) && ed.selOp === 'new') clearSelection();
  } else if (s.kind === 'selshape') {
    setOverlay({ shape: null });
    const ok = s.x1 !== undefined && selectShape(s.p, ed.selMode, [{ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }], ed.selOp);
    if (!ok && ed.selOp === 'new') clearSelection();   // un simple toucher dans le vide désélectionne
  }
}

// Geste interrompu (second doigt posé) : on défait le trait en cours sans rien empiler.
export function cancel() {
  const s = session; session = null;
  if (!s) return;
  if (s.kind === 'stroke') { ed.undo.rollback(); invalidate(s.p); }
  else if (s.kind === 'guide') { page().guide = s.from; requestRender(); }
  else if (s.kind === 'shape') setOverlay({ shape: null });
  else if (s.kind === 'free') setOverlay({ free: null });
  else if (s.kind === 'gutter') setOverlay({ guide: null });
  else if (s.kind === 'selmove') cancelMove(s);
  else if (s.kind === 'selfree') setOverlay({ free: null });
  else if (s.kind === 'selshape') setOverlay({ shape: null });
  else if (s.kind === 'bubble') { Object.keys(s.b).forEach(k => delete s.b[k]); Object.assign(s.b, s.before); selectBubble(s.b.id); }
}

// ───────────────────────── Sélection ─────────────────────────

function selectDown(pt) {
  if (ed.selMove) {   // déplacer : la sélection, ou à défaut tout le contenu de la case touchée
    const p = (ed.sel && page().panels.find(q => q.id === ed.sel.panelId)) || panelAt(pt.x, pt.y);
    if (!p) return;
    selectPanel(p.id);
    session = beginMove(p, pt);
    return;
  }
  const p = panelAt(pt.x, pt.y);
  if (!p) return;
  selectPanel(p.id);
  const mode = ed.selMode;
  if (mode === 'auto') { if (!selectAuto(p, Math.floor(pt.x - p.ex), Math.floor(pt.y - p.ey), ed.selOp) && ed.selOp === 'new') clearSelection(); }
  else if (mode === 'poly') {
    const f = polyFirst();
    if (f && polyCount() >= 3 && near(toScreen(pt.x, pt.y), toScreen(f.x, f.y), pt.type === 'touch' ? 26 : 14)) polyFinish();
    else polyAdd(p, pt);
  } else if (mode === 'free') { session = { kind: 'selfree', p, pts: [{ x: pt.x, y: pt.y }] }; setOverlay({ free: session.pts }); }
  else session = { kind: 'selshape', p, x0: pt.x, y0: pt.y };
}

// ───────────────────────── Gouttières ─────────────────────────

// La poignée de l'aperçu d'ajout suit le doigt : la part de la nouvelle case s'ajuste (20 à 80 %), avec un aimant à 25, 33, 50, 67 et 75 %.
function ratioMove(pt) {
  const s = session, p = s.ap, gap = mmToPx(ed.project.gutter, ed.project.dpi);
  const L = (s.horiz ? pt.x : pt.y) - s.off, total = (s.horiz ? p.w : p.h) - gap;
  const fresh = { right: p.x + p.w - L, left: L - p.x, bottom: p.y + p.h - L, top: L - p.y }[s.side];
  let r = Math.max(0.2, Math.min(0.8, fresh / total));
  for (const m of [0.25, 1 / 3, 0.5, 2 / 3, 0.75]) if (Math.abs(r - m) < 0.02) r = m;
  if (!splitRects(p, s.side, r)) return;
  ed.addRatio = r * 100;
  setOverlay({});
}


// Bouton de fusion : le rond et son étiquette « Fusionner » dessous.
const onMerge = (at, m, touch) => Math.hypot(at.x - m.x, at.y - m.y) <= m.r + (touch ? 8 : 3)
  || (Math.abs(at.x - m.x) <= 48 && at.y >= m.y && at.y <= m.y + m.r + 30);
// Outil Taille des cases au doigt quand le stylet est en usage : un doigt posé sur un bouton de fusion, un « + », l'aperçu d'ajout
// ou une gouttière agit dessus ; ailleurs, il déplace la vue.
export function layoutTouchable(pt) {
  if (ed.tool !== 'layout' || ed.focus) return false;
  const at = toScreen(pt.x, pt.y), ap = page().panels.find(p => p.id === ed.panelId);
  if (!ap) return false;
  const pc = previewControls(ap);
  if (pc) return true;   // pendant l'aperçu, tout toucher le règle, le valide ou l'abandonne
  if (mergeButtons(ap).some(m => onMerge(at, m, true))) return true;
  if (edgePluses(ap).some(pl => Math.hypot(at.x - pl.x, at.y - pl.y) <= pl.r + 10)) return true;
  return gutterHandles().some(h => {
    const v = h.axis === 'v', along = v ? pt.y : pt.x, across = Math.abs((v ? pt.x : pt.y) - h.pos) * view.s;
    return along >= h.span[0] - 28 / view.s && along <= h.span[1] + 28 / view.s && across <= 28;
  });
}

// On attrape une gouttière n'importe où le long de son trait.
function layoutDown(pt) {
  const R = pt.type === 'touch' ? 28 : 18, at = toScreen(pt.x, pt.y);
  const ap = page().panels.find(p => p.id === ed.panelId), pc = ap && previewControls(ap), near = (c, r) => Math.hypot(at.x - c.x, at.y - c.y) <= r + (pt.type === 'touch' ? 6 : 2);
  const added = () => toast('Case ajoutée.', { actionLabel: 'Annuler', duration: 6000, onAction: () => ed.undo.undo() });
  if (pc) {   // aperçu en cours : ✓ ajoute, ✕ abandonne, la poignée de la ligne pointillée règle la part de la nouvelle case
    if (near(pc.ok, pc.ok.r)) { if (confirmAdd()) added(); setOverlay({}); return; }
    if (near(pc.no, pc.no.r)) { cancelAdd(); return; }
    if (near(pc.handle, pc.handle.r)) { session = { kind: 'ratio', ap, side: pc.side, horiz: pc.horiz, off: (pc.horiz ? pt.x : pt.y) - pc.line }; return; }
    cancelAdd(); return;   // un toucher ailleurs abandonne l'aperçu sans rien faire d'autre
  }
  if (ap && !pc) for (const m of mergeButtons(ap)) {   // bouton de fusion posé dans la case voisine : la case active l'absorbe
    if (!onMerge(at, m, pt.type === 'touch')) continue;
    if (mergePanels(ap.id, m.id)) toast('Cases fusionnées.', { actionLabel: 'Annuler', duration: 6000, onAction: () => ed.undo.undo() });
    notify('tool'); setOverlay({}); return;
  }
  if (ap) for (const pl of edgePluses(ap)) {   // « + » d'un bord de la case active : montre la future case (réglée ensuite par sa poignée)
    if (Math.hypot(at.x - pl.x, at.y - pl.y) > pl.r + (pt.type === 'touch' ? 10 : 4)) continue;
    if (!splitRects(ap, pl.side, ed.addRatio / 100)) { toast('Cette case est trop petite pour être coupée de ce côté.'); return; }
    ed.addPreview = { panelId: ap.id, side: pl.side }; ed.addRatio = 50;
    notify('tool'); setOverlay({}); return;
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
    if (ed.focus && bb.panel !== ed.panelId) continue;   // mode case : seules les bulles de la case se touchent
    if (bb.hidden || pg.bubblesHidden) continue;
    if (hitBubble(bb, pt.x, pt.y)) { selectBubble(bb.id); if (!bb.locked) start(bb, 'move', pt); return; }
  }
  const into = panelAt(pt.x, pt.y);
  if (into) { selectPanel(into.id); addTemplateBubble({ x: pt.x, y: pt.y }); notify('bubble-added'); return; }   // un toucher dans une case y pose une bulle du modèle choisi
  selectBubble(null);
}

// Un toucher à cet endroit agirait-il sur une bulle (bulle de la case, ou poignée de la bulle choisie) ? Sert au doigt :
// quand le stylet dessine, le doigt déplace la vue, sauf sur une bulle avec l'outil Bulle.
export function bubbleTouchable(pt) {
  if (ed.tool !== 'bubble' || ed.bubbleDraw) return false;
  const pg = page(), sel = pg.bubbles.find(b => b.id === ed.bubbleId), at = toScreen(pt.x, pt.y), R = 26;
  if (sel && !sel.hidden) {
    const hs = [bubbleCross(sel), bubbleRotHandle(sel), bubbleCorner(sel)];
    if (sel.tail) hs.push(toScreen(sel.tail.x, sel.tail.y));
    const o = tailOrigin(sel); if (o) hs.push(toScreen(o.x, o.y));
    if (hs.some(h => near(at, h, R))) return true;
  }
  return !pg.bubblesHidden && pg.bubbles.some(bb => !bb.hidden && (!ed.focus || bb.panel === ed.panelId) && hitBubble(bb, pt.x, pt.y));
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
    snapNarration(b, page().panels);   // narration : calée à sa marge près des bords de la case
  } else if (s.mode === 'resize') {
    // le déplacement se mesure dans l'axe de la bulle tournée ; le centre bouge de moitié, donc on recale x, y pour garder le coin haut gauche en place
    const a = (o.rot || 0) * Math.PI / 180, ld = { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
    if (o.path) {   // bulle dessinée à la main : sa forme s'étire librement
      b.w = Math.max(80, Math.round(o.w + ld.x)); b.h = Math.max(60, Math.round(o.h + ld.y)); b.auto = false;
      const kx = b.w / o.w, ky = b.h / o.h; b.path = o.path.map(q => ({ x: Math.round(b.x + (q.x - o.x) * kx), y: Math.round(b.y + (q.y - o.y) * ky) }));
    } else {
      // taille toujours automatique : le coin choisit la largeur (la forme), la hauteur suit le texte
      resizeBubbleWidth(b, o.w + ld.x, a ? null : { x: o.x, y: o.y });
      if (a) {
        const dw = b.w - o.w, dh = b.h - o.h, cs = Math.cos(a), sn = Math.sin(a);
        b.x = Math.round(o.x + (dw / 2) * (cs - 1) - (dh / 2) * sn); b.y = Math.round(o.y + (dw / 2) * sn + (dh / 2) * (cs - 1));
      } else snapNarration(b, page().panels, { resize: true });
    }
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

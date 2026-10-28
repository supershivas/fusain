// État de l'éditeur et actions sur le document (pages, cases, calques, bulles), toutes annulables.
import {
  newLayer, newPage, newBubble, pageLayers, ensureData, mmToPx, uid, layoutById, layoutRects, pageSize, newPanel, DRAFT_COLORS,
} from './model.js';
import { UndoStack, BUILTIN_BRUSHES, BRUSH_DEFAULTS, brushSpec } from './raster.js';
import { saveProject, loadPage, unloadPage, setThumb } from './store.js';
import { pageThumb } from './export.js';
import { syncSoon } from './sync.js';
import { autoSize, pathBounds } from './bubbles.js';
import { invalidate, invalidateLayer, dropCaches, requestRender } from './view.js';

export const ed = {
  project: null, pageIdx: 0, panelId: null, bubbleId: null,
  tool: 'pencil', size: 6, sizeMm: 0.5, ink: 1, brushId: 'stylo', brushParams: null, customBrushes: [], brushSizes: {}, tramaPresets: [], toolSettings: {}, bubbleDefaults: {}, ditherOpts: {}, solo: null,
  tramaId: 'plein', tramaScale: 2, tramaOpaque: false,
  shapeKind: 'rect', shapeFilled: false,
  maskMode: 'off', maskErase: false, bubbleDraw: false,
  fingerDraws: false, pressure: true, pressureGamma: 1, showNotes: true,
  undo: new UndoStack(),
};

const subs = new Set();
export const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
export const notify = what => subs.forEach(fn => fn(what));

// Chaque outil garde ses propres réglages (taille, encre, trame, forme…) : on les range en quittant l'outil et on les reprend en y revenant.
export const TOOL_DEFAULTS = {
  pencil: { sizeMm: 0.5, ink: 1, brushId: 'stylo', brushParams: null },
  texture: { sizeMm: 3, ink: 1, tramaId: 'g25', tramaScale: 2, tramaOpaque: false },
  eraser: { sizeMm: 3 },
  fill: { ink: 1, tramaId: 'plein', tramaScale: 2, tramaOpaque: false },
  shape: { sizeMm: 0.5, ink: 1, shapeKind: 'rect', shapeFilled: false, tramaId: 'plein', tramaScale: 2, tramaOpaque: false },
  mask: { sizeMm: 6, maskErase: false },
};
export function storeToolSettings() {
  const d = TOOL_DEFAULTS[ed.tool];
  if (d) ed.toolSettings[ed.tool] = Object.fromEntries(Object.keys(d).map(k => [k, ed[k]]));
}
export function applyToolSettings() {
  const d = TOOL_DEFAULTS[ed.tool];
  if (d) Object.assign(ed, d, ed.toolSettings[ed.tool]);
  ed.brushParams = { ...BRUSH_DEFAULTS, ...(ed.brushParams || brushSpec(ed.brushId, ed.customBrushes)) };
  syncSize();
}

// ── Pinceaux : livrés ou enregistrés par l'utilisateur ──
export const allBrushes = () => BUILTIN_BRUSHES.concat(ed.customBrushes);
export const currentBrush = () => allBrushes().find(b => b.id === ed.brushId) || BUILTIN_BRUSHES[0];

// Choisir un pinceau reprend la dernière taille réglée pour lui.
export function selectBrush(id) {
  ed.brushSizes[ed.brushId] = ed.sizeMm;
  ed.brushId = id; ed.brushParams = brushSpec(id, ed.customBrushes);
  setSizeMm(ed.brushSizes[id] ?? ed.brushParams.sizeMm);
}
export function resetBrush() { ed.brushParams = brushSpec(ed.brushId, ed.customBrushes); }
export function saveBrushAs(name) {
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  ed.customBrushes.push({ ...ed.brushParams, id, name, group: 'Mes pinceaux', custom: true, sizeMm: ed.sizeMm });
  ed.brushSizes[id] = ed.sizeMm; ed.brushId = id; ed.brushParams = brushSpec(id, ed.customBrushes);
}
export function updateBrush() {
  const i = ed.customBrushes.findIndex(b => b.id === ed.brushId);
  if (i >= 0) { const c = ed.customBrushes[i]; ed.customBrushes[i] = { ...ed.brushParams, id: c.id, name: c.name, group: 'Mes pinceaux', custom: true, sizeMm: ed.sizeMm }; }
}
export function deleteBrush(id) {
  ed.customBrushes = ed.customBrushes.filter(b => b.id !== id);
  if (ed.brushId === id) selectBrush('stylo');
}
// La taille se règle en millimètres (la même épaisseur à 150 ou 300 dpi) ; `ed.size` en est la valeur en pixels.
export function syncSize() { ed.size = Math.max(1, Math.round(ed.sizeMm / 25.4 * (ed.project ? ed.project.dpi : 300))); }
export function setSizeMm(mm) { ed.sizeMm = Math.max(0.05, Math.min(30, mm)); syncSize(); }

export const page = () => ed.project.pages[ed.pageIdx];
export const panel = () => page().panels.find(p => p.id === ed.panelId) || page().panels[0];
export const activeLayer = p => { p = p || panel(); return p.layers.find(l => l.id === p.active) || p.layers[p.layers.length - 1]; };
export const bubble = () => page().bubbles.find(b => b.id === ed.bubbleId) || null;

ed.undo.onApply = (layer, rect) => invalidateLayer(layer, rect);
ed.undo.onChange = () => { notify('undo'); };

let ctx2d = null;
const measureCtx = () => ctx2d || (ctx2d = document.createElement('canvas').getContext('2d'));

// ───────────────────────── Ouverture et enregistrement ─────────────────────────

export async function openInEditor(project, pageIdx = 0) {
  ed.project = project; ed.pageIdx = Math.min(pageIdx, project.pages.length - 1);
  ed.undo.clear(); ed.bubbleId = null;
  applyToolSettings();
  await loadPage(project, page());
  ed.panelId = page().panels[0] ? page().panels[0].id : null;
  invalidatePage();
  notify('project');
}

export function invalidatePage() { for (const p of page().panels) invalidate(p); }

let saveTimer = null, saving = Promise.resolve(), lastThumb = 0, changed = false, inflight = 0;

export function markChanged() {
  changed = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 1500);
  notify('dirty');
}

export const hasPendingSave = () => changed || saveTimer !== null || inflight > 0;

// Enregistre d'abord (rien ne se perd), puis met à jour la vignette de la première page si elle est en mémoire.
export function saveNow(withThumb = false) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!ed.project) return saving;
  const project = ed.project, wasChanged = changed;
  changed = false;
  inflight++;
  saving = saving.then(async () => {
    await saveProject(project, { changed: wasChanged });
    if (wasChanged) syncSoon();
    notify('saved');
    const first = project.pages[0];
    if (wasChanged && (withThumb || Date.now() - lastThumb > 30000) && pageLayers(first).every(l => l.loaded)) {
      try { await setThumb(project.id, await pageThumb(project, first)); lastThumb = Date.now(); } catch { /* vignette facultative */ }
    }
  }).catch(e => { console.error(e); notify('save-error'); }).finally(() => { inflight--; });
  return saving;
}

export async function closeEditor() {
  await saveNow(true);
  if (ed.project) { for (const p of ed.project.pages) { dropCaches(p); unloadPage(p); } }
  ed.project = null; ed.panelId = null; ed.bubbleId = null; ed.undo.clear();
}

// ───────────────────────── Pages ─────────────────────────

export async function goToPage(idx) {
  if (idx < 0 || idx >= ed.project.pages.length || idx === ed.pageIdx) return;
  await saveNow();
  const old = page();
  ed.pageIdx = idx; ed.bubbleId = null; ed.undo.clear();
  await loadPage(ed.project, page());
  dropCaches(old); unloadPage(old);
  ed.panelId = page().panels[0] ? page().panels[0].id : null;
  invalidatePage(); notify('page');
}

export async function addPage(layoutId, count) {
  const pg = newPage(ed.project, layoutId, count);
  ed.project.pages.splice(ed.pageIdx + 1, 0, pg);
  markChanged();
  await goToPage(ed.pageIdx + 1);
}

export async function duplicatePage() {
  const src = page(), pg = { id: uid(), panels: [], bubbles: JSON.parse(JSON.stringify(src.bubbles)).map(b => ({ ...b, id: uid() })) };
  for (const p of src.panels) {
    const np = newPanel(p);
    Object.assign(np, { ex: p.ex, ey: p.ey, ew: p.ew, eh: p.eh, stroke: p.stroke });
    np.note = { ...p.note };
    np.layers = p.layers.map(l => {
      const nl = newLayer(l.name, l.w, l.h, { kind: l.kind, color: l.color });
      Object.assign(nl, { visible: l.visible, opacity: l.opacity, locked: l.locked });
      if (l.data) { nl.data = l.data.slice(); nl.dirty = true; }
      return nl;
    });
    const ai = p.layers.findIndex(l => l.id === p.active);
    np.active = np.layers[Math.max(0, ai)].id;
    if (p.mask && p.mask.data) { np.mask = newLayer('Masque', p.ew, p.eh); np.mask.data = p.mask.data.slice(); np.mask.dirty = true; }
    pg.panels.push(np);
  }
  ed.project.pages.splice(ed.pageIdx + 1, 0, pg);
  markChanged();
  await goToPage(ed.pageIdx + 1);
}

// Supprime la page ; renvoie une fonction qui la rétablit (toast « Annuler »).
export async function deletePage() {
  const project = ed.project;
  if (project.pages.length < 2) return null;
  const idx = ed.pageIdx, removed = project.pages[idx];
  await saveNow();
  const target = idx > 0 ? idx - 1 : 1;
  await goToPage(target);
  const at = project.pages.indexOf(removed), shown = page();
  project.pages.splice(at, 1);
  ed.pageIdx = project.pages.indexOf(shown);
  markChanged(); notify('page');
  return async () => {
    const cur = page();
    project.pages.splice(Math.min(at, project.pages.length), 0, removed);
    ed.pageIdx = project.pages.indexOf(cur);
    markChanged(); notify('page');
  };
}

export function movePage(dir) {
  const pages = ed.project.pages, i = ed.pageIdx, j = i + dir;
  if (j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  ed.pageIdx = j; markChanged(); notify('page');
}

// Change la disposition des cases de la page. Le dessin reste à sa place ; les cases en trop sont retirées (annulable).
export function relayoutPage(layoutId) {
  const project = ed.project, pg = page();
  const { w, h } = pageSize(project);
  const layout = layoutById(layoutId, pg.panels.length);
  const rects = layoutRects(layout, w, h, mmToPx(project.margin, project.dpi), mmToPx(project.gutter, project.dpi));
  const before = pg.panels.slice();
  const after = rects.map((r, i) => before[i] ? reshape(before[i], r) : newPanel(r));
  swapPanels(pg, after);
  ed.undo.pushAction('Disposition', () => swapPanels(pg, before), () => swapPanels(pg, after));
  return { removed: Math.max(0, before.length - after.length) };
}

// Remplace les cases de la page (disposition, gouttières) ; les calques des cases nouvelles ou restaurées sont à réécrire.
function swapPanels(pg, list) {
  const prev = new Set(pg.panels.flatMap(p => [...p.layers, p.mask]));
  pg.panels = list;
  if (!list.some(p => p.id === ed.panelId)) ed.panelId = list[0].id;
  for (const p of list) for (const l of [...p.layers, p.mask]) if (l && !prev.has(l)) l.dirty = true;
  dropCaches(pg); invalidatePage(); notify('panels'); markChanged();
}

const union = (a, b) => {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// Nouvelle case de rectangle `r` : le dessin reste à sa place sur la page, la case en révèle plus ou moins.
// Les calques ne rétrécissent jamais (ils couvrent l'étendue la plus large atteinte) : rien n'est effacé, même case réduite.
function reshape(old, r, extra = null) {
  const oldExt = { x: old.ex, y: old.ey, w: old.ew, h: old.eh };
  let ext = union(oldExt, r);
  if (extra) ext = union(ext, extra);
  const np = { ...old, x: r.x, y: r.y, w: r.w, h: r.h, ex: ext.x, ey: ext.y, ew: ext.w, eh: ext.h };
  if (ext.x === oldExt.x && ext.y === oldExt.y && ext.w === oldExt.w && ext.h === oldExt.h) return np;   // mêmes calques
  const dx = old.ex - ext.x, dy = old.ey - ext.y;
  const grow = l => {
    if (!l) return l;
    const nl = { ...l, w: ext.w, h: ext.h, data: null, dirty: true, loaded: true };
    if (l.data) {
      nl.data = new Uint8Array(ext.w * ext.h);
      for (let j = 0; j < l.h; j++) nl.data.set(l.data.subarray(j * l.w, (j + 1) * l.w), (j + dy) * ext.w + dx);
    }
    return nl;
  };
  np.layers = old.layers.map(grow); np.mask = grow(old.mask);
  return np;
}

// ───────────────────────── Gouttières : changer la taille des cases ─────────────────────────

// Une poignée par gouttière (colonne ou ligne) : elle déplace d'un coup toutes les cases qui la bordent.
export function gutterHandles() {
  const ps = page().panels, gap = mmToPx(ed.project.gutter, ed.project.dpi), tol = Math.max(4, gap * 0.5), out = [];
  for (const axis of ['v', 'h']) {
    const v = axis === 'v', groups = [];
    const pairs = [];
    for (const a of ps) for (const c of ps) {
      if (a === c) continue;
      const aEnd = v ? a.x + a.w : a.y + a.h, cStart = v ? c.x : c.y;
      if (Math.abs(aEnd + gap - cStart) > tol) continue;
      const a0 = v ? a.y : a.x, a1 = a0 + (v ? a.h : a.w), c0 = v ? c.y : c.x, c1 = c0 + (v ? c.h : c.w);
      if (Math.min(a1, c1) - Math.max(a0, c0) <= 0) continue;
      pairs.push({ a, c, pos: (aEnd + cStart) / 2 });
    }
    for (const pr of pairs.sort((x, y) => x.pos - y.pos)) {
      const g = groups.find(x => Math.abs(x.pos - pr.pos) <= tol);
      if (g) { g.L.add(pr.a); g.R.add(pr.c); } else groups.push({ axis, pos: pr.pos, L: new Set([pr.a]), R: new Set([pr.c]) });
    }
    for (const g of groups) {
      const all = [...g.L, ...g.R], s0 = Math.min(...all.map(p => v ? p.y : p.x)), s1 = Math.max(...all.map(p => v ? p.y + p.h : p.x + p.w));
      out.push({ axis, pos: g.pos, span: [s0, s1], L: [...g.L].map(p => p.id), R: [...g.R].map(p => p.id) });
    }
  }
  return out;
}

export function clampGutter(h, d) {
  const { w, h: ph } = pageSize(ed.project), min = Math.round(Math.min(w, ph) * 0.1), v = h.axis === 'v';
  const size = p => (v ? p.w : p.h), by = id => page().panels.find(p => p.id === id);
  const lo = -(Math.min(...h.L.map(id => size(by(id)))) - min), hi = Math.min(...h.R.map(id => size(by(id)))) - min;
  return Math.round(Math.max(lo, Math.min(hi, d)));
}

export function resizeGutter(h, d) {
  d = clampGutter(h, d);
  if (!d) return;
  const pg = page(), before = pg.panels.slice(), v = h.axis === 'v';
  const after = before.map(p => {
    if (h.L.includes(p.id)) return reshape(p, v ? { x: p.x, y: p.y, w: p.w + d, h: p.h } : { x: p.x, y: p.y, w: p.w, h: p.h + d });
    if (h.R.includes(p.id)) return reshape(p, v ? { x: p.x + d, y: p.y, w: p.w - d, h: p.h } : { x: p.x, y: p.y + d, w: p.w, h: p.h - d });
    return p;
  });
  swapPanels(pg, after);
  ed.undo.pushAction('Taille des cases', () => swapPanels(pg, before), () => swapPanels(pg, after));
}

// ───────────────────────── Copier le contenu d'une case dans une autre ─────────────────────────

// Partie visible d'un calque (w × h de la case), extraite de son étendue.
function visibleData(layer, panel) {
  const out = new Uint8Array(panel.w * panel.h);
  if (!layer.data) return out;
  const ox = panel.x - panel.ex, oy = panel.y - panel.ey;
  for (let y = 0; y < panel.h; y++) out.set(layer.data.subarray((oy + y) * layer.w + ox, (oy + y) * layer.w + ox + panel.w), y * panel.w);
  return out;
}

// Pose des pixels de la taille du cadre visible dans un tampon de l'étendue de la case.
function placeVisible(vis, panel) {
  const out = new Uint8Array(panel.ew * panel.eh), ox = panel.x - panel.ex, oy = panel.y - panel.ey;
  for (let y = 0; y < panel.h; y++) out.set(vis.subarray(y * panel.w, (y + 1) * panel.w), (oy + y) * panel.ew + ox);
  return out;
}

// Reporte des pixels d'une case dans une autre de taille différente : 'same' garde l'échelle (coin haut gauche), 'fit' ajuste.
function transferPixels(data, sw, sh, dw, dh, mode) {
  const out = new Uint8Array(dw * dh);
  if (mode === 'fit') {
    const k = Math.min(dw / sw, dh / sh), ox = (dw - sw * k) / 2, oy = (dh - sh * k) / 2;
    for (let y = 0; y < dh; y++) {
      const sy = Math.floor((y - oy) / k); if (sy < 0 || sy >= sh) continue;
      for (let x = 0; x < dw; x++) { const sx = Math.floor((x - ox) / k); if (sx >= 0 && sx < sw) out[y * dw + x] = data[sy * sw + sx]; }
    }
  } else {
    const w = Math.min(sw, dw);
    for (let y = 0; y < Math.min(sh, dh); y++) out.set(data.subarray(y * sw, y * sw + w), y * dw);
  }
  return out;
}

// Remplace les calques de la case cible par une copie de ceux de la source. Sur la page affichée, c'est annulable.
export async function copyPanelTo(src, pageIdx, panelId, mode = 'same') {
  const project = ed.project, pg = project.pages[pageIdx], samePage = pageIdx === ed.pageIdx;
  if (!samePage) await loadPage(project, pg);
  const dst = pg.panels.find(p => p.id === panelId);
  if (!dst || dst === src) return false;
  const clone = l => {
    const nl = newLayer(l.name, dst.ew, dst.eh, { kind: l.kind, color: l.color });
    Object.assign(nl, { visible: l.visible, opacity: l.opacity, locked: l.locked });
    if (l.data) nl.data = placeVisible(transferPixels(visibleData(l, src), src.w, src.h, dst.w, dst.h, mode), dst);
    nl.dirty = true;
    return nl;
  };
  const before = { layers: dst.layers, active: dst.active, mask: dst.mask };
  const layers = src.layers.map(clone), mask = src.mask && src.mask.data ? clone(src.mask) : null;
  const after = { layers, mask, active: layers[Math.max(0, src.layers.findIndex(l => l.id === src.active))].id };
  const set = st => {
    Object.assign(dst, st); for (const l of [...dst.layers, dst.mask]) if (l) l.dirty = true;
    if (samePage) { invalidate(dst); notify('layers'); }
    markChanged();
  };
  set(after);
  if (samePage) ed.undo.pushAction('Copier le contenu de la case', () => set(before), () => set(after));
  else { await saveNow(); unloadPage(pg); }
  return true;
}

// ───────────────────────── Fusionner, supprimer, cadre d'une case ─────────────────────────

// Cases voisines qu'on peut absorber : adjacentes, et le rectangle qui les réunit ne recouvre aucune autre case.
export function mergeCandidates(a) {
  const ps = page().panels, gap = mmToPx(ed.project.gutter, ed.project.dpi), tol = Math.max(4, gap * 0.6), out = [];
  const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  for (const b of ps) {
    if (b === a) continue;
    let dir = null;
    if (Math.abs(a.x + a.w + gap - b.x) <= tol && overlap(a.y, a.y + a.h, b.y, b.y + b.h)) dir = 'right';
    else if (Math.abs(b.x + b.w + gap - a.x) <= tol && overlap(a.y, a.y + a.h, b.y, b.y + b.h)) dir = 'left';
    else if (Math.abs(a.y + a.h + gap - b.y) <= tol && overlap(a.x, a.x + a.w, b.x, b.x + b.w)) dir = 'down';
    else if (Math.abs(b.y + b.h + gap - a.y) <= tol && overlap(a.x, a.x + a.w, b.x, b.x + b.w)) dir = 'up';
    if (!dir) continue;
    const u = union(a, b);
    const blocked = ps.some(c => c !== a && c !== b && overlap(u.x, u.x + u.w, c.x, c.x + c.w) && overlap(u.y, u.y + u.h, c.y, c.y + c.h));
    if (!blocked) out.push({ id: b.id, dir, index: ps.indexOf(b) });
  }
  return out;
}

// La case `aId` absorbe `bId` : elle occupe tout l'espace réuni et reprend le dessin de l'autre (calques de même nom fusionnés).
export function mergePanels(aId, bId) {
  const pg = page(), a = pg.panels.find(p => p.id === aId), b = pg.panels.find(p => p.id === bId);
  if (!a || !b) return false;
  const before = pg.panels.slice();
  const na = reshape(a, union(a, b), { x: b.ex, y: b.ey, w: b.ew, h: b.eh });
  // les calques de `a` sont copiés : l'état d'avant reste intact pour l'annulation
  const cloneL = l => (l ? { ...l, data: l.data ? l.data.slice() : null, dirty: true } : l);
  na.layers = na.layers.map(cloneL); na.mask = cloneL(na.mask);
  const ox = b.ex - na.ex, oy = b.ey - na.ey;
  const paste = (from, to) => {
    if (!from.data) return;
    const dst = ensureData(to);
    for (let j = 0; j < from.h; j++) for (let i = 0; i < from.w; i++) { const v = from.data[j * from.w + i]; if (v) dst[(j + oy) * to.w + i + ox] = v; }
  };
  for (const bl of b.layers) {
    let target = na.layers.find(l => l.name === bl.name && l.draft === bl.draft);
    if (!target) { target = newLayer(bl.name, na.ew, na.eh, { draft: bl.draft }); target.visible = bl.visible; na.layers.push(target); }
    paste(bl, target);
  }
  if (b.mask && b.mask.data) { if (!na.mask) { na.mask = newLayer('Masque', na.ew, na.eh); } paste(b.mask, na.mask); na.mask.dirty = true; }
  na.note = { plan: a.note.plan || b.note.plan, description: [a.note.description, b.note.description].filter(Boolean).join(' / ') };
  const after = before.filter(p => p !== b).map(p => (p === a ? na : p));
  swapPanels(pg, after);
  ed.panelId = na.id; notify('panel');
  ed.undo.pushAction('Fusionner les cases', () => swapPanels(pg, before), () => { swapPanels(pg, after); ed.panelId = na.id; });
  return true;
}

export function deletePanel() {
  const pg = page(), p = panel();
  if (pg.panels.length < 2) return false;
  const before = pg.panels.slice(), after = before.filter(x => x !== p);
  swapPanels(pg, after); notify('panel');
  ed.undo.pushAction('Supprimer la case', () => swapPanels(pg, before), () => swapPanels(pg, after));
  return true;
}

// Trait du cadre en millimètres, pour la case active ou pour toutes celles de la page.
export function setPanelStroke(mm, all = false) {
  for (const p of all ? page().panels : [panel()]) p.stroke = mm;
  requestRender(); markChanged();
}

// Après le chargement d'une police, les bulles à taille automatique sont remesurées.
export function refitAutoBubbles() {
  let any = false;
  for (const b of page().bubbles) if (b.auto) { autoSize(measureCtx(), b, ed.project.dpi); any = true; }
  if (any) { requestRender(); markChanged(); }
}

// ───────────────────────── Calques ─────────────────────────

export function selectPanel(id) { if (ed.panelId !== id) { ed.panelId = id; notify('panel'); requestRender(); } }

export function selectLayer(id) {
  const p = panel(), l = p.layers.find(x => x.id === id);
  p.active = id;
  if (l && l.kind === 'ink') p._ink = id; else if (l && l.kind === 'tram') p._tram = id;
  markChanged(); notify('layers');
}

// Un nouveau brouillon prend la première couleur pas encore utilisée dans la case.
function nextDraftColor(p) {
  const used = new Set(p.layers.filter(l => l.draft).map(l => l.color));
  return Object.keys(DRAFT_COLORS).find(c => !used.has(c)) || 'blue';
}

export function addLayer(kind = 'ink') {
  if (kind === true) kind = 'draft';
  const p = panel(), color = kind === 'draft' ? nextDraftColor(p) : undefined;
  const base = { draft: 'Brouillon', tram: 'Trames', ink: 'Encrage' }[kind], n = p.layers.filter(x => x.kind === kind).length;
  const l = newLayer(n ? `${base} ${n + 1}` : base, p.ew, p.eh, { kind, color });
  const at = p.layers.findIndex(x => x.id === p.active) + 1, prevActive = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Nouveau calque', unapply, apply);
}

// ── Calque visé par un outil : l'encrage va dans un calque d'encre (ou de brouillon si c'est l'actif), les trames dans un calque de trame ──
const roleOk = (l, role) => (role === 'tram' ? l.kind === 'tram' : l.kind === 'ink' || l.kind === 'draft');
export function peekTarget(p, role) {
  const act = activeLayer(p);
  if (roleOk(act, role)) return act;
  const last = p.layers.find(l => l.id === (role === 'tram' ? p._tram : p._ink) && roleOk(l, role));
  if (last) return last;
  return [...p.layers].reverse().find(l => l.kind === (role === 'tram' ? 'tram' : 'ink')) || null;
}
export function targetLayer(p, role) {
  const found = peekTarget(p, role);
  if (found) { if (found.kind !== 'draft') p[role === 'tram' ? '_tram' : '_ink'] = found.id; return found; }
  // aucun calque de cette sorte dans la case : on en crée un (annulable), sous l'encrage pour les trames
  const kind = role === 'tram' ? 'tram' : 'ink', l = newLayer(kind === 'tram' ? 'Trames' : 'Encrage', p.ew, p.eh, { kind });
  const inkAt = p.layers.findIndex(x => x.kind === 'ink'), at = kind === 'tram' && inkAt >= 0 ? inkAt : p.layers.length, prev = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prev; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Nouveau calque', unapply, apply);
  return l;
}

export function duplicateLayer() {
  const p = panel(), src = activeLayer(p);
  const l = newLayer(src.name + ' (copie)', src.w, src.h, { kind: src.kind, color: src.color });
  Object.assign(l, { visible: src.visible, opacity: src.opacity, locked: false });
  if (src.data) l.data = src.data.slice();
  l.dirty = true;
  const at = p.layers.indexOf(src) + 1, prevActive = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Dupliquer le calque', unapply, apply);
}

// Réglage d'un calque (opacité, couleur, verrou, type) : enregistré avec le projet, hors historique de pixels.
export function setLayerProp(id, key, value) {
  const p = panel(), l = p.layers.find(x => x.id === id);
  if (!l) return;
  l[key] = value;
  if (key === 'kind') { l.draft = value === 'draft'; if (l.draft && !l.color) l.color = nextDraftColor(p); }
  invalidate(p); notify('layers'); markChanged();
}

export function setSolo(id) { ed.solo = ed.solo === id ? null : id; invalidatePage(); notify('layers'); }

// Nouveau calque déjà rempli (image tramée importée).
export function addImageLayer(name, data) {
  const p = panel(), l = newLayer(name, p.ew, p.eh, { kind: 'tram' });
  l.data = placeVisible(data, p); l.dirty = true;   // `data` est de la taille du cadre visible
  const at = p.layers.findIndex(x => x.id === p.active) + 1, prevActive = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Image tramée', unapply, apply);
}

export function deleteLayer() {
  const p = panel();
  if (p.layers.length < 2) return false;
  const l = activeLayer(p), at = p.layers.indexOf(l), prevActive = p.active;
  const apply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = p.layers[Math.min(at, p.layers.length - 1)].id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(at, 0, l); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Supprimer le calque', unapply, apply);
  return true;
}

export function moveLayer(dir) {
  const p = panel(), l = activeLayer(p), i = p.layers.indexOf(l), j = i + dir;
  if (j < 0 || j >= p.layers.length) return;
  const swap = (a, b) => { [p.layers[a], p.layers[b]] = [p.layers[b], p.layers[a]]; invalidate(p); notify('layers'); markChanged(); };
  swap(i, j); ed.undo.pushAction('Ordre des calques', () => swap(j, i), () => swap(i, j));
}

export function toggleLayer(id, prop) {
  const l = panel().layers.find(x => x.id === id);
  if (!l) return;
  l[prop] = !l[prop]; invalidate(panel()); notify('layers'); markChanged();
  // `visible` et `draft` ne passent pas par l'historique de pixels : ils sont dans la description du projet
}

export function renameLayer(id, name) {
  const l = panel().layers.find(x => x.id === id);
  if (l && name.trim()) { l.name = name.trim(); notify('layers'); markChanged(); }
}

// Vide le calque actif (annulable). Renvoie 'locked' / 'empty' si rien n'a été fait.
export function clearLayer() {
  const l = activeLayer();
  if (l.locked) return 'locked';
  if (!l.data || !l.data.some(v => v)) return 'empty';
  ed.undo.begin('Vider le calque');
  ed.undo.touch(l, 0, 0, l.w, l.h);
  ensureData(l).fill(0);
  ed.undo.commit();
  invalidate(panel()); markChanged();
  return 'ok';
}

export function mergeDown() {
  const p = panel(), l = activeLayer(p), i = p.layers.indexOf(l);
  if (i < 1) return false;
  const below = p.layers[i - 1];
  ed.undo.begin('Fusionner vers le bas');
  ed.undo.touch(below, 0, 0, below.w, below.h);
  const src = l.data, dst = ensureData(below);
  if (src) for (let k = 0; k < src.length; k++) if (src[k]) dst[k] = src[k];
  ed.undo.commit();
  const apply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = below.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(i, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  // la fusion des pixels est déjà dans l'historique ; le retrait du calque est une seconde étape
  apply(); ed.undo.pushAction('Retirer le calque fusionné', unapply, apply);
  return true;
}

export function ensureMask() {
  const p = panel();
  if (!p.mask) { p.mask = newLayer('Masque', p.ew, p.eh); p.mask.data = new Uint8Array(p.ew * p.eh); }
  return p.mask;
}

export function clearMask() {
  const p = panel();
  if (!p.mask || !p.mask.data) return;
  ed.undo.begin('Vider le masque'); ed.undo.touch(p.mask, 0, 0, p.mask.w, p.mask.h);
  p.mask.data.fill(0); ed.undo.commit(); invalidate(p); markChanged();
}

export function invertMask() {
  const p = panel(), m = ensureMask();
  ed.undo.begin('Inverser le masque'); ed.undo.touch(m, 0, 0, m.w, m.h);
  for (let i = 0; i < m.data.length; i++) m.data[i] = m.data[i] ? 0 : 1;
  ed.undo.commit(); invalidate(p); markChanged();
}

// ───────────────────────── Case ─────────────────────────

export function setNote(field, value) {
  panel().note[field] = value; requestRender(); markChanged();
}

// ───────────────────────── Bulles ─────────────────────────

const clone = o => JSON.parse(JSON.stringify(o));

export function addBubbleObj(b) {
  const pg = page();
  const apply = () => { pg.bubbles.push(b); ed.bubbleId = b.id; notify('bubbles'); requestRender(); markChanged(); };
  const unapply = () => { pg.bubbles.splice(pg.bubbles.indexOf(b), 1); ed.bubbleId = null; notify('bubbles'); requestRender(); markChanged(); };
  apply(); ed.undo.pushAction('Nouvelle bulle', unapply, apply);
  return b;
}

export function addBubble(kind, at) {
  const p = panel();
  const b = newBubble(kind, 0, 0), c = at || { x: p.x + p.w / 2, y: p.y + p.h / 3 };
  Object.assign(b, ed.bubbleDefaults[kind] || {});   // le dernier style réglé pour ce type de bulle
  b.x = Math.round(c.x - b.w / 2); b.y = Math.round(c.y - b.h / 2);
  if (b.tail) b.tail = { x: Math.round(b.x + b.w * 0.35), y: Math.round(b.y + b.h + 160) };
  return addBubbleObj(b);
}

// Bulle dessinée à la main : le tracé fermé devient le contour, le texte se centre dedans.
export function addFreeBubble(points) {
  const spacing = Math.max(8, ed.project.dpi / 25);
  const path = [points[0]];
  for (const q of points) { const l = path[path.length - 1]; if (Math.hypot(q.x - l.x, q.y - l.y) >= spacing) path.push({ x: Math.round(q.x), y: Math.round(q.y) }); }
  if (path.length < 4) return null;
  const r = pathBounds(path);
  const b = newBubble('parole', r.x, r.y);
  Object.assign(b, { shape: 'libre', path, x: r.x, y: r.y, w: Math.max(120, r.w), h: Math.max(90, r.h), auto: false, tail: null });
  return addBubbleObj(b);
}

export function deleteBubble(b = bubble()) {
  const pg = page();
  if (!b) return;
  const at = pg.bubbles.indexOf(b);
  const apply = () => { pg.bubbles.splice(pg.bubbles.indexOf(b), 1); ed.bubbleId = null; notify('bubbles'); requestRender(); markChanged(); };
  const unapply = () => { pg.bubbles.splice(at, 0, b); ed.bubbleId = b.id; notify('bubbles'); requestRender(); markChanged(); };
  apply(); ed.undo.pushAction('Supprimer la bulle', unapply, apply);
}

// Bulles dans la liste des calques : afficher / masquer et verrouiller, une par une ou toutes ensemble.
export function setBubbleProp(b, key, value) {
  b[key] = value; if (key === 'hidden' && value && ed.bubbleId === b.id) ed.bubbleId = null;
  notify('bubbles'); requestRender(); markChanged();
}
export function togglePageBubbles() { const pg = page(); pg.bubblesHidden = !pg.bubblesHidden; notify('bubbles'); requestRender(); markChanged(); }

export function selectBubble(id) { ed.bubbleId = id; notify('bubbles'); requestRender(); }

// Une modification de bulle (déplacement, texte…) devient une entrée d'historique.
export function commitBubbleEdit(b, before) {
  const after = clone(b);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const set = state => { Object.keys(b).forEach(k => delete b[k]); Object.assign(b, clone(state)); notify('bubbles'); requestRender(); markChanged(); };
  ed.undo.pushAction('Bulle', () => set(before), () => set(after));
  markChanged();
}

export function refitBubble(b) {
  if (b.auto) { autoSize(measureCtx(), b, ed.project.dpi); }
  requestRender();
}

export const snapshotBubble = b => clone(b);

export { pageLayers };

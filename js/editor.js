// État de l'éditeur et actions sur le document (pages, cases, calques, bulles), toutes annulables.
import {
  newLayer, newPage, newBubble, pageLayers, ensureData, mmToPx, uid, layoutById, layoutRects, pageSize, newPanel,
} from './model.js';
import { UndoStack } from './raster.js';
import { saveProject, loadPage, unloadPage, setThumb } from './store.js';
import { pageThumb } from './export.js';
import { syncSoon } from './sync.js';
import { autoSize, pathBounds } from './bubbles.js';
import { invalidate, invalidateLayer, dropCaches, requestRender } from './view.js';

export const ed = {
  project: null, pageIdx: 0, panelId: null, bubbleId: null,
  tool: 'pencil', size: 6, ink: 1,
  tramaId: 'plein', tramaScale: 2, tramaOpaque: false,
  shapeKind: 'rect', shapeFilled: false,
  maskMode: 'off', maskErase: false, bubbleDraw: false,
  fingerDraws: false, pressure: true, showNotes: true,
  undo: new UndoStack(),
};

const subs = new Set();
export const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
export const notify = what => subs.forEach(fn => fn(what));

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
    np.note = { ...p.note };
    np.layers = p.layers.map(l => {
      const nl = newLayer(l.name, l.w, l.h, { draft: l.draft });
      nl.visible = l.visible;
      if (l.data) { nl.data = l.data.slice(); nl.dirty = true; }
      return nl;
    });
    const ai = p.layers.findIndex(l => l.id === p.active);
    np.active = np.layers[Math.max(0, ai)].id;
    if (p.mask && p.mask.data) { np.mask = newLayer('Masque', p.w, p.h); np.mask.data = p.mask.data.slice(); np.mask.dirty = true; }
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

// Change la disposition des cases de la page : les calques existants sont rognés ou prolongés dans leur case.
export function relayoutPage(layoutId) {
  const project = ed.project, pg = page();
  const { w, h } = pageSize(project);
  const layout = layoutById(layoutId, pg.panels.length);
  const rects = layoutRects(layout, w, h, mmToPx(project.margin, project.dpi), mmToPx(project.gutter, project.dpi));
  const before = pg.panels.slice();
  const after = rects.map((r, i) => {
    const old = before[i];
    if (!old) return newPanel(r);
    return resizedPanel(old, r);
  });
  const apply = list => {
    pg.panels = list; ed.panelId = list[0].id;
    for (const l of pageLayers(pg)) l.dirty = true;   // les dimensions ont changé : tout est à réécrire
    dropCaches(pg); invalidatePage(); notify('page'); markChanged();
  };
  apply(after);
  ed.undo.pushAction('Disposition', () => apply(before), () => apply(after));
}

function resizedPanel(old, r) {
  const np = { ...old, x: r.x, y: r.y, w: r.w, h: r.h, note: old.note };
  const move = l => {
    if (!l) return l;
    const nl = { ...l, w: r.w, h: r.h, data: null, dirty: true };
    if (l.data) {
      nl.data = new Uint8Array(r.w * r.h);
      for (let y = 0; y < Math.min(l.h, r.h); y++) nl.data.set(l.data.subarray(y * l.w, y * l.w + Math.min(l.w, r.w)), y * r.w);
    }
    return nl;
  };
  np.layers = old.layers.map(move); np.mask = move(old.mask);
  np.active = np.layers[Math.max(0, old.layers.findIndex(l => l.id === old.active))].id;
  return np;
}

// ───────────────────────── Calques ─────────────────────────

export function selectPanel(id) { if (ed.panelId !== id) { ed.panelId = id; notify('panel'); requestRender(); } }

export function selectLayer(id) { panel().active = id; markChanged(); notify('layers'); }

export function addLayer(draft = false) {
  const p = panel(), l = newLayer(draft ? 'Brouillon' : 'Calque ' + (p.layers.length + 1), p.w, p.h, { draft });
  const at = p.layers.findIndex(x => x.id === p.active) + 1, prevActive = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Nouveau calque', unapply, apply);
}

// Nouveau calque déjà rempli (image tramée importée).
export function addImageLayer(name, data) {
  const p = panel(), l = newLayer(name, p.w, p.h);
  l.data = data; l.dirty = true;
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

export function clearLayer() {
  const l = activeLayer();
  if (!l.data) return;
  ed.undo.begin('Vider le calque');
  ed.undo.touch(l, 0, 0, l.w, l.h);
  ensureData(l).fill(0);
  ed.undo.commit();
  invalidate(panel()); markChanged();
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
  if (!p.mask) { p.mask = newLayer('Masque', p.w, p.h); p.mask.data = new Uint8Array(p.w * p.h); }
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

export function deleteBubble() {
  const pg = page(), b = bubble();
  if (!b) return;
  const at = pg.bubbles.indexOf(b);
  const apply = () => { pg.bubbles.splice(pg.bubbles.indexOf(b), 1); ed.bubbleId = null; notify('bubbles'); requestRender(); markChanged(); };
  const unapply = () => { pg.bubbles.splice(at, 0, b); ed.bubbleId = b.id; notify('bubbles'); requestRender(); markChanged(); };
  apply(); ed.undo.pushAction('Supprimer la bulle', unapply, apply);
}

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

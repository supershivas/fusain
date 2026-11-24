// État de l'éditeur et actions sur le document (pages, cases, calques, bulles), toutes annulables.
import {
  BLEED_MM, newLayer, newPage, newBubble, pageLayers, ensureData, bppOf, mmToPx, uid, layoutById, layoutRects, pageSize, newPanel, DRAFT_COLORS,
} from './model.js';
import { UndoStack, BUILTIN_BRUSHES, BRUSH_DEFAULTS, brushSpec } from './raster.js';
import { saveProject, loadPage, unloadPage, setThumb } from './store.js';
import { pageThumb } from './export.js';
import { loadFont } from './fonts.js';
import { syncSoon } from './sync.js';
import { autoSize, pathBounds, props as bubbleProps, BUBBLE_TEMPLATES, bubblePanelOf, wrapForWidth } from './bubbles.js';
import { invalidate, invalidateLayer, dropCaches, requestRender } from './view.js';

export const ed = {
  project: null, pageIdx: 0, panelId: null, bubbleId: null, focus: false,
  tool: 'pencil', size: 6, sizeMm: 0.5, alpha: 1, slotId: null, ink: 1, color: '#000000', color2: '#FFFFFF', recentColors: [], picking: false, brushId: 'stylo', brushParams: null, customBrushes: [], brushSizes: {}, tramaPresets: [], toolSettings: {}, bubbleDefaults: {}, ditherOpts: {}, solo: null,
  tramaId: 'plein', tramaScale: 2, tramaOpaque: false,
  shapeKind: 'rect', shapeFilled: false, fillGap: 100, symmetry: 'off',
  maskMode: 'off', maskErase: false, bubbleDraw: false,
  sel: null, selFloat: null, selMode: 'auto', selOp: 'new', selMove: false, selScope: 'all', selCopy: false,   // outil Sélection (selection.js)
  addRatio: 50, addPreview: null, bubbleTemplate: 'parole', bubbleTemplates: [],
  fingerDraws: false, palm: 'strong', pressure: true, pressureGamma: 1, showNotes: true,
  undo: new UndoStack(),
};

const subs = new Set();
export const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
export const notify = what => subs.forEach(fn => fn(what));

// Chaque outil garde ses propres réglages (taille, encre, trame, forme…) : on les range en quittant l'outil et on les reprend en y revenant.
export const TOOL_DEFAULTS = {
  pencil: { sizeMm: 0.5, alpha: 1, ticks: null, slotId: null, brushId: 'stylo', brushParams: null, tramaId: 'plein', tramaScale: 2, tramaOpaque: false },
  eraser: { sizeMm: 3, alpha: 1, ticks: null, slotId: null, brushId: 'stylo', brushParams: null },
  fill: { fillGap: 100, tramaId: 'plein', tramaScale: 2, tramaOpaque: false },
  shape: { sizeMm: 0.5, ticks: null, shapeKind: 'rect', shapeFilled: false, tramaId: 'plein', tramaScale: 2, tramaOpaque: false },
  mask: { sizeMm: 6, ticks: null, maskErase: false },
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
  syncSlot();
  ed.ink = inkOf(ed.color);   // la couleur est commune à tous les outils
}

// ── Pinceaux : livrés ou enregistrés par l'utilisateur ──
export const allBrushes = () => BUILTIN_BRUSHES.concat(ed.customBrushes);
export const currentBrush = () => allBrushes().find(b => b.id === ed.brushId) || BUILTIN_BRUSHES[0];

// Choisir un pinceau reprend la dernière taille réglée pour lui.
export function selectBrush(id) {
  const key = i => i;
  ed.brushSizes[key(ed.brushId)] = ed.sizeMm;
  ed.brushId = id; ed.brushParams = brushSpec(id, ed.customBrushes);
  setSizeMm(ed.brushSizes[key(id)] ?? ed.brushParams.sizeMm);
}
export function resetBrush() { ed.brushParams = brushSpec(ed.brushId, ed.customBrushes); }
export function saveBrushAs(name, group = 'Mes pinceaux') {
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  ed.customBrushes.push({ ...ed.brushParams, id, name, group, custom: true, sizeMm: ed.sizeMm });
  ed.brushSizes[id] = ed.sizeMm; ed.brushId = id; ed.brushParams = brushSpec(id, ed.customBrushes);
}
export function updateBrush() {
  const i = ed.customBrushes.findIndex(b => b.id === ed.brushId);
  if (i >= 0) { const c = ed.customBrushes[i]; ed.customBrushes[i] = { ...ed.brushParams, id: c.id, name: c.name, group: c.group || 'Mes pinceaux', custom: true, sizeMm: ed.sizeMm }; }
}
export function restoreBrush(b, index) {
  if (ed.customBrushes.some(x => x.id === b.id)) return;
  ed.customBrushes.splice(Math.min(index, ed.customBrushes.length), 0, b);
}
export function deleteBrush(id) {
  ed.customBrushes = ed.customBrushes.filter(b => b.id !== id);
  if (ed.brushId === id) selectBrush('stylo');
}
// ── Palette du projet : 4 à 8 pinceaux par outil (crayon, pinceau trame, gomme), synchronisés avec le projet ──
// Un emplacement garde le pinceau entier (réglages, taille, opacité, et la trame pour le pinceau trame).
// Tant qu'un emplacement est actif, ce qu'on règle (taille, opacité, réglages) y est enregistré.
export const BRUSH_TOOLS = ['pencil', 'eraser'];
// Pression des pinceaux livrés avant la v1.44 (press, pressMin), pour mettre à jour les palettes restées telles quelles.
const PRESS_V1 = { stylo: [0.6, 0.3], technique: [0, 0.25], plume: [0.6, 0.35], plumeg: [0.9, 0.1], brushpen: [1, 0.08], hb: [0.4, 0.5], '6b': [0.5, 0.4], mine: [0, 0.25], rond: [1, 0.1], plat: [0, 0.25], sec: [0.5, 0.5], feutre: [0.3, 0.6], plate: [0.4, 0.5], plate2: [0, 0.25], fusain: [0.6, 0.4], craie: [0.5, 0.5], spray: [0.7, 0.3], point: [0, 0.25] };
// Repères des curseurs latéraux (valeurs en mm et en opacité 0–1) : le curseur s'y aimante.
export const copyTicks = t => ({ size: [...((t && t.size) || [])], alpha: [...((t && t.alpha) || [])] });
export const ticksOf = () => (ed.ticks || (ed.ticks = copyTicks(null)));
export const SLOT_MAX = 10;
const SLOT_DEFAULTS = {
  pencil: [['hb'], ['plumeg'], ['couleur']],   // trois pinceaux pour commencer ; « + » ouvre la bibliothèque
  eraser: [['stylo', { name: 'Gomme fine', sizeMm: 1 }], ['stylo', { name: 'Gomme ronde', sizeMm: 4 }], ['feutre', { name: 'Gomme carrée', sizeMm: 8 }], ['6b', { name: 'Gomme grain', sizeMm: 3 }]],
};
const slotId = () => 's' + Math.random().toString(36).slice(2, 8);
function makeSlot(tool, base, spec, o = {}) {
  const s = { id: slotId(), name: o.name || spec.name || 'Pinceau', base, spec: { ...spec }, sizeMm: o.sizeMm ?? spec.sizeMm, alpha: o.alpha ?? 1 };
  if (tool === 'pencil') Object.assign(s, { tramaId: o.tramaId || 'plein', tramaScale: o.tramaScale ?? 2, tramaOpaque: !!o.tramaOpaque });
  for (const k of ['id', 'name', 'group', 'custom']) delete s.spec[k];
  return s;
}
// Palette de l'outil, créée à la première ouverture (pinceaux livrés, plus ceux déjà enregistrés sur cet appareil).
export function brushSlots(tool = ed.tool) {
  if (!ed.project || !BRUSH_TOOLS.includes(tool)) return [];
  const set = ed.project.brushSet || (ed.project.brushSet = {});
  if (!Array.isArray(set[tool])) {
    set[tool] = SLOT_DEFAULTS[tool].map(([id, o]) => makeSlot(tool, id, brushSpec(id), o));
    const mine = ed.customBrushes.filter(b => (b.group === 'Mes gommes') === (tool === 'eraser'));
    for (const b of mine) if (set[tool].length < SLOT_MAX) set[tool].push(makeSlot(tool, b.id, brushSpec(b.id, ed.customBrushes)));
  }
  // v1.44 : pression par défaut à 100 % (pression nulle : 10 %). Un pinceau de palette resté aux anciennes valeurs livrées
  // prend les nouvelles ; un pinceau réglé par l'auteur garde les siennes.
  if ((set.pressV || 1) < 2) {
    for (const list of [set.pencil, set.eraser, set.texture]) for (const sl of list || []) {
      const old = PRESS_V1[sl.base], sp = sl.spec || {};
      if (old && (sp.press ?? 0) === old[0] && (sp.pressMin ?? 0.25) === old[1]) { const nb = brushSpec(sl.base); sp.press = nb.press; sp.pressMin = nb.pressMin; sl.spec = sp; }
    }
    set.pressV = 2;
  }
  // anciens projets : la palette du « pinceau trame » rejoint celle du pinceau (ses pinceaux gardent leur trame)
  if (tool === 'pencil' && Array.isArray(set.texture)) {
    for (const s of set.texture) if (set.pencil.length < SLOT_MAX && !set.pencil.some(x => x.id === s.id)) set.pencil.push({ ...s, tramaId: s.tramaId || 'g25' });
    delete set.texture;
  }
  return set[tool];
}
export const activeSlot = () => brushSlots().find(s => s.id === ed.slotId) || null;
export function applySlot(id) {
  const s = brushSlots().find(x => x.id === id);
  if (!s) return;
  ed.slotId = s.id; ed.brushId = s.base; ed.brushParams = { ...BRUSH_DEFAULTS, ...s.spec };
  ed.alpha = s.alpha ?? 1;
  ed.ticks = copyTicks(s.ticks);
  if (ed.tool === 'pencil') Object.assign(ed, { tramaId: s.tramaId || 'plein', tramaScale: s.tramaScale ?? 2, tramaOpaque: !!s.tramaOpaque });
  setSizeMm(s.sizeMm);
}
// Range l'état courant dans l'emplacement actif (appelé après chaque réglage).
export function storeSlot() {
  const s = activeSlot();
  if (!s) return;
  s.spec = { ...ed.brushParams }; for (const k of ['id', 'name', 'group', 'custom']) delete s.spec[k];
  s.sizeMm = ed.sizeMm; s.alpha = ed.alpha; s.ticks = copyTicks(ed.ticks);
  if (ed.tool === 'pencil') Object.assign(s, { tramaId: ed.tramaId, tramaScale: ed.tramaScale, tramaOpaque: ed.tramaOpaque });
  markChanged();
}
// Un pinceau pris dans la bibliothèque entre dans la palette (s'il n'y est pas) ; palette pleine : il remplace l'emplacement actif.
export function brushToPalette(id) {
  const list = brushSlots(), found = list.find(s => s.base === id && s.name === (allBrushes().find(b => b.id === id) || {}).name);
  if (found) { applySlot(found.id); return 'found'; }
  selectBrush(id);
  const slot = makeSlot(ed.tool, id, ed.brushParams, { name: currentBrush().name, sizeMm: ed.sizeMm, alpha: 1, tramaId: ed.tramaId, tramaScale: ed.tramaScale, tramaOpaque: ed.tramaOpaque });
  let how = 'added';
  if (list.length < SLOT_MAX) list.push(slot);
  else { const i = Math.max(0, list.findIndex(s => s.id === ed.slotId)); list[i] = slot; how = 'replaced'; }
  applySlot(slot.id); markChanged();
  return how;
}
export function removeSlot(id) {
  const list = brushSlots(), i = list.findIndex(s => s.id === id);
  if (i < 0 || list.length <= 1) return false;
  list.splice(i, 1);
  if (ed.slotId === id) applySlot(list[Math.min(i, list.length - 1)].id);
  markChanged();
  return true;
}
export function restoreSlot(slot, index) {
  const list = brushSlots();
  if (list.some(s => s.id === slot.id)) return;
  list.splice(Math.min(index, list.length), 0, slot); markChanged();
}
export function renameSlot(id, name) { const s = brushSlots().find(x => x.id === id); if (s && name) { s.name = name; markChanged(); } }
export function moveSlot(id, dir) {
  const list = brushSlots(), i = list.findIndex(s => s.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]]; markChanged();
}
// Glisser-déposer dans la palette : place l'emplacement à l'index donné.
export function moveSlotTo(id, index) {
  const list = brushSlots(), i = list.findIndex(s => s.id === id);
  if (i < 0) return false;
  const j = Math.max(0, Math.min(list.length - 1, index));
  if (i === j) return false;
  const [s] = list.splice(i, 1); list.splice(j, 0, s); markChanged();
  return true;
}
// Rétablir : l'emplacement reprend les réglages d'origine de son pinceau (taille comprise, opacité 100 %, encre pleine).
// Renvoie l'état d'avant pour « Annuler ».
export function resetSlot(id) {
  const s = brushSlots().find(x => x.id === id);
  if (!s) return null;
  const before = JSON.parse(JSON.stringify(s)), fresh = makeSlot(ed.tool, s.base, brushSpec(s.base, ed.customBrushes));
  Object.assign(s, { spec: fresh.spec, sizeMm: fresh.sizeMm, alpha: 1, ticks: undefined });
  if (ed.tool === 'pencil') Object.assign(s, { tramaId: 'plein', tramaScale: 2, tramaOpaque: false });
  if (ed.slotId === id) applySlot(id);
  markChanged();
  return before;
}
export function restoreSlotState(state) {
  const s = brushSlots().find(x => x.id === state.id);
  if (!s) return;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, state);
  if (ed.slotId === s.id) applySlot(s.id);
  markChanged();
}
// Garde la palette et l'outil d'accord : à l'ouverture d'un projet ou d'un outil, l'emplacement actif est repris (ou le premier).
export function syncSlot() {
  if (!BRUSH_TOOLS.includes(ed.tool) || !ed.project) return;
  const list = brushSlots();
  if (list.some(s => s.id === ed.slotId)) applySlot(ed.slotId); else if (list[0]) applySlot(list[0].id);
}
// ── Couleurs du projet : une palette partagée par toutes ses pages (créée à la première ouverture) ──
export const DEFAULT_COLORS = ['#000000', '#FFFFFF', '#F2D3B3', '#D9A57A', '#8D5524', '#C0392B', '#E67E22', '#F4D03F', '#27AE60', '#1ABC9C', '#2E86DE', '#1F3A93', '#8E44AD', '#E84393', '#7F8C8D', '#2C3E50'];
// Un projet a plusieurs palettes nommées (peaux, décors, nuit…) ; `paletteId` est celle qui est ouverte.
// Ancien format : une seule liste `colors`, reprise comme première palette.
export function projectPalettes() {
  const pr = ed.project;
  if (!pr) return [{ id: 'p0', name: 'Projet', colors: DEFAULT_COLORS.slice() }];
  if (!Array.isArray(pr.palettes) || !pr.palettes.length) {
    pr.palettes = [{ id: 'p' + Math.random().toString(36).slice(2, 8), name: 'Projet', colors: (pr.colors || DEFAULT_COLORS).slice() }];
    delete pr.colors;
  }
  if (!pr.palettes.some(p => p.id === pr.paletteId)) pr.paletteId = pr.palettes[0].id;
  return pr.palettes;
}
export const currentPalette = () => { const list = projectPalettes(); return list.find(p => p.id === (ed.project && ed.project.paletteId)) || list[0]; };
export const projectColors = () => currentPalette().colors;
export function selectPalette(id) { if (ed.project && projectPalettes().some(p => p.id === id)) { ed.project.paletteId = id; markChanged(); } }
export function addPalette(name) {
  const p = { id: 'p' + Math.random().toString(36).slice(2, 8), name, colors: [] };
  projectPalettes().push(p); ed.project.paletteId = p.id; markChanged(); return p;
}
export function renamePalette(id, name) { const p = projectPalettes().find(x => x.id === id); if (p && name) { p.name = name; markChanged(); } }
export function removePalette(id) {
  const list = projectPalettes(), i = list.findIndex(p => p.id === id);
  if (i < 0 || list.length < 2) return null;
  const [p] = list.splice(i, 1); ed.project.paletteId = list[Math.max(0, i - 1)].id; markChanged();
  return { p, i };
}
export function restorePalette({ p, i }) { const list = projectPalettes(); if (!list.some(x => x.id === p.id)) { list.splice(i, 0, p); ed.project.paletteId = p.id; markChanged(); } }
export function addProjectColor(hex) {
  const pal = currentPalette();
  if (pal.colors.includes(hex)) return false;
  pal.colors.push(hex); markChanged(); return true;
}
export function removeProjectColor(hex) {
  const pal = currentPalette(), i = pal.colors.indexOf(hex);
  if (i < 0) return false;
  pal.colors.splice(i, 1); markChanged(); return true;
}
export function restoreProjectColor(hex, index) {
  const list = currentPalette().colors;
  if (list.includes(hex)) return;
  list.splice(Math.min(index, list.length), 0, hex); markChanged();
}
// Noir pur et blanc pur restent dans les calques 1 bit (encre 1 et 2) ; toute autre couleur passe le calque en RVBA.
export const inkOf = hex => (hex === '#000000' ? 1 : hex === '#FFFFFF' ? 2 : 3);
export function setColor(hex, recent = true) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
  ed.color = hex.toUpperCase(); ed.ink = inkOf(ed.color);
  if (recent) ed.recentColors = [ed.color, ...ed.recentColors.filter(c => c !== ed.color)].slice(0, 10);
}
export function swapColors() { [ed.color, ed.color2] = [ed.color2, ed.color]; ed.ink = inkOf(ed.color); }
export function resetColors() { ed.color = '#000000'; ed.color2 = '#FFFFFF'; ed.ink = 1; }

// Passe un calque d'encre ou de trame en RVBA (1 → noir ou sa teinte, 2 → blanc), en une étape annulable.
export function toRGBA(l) {
  if (!l || bppOf(l) === 4 || l.kind === 'draft') return l;
  const old = l.data, oldColor = l.color, rgb = /^#[0-9a-f]{6}$/i.test(l.color || '') ? [1, 3, 5].map(i => parseInt(l.color.slice(i, i + 2), 16)) : [0, 0, 0];
  let next = null;
  if (old) {
    next = new Uint8Array(l.w * l.h * 4);
    for (let i = 0, j = 0; i < old.length; i++, j += 4) {
      const v = old[i]; if (!v) continue;
      const c = v === 1 ? rgb : [255, 255, 255];
      next[j] = c[0]; next[j + 1] = c[1]; next[j + 2] = c[2]; next[j + 3] = 255;
    }
  }
  const p = page().panels.find(q => q.layers.includes(l));
  const apply = () => { l.rgba = true; l.data = next; delete l.color; l.dirty = true; if (p) invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { l.rgba = false; l.data = old; if (oldColor) l.color = oldColor; l.dirty = true; if (p) invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Calque en couleur', unapply, apply).rgbaLayer = l;
  return l;
}

export function setAlpha(a) { ed.alpha = Math.max(0.05, Math.min(1, a)); }

// La taille se règle en millimètres (la même épaisseur à 150 ou 300 dpi) ; `ed.size` en est la valeur en pixels.
export function syncSize() { ed.size = Math.max(1, Math.round(ed.sizeMm / 25.4 * (ed.project ? ed.project.dpi : 300))); }
// Plus grosse taille : 50 mm pour les trames (aplats), 30 mm pour le reste.
export const maxSizeMm = () => ed.tool === 'pencil' ? 50 : 30;
export function setSizeMm(mm) { ed.sizeMm = Math.max(0.05, Math.min(maxSizeMm(), mm)); syncSize(); }

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
  ed.project = project; ed.pageIdx = Math.min(pageIdx, project.pages.length - 1); ed.focus = false;
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

// save = false : la version enregistrée vient d'être remplacée (synchronisation, autre onglet) et rien n'est en attente ici ;
// réenregistrer la copie en mémoire écraserait la version reçue.
export async function closeEditor({ save = true } = {}) {
  if (save) await saveNow(true);
  if (ed.project) { for (const p of ed.project.pages) { dropCaches(p); unloadPage(p); } }
  ed.project = null; ed.panelId = null; ed.bubbleId = null; ed.undo.clear();
}

// ───────────────────────── Pages ─────────────────────────

export async function goToPage(idx) {
  if (idx < 0 || idx >= ed.project.pages.length || idx === ed.pageIdx) return;
  await saveNow();
  const old = page();
  ed.pageIdx = idx; ed.bubbleId = null; ed.focus = false; ed.undo.clear();
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
  const src = page(), pg = { id: uid(), guide: src.guide ? JSON.parse(JSON.stringify(src.guide)) : undefined, panels: [], bubbles: JSON.parse(JSON.stringify(src.bubbles)).map(b => ({ ...b, id: uid() })) };
  linkBubbles(src);
  const ids = new Map();
  for (const p of src.panels) {
    const np = newPanel(p); ids.set(p.id, np.id);
    Object.assign(np, { ex: p.ex, ey: p.ey, ew: p.ew, eh: p.eh, stroke: p.stroke });
    np.note = { ...p.note };
    np.layers = p.layers.map(l => {
      const nl = newLayer(l.name, l.w, l.h, { kind: l.kind, color: l.color, gradient: l.gradient });
      Object.assign(nl, { visible: l.visible, opacity: l.opacity, locked: l.locked });
      if (l.data) { nl.data = l.data.slice(); nl.dirty = true; }
      return nl;
    });
    const ai = p.layers.findIndex(l => l.id === p.active);
    np.active = np.layers[Math.max(0, ai)].id;
    if (p.mask && p.mask.data) { np.mask = newLayer('Masque', p.ew, p.eh); np.mask.data = p.mask.data.slice(); np.mask.dirty = true; }
    pg.panels.push(np);
  }
  src.bubbles.forEach((b, i) => { pg.bubbles[i].panel = ids.get(b.panel); });
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

// Couverture : une page en tête, une seule case à fond perdu sans cadre, le titre du projet en texte. Jamais numérotée.
export async function addCover() {
  const project = ed.project, at = project.pages.findIndex(p => p.cover);
  if (at >= 0) { await goToPage(at); return false; }
  const { w, h } = pageSize(project), b = mmToPx(BLEED_MM, project.dpi);
  const panel = Object.assign(newPanel({ x: -b, y: -b, w: w + 2 * b, h: h + 2 * b }), { x: 0, y: 0, w, h });   // réserve sur le fond perdu dès le départ
  panel.stroke = 0;
  await loadFont('londrina');
  const title = newBubble('texte', 0, 0);
  Object.assign(title, { text: project.title, pt: 36, font: 'londrina', panel: panel.id });
  autoSize(measureCtx(), title, project.dpi);
  title.x = Math.round((w - title.w) / 2); title.y = Math.round(h * 0.12);
  project.pages.unshift({ id: uid(), cover: true, panels: [panel], bubbles: [title] });
  ed.pageIdx++;   // la page ouverte a glissé d'un cran
  markChanged();
  await goToPage(0);
  return true;
}

// Nouvel ordre des pages (chemin de fer) : `ids` dans l'ordre voulu. La page ouverte reste ouverte.
export function reorderPages(ids) {
  const pages = ed.project.pages, cur = page(), byId = new Map(pages.map(p => [p.id, p]));
  if (ids.length !== pages.length || ids.some(id => !byId.has(id))) return false;
  const before = pages.map(p => p.id).join();
  if (before === ids.join()) return false;
  pages.splice(0, pages.length, ...ids.map(id => byId.get(id)));
  ed.pageIdx = pages.indexOf(cur);
  markChanged(); notify('page');
  return true;
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
// Chaque bulle est liée à une case (`b.panel`). Les bulles d'une case retirée partent avec elle et reviennent si on annule.
const stashed = new WeakMap();
const panelOfPoint = (panels, x, y) => panels.find(q => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
export function linkBubbles(pg) {
  for (const b of pg.bubbles) {
    if (pg.panels.some(p => p.id === b.panel)) continue;
    const q = panelOfPoint(pg.panels, b.x + b.w / 2, b.y + b.h / 2) || pg.panels[0];
    if (q) b.panel = q.id;
  }
}
function swapPanels(pg, list) {
  const prev = new Set(pg.panels.flatMap(p => [...p.layers, p.mask]));
  linkBubbles(pg);
  const was = new Set(pg.panels.map(p => p.id)), now = new Set(list.map(p => p.id)), box = stashed.get(pg) || new Map();
  stashed.set(pg, box);
  for (const id of was) if (!now.has(id)) {
    const gone = pg.bubbles.filter(b => b.panel === id);
    if (gone.length) { box.set(id, gone); pg.bubbles = pg.bubbles.filter(b => b.panel !== id); }
  }
  for (const id of now) if (!was.has(id) && box.has(id)) { pg.bubbles.push(...box.get(id)); box.delete(id); }
  if (!pg.bubbles.some(b => b.id === ed.bubbleId)) ed.bubbleId = null;
  notify('bubbles');
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
      const b = bppOf(l);
      nl.data = new Uint8Array(ext.w * ext.h * b);
      for (let j = 0; j < l.h; j++) nl.data.set(l.data.subarray(j * l.w * b, (j + 1) * l.w * b), ((j + dy) * ext.w + dx) * b);
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

// Rectangles des cases touchées par une gouttière déplacée de `d` : [{ id, rect }], pour l'aperçu en direct.
export function gutterPreview(h, d) {
  const v = h.axis === 'v';
  return page().panels.flatMap(p => {
    if (h.L.includes(p.id)) return [{ id: p.id, rect: v ? { x: p.x, y: p.y, w: p.w + d, h: p.h } : { x: p.x, y: p.y, w: p.w, h: p.h + d } }];
    if (h.R.includes(p.id)) return [{ id: p.id, rect: v ? { x: p.x + d, y: p.y, w: p.w - d, h: p.h } : { x: p.x, y: p.y + d, w: p.w, h: p.h - d } }];
    return [];
  });
}

// Agrandit l'étendue des calques d'une case pour qu'elle contienne `rect` (pixels de page, jusqu'à une page hors de la page) : un dessin poussé
// hors du cadre y est gardé, caché, au lieu d'être coupé. Le cadre ne bouge pas. Annulable ; renvoie la case (nouvelle ou non).
export function growExtent(p, rect) {
  const { w, h } = pageSize(ed.project);   // borne de sûreté : une page de marge tout autour de la page
  const x0 = Math.max(-w, Math.floor(rect.x)), y0 = Math.max(-h, Math.floor(rect.y)), x1 = Math.min(2 * w, Math.ceil(rect.x + rect.w)), y1 = Math.min(2 * h, Math.ceil(rect.y + rect.h));
  if (x0 >= p.ex && y0 >= p.ey && x1 <= p.ex + p.ew && y1 <= p.ey + p.eh) return p;
  const pg = page(), before = pg.panels.slice(), np = reshape(p, { x: p.x, y: p.y, w: p.w, h: p.h }, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const after = before.map(q => (q === p ? np : q));
  swapPanels(pg, after); ed.panelId = np.id;
  ed.undo.pushAction('Agrandir la réserve de la case', () => swapPanels(pg, before), () => swapPanels(pg, after));
  return np;
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
  const b = bppOf(layer), out = new Uint8Array(panel.w * panel.h * b);
  if (!layer.data) return out;
  const ox = panel.x - panel.ex, oy = panel.y - panel.ey;
  for (let y = 0; y < panel.h; y++) out.set(layer.data.subarray(((oy + y) * layer.w + ox) * b, ((oy + y) * layer.w + ox + panel.w) * b), y * panel.w * b);
  return out;
}

// Pose des pixels de la taille du cadre visible dans un tampon de l'étendue de la case.
function placeVisible(vis, panel, b = 1) {
  const out = new Uint8Array(panel.ew * panel.eh * b), ox = panel.x - panel.ex, oy = panel.y - panel.ey;
  for (let y = 0; y < panel.h; y++) out.set(vis.subarray(y * panel.w * b, (y + 1) * panel.w * b), ((oy + y) * panel.ew + ox) * b);
  return out;
}

// Reporte des pixels d'une case dans une autre de taille différente : 'same' garde l'échelle (coin haut gauche), 'fit' ajuste.
function transferPixels(data, sw, sh, dw, dh, mode, b = 1) {
  const out = new Uint8Array(dw * dh * b);
  if (mode === 'fit') {
    const k = Math.min(dw / sw, dh / sh), ox = (dw - sw * k) / 2, oy = (dh - sh * k) / 2;
    for (let y = 0; y < dh; y++) {
      const sy = Math.floor((y - oy) / k); if (sy < 0 || sy >= sh) continue;
      for (let x = 0; x < dw; x++) {
        const sx = Math.floor((x - ox) / k); if (sx < 0 || sx >= sw) continue;
        for (let c = 0; c < b; c++) out[(y * dw + x) * b + c] = data[(sy * sw + sx) * b + c];
      }
    }
  } else {
    const w = Math.min(sw, dw);
    for (let y = 0; y < Math.min(sh, dh); y++) out.set(data.subarray(y * sw * b, (y * sw + w) * b), y * dw * b);
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
    const nl = newLayer(l.name, dst.ew, dst.eh, { kind: l.kind, color: l.color, gradient: l.gradient });
    Object.assign(nl, { visible: l.visible, opacity: l.opacity, locked: l.locked, rgba: !!l.rgba, blend: l.blend, reference: l.reference, alphaLock: l.alphaLock });
    if (l.data) nl.data = placeVisible(transferPixels(visibleData(l, src), src.w, src.h, dst.w, dst.h, mode, bppOf(l)), dst, bppOf(l));
    nl.dirty = true;
    return nl;
  };
  // les bulles de la case source sont copiées dans la case cible, à la même place relative
  const srcPg = project.pages[ed.pageIdx], sx = dst.x - src.x, sy = dst.y - src.y;
  linkBubbles(srcPg);
  const fresh = srcPg.bubbles.filter(b => b.panel === src.id).map(b => {
    const nb = JSON.parse(JSON.stringify(b));
    nb.id = uid(); nb.panel = dst.id; nb.x += sx; nb.y += sy;
    if (nb.tail) nb.tail = { x: nb.tail.x + sx, y: nb.tail.y + sy };
    if (nb.path) nb.path = nb.path.map(q => ({ x: q.x + sx, y: q.y + sy }));
    return nb;
  });
  const before = { layers: dst.layers, active: dst.active, mask: dst.mask };
  const layers = src.layers.map(clone), mask = src.mask && src.mask.data ? clone(src.mask) : null;
  const after = { layers, mask, active: layers[Math.max(0, src.layers.findIndex(l => l.id === src.active))].id };
  const set = st => {
    Object.assign(dst, st); for (const l of [...dst.layers, dst.mask]) if (l) l.dirty = true;
    if (samePage) { invalidate(dst); notify('layers'); }
    pg.bubbles = pg.bubbles.filter(b => !fresh.includes(b)); if (st === after) pg.bubbles.push(...fresh);
    if (samePage) { notify('bubbles'); requestRender(); }
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
    if (bppOf(from) === 4) {
      for (let j = 0; j < from.h; j++) for (let i = 0; i < from.w; i++) {
        const s = (j * from.w + i) * 4; if (!from.data[s + 3]) continue;
        dst.set(from.data.subarray(s, s + 4), ((j + oy) * to.w + i + ox) * 4);
      }
      return;
    }
    for (let j = 0; j < from.h; j++) for (let i = 0; i < from.w; i++) { const v = from.data[j * from.w + i]; if (v) dst[(j + oy) * to.w + i + ox] = v; }
  };
  for (const bl of b.layers) {
    let target = na.layers.find(l => l.name === bl.name && l.draft === bl.draft && bppOf(l) === bppOf(bl));
    if (!target) { target = newLayer(bl.name, na.ew, na.eh, { kind: bl.kind, color: bl.color }); target.visible = bl.visible; target.rgba = !!bl.rgba; na.layers.push(target); }
    paste(bl, target);
  }
  if (b.mask && b.mask.data) { if (!na.mask) { na.mask = newLayer('Masque', na.ew, na.eh); } paste(b.mask, na.mask); na.mask.dirty = true; }
  na.note = { plan: a.note.plan || b.note.plan, description: [a.note.description, b.note.description].filter(Boolean).join(' / ') };
  const after = before.filter(p => p !== b).map(p => (p === a ? na : p));
  linkBubbles(pg);
  const moved = pg.bubbles.filter(x => x.panel === b.id);   // les bulles de la case absorbée passent dans la case qui l'absorbe
  const relink = id => moved.forEach(x => { x.panel = id; });
  relink(na.id); swapPanels(pg, after);
  ed.panelId = na.id; notify('panel');
  ed.undo.pushAction('Fusionner les cases', () => { swapPanels(pg, before); relink(b.id); }, () => { relink(na.id); swapPanels(pg, after); ed.panelId = na.id; });
  return true;
}

// Ajoute une case en coupant en deux chaque case de `ids` (axis 'v' : côte à côte, 'h' : l'une sous l'autre) ; la nouvelle prend la moitié du côté de la gouttière.
export function addCase(ids, axis) {
  const pg = page(), before = pg.panels.slice(), gap = mmToPx(ed.project.gutter, ed.project.dpi), v = axis === 'v';
  const { w: pw, h: ph } = pageSize(ed.project), min = Math.round(Math.min(pw, ph) * 0.1);
  const targets = before.filter(p => ids.includes(p.id));
  if (!targets.length || targets.some(p => (v ? p.w : p.h) < 2 * min + gap)) return null;
  const fresh = [];
  const after = before.flatMap(p => {
    if (!targets.includes(p)) return [p];
    const s1 = Math.floor(((v ? p.w : p.h) - gap) / 2);
    const a = v ? { x: p.x, y: p.y, w: s1, h: p.h } : { x: p.x, y: p.y, w: p.w, h: s1 };
    const b = v ? { x: p.x + s1 + gap, y: p.y, w: p.w - s1 - gap, h: p.h } : { x: p.x, y: p.y + s1 + gap, w: p.w, h: p.h - s1 - gap };
    const np = newPanel(b); fresh.push(np);
    return [reshape(p, a), np];
  });
  const prevId = ed.panelId;
  swapPanels(pg, after); ed.panelId = fresh[0].id; notify('panel');
  ed.undo.pushAction('Ajouter une case', () => { swapPanels(pg, before); ed.panelId = before.some(p => p.id === prevId) ? prevId : before[0].id; }, () => { swapPanels(pg, after); ed.panelId = fresh[0].id; });
  return fresh[0];
}

// Ajout d'une case contre un bord de la case `p` : `side` 'left' | 'right' | 'top' | 'bottom', `ratio` = part de la nouvelle case (0,2 à 0,8).
// Elle prend la place de la case coupée (la page ne grandit pas, rien n'entre dans la marge). Renvoie { old, fresh } (rectangles) ou null si trop petit.
export function splitRects(p, side, ratio = 0.5) {
  const gap = mmToPx(ed.project.gutter, ed.project.dpi), { w: pw, h: ph } = pageSize(ed.project), min = Math.round(Math.min(pw, ph) * 0.1);
  const horiz = side === 'left' || side === 'right', total = (horiz ? p.w : p.h) - gap;
  if (total < 2 * min) return null;
  // la part demandée est ramenée dans ce que la taille minimale permet : une case coupable ne refuse jamais l'ajout
  const share = Math.max(min / total, Math.min(1 - min / total, ratio)), fresh = Math.round(total * share), old = total - fresh;
  if (side === 'right') return { old: { x: p.x, y: p.y, w: old, h: p.h }, fresh: { x: p.x + old + gap, y: p.y, w: fresh, h: p.h } };
  if (side === 'left') return { fresh: { x: p.x, y: p.y, w: fresh, h: p.h }, old: { x: p.x + fresh + gap, y: p.y, w: old, h: p.h } };
  if (side === 'bottom') return { old: { x: p.x, y: p.y, w: p.w, h: old }, fresh: { x: p.x, y: p.y + old + gap, w: p.w, h: fresh } };
  return { fresh: { x: p.x, y: p.y, w: p.w, h: fresh }, old: { x: p.x, y: p.y + fresh + gap, w: p.w, h: old } };
}

export function addCaseAt(panelId, side, ratio = 0.5) {
  const pg = page(), p = pg.panels.find(q => q.id === panelId);
  const r = p && splitRects(p, side, ratio);
  if (!r) return null;
  const before = pg.panels.slice(), np = newPanel(r.fresh), prevId = ed.panelId;
  const first = side === 'left' || side === 'top';
  const after = before.flatMap(q => (q !== p ? [q] : first ? [np, reshape(q, r.old)] : [reshape(q, r.old), np]));
  swapPanels(pg, after); ed.panelId = np.id; notify('panel');
  ed.undo.pushAction('Ajouter une case', () => { swapPanels(pg, before); ed.panelId = prevId; }, () => { swapPanels(pg, after); ed.panelId = np.id; });
  return np;
}

// Valide ou abandonne l'aperçu d'ajout de case (`ed.addPreview`).
export function confirmAdd() {
  const pv = ed.addPreview; ed.addPreview = null; notify('tool');
  return pv ? addCaseAt(pv.panelId, pv.side, ed.addRatio / 100) : null;
}
export function cancelAdd() { if (!ed.addPreview) return; ed.addPreview = null; notify('tool'); requestRender(); }

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
  if (kind === 'gradmap') {   // carte de dégradé : au-dessus du calque actif, elle colore tout ce qui est dessous
    const p = panel(), n = p.layers.filter(x => x.kind === 'gradmap').length;
    const l = newLayer(n ? `Dégradé ${n + 1}` : 'Dégradé', p.ew, p.eh, { kind: 'gradmap' });
    const at = p.layers.findIndex(x => x.id === p.active) + 1, prevActive = p.active;
    const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
    const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
    apply(); ed.undo.pushAction('Nouvelle carte de dégradé', unapply, apply);
    return l;
  }
  const p = panel(), color = kind === 'draft' ? nextDraftColor(p) : undefined;
  if (kind !== 'draft') kind = 'ink';   // calques tous pareils : seul le brouillon est une option à part
  const base = kind === 'draft' ? 'Brouillon' : 'Calque', n = p.layers.filter(x => (kind === 'draft') === (x.kind === 'draft')).length;
  const l = newLayer(kind === 'draft' ? (n ? `${base} ${n + 1}` : base) : `${base} ${n + 1}`, p.ew, p.eh, { kind, color });
  const at = p.layers.findIndex(x => x.id === p.active) + 1, prevActive = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prevActive; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Nouveau calque', unapply, apply);
}

// Calque qui reçoit un remplissage : l'actif, sauf s'il est une référence (ou verrouillé, masqué, brouillon) ;
// sinon le plus haut calque possible ; à défaut, un calque « Aplats » est créé sous la référence (annulable).
export function fillLayer(p) {
  const ok = l => !l.reference && !l.locked && l.visible && l.kind !== 'draft' && l.kind !== 'gradmap';
  const act = activeLayer(p);
  if (ok(act)) return act;
  const cand = [...p.layers].reverse().find(ok);
  if (cand) return cand;
  const l = newLayer('Aplats', p.ew, p.eh, { kind: 'ink' });
  const refAt = p.layers.findIndex(x => x.reference), at = refAt >= 0 ? refAt : p.layers.length, prev = p.active;
  const apply = () => { p.layers.splice(at, 0, l); invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prev; invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Nouveau calque', unapply, apply);
  return l;
}

// Le dernier trait (entrée `entry` de l'historique, encore au sommet) quitte `layer` pour un calque « Couleurs » créé juste dessous.
// On défait le trait, on crée le calque, puis on y repose les pixels que le trait avait changés.
export function moveStrokeBelow(p, layer, entry) {
  const u = ed.undo;
  if (u.stack[u.ptr - 1] !== entry || !entry.ops) return null;
  const b = entry.ops[0].before.length === entry.ops[0].tw * entry.ops[0].th * 4 ? 4 : 1;   // octets par pixel du trait
  u.undo();
  // l'encrage venait de passer en couleur pour ce trait : il redevient noir et blanc (plus léger)
  const top = u.stack[u.ptr - 1];
  if (top && top.rgbaLayer === layer) u.undo();
  const l = newLayer('Couleurs', p.ew, p.eh);
  if (b === 4) l.rgba = true;
  const at = Math.max(0, p.layers.indexOf(layer)), prev = p.active;
  const apply = () => { p.layers.splice(at, 0, l); p.active = l.id; invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(p.layers.indexOf(l), 1); p.active = prev; invalidate(p); notify('layers'); markChanged(); };
  apply(); u.pushAction('Nouveau calque', unapply, apply);
  u.begin('Colorier dessous');
  const data = ensureData(l);
  for (const o of entry.ops) {
    if (o.layer !== layer || o.before.length !== o.tw * o.th * b) continue;
    u.touch(l, o.px, o.py, o.px + o.tw, o.py + o.th);
    for (let y = 0; y < o.th; y++) for (let x = 0; x < o.tw; x++) {
      const k = (y * o.tw + x) * b;
      let changed = false;
      for (let c = 0; c < b; c++) if (o.after[k + c] !== o.before[k + c]) { changed = true; break; }
      if (changed) data.set(o.after.subarray(k, k + b), ((o.py + y) * l.w + o.px + x) * b);
    }
  }
  u.commit(); invalidate(p); markChanged();
  return l;
}

export function duplicateLayer() {
  const p = panel(), src = activeLayer(p);
  const l = newLayer(src.name + ' (copie)', src.w, src.h, { kind: src.kind, color: src.color, gradient: src.gradient });
  Object.assign(l, { visible: src.visible, opacity: src.opacity, locked: false, rgba: !!src.rgba, blend: src.blend, alphaLock: src.alphaLock });
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
  if (key === 'kind' && ((value === 'color') !== (l.kind === 'color') || (value === 'draft' && l.rgba))) return;   // pixels de nature différente (RVBA / 1 octet)
  l[key] = value;
  if (key === 'kind') {
    l.draft = value === 'draft';
    if (l.draft && (!l.color || l.color[0] === '#')) l.color = nextDraftColor(p);
    else if (!l.draft && l.color && l.color[0] !== '#') delete l.color;   // la couleur d'un brouillon est un nom de palette, celle d'un calque une teinte libre
  }
  invalidate(p); notify('layers'); markChanged();
}

export function setSolo(id) { ed.solo = ed.solo === id ? null : id; invalidatePage(); notify('layers'); }

// Nouveau calque déjà rempli (image tramée importée).
export function addImageLayer(name, data) {
  const p = panel(), l = newLayer(name, p.ew, p.eh);
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

// Glisser-déposer dans la liste : le calque `id` va à la position `to` du tableau (0 = tout en bas de la pile).
export function moveLayerTo(id, to) {
  const p = panel(), i = p.layers.findIndex(l => l.id === id), order = p.layers.slice();
  if (i < 0 || to < 0 || to >= order.length || to === i) return false;
  const apply = () => { const [l] = p.layers.splice(i, 1); p.layers.splice(to, 0, l); invalidate(p); notify('layers'); markChanged(); };
  const unapply = () => { p.layers.splice(0, p.layers.length, ...order); invalidate(p); notify('layers'); markChanged(); };
  apply(); ed.undo.pushAction('Ordre des calques', unapply, apply);
  return true;
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
  if (l.kind === 'gradmap' || below.kind === 'gradmap') return 'gradmap';   // un calque de réglage n'a pas de pixels à fusionner
  if (bppOf(l) === 4 && bppOf(below) === 1 && below.kind !== 'draft') toRGBA(below);
  if (bppOf(l) !== bppOf(below)) return 'kind';   // un calque en couleur ne se fusionne pas dans un brouillon
  ed.undo.begin('Fusionner vers le bas');
  ed.undo.touch(below, 0, 0, below.w, below.h);
  const src = l.data, dst = ensureData(below);
  if (src && bppOf(l) === 4) {   // couleur sur couleur : mélange « par-dessus » avec l'opacité du calque du haut
    const op = (l.opacity ?? 100) / 100;
    for (let k = 0; k < src.length; k += 4) {
      const a = src[k + 3] / 255 * op; if (!a) continue;
      const da = dst[k + 3] / 255, oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) dst[k + c] = Math.round((src[k + c] * a + dst[k + c] * da * (1 - a)) / oa);
      dst[k + 3] = Math.round(oa * 255);
    }
  } else if (src) for (let k = 0; k < src.length; k++) if (src[k]) dst[k] = src[k];
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
  if (!b.panel) b.panel = (panelOfPoint(pg.panels, b.x + b.w / 2, b.y + b.h / 2) || panel()).id;
  const apply = () => { pg.bubbles.push(b); ed.bubbleId = b.id; notify('bubbles'); requestRender(); markChanged(); };
  const unapply = () => { pg.bubbles.splice(pg.bubbles.indexOf(b), 1); ed.bubbleId = null; notify('bubbles'); requestRender(); markChanged(); };
  apply(); ed.undo.pushAction('Nouvelle bulle', unapply, apply);
  return b;
}

export function addBubble(kind, at, style) {
  const p = panel();
  const b = newBubble(kind, 0, 0), c = at || { x: p.x + p.w / 2, y: p.y + p.h / 3 };
  Object.assign(b, style || ed.bubbleDefaults[kind] || {});   // le style du modèle choisi, sinon le dernier style réglé pour ce type de bulle
  b.x = Math.round(c.x - b.w / 2); b.y = Math.round(c.y - b.h / 2);
  if (b.tail) b.tail = { x: Math.round(b.x + b.w * 0.35), y: Math.round(b.y + b.h + 160) };
  return addBubbleObj(b);
}

// Modèles de bulle : ceux du programme + ceux que l'auteur enregistre (sur cet appareil).
export const allBubbleTemplates = () => BUBBLE_TEMPLATES.concat(ed.bubbleTemplates);
export const currentTemplate = () => allBubbleTemplates().find(t => t.id === ed.bubbleTemplate) || BUBBLE_TEMPLATES[0];
export function addTemplateBubble(at) { const t = currentTemplate(); return addBubble(t.kind, at, t.style ? { ...t.style } : undefined); }
const TEMPLATE_KEYS = ['align', 'valign', 'lobes', 'bulge', 'cloudSoft', 'valleyRound', 'tipRound', 'pt', 'caps', 'auto', 'font', 'shape', 'radius', 'pad', 'stroke', 'wobble', 'spikes', 'depth', 'tailStyle', 'tailW', 'tailRound', 'tailBend', 'tailTip', 'sameStroke', 'clip', 'noFrame'];
export function saveBubbleTemplate(name, b) {
  const style = {};
  for (const k of TEMPLATE_KEYS) if (b[k] !== undefined && !(k === 'shape' && b.shape === 'libre')) style[k] = b[k];
  const t = { id: 'bt' + Math.random().toString(36).slice(2, 8), name, kind: b.kind, style };
  ed.bubbleTemplates.push(t); ed.bubbleTemplate = t.id;
  return t;
}
export function deleteBubbleTemplate(id) {
  ed.bubbleTemplates = ed.bubbleTemplates.filter(t => t.id !== id);
  if (ed.bubbleTemplate === id) ed.bubbleTemplate = 'parole';
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

// Copie d'une bulle (même case, légèrement décalée), annulable.
export function duplicateBubble(b = bubble()) {
  if (!b) return null;
  const d = Math.round(ed.project.dpi / 8), nb = clone(b);
  nb.id = uid(); nb.seed = Math.floor(Math.random() * 1e6);
  nb.x += d; nb.y += d;
  if (nb.tail) nb.tail = { x: nb.tail.x + d, y: nb.tail.y + d };
  if (nb.path) nb.path = nb.path.map(q => ({ x: q.x + d, y: q.y + d }));
  delete nb.locked; delete nb.hidden;
  const pg = page(), at = pg.bubbles.indexOf(b) + 1;
  const apply = () => { pg.bubbles.splice(at, 0, nb); ed.bubbleId = nb.id; notify('bubbles'); requestRender(); markChanged(); };
  const unapply = () => { pg.bubbles.splice(pg.bubbles.indexOf(nb), 1); ed.bubbleId = b.id; notify('bubbles'); requestRender(); markChanged(); };
  apply(); ed.undo.pushAction('Dupliquer la bulle', unapply, apply);
  return nb;
}

// Copie les réglages de trait d'une bulle (épaisseur, même épaisseur que les cases, rognage) sur toutes les bulles du projet ; annulable.
export function applyBubbleLines(src = bubble()) {
  if (!src) return 0;
  const keys = ['stroke', 'sameStroke', 'clip', 'noFrame'], all = ed.project.pages.flatMap(p => p.bubbles);
  const before = new Map(all.map(b => [b, keys.map(k => b[k])]));
  const set = vals => { for (const b of all) { const v = vals(b); keys.forEach((k, i) => { if (v[i] === undefined) delete b[k]; else b[k] = v[i]; }); } notify('bubbles'); requestRender(); markChanged(); };
  const to = keys.map(k => (k === 'stroke' ? bubbleProps(src).stroke : src[k]));
  const after = () => to;
  set(after); ed.undo.pushAction('Traits des bulles', () => set(b => before.get(b)), () => set(after));
  return all.length;
}

// ── Narration : marge au bord de la case ──
// Un côté de la bulle à moins de `zone` px de la ligne « bord de la case − marge » s'y cale (déplacement, ou taille si `resize`).
// Une bulle tournée ne se cale pas.
export const EDGE_ZONE_MM = 3;
export function snapNarration(b, panels, { resize = false, zone } = {}) {
  if (!b || b.kind !== 'narration' || b.rot) return false;
  const p = bubblePanelOf(b, panels);
  if (!p) return false;
  const dpi = ed.project.dpi, m = mmToPx(bubbleProps(b).edge ?? 0, dpi), z = zone ?? mmToPx(EDGE_ZONE_MM, dpi);
  const L = p.x + m, T = p.y + m, R = p.x + p.w - m, Bt = p.y + p.h - m;
  let moved = false;
  if (resize) {   // seule la largeur se règle (la hauteur suit le texte) : le bord droit se cale à la marge
    if (Math.abs(b.x + b.w - R) <= z && R - b.x >= 80) { resizeBubbleWidth(b, R - b.x, { x: b.x, y: b.y }); moved = true; }
    return moved;
  }
  let dx = 0, dy = 0;
  if (Math.abs(b.x - L) <= z) dx = L - b.x; else if (Math.abs(b.x + b.w - R) <= z) dx = R - (b.x + b.w);
  if (Math.abs(b.y - T) <= z) dy = T - b.y; else if (Math.abs(b.y + b.h - Bt) <= z) dy = Bt - (b.y + b.h);
  if (!dx && !dy) return false;
  b.x = Math.round(b.x + dx); b.y = Math.round(b.y + dy);
  if (b.tail) b.tail = { x: Math.round(b.tail.x + dx), y: Math.round(b.tail.y + dy) };
  if (b.path) b.path = b.path.map(q => ({ x: Math.round(q.x + dx), y: Math.round(q.y + dy) }));
  return true;
}
// Donne la marge de `src` à toutes les narrations du projet ; celles qui étaient calées à un bord s'y recalent. Annulable.
export function applyNarrationEdge(src = bubble()) {
  if (!src) return 0;
  const edge = bubbleProps(src).edge ?? 0, pad = bubbleProps(src).pad, dpi = ed.project.dpi;
  const list = ed.project.pages.flatMap(pg => pg.bubbles.filter(b => b.kind === 'narration').map(b => ({ b, pg })));
  const snap = b => ({ x: b.x, y: b.y, w: b.w, h: b.h, edge: b.edge, pad: b.pad, wrap: b.wrap, auto: b.auto, tail: b.tail && { ...b.tail }, path: b.path && b.path.map(q => ({ ...q })) });
  const before = list.map(({ b }) => ({ b, s: snap(b) }));
  for (const { b, pg } of list) {
    const old = mmToPx(bubbleProps(b).edge ?? 0, dpi);
    b.edge = edge; b.pad = pad;
    if (!b.path) { const x0 = b.x, y0 = b.y; b.auto = true; b.wrap = b.wrap || Math.round(wrapForWidth(b, b.w, dpi)); autoSize(measureCtx(), b, dpi); b.x = x0; b.y = y0; }   // nouvelle marge intérieure : la bulle se réajuste, coin haut gauche fixe
    snapNarration(b, pg.panels, { zone: Math.abs(mmToPx(edge, dpi) - old) + mmToPx(3, dpi) });   // seules les bulles déjà calées bougent
  }
  const after = list.map(({ b }) => ({ b, s: snap(b) }));
  const set = st => { for (const { b, s } of st) Object.assign(b, s); notify('bubbles'); requestRender(); markChanged(); };
  set(after); ed.undo.pushAction('Marge des narrations', () => set(before), () => set(after));
  return list.length;
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

export function selectBubble(id) {
  ed.bubbleId = id;
  // une bulle appartient à sa case : la choisir ouvre sa case dans le volet (hors mode case, qui reste sur la sienne)
  const b = id && page().bubbles.find(x => x.id === id);
  if (b && !ed.focus) { linkBubbles(page()); if (b.panel && b.panel !== ed.panelId && page().panels.some(p => p.id === b.panel)) { ed.panelId = b.panel; notify('panel'); } }
  notify('bubbles'); requestRender();
}

// Une modification de bulle (déplacement, texte…) devient une entrée d'historique.
export function commitBubbleEdit(b, before) {
  const after = clone(b);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const set = state => { Object.keys(b).forEach(k => delete b[k]); Object.assign(b, clone(state)); notify('bubbles'); requestRender(); markChanged(); };
  ed.undo.pushAction('Bulle', () => set(before), () => set(after));
  markChanged();
}

export function refitBubble(b) {
  if (!b.auto && !b.path) { b.wrap = Math.round(wrapForWidth(b, b.w, ed.project.dpi)); b.auto = true; }   // ancienne bulle à taille fixe : elle garde sa largeur
  if (b.auto) {
    const held = sidesAtEdge(b);   // une narration calée à un bord y reste quand elle change de taille
    autoSize(measureCtx(), b, ed.project.dpi);
    if (held) keepSides(b, held);
  }
  requestRender();
}
// Côtés d'une narration posés sur la ligne « bord de la case − marge » (à 2 px près), et cette ligne.
function sidesAtEdge(b) {
  if (b.kind !== 'narration' || b.rot) return null;
  const p = bubblePanelOf(b, page().panels);
  if (!p) return null;
  const m = mmToPx(bubbleProps(b).edge ?? 0, ed.project.dpi), L = p.x + m, T = p.y + m, R = p.x + p.w - m, B = p.y + p.h - m, near = (a, c) => Math.abs(a - c) <= 2;
  const s = { L: near(b.x, L) && L, T: near(b.y, T) && T, R: near(b.x + b.w, R) && R, B: near(b.y + b.h, B) && B };
  return s.L !== false || s.T !== false || s.R !== false || s.B !== false ? s : null;
}
function keepSides(b, s) {
  const x0 = b.x, y0 = b.y;
  if (s.L !== false) b.x = s.L; else if (s.R !== false) b.x = s.R - b.w;
  if (s.T !== false) b.y = s.T; else if (s.B !== false) b.y = s.B - b.h;
  const dx = b.x - x0, dy = b.y - y0;
  if (b.tail && (dx || dy)) b.tail = { x: b.tail.x + dx, y: b.tail.y + dy };
}
// Tirer le coin d'une bulle : on choisit la largeur (donc la forme), la hauteur suit le texte. Coin haut gauche fixe.
export function resizeBubbleWidth(b, w, keep) {
  b.auto = true; b.wrap = Math.round(wrapForWidth(b, Math.max(80, w), ed.project.dpi));
  autoSize(measureCtx(), b, ed.project.dpi);
  if (keep) { b.x = keep.x; b.y = keep.y; }
}

export const snapshotBubble = b => clone(b);

export { pageLayers };

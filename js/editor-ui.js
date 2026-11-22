// Interface de l'éditeur : barre d'outils, options de l'outil, volet (calques, trames, pages, bulles, case).
import {
  ed, page, panel, selectPanel, linkBubbles, activeLayer, bubble, subscribe, notify, selectLayer, addLayer, deleteLayer, moveLayer, moveLayerTo, toggleLayer, renameLayer,
  clearLayer, mergeDown, clearMask, invertMask, addCase, confirmAdd, cancelAdd, setNote, addBubble, deleteBubble, duplicateBubble, allBubbleTemplates, currentTemplate, addTemplateBubble, saveBubbleTemplate, deleteBubbleTemplate, applyBubbleLines, selectBubble, commitBubbleEdit, refitBubble,
  snapshotBubble, goToPage, addPage, duplicatePage, deletePage, movePage, relayoutPage, markChanged, saveNow, addImageLayer,
  copyPanelTo, refitAutoBubbles, setBubbleProp, togglePageBubbles, allBrushes, currentBrush, selectBrush, resetBrush, saveBrushAs, updateBrush, deleteBrush, duplicateLayer, setLayerProp, brushSlots, activeSlot, applySlot, storeSlot, brushToPalette, removeSlot, restoreSlot, restoreBrush, renameSlot, moveSlot, setAlpha, SLOT_MAX, BRUSH_TOOLS, ticksOf, projectColors, projectPalettes, currentPalette, selectPalette, addPalette, renamePalette, removePalette, restorePalette, addProjectColor, removeProjectColor, restoreProjectColor, setColor, swapColors, resetColors, snapNarration, applyNarrationEdge, setSolo, storeToolSettings, applyToolSettings, setSizeMm, maxSizeMm, mergeCandidates, mergePanels, deletePanel, setPanelStroke,
} from './editor.js';
import { FONTS, loadFont, importFont, fontName } from './fonts.js';
import { BRUSH_GROUPS, previewBrush, BLEND_MODES } from './raster.js';
import { attach, fit, view, zoomAt, requestRender, resize, invalidate, colorAt, rotateView, hooks, toScreen, toPage, bubbleRotHandle } from './view.js';
import { colorDrop } from './tools.js';
import { attachInput, typing } from './input.js';
import { LAYOUTS, pageSize, panelStroke, DRAFT_COLORS, bppOf, mmToPx } from './model.js';
import { allTramas, tramaById, drawTramaSwatch, encodeTrama, saveToLibrary, removeFromLibrary, DITHER_METHODS, ditherGray, imageToGray } from './tramas.js';
import { BUBBLE_KINDS, SHAPES as BUBBLE_SHAPES, TAILS, props, preset, bubblePanelOf, bubbleToPage } from './bubbles.js';
import { openModal, esc, icon, $, $$, confirmModal, promptModal, modalOpen } from './ui-core.js';
import { toast } from './toast.js';
import { canFullscreen, isFullscreen, toggleFullscreen, onFullscreenChange } from './shell.js';
import { layoutSvg, newProjectModal, decoupageModal } from './home.js';
import { buildPDF, renderPage, canvasToBlob, download, safeName, ensureFonts } from './export.js';
import { loadPage, unloadPage } from './store.js';
import { exportProject } from './portable.js';
import { stampLibrary } from './library.js';
import { syncSoon } from './sync.js';
import { clearSelection, selectAll, invertSelection, clearSelectionContent, polyFinish, polyCancel, polyCount, currentSelection } from './selection.js';

export const TOOLS = [
  { id: 'pencil', icon: 'brush', label: 'Pinceaux et trames (B)', key: 'b' },
  { id: 'eraser', icon: 'eraser', label: 'Gomme (E)', key: 'e' },
  { id: 'fill', icon: 'bucket-droplet', label: 'Remplir (G)', key: 'g' },
  { id: 'shape', icon: 'square', label: 'Formes (S)', key: 's' },
  { id: 'mask', icon: 'mask', label: 'Masque (M)', key: 'm' },
  { id: 'select', icon: 'marquee-2', label: 'Sélection (A)', key: 'a' },
  { id: 'bubble', icon: 'message-circle', label: 'Bulles (V)', key: 'v' },
  { id: 'layout', icon: 'layout-board-split', label: 'Taille des cases (L)', key: 'l' },
  { id: 'pan', icon: 'hand-stop', label: 'Déplacer la vue (H)', key: 'h' },
];
// Outils de la case (dessin) et de la planche (cases et pages) ; « Déplacer la vue » sert aux deux.
const CASE_TOOLS = ['pencil', 'eraser', 'fill', 'shape', 'mask', 'select', 'bubble'];
const PAGE_TOOLS = ['layout', 'pan'];
const toolsOfLevel = () => TOOLS.filter(t => (ed.focus ? t.id !== 'layout' : PAGE_TOOLS.includes(t.id)));
const SHAPES = [{ id: 'line', icon: 'slash', label: 'Ligne' }, { id: 'rect', icon: 'square', label: 'Rectangle' }, { id: 'ellipse', icon: 'circle', label: 'Ellipse' }];
const TABS = [{ id: 'layers', icon: 'stack-2', label: 'Calques' }, { id: 'page', icon: 'files', label: 'Page' }];

let fsListener = null;
let popBack = null;   // fenêtre à rouvrir après un choix dans la bibliothèque ouverte depuis elle
let root, dockTab = 'layers', popId = null, dockOpen = true, unsub = null, keyHandler = null;
// Volet de droite : complet (dockOpen), réduit à une colonne de vignettes (dockMini), ou masqué (ni l'un ni l'autre).
let dockMini = false;
let layerOpts = null;   // calque dont les options sont dépliées (toucher le calque actif)
const narrow = () => window.matchMedia('(max-width: 768px)').matches;
const DOCK_KEY = 'fusain:dock';

const prefsKey = 'fusain:prefs';
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefsKey)) || {};
    if (typeof p.fingerDraws === 'boolean') ed.fingerDraws = p.fingerDraws;
    if (typeof p.pressure === 'boolean') ed.pressure = p.pressure;
    if (typeof p.pressureGamma === 'number') ed.pressureGamma = p.pressureGamma;
    if (['off', 'normal', 'strong'].includes(p.palm)) ed.palm = p.palm;
    if (typeof p.showNotes === 'boolean') ed.showNotes = p.showNotes;
    if (p.toolSettings && typeof p.toolSettings === 'object') ed.toolSettings = p.toolSettings;
    if (p.bubbleDefaults && typeof p.bubbleDefaults === 'object') ed.bubbleDefaults = p.bubbleDefaults;
    if (p.ditherOpts && typeof p.ditherOpts === 'object') ed.ditherOpts = p.ditherOpts;
    if (Array.isArray(p.customBrushes)) ed.customBrushes = p.customBrushes;
    if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) ed.color = p.color.toUpperCase();
    if (typeof p.color2 === 'string' && /^#[0-9a-f]{6}$/i.test(p.color2)) ed.color2 = p.color2.toUpperCase();
    else if (ed.color !== '#000000') { p.recentColors = [ed.color, ...(p.recentColors || [])]; ed.color = '#000000'; }   // ancien format : la couleur part dans les récentes
    if (Array.isArray(p.recentColors)) ed.recentColors = p.recentColors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => c.toUpperCase()).slice(0, 10);
    if (p.brushSizes && typeof p.brushSizes === 'object') ed.brushSizes = p.brushSizes;
    if (Array.isArray(p.tramaPresets)) ed.tramaPresets = p.tramaPresets;
    if (Array.isArray(p.bubbleTemplates)) ed.bubbleTemplates = p.bubbleTemplates;
    if (typeof p.bubbleTemplate === 'string') ed.bubbleTemplate = p.bubbleTemplate;
        if (typeof p.tool === 'string') ed.tool = ['bubble', 'layout', 'select', 'texture'].includes(p.tool) ? 'pencil' : p.tool;
  } catch { /* préférences locales seulement */ }
}
// Préférences de l'appareil : réglages de chaque outil, dernier style de chaque type de bulle, options d'image tramée.
export function savePrefs() {
  storeToolSettings();
  if (stampLibrary(ed)) syncSoon();   // pinceaux, réglages de trame ou modèles de bulles changés : on les partage
  try {
    localStorage.setItem(prefsKey, JSON.stringify({ fingerDraws: ed.fingerDraws, pressure: ed.pressure, pressureGamma: ed.pressureGamma, palm: ed.palm, showNotes: ed.showNotes,
      toolSettings: ed.toolSettings, bubbleDefaults: ed.bubbleDefaults, ditherOpts: ed.ditherOpts, tool: ed.tool,
      color: ed.color, color2: ed.color2, recentColors: ed.recentColors,
      customBrushes: ed.customBrushes, brushSizes: ed.brushSizes, tramaPresets: ed.tramaPresets, bubbleTemplates: ed.bubbleTemplates, bubbleTemplate: ed.bubbleTemplate }));
  } catch { /* */ }
}

// ───────────────────────── Montage ─────────────────────────

export function mountEditor(el) {
  root = el;
  let saved = null; try { saved = localStorage.getItem(DOCK_KEY); } catch { /* */ }
  dockOpen = !narrow() && saved !== 'mini' && saved !== 'hidden';
  dockMini = !narrow() && saved === 'mini';
  root.innerHTML = `<div class="ed">
    <nav class="toolbar" id="toolbar" aria-label="Outils"></nav>
    <section class="stage" id="stage">
      <div class="canvas-wrap">
        <canvas id="view" aria-label="Page de BD"></canvas>
        <div class="bfloat" id="bfloat" hidden></div>
        <textarea class="bedit" id="bedit" hidden aria-label="Texte de la bulle"></textarea>
        <button class="bedit-ok" id="beditok" hidden title="Terminer la saisie" aria-label="Terminer la saisie">${icon('check')}</button>
        <div class="zoombar" id="zoombar"></div>
        <div class="quick" id="quick" hidden></div>
        <div class="qprev" id="qprev" hidden aria-hidden="true"><canvas></canvas><span></span></div>
        <button class="icon-btn icon-only dock-reopen" id="dockreopen" hidden title="Afficher le panneau" aria-label="Afficher le panneau de droite">${icon('layout-sidebar-right-expand')}</button>
      </div>
      <div class="optwrap"><div class="pop" id="pop" role="dialog" aria-label="Réglages de l'outil" hidden></div><div class="optbar" id="optbar"></div></div>
    </section>
    <aside class="dock ${dockOpen ? '' : dockMini ? 'closed mini' : 'closed gone'}" id="dock"></aside>
  </div>`;
  enterPageLevel();
  attach($('#view', root));
  hooks.afterRender = placeBubbleUI;
  initBubbleUI();
  attachInput($('#view', root), { onUndo: undo, onRedo: redo, onClear: clearActiveLayer, onPenToggle: penToggle, onPenEraser: penEraser, onDoubleTap, onLongPress });
  fit();
  renderAll();

  $('#dockreopen', root).hidden = dockOpen || dockMini || narrow();
  $('#dockreopen', root).onclick = () => setDock('full');
  $('#toolbar', root).onclick = e => { if (e.target.closest('[data-z="focus"]')) { setFocus(true); return; } onToolbar(e); };
  $('#zoombar', root).onclick = onZoombar;
  $('#optbar', root).addEventListener('click', onOptbar);
  attachHold($('#optbar', root)); attachHold($('#pop', root));
  $('#optbar', root).addEventListener('input', onOptInput);
  const pop = $('#pop', root);
  const quick = $('#quick', root);
  quick.addEventListener('pointerdown', quickDown);
  quick.addEventListener('pointermove', quickMove);
  quick.addEventListener('pointerup', quickUp);
  quick.addEventListener('pointercancel', quickUp);
  quick.addEventListener('keydown', quickKey);
  quick.addEventListener('click', onQuickClick);
  quick.addEventListener('pointerdown', cdropDown); quick.addEventListener('pointermove', cdropMove);
  quick.addEventListener('pointerup', cdropUp); quick.addEventListener('pointercancel', cdropUp);
  pop.addEventListener('pointerdown', pickerDown); pop.addEventListener('pointermove', pickerMove);
  pop.addEventListener('pointerup', pickerUp); pop.addEventListener('pointercancel', pickerUp);
  $('#dock', root).addEventListener('pointerdown', e => { if (!gripDown(e)) swipeDown(e); });
  $('#dock', root).addEventListener('pointermove', e => { gripMove(e); swipeMove(e); });
  $('#dock', root).addEventListener('pointerup', e => { gripUp(e); swipeUp(e); });
  $('#dock', root).addEventListener('pointercancel', e => { gripUp(e, true); swipeUp(e); });
  $('#dock', root).addEventListener('click', onDock);
  $('#dock', root).addEventListener('click', onDockFoot);
  $('#dock', root).addEventListener('toggle', onSecToggle, true);
  $('#dock', root).addEventListener('input', onDockInput);
  $('#dock', root).addEventListener('change', onDockChange);
  $('#dock', root).addEventListener('focusin', onDockFocus);
  pop.addEventListener('click', onDock); pop.addEventListener('input', onDockInput); pop.addEventListener('change', onDockChange); pop.addEventListener('focusin', onDockFocus);

  unsub = subscribe(what => {
    if (what === 'panels' || what === 'page' || what === 'project') { polyCancel(); clearSelection(false); }
    if (what === 'dirty' || what === 'undo') refreshMiniSoon();
    if (what === 'undo') { updateUndo(); if (ed.tool === 'layout') renderOptbar(); }
    else if (what === 'sel') renderOptbar();
    else if (what === 'panels') renderAll();
    else if (what === 'project' || what === 'page') { enterPageLevel(); renderAll(); fit(); }
    else if (what === 'panel') { renderDock(); renderOptbar(); renderZoombar(); if (ed.focus) fit(); }
    else if (what === 'layers') renderDock();
    else if (what === 'bubbles') { renderDock(); if (ed.tool === 'bubble') renderOptbar(); }
    else if (what === 'tool') { renderOptbar(); renderDock(); }
    else if (what === 'bubble-added') { renderOptbar(); renderDock(); setTimeout(openBubbleEdit, 0); }
  });
  keyHandler = onKey;
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('fusain:library', onLibrary);
  document.addEventListener('pointerdown', closeColorOutside, true);
  fsListener = () => { renderToolbar(); renderDock(); setTimeout(resize, 100); };
  onFullscreenChange(fsListener);
  setTimeout(resize, 0);
}

function closeColorOutside(e) {
  if (pickFromCanvas(e)) return;
  if (popId !== 'color' || modalOpen() || e.target.closest('#pop, [data-cw="open"], .toast, dialog, [aria-modal="true"]')) return;
  popId = null; renderPop(); renderOptbar(); updateColorWidget();
  if (e.target.id === 'view') { e.stopPropagation(); e.preventDefault(); }   // ce toucher ferme la palette, il ne dessine pas
}
// La bibliothèque est arrivée d'un autre appareil : listes et barre à jour.
function onLibrary() { if (!ed.project) return; const pe = $('#pop', root); if (pe) pe._html = ''; renderOptbar(); renderDock(); renderPop(); }

export function unmountEditor() {
  window.removeEventListener('fusain:library', onLibrary);
  document.removeEventListener('pointerdown', closeColorOutside, true);
  if (unsub) unsub(); unsub = null;
  if (keyHandler) window.removeEventListener('keydown', keyHandler); keyHandler = null;
}

function renderAll() { renderToolbar(); renderOptbar(); renderZoombar(); renderDock(); renderPop(); updateUndo(); }

// ───────────────────────── Barre d'outils ─────────────────────────

function renderToolbar() {
  const open = ed.focus ? '' : `<button class="icon-btn icon-only" data-z="focus" title="Dessiner dans la case ${page().panels.indexOf(panel()) + 1} (double toucher sur une case)" aria-label="Dessiner dans la case ${page().panels.indexOf(panel()) + 1}">${icon('pencil')}</button>`;
  $('#toolbar', root).innerHTML = toolsOfLevel().map(t => {
    const ic = t.id === 'shape' ? SHAPES.find(s => s.id === ed.shapeKind).icon : t.icon;
    return `<button class="icon-btn icon-only" data-tool="${t.id}" title="${t.label}" aria-label="${t.label}" aria-pressed="${ed.tool === t.id}">${icon(ic)}</button>`;
  }).join('') + open + `<span class="sep"></span>
    <span class="undo-redo">
    <button class="icon-btn icon-only" data-act="undo" id="btn-undo" title="Annuler (Ctrl+Z)" aria-label="Annuler">${icon('arrow-back-up')}</button>
    <button class="icon-btn icon-only" data-act="redo" id="btn-redo" title="Rétablir (Ctrl+Maj+Z)" aria-label="Rétablir">${icon('arrow-forward-up')}</button></span>
    <span class="sp"></span>
    <button class="icon-btn icon-only dock-toggle" data-act="dock" title="Panneaux" aria-label="Panneaux" aria-pressed="${dockOpen}">${icon('layout-sidebar-right')}</button>`;
  updateUndo();
}

function updateUndo() {
  for (const [sel, ok] of [['[data-act=undo]', ed.undo.canUndo], ['[data-act=redo]', ed.undo.canRedo]]) {
    $$(sel, root).forEach(b => { b.disabled = !ok; });
  }
}

// Stylet : bascule plume ↔ gomme (bouton du flanc) ; le bout gomme du stylet gomme le temps d'un trait.
let penBefore = null;
function penToggle(fromTap) {
  if (fromTap) { markChanged(); requestRender(); }
  if (!['pencil', 'eraser'].includes(ed.tool)) { if (fromTap) return; setTool('pencil'); return; }
  const to = ed.tool === 'eraser' ? 'pencil' : 'eraser';
  setTool(to); toast(to === 'eraser' ? 'Gomme' : 'Pinceau', { duration: 900 });
}
function penEraser(on) {
  if (on) { if (ed.tool !== 'eraser') { penBefore = ed.tool; setTool('eraser'); } }
  else if (penBefore) { setTool(penBefore); penBefore = null; }
}

// Trois doigts qui frottent : vide le calque actif, avec « Annuler » pendant quelques secondes.
function dupWithToast() { const n = activeLayer().name; duplicateLayer(); toast(`« ${n} » dupliqué.`, { actionLabel: 'Annuler', duration: 5000, onAction: undo }); }
function mergeWithToast() {
  const p = panel(), l = activeLayer(), below = p.layers[p.layers.indexOf(l) - 1], r = mergeDown();
  if (!r) toast('Pas de calque en dessous.');
  else if (r === 'kind') toast('Un calque en couleur ne se fusionne pas dans un brouillon.');
  else toast(`« ${l.name} » fusionné dans « ${below.name} ».`, { actionLabel: 'Annuler', duration: 7000, onAction: () => { undo(); undo(); } });
}
function clearActiveLayer() {
  const name = activeLayer().name, r = clearLayer();
  if (r === 'ok') toast(`Calque « ${name} » vidé.`, { actionLabel: 'Annuler', duration: 7000, onAction: undo });
  else if (r === 'locked') toast(`Le calque « ${name} » est verrouillé.`);
}

export function undo() { ed.undo.undo(); markChanged(); requestRender(); }
export function redo() { ed.undo.redo(); markChanged(); requestRender(); }

function setTool(id) {
  // un outil de dessin ouvre la case active ; l'outil des cases ramène à la planche
  if (CASE_TOOLS.includes(id) && !ed.focus) { setFocus(true, null, id); return; }
  if (id === 'layout' && ed.focus) { setFocus(false); return; }
  switchTool(id);
  renderToolbar(); renderOptbar(); renderDock(); requestRender();
}
function switchTool(id) {
  if (ed.tool === 'select' && id !== 'select') { polyCancel(); clearSelection(false); }
  if (CASE_TOOLS.includes(id)) ed.caseTool = id;
  storeToolSettings();   // l'outil quitté garde ses réglages ; celui qu'on prend retrouve les siens
  ed.tool = id;
  applyToolSettings();
  savePrefs();
  if (id !== 'bubble') { ed.bubbleId = null; ed.bubbleDraw = false; }
  popId = null;
}

function onToolbar(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) {
    if (b.dataset.tool === 'shape' && ed.tool === 'shape') ed.shapeKind = SHAPES[(SHAPES.findIndex(s => s.id === ed.shapeKind) + 1) % SHAPES.length].id;
    setTool(b.dataset.tool);
  } else if (b.dataset.act === 'undo') undo();
  else if (b.dataset.act === 'redo') redo();
  else if (b.dataset.act === 'dock') toggleDock();
}

// Panneau de droite : complet, réduit (une colonne de vignettes de calques, ou de pages sur la planche) ou masqué.
// Sur téléphone, il n'y a que complet (en tiroir) et masqué.
function setDock(mode) {
  if (narrow() && mode === 'mini') mode = 'hidden';
  dockOpen = mode === 'full'; dockMini = mode === 'mini';
  const d = $('#dock', root);
  d.classList.toggle('closed', !dockOpen); d.classList.toggle('mini', dockMini); d.classList.toggle('gone', !dockOpen && !dockMini);
  $('#dockreopen', root).hidden = dockOpen || dockMini || narrow();
  try { localStorage.setItem(DOCK_KEY, mode); } catch { /* */ }
  renderToolbar(); renderDock(); setTimeout(resize, 0);
}
const dockMode = () => (dockOpen ? 'full' : dockMini ? 'mini' : 'hidden');
function toggleDock(open = !dockOpen) { setDock(open ? 'full' : narrow() ? 'hidden' : 'mini'); }
function onDockFoot(e) {
  const b = e.target.closest('.dock-foot [data-act]');
  if (!b) return;
  if (b.dataset.act === 'foot-fs') toggleFullscreen();
  else if (b.dataset.act === 'foot-dock') toggleDock();
  else if (b.dataset.act === 'dock-full') setDock('full');
  else if (b.dataset.act === 'dock-mini') setDock('mini');
  else if (b.dataset.act === 'dock-hide') setDock('hidden');
}

// ───────────────────────── Zoom et pages ─────────────────────────

function renderZoombar() {
  const n = ed.project.pages.length, panels = page().panels, ci = panels.indexOf(panel());
  // mode case : on passe d'une case à l'autre, et « Page » ramène à la page entière
  const nav = ed.focus
    ? `<button class="btn small" data-z="page" title="Revenir à la page entière (double toucher)" aria-label="Revenir à la page entière">${icon('layout-grid')} Page</button>
    <button class="icon-btn icon-only" data-z="pcase" aria-label="Case précédente" ${ci <= 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
    <span class="zb-label">Case ${ci + 1} / ${panels.length}</span>
    <button class="icon-btn icon-only" data-z="ncase" aria-label="Case suivante" ${ci >= panels.length - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button>`
    : `<button class="icon-btn icon-only" data-z="focus" title="Ouvrir la case ${ci + 1} seule (double toucher)" aria-label="Ouvrir la case ${ci + 1} seule">${icon('focus-2')}</button>
    <button class="icon-btn icon-only" data-z="prev" aria-label="Page précédente" ${ed.pageIdx === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
    <span class="zb-label">${ed.pageIdx + 1} / ${n}</span>
    <button class="icon-btn icon-only" data-z="next" aria-label="Page suivante" ${ed.pageIdx >= n - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button>`;
  $('#zoombar', root).innerHTML = `
    <button class="icon-btn icon-only mob-only" data-act="undo" aria-label="Annuler">${icon('arrow-back-up')}</button>
    <button class="icon-btn icon-only mob-only" data-act="redo" aria-label="Rétablir">${icon('arrow-forward-up')}</button>
    ${nav}
    <button class="icon-btn icon-only" data-z="out" aria-label="Zoom arrière">${icon('zoom-out')}</button>
    <button class="icon-btn icon-only" data-z="in" aria-label="Zoom avant">${icon('zoom-in')}</button>
    <button class="icon-btn icon-only" data-z="fit" aria-label="Ajuster à l'écran">${icon('zoom-scan')}</button>`;
}

function onZoombar(e) {
  const a = e.target.closest('[data-act]');
  if (a) { if (a.dataset.act === 'undo') undo(); else redo(); return; }
  const b = e.target.closest('[data-z]');
  if (!b) return;
  const z = b.dataset.z, cx = view.w / 2, cy = view.h / 2;
  if (z === 'in') zoomAt(cx, cy, 1.5); else if (z === 'out') zoomAt(cx, cy, 1 / 1.5);
  else if (z === 'fit') fit(); else if (z === 'prev') goToPage(ed.pageIdx - 1); else if (z === 'next') goToPage(ed.pageIdx + 1);
  else if (z === 'focus') setFocus(true); else if (z === 'page') setFocus(false);
  else if (z === 'pcase' || z === 'ncase') stepCase(z === 'pcase' ? -1 : 1);
}

// ── Mode case : la case choisie devient le seul canevas (ses calques dans le volet), jusqu'au retour à la page ──
// Deux niveaux : la planche (cases, pages ; outils Taille des cases et Déplacer) et la case ouverte (dessin, calques, bulles).
export function setFocus(on, panelId, tool) {
  if (panelId) selectPanel(panelId);
  on = !!on && !!ed.project;
  if (ed.focus === on && !panelId && !tool) return;
  ed.focus = on;
  if (on) { const t = tool || (CASE_TOOLS.includes(ed.tool) ? ed.tool : ed.caseTool || 'pencil'); if (t !== ed.tool) switchTool(t); }
  else if (CASE_TOOLS.includes(ed.tool)) switchTool('layout');
  dockTab = on ? 'layers' : 'page';
  dropForeignBubble();
  fit(); renderToolbar(); renderZoombar(); renderOptbar(); renderDock(); requestRender();
}
// À l'ouverture d'un projet ou d'une page, on est sur la planche : outils de la planche, onglet Page.
function enterPageLevel() {
  ed.focus = false;
  if (CASE_TOOLS.includes(ed.tool)) { ed.caseTool = ed.tool; switchTool('layout'); }
  dockTab = 'page';
}
function stepCase(d) {
  const list = page().panels, i = list.indexOf(panel()) + d;
  if (i < 0 || i >= list.length) return;
  selectPanel(list[i].id); dropForeignBubble(); fit(); renderZoombar(); renderDock();
}
// En mode case, une bulle choisie qui appartient à une autre case est désélectionnée.
function dropForeignBubble() { const b = bubble(); if (ed.focus && b && b.panel !== ed.panelId) { ed.bubbleId = null; renderOptbar(); } }
// Double toucher (doigt qui déplace la vue, main, souris en mode main) : ouvre la case touchée, ou revient à la page.
function onDoubleTap(panelId) {
  if (ed.focus) setFocus(false);
  else if (panelId) setFocus(true, panelId);
}

// ───────────────────────── Options de l'outil ─────────────────────────

// Corps du texte : 5 à 200 pt sur un curseur logarithmique, arrondi (0,5 jusqu'à 24 pt, 1 jusqu'à 60, 2 au-delà).
const ptToV = pt => Math.round(100 * Math.log(pt / 5) / Math.log(40) * 2) / 2;
const vToPt = v => { const pt = 5 * Math.pow(40, v / 100); return pt < 24 ? Math.round(pt * 2) / 2 : pt < 60 ? Math.round(pt) : Math.round(pt / 2) * 2; };
const fmtMm = v => String(+v.toFixed(2)).replace('.', ',');
// Course du curseur de taille (0–100) : courbe en puissance (exposant SIZE_CURVE) plutôt que logarithmique.
// En logarithmique, 0,05–0,5 mm prenait un tiers de la course et les grandes tailles sautaient de 2 mm par pixel ;
// ici (50 mm au maximum) : 0,05–1 mm ≈ 21 %, 1–5 mm ≈ 19 %, 5–20 mm ≈ 29 %, 20–50 mm ≈ 31 %. Pas d'arrondi de la position.
const SIZE_MIN = 0.05, SIZE_CURVE = 2.5;
const sizeToV = mm => 100 * Math.pow(Math.max(0, Math.min(1, (mm - SIZE_MIN) / (maxSizeMm() - SIZE_MIN))), 1 / SIZE_CURVE);
const vToSize = v => {
  const mm = SIZE_MIN + (maxSizeMm() - SIZE_MIN) * Math.pow(Math.max(0, Math.min(1, v / 100)), SIZE_CURVE);
  const step = mm < 1 ? 0.05 : mm < 5 ? 0.1 : mm < 20 ? 0.5 : 1;   // pas lisibles : 0,05 mm, 0,1 mm, 0,5 mm, 1 mm
  return +Math.max(SIZE_MIN, Math.round(mm / step) * step).toFixed(2);
};
// Remplissage : tolérance aux contours ouverts (0 = fermés seulement).
const gapControl = () => `<span class="opt size"><input type="range" id="o-gap" min="0" max="100" value="${ed.fillGap}" aria-label="Tolérance aux trous du contour"><span class="unit" id="o-gap-v">${ed.fillGap} %</span></span>`;
// La trame se montre sans texte : un toucher ouvre la bibliothèque en liste déroulante.
function tramaControl() {
  const t = tramaById(ed.project, ed.tramaId);
  const name = t.solid ? 'aucune (encre pleine)' : t.name;
  return `<button class="swatch-btn ${popId === 'lib-trama' ? 'on' : ''}" data-pop="lib-trama" aria-expanded="${popId === 'lib-trama'}" title="Trame : ${esc(name)}" aria-label="Choisir la trame, actuelle : ${esc(name)}">${t.solid ? '<span class="ink-dot"></span>' : `<canvas width="30" height="30" data-swatch="${t.id}"></canvas>`}</button>`;
}

export function renderOptbar() {
  const o = $('#optbar', root), t = ed.tool;
  let html = '';
  if (t === 'pencil') html = paletteControl() + tramaControl() + popBtn('brush');
  else if (t === 'eraser') html = paletteControl() + popBtn('brush');
  else if (t === 'fill') html = tramaControl() + gapControl() + popBtn('trama');
  else if (t === 'shape') {
    html = `<span class="seg" role="group" aria-label="Forme">${SHAPES.map(s => `<button data-shape="${s.id}" class="${ed.shapeKind === s.id ? 'on' : ''}" aria-label="${s.label}" title="${s.label}">${icon(s.icon)}</button>`).join('')}</span>`
      + (ed.shapeKind !== 'line' ? `<label class="check" style="min-height:40px"><input type="checkbox" id="o-filled" ${ed.shapeFilled ? 'checked' : ''}> Plein</label>` : '')
      + tramaControl() + popBtn('trama');
  } else if (t === 'mask') {
    html = `<span class="seg" role="group" aria-label="Effet du masque">
        <button data-mask="off" class="${ed.maskMode === 'off' ? 'on' : ''}">Sans effet</button>
        <button data-mask="in" class="${ed.maskMode === 'in' ? 'on' : ''}">Dans</button>
        <button data-mask="out" class="${ed.maskMode === 'out' ? 'on' : ''}">Hors</button></span>
      <span class="seg"><button data-maskpen="0" class="${!ed.maskErase ? 'on' : ''}" aria-label="Ajouter au masque">${icon('pencil')}</button>
        <button data-maskpen="1" class="${ed.maskErase ? 'on' : ''}" aria-label="Retirer du masque">${icon('eraser')}</button></span>`;
  } else if (t === 'bubble') {
    const b = bubble();
    html = ed.bubbleDraw
      ? `<span class="hint">Trace le contour de la bulle d'un seul geste.</span><button class="btn small" data-freebubble="0">Annuler</button>`
      : `<button class="swatch-btn tpl-btn ${popId === 'lib-bubble' ? 'on' : ''}" data-pop="lib-bubble" aria-expanded="${popId === 'lib-bubble'}" title="Modèle de bulle : ${esc(currentTemplate().name)}" aria-label="Choisir le modèle de bulle, actuel : ${esc(currentTemplate().name)}">${icon((BUBBLE_KINDS.find(k => k.id === currentTemplate().kind) || BUBBLE_KINDS[0]).icon)} <span>${esc(currentTemplate().name)}</span>${icon('chevron-down')}</button>
        <span class="row tight">
          <button class="icon-btn icon-only" data-freebubble="1" title="Dessiner une bulle à la main" aria-label="Dessiner une bulle à la main">${icon('writing')}</button></span>`
        + (b ? `<span class="hint">Barre sur la bulle : écrire, forme, queue, réglages.</span>`
          : `<span class="hint">Touche une case pour y poser une bulle, une bulle pour la régler.</span>`);
  } else if (t === 'layout') {
    const pn = panel(), idx = page().panels.indexOf(pn), ARROW = { left: 'arrow-left', right: 'arrow-right', up: 'arrow-up', down: 'arrow-down' };
    const pv = ed.addPreview && ed.addPreview.panelId === pn.id ? ed.addPreview : null;
    html = (pv
      ? `<span class="hint">Glisse la poignée sur la ligne pointillée pour régler la taille, puis ✓ pour ajouter (✕ ou un toucher ailleurs pour abandonner).</span>`
      : `<span class="hint">Glisse une gouttière, ou touche un « + » au bord de la case ${idx + 1} pour ajouter une case de ce côté.</span>`)
      + `<button class="btn small primary" data-openfocus="1">${icon('pencil')} Dessiner dans la case ${idx + 1}</button>`
      + mergeCandidates(pn).map(c => `<button class="btn small" data-merge="${c.id}" title="La case ${idx + 1} absorbe la case ${c.index + 1}">${icon(ARROW[c.dir])} Fusionner avec la ${c.index + 1}</button>`).join('')
      + (page().panels.length > 1 ? `<button class="btn small danger" data-delpanel="1">${icon('trash')} Supprimer la case</button>` : '');
  } else if (t === 'select') html = selectBar();
  else if (t === 'pan') {
    html = `<span class="hint">Fais glisser pour déplacer la page. Pincer pour zoomer.</span>`;
  }
  if (ed.maskMode !== 'off' && t !== 'mask' && t !== 'bubble' && t !== 'pan') {
    html += `<button class="btn small" data-mask="off" title="Désactiver le masque">${icon('mask')} Masque : ${ed.maskMode === 'in' ? 'dans' : 'hors'} ${icon('x')}</button>`;
  }
  o.hidden = !html; o.innerHTML = html;
  paintSwatches(o);
  paintSlots(o);
  paintBprev(o);
  renderQuick();
}

// ── Palette du projet : les pinceaux de l'outil, un toucher pour en changer ; toucher l'actif ouvre ses réglages ──
function paletteControl() {
  const list = brushSlots(), libOn = popId === 'lib-brush';
  return `<span class="palette" role="group" aria-label="Palette de pinceaux du projet">${list.map(s =>
    `<button class="slot ${s.id === ed.slotId ? 'on' : ''}" data-slot="${s.id}" aria-pressed="${s.id === ed.slotId}" title="${esc(s.name)}" aria-label="${esc(s.name)}${s.id === ed.slotId ? ' (actif : toucher pour ses réglages)' : ''}"><canvas width="56" height="28" data-slotprev="${s.id}"></canvas></button>`).join('')}<button class="slot add ${libOn ? 'on' : ''}" data-pop="lib-brush" aria-expanded="${libOn}" title="Ajouter un pinceau de la bibliothèque" aria-label="Ajouter un pinceau de la bibliothèque">${icon('plus')}</button></span>`;
}
function paintSlots(scope) {
  if (!scope) return;
  const dpi = ed.project ? ed.project.dpi : 300;
  $$('canvas[data-slotprev]', scope).forEach(c => {
    const s = brushSlots().find(x => x.id === c.dataset.slotprev);
    if (!s) return;
    const live = s.id === ed.slotId, spec = live ? ed.brushParams : { ...s.spec };
    const mm = live ? ed.sizeMm : s.sizeMm;
    const tid = ed.tool === 'pencil' ? (live ? ed.tramaId : s.tramaId) : null, t = tid ? tramaById(ed.project, tid) : null;
    previewBrush(c, spec, Math.max(2, Math.min(mm / 25.4 * dpi, 10)), live ? ed.alpha : s.alpha ?? 1, t && !t.solid ? t : null, 1);
  });
}

// ── Réglages rapides : taille et opacité en curseurs verticaux au bord du canevas, à portée du pouce ──
const QUICK = {
  size: { label: 'Taille', get: () => sizeToV(ed.sizeMm) / 100, set: v => setSizeMm(vToSize(v * 100)), fmt: () => fmtMm(ed.sizeMm) + ' mm',
    val: () => ed.sizeMm, toV: mm => sizeToV(mm) / 100, setVal: mm => setSizeMm(mm), say: mm => fmtMm(mm) + ' mm' },
  alpha: { label: 'Opacité', get: () => (ed.alpha - 0.05) / 0.95, set: v => setAlpha(0.05 + 0.95 * v), fmt: () => Math.round(ed.alpha * 100) + ' %',
    val: () => ed.alpha, toV: a => (a - 0.05) / 0.95, setVal: a => setAlpha(a), say: a => Math.round(a * 100) + ' %' },
};
// Aimant des repères, en pixels d'écran (pas en part de la course : un doigt est large quelle que soit la taille du curseur).
// On s'accroche à SNAP_IN du repère, on n'en décroche qu'à une fois et demie cette distance : le curseur colle, sans trembler à la limite.
const SNAP_IN = { touch: 16, pen: 10, mouse: 8 }, SNAP_OUT = 1.5, LONG_MS = 500;
const clamp01 = v => Math.max(0, Math.min(1, v));
const tickHtml = k => ticksOf()[k].map(t => `<i class="qs-tick" data-tick="${t}" style="bottom:${clamp01(QUICK[k].toV(t)) * 100}%"></i>`).join('');
const trackH = k => { const tr = $(`[data-quick="${k}"] .qs-track`, root); return (tr && tr.getBoundingClientRect().height) || 150; };
// Repère le plus proche de la position v (0–1) dans un rayon de `px` pixels ; celui déjà accroché a un rayon élargi.
function nearTick(k, v, px, held = null) {
  const h = trackH(k);
  let best = null, bd = Infinity;
  for (const t of ticksOf()[k]) {
    const d = Math.abs(clamp01(QUICK[k].toV(t)) - v) * h, rad = t === held ? px * SNAP_OUT : px;
    if (d <= rad && d < bd) { bd = d; best = t; }
  }
  return best;
}
// Appui long sur un curseur : pose un repère à la valeur touchée, ou retire celui qui s'y trouve.
function toggleTick(k) {
  const list = ticksOf()[k], v = QUICK[k].get(), t = nearTick(k, v, SNAP_IN.touch);
  if (t !== null) { list.splice(list.indexOf(t), 1); toast(`Repère ${QUICK[k].say(t)} retiré.`, { duration: 1400 }); }
  else { const val = +QUICK[k].val().toFixed(3); list.push(val); list.sort((a, b) => a - b); toast(`Repère posé à ${QUICK[k].say(val)} : le curseur s'y aimante.`, { duration: 1800 }); }
  const tr = $(`[data-quick="${k}"] .qs-track`, root);
  if (tr) { $$('.qs-tick', tr).forEach(x => x.remove()); tr.insertAdjacentHTML('beforeend', tickHtml(k)); }
  afterBrushChange();
}
function renderQuick() {
  const q = $('#quick', root);
  if (!q) return;
  const sized = BRUSH_TOOLS.includes(ed.tool) || ed.tool === 'mask' || ed.tool === 'shape', colored = TOOL_COLOR.includes(ed.tool);
  q.hidden = !sized && !colored;
  if (q.hidden) { q.innerHTML = ''; return; }
  const keys = [sized ? 'size' : null, colored ? 'color' : null, BRUSH_TOOLS.includes(ed.tool) ? 'alpha' : null].filter(Boolean);
  q.innerHTML = keys.map(k => k === 'color' ? colorWidget() : `<div class="qs" data-quick="${k}" role="slider" tabindex="0" aria-label="${QUICK[k].label}" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(QUICK[k].get() * 100)}" aria-valuetext="${QUICK[k].fmt()}">
      <div class="qs-track"><div class="qs-fill" style="height:${QUICK[k].get() * 100}%"></div>${tickHtml(k)}<div class="qs-thumb" style="bottom:${QUICK[k].get() * 100}%"></div></div>
      <span class="qs-val">${QUICK[k].fmt()}</span></div>`).join('');
}
function updateQuick(k) {
  const el = $(`[data-quick="${k}"]`, root);
  if (!el) return;
  const v = QUICK[k].get();
  el.querySelector('.qs-fill').style.height = v * 100 + '%';
  el.querySelector('.qs-thumb').style.bottom = v * 100 + '%';
  el.querySelector('.qs-val').textContent = QUICK[k].fmt();
  el.setAttribute('aria-valuenow', Math.round(v * 100)); el.setAttribute('aria-valuetext', QUICK[k].fmt());
}
// Aperçu du trait à côté du curseur, à sa taille réelle à l'écran (zoom compris), avec trame, opacité et couleur.
let qprevRaf = 0;
function showQprev(g) {
  const box = $('#qprev', root);
  if (!box || !BRUSH_TOOLS.includes(ed.tool) && ed.tool !== 'shape' && ed.tool !== 'mask') return;
  box.hidden = false; box.classList.add('on');
  const r = g.el.getBoundingClientRect(), wrap = box.parentElement.getBoundingClientRect();
  box.style.left = (r.right - wrap.left + 10) + 'px';
  cancelAnimationFrame(qprevRaf);
  qprevRaf = requestAnimationFrame(() => {
    const dpr = window.devicePixelRatio || 1, d = Math.max(1, ed.size * view.s);   // diamètre à l'écran
    const cw = 220, ch = Math.round(Math.max(56, Math.min(240, d * 1.9 + 24)));
    const cv = $('canvas', box);
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    const t = ed.tool === 'pencil' ? tramaById(ed.project, ed.tramaId) : null;
    const eraser = ed.tool === 'eraser';
    previewBrush(cv, ed.tool === 'mask' || ed.tool === 'shape' ? { ...ed.brushParams, shape: 'round', press: 0, start: 0, grainType: 'none', grain: 1, scatter: 0 } : ed.brushParams,
      Math.max(1, Math.round(d * dpr)), eraser ? 1 : ed.alpha, t && !t.solid ? t : null, Math.max(1, Math.round(ed.tramaScale * view.s * dpr)) || 1, eraser ? '#9A9A9A' : ed.color);
    $('span', box).textContent = g.k === 'alpha' ? QUICK.alpha.fmt() : QUICK.size.fmt();
    const top = Math.max(8, Math.min(wrap.height - ch - 30, (g.lastY ?? r.top + r.height / 2) - wrap.top - ch / 2));
    box.style.top = top + 'px';
  });
}
function hideQprev() { const box = $('#qprev', root); if (box) { box.classList.remove('on'); setTimeout(() => { if (!quickDrag) box.hidden = true; }, 180); } }

let quickDrag = null;
function quickDown(e) {
  const el = e.target.closest('[data-quick]');
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  try { el.setPointerCapture(e.pointerId); } catch { /* */ }
  const g = quickDrag = { el, k: el.dataset.quick, id: e.pointerId, x0: e.clientX, y0: e.clientY, type: e.pointerType, held: null };
  g.timer = setTimeout(() => { if (quickDrag === g) { g.long = true; toggleTick(g.k); } }, LONG_MS);
  el.classList.add('active');
  quickMove(e);
}

function quickMove(e) {
  const g = quickDrag;
  if (!g || e.pointerId !== g.id) return;
  if (g.timer && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 8) { clearTimeout(g.timer); g.timer = null; }   // le doigt glisse : pas d'appui long
  const r = g.el.querySelector('.qs-track').getBoundingClientRect(), v = clamp01((r.bottom - e.clientY) / r.height);
  const t = g.long ? null : nearTick(g.k, v, SNAP_IN[g.type] || SNAP_IN.touch, g.held);
  if (t !== null) QUICK[g.k].setVal(t); else QUICK[g.k].set(v);   // aimanté au repère proche : valeur exacte du repère
  if (t !== null && t !== g.held && navigator.vibrate) { try { navigator.vibrate(8); } catch { /* */ } }   // petit déclic (Android)
  g.held = t; g.lastY = e.clientY;
  showQprev(g);
  g.el.classList.toggle('snap', t !== null);
  $$('.qs-tick', g.el).forEach(x => x.classList.toggle('hit', t !== null && +x.dataset.tick === t));
  updateQuick(g.k);
  paintSlots($('#optbar', root));
}
function quickUp(e) {
  const g = quickDrag;
  if (!g || e.pointerId !== g.id) return;
  clearTimeout(g.timer);
  quickDrag = null; g.el.classList.remove('active', 'snap');
  hideQprev();
  $$('.qs-tick.hit', g.el).forEach(x => x.classList.remove('hit'));
  afterBrushChange();
}
function quickKey(e) {
  const el = e.target.closest('[data-quick]');
  if (!el || !/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const k = el.dataset.quick, d = /Up|Right/.test(e.key) ? 0.02 : -0.02;
  QUICK[k].set(Math.max(0, Math.min(1, QUICK[k].get() + d)));
  updateQuick(k); afterBrushChange();
}
// Après un réglage de pinceau : l'emplacement actif le garde, les aperçus suivent.
function afterBrushChange() {
  storeSlot(); savePrefs(); paintBprev($('#pop', root));
  paintSlots($('#optbar', root));
  const pe = $('#pop', root);
  if (pe && popId === 'brush') {
    const mm = $('#o-mm', pe); if (mm && document.activeElement !== mm) mm.value = +ed.sizeMm.toFixed(2);
    const al = $('#o-alpha', pe); if (al) { al.value = Math.round(ed.alpha * 100); al.previousElementSibling.textContent = `Opacité : ${Math.round(ed.alpha * 100)} %`; }
    syncPop();
  }
}


// Outil Sélection : forme, opération, déplacement du contenu.
const SEL_MODES = [['auto', 'wand', 'Automatique : la zone fermée touchée'], ['free', 'lasso', 'Main levée'], ['poly', 'lasso-polygon', 'Polygone : touche les sommets, touche le premier pour fermer'], ['rect', 'rectangle', 'Rectangle'], ['ellipse', 'circle', 'Ellipse']];
const SEL_OPS = [['new', 'replace', 'Nouvelle sélection'], ['add', 'plus', 'Ajouter à la sélection'], ['sub', 'minus', 'Retirer de la sélection']];
function selectBar() {
  const has = !!currentSelection(), seg = (name, list, cur) => `<span class="seg" role="group" aria-label="${name}">${list.map(([id, ic, label]) =>
    `<button data-sel${name === 'Forme' ? 'mode' : 'op'}="${id}" class="${cur === id ? 'on' : ''}" title="${label}" aria-label="${label}" aria-pressed="${cur === id}">${icon(ic)}</button>`).join('')}</span>`;
  const tog = (act, ic, label, on) => `<button class="icon-btn icon-only ${on ? 'on' : ''}" data-selact="${act}" title="${label}" aria-label="${label}" aria-pressed="${!!on}">${icon(ic)}</button>`;
  const hint = ed.selMove ? `Fais glisser pour déplacer ${has ? 'la sélection' : 'tout le contenu de la case'}.`
    : ed.selMode === 'poly' ? (polyCount() ? `${polyCount()} point${polyCount() > 1 ? 's' : ''} : touche le premier point pour fermer.` : 'Touche les sommets du polygone.')
    : has ? '' : 'Touche une zone ou trace-la.';
  return seg('Forme', SEL_MODES, ed.selMode) + seg('Opération', SEL_OPS, ed.selOp)
    + (ed.selMode === 'poly' && polyCount() ? `<button class="btn small" data-selact="polyok" ${polyCount() < 3 ? 'disabled' : ''}>${icon('check')} Fermer</button><button class="btn small" data-selact="polycancel">${icon('x')} Annuler</button>` : '')
    + `<span class="sep-v"></span>`
    + tog('move', 'arrows-move', 'Déplacer le contenu (sans sélection : tout le contenu de la case)', ed.selMove)
    + tog('scope', 'stack-2', ed.selScope === 'all' ? 'Déplace tous les calques (touche pour le calque actif seul)' : 'Déplace le calque actif seul (touche pour tous les calques)', ed.selScope === 'active')
    + tog('copy', 'copy', 'Copier au lieu de déplacer', ed.selCopy)
    + `<span class="sep-v"></span>`
    + `<button class="icon-btn icon-only" data-selact="all" title="Tout sélectionner (Ctrl+A)" aria-label="Tout sélectionner">${icon('select-all')}</button>`
    + `<button class="icon-btn icon-only" data-selact="invert" title="Inverser la sélection" aria-label="Inverser la sélection">${icon('switch-horizontal')}</button>`
    + `<button class="icon-btn icon-only" data-selact="clear" title="Effacer le contenu sélectionné" aria-label="Effacer le contenu sélectionné" ${has ? '' : 'disabled'}>${icon('eraser')}</button>`
    + `<button class="icon-btn icon-only" data-selact="none" title="Désélectionner (Échap)" aria-label="Désélectionner" ${has ? '' : 'disabled'}>${icon('square-off')}</button>`
    + (hint ? `<span class="hint">${hint}</span>` : '');
}
function onSelect(b) {
  const d = b.dataset;
  if (d.selmode) { polyCancel(); ed.selMode = d.selmode; ed.selMove = false; }
  else if (d.selop) ed.selOp = d.selop;
  else if (d.selact === 'move') { ed.selMove = !ed.selMove; polyCancel(); }
  else if (d.selact === 'scope') ed.selScope = ed.selScope === 'all' ? 'active' : 'all';
  else if (d.selact === 'copy') ed.selCopy = !ed.selCopy;
  else if (d.selact === 'all') { polyCancel(); selectAll(panel()); }
  else if (d.selact === 'invert') { polyCancel(); invertSelection(panel()); }
  else if (d.selact === 'none') { polyCancel(); clearSelection(); }
  else if (d.selact === 'polycancel') polyCancel();
  else if (d.selact === 'polyok') { if (!polyFinish()) toast('Il faut au moins trois points.'); }
  else if (d.selact === 'clear') eraseSelection();
  renderOptbar();
}
function eraseSelection() {
  const r = clearSelectionContent();
  if (r === 'ok') toast('Contenu effacé.', { actionLabel: 'Annuler', duration: 6000, onAction: undo });
  else if (r === 'locked') toast('Aucun calque visible et déverrouillé à effacer.');
  else if (r === 'empty') toast('Rien à effacer dans la sélection.', { duration: 1600 });
}

const POP_BTN = { brush: ['adjustments-horizontal', 'Réglages'], trama: ['adjustments-horizontal', 'Réglages'], btext: ['typography', 'Texte'], bshape: ['shape', 'Forme'], btail: ['message-circle-plus', 'Queue'] };
const popBtn = id => id === 'brush' || id === 'trama'
  ? `<button class="icon-btn icon-only ${popId === id ? 'on' : ''}" data-pop="${id}" aria-expanded="${popId === id}" title="Réglages" aria-label="Réglages">${icon('adjustments-horizontal')}</button>`
  : `<button class="btn small ${popId === id ? 'on' : ''}" data-pop="${id}" aria-expanded="${popId === id}">${icon(POP_BTN[id][0])} ${POP_BTN[id][1]}</button>`;

function paintSwatches(scope) {
  $$('canvas[data-swatch]', scope).forEach(c => {
    const t = tramaById(ed.project, c.dataset.swatch);
    drawTramaSwatch(c, t, t.solid ? 1 : Math.max(1, Math.min(3, ed.tramaScale)) );
  });
}

// ── Appui long sur un pinceau : le retirer (palette) ou le supprimer (« Mes pinceaux »), avec « Annuler » ──
let hold = null, swallowClick = null;   // l'élément dont il faut ignorer le clic qui suit l'appui long
function holdDown(e) {
  const el = e.target.closest('.slot[data-slot], .brush-row[data-brush], .cswatch[data-pal]');
  if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (el.dataset.brush && !(allBrushes().find(x => x.id === el.dataset.brush) || {}).custom) return;   // pinceaux livrés : pas de suppression
  clearTimeout(hold && hold.timer);
  hold = { el, x: e.clientX, y: e.clientY, id: e.pointerId };
  el.classList.add('holding');
  hold.timer = setTimeout(() => { const h = hold; hold = null; h.el.classList.remove('holding'); swallowClick = h.el; setTimeout(() => { swallowClick = null; }, 700); holdFire(h.el); }, 550);
}
function holdMove(e) { if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) holdCancel(); }
function holdCancel() { if (hold) { clearTimeout(hold.timer); hold.el.classList.remove('holding'); hold = null; } }
function holdFire(el) {
  if (el.dataset.pal) {
    const hex = el.dataset.pcolor, i = projectColors().indexOf(hex);
    if (!removeProjectColor(hex)) return;
    const pe = $('#pop', root); if (pe) pe._html = ''; renderPop();
    toast(`${hex} retiré de la palette.`, { actionLabel: 'Annuler', duration: 6000, onAction: () => { restoreProjectColor(hex, i); const p2 = $('#pop', root); if (p2) p2._html = ''; renderPop(); } });
    return;
  }
  if (el.dataset.slot) {
    const list = brushSlots(), i = list.findIndex(s => s.id === el.dataset.slot), slot = list[i];
    if (!slot) return;
    if (!removeSlot(slot.id)) { toast('La palette garde au moins un pinceau.'); return; }
    savePrefs(); renderOptbar(); renderPop();
    toast(`« ${slot.name} » retiré de la palette.`, { actionLabel: 'Annuler', duration: 6000, onAction: () => { restoreSlot(slot, i); applySlot(slot.id); savePrefs(); renderOptbar(); renderPop(); } });
  } else {
    const i = ed.customBrushes.findIndex(x => x.id === el.dataset.brush), br = ed.customBrushes[i];
    if (!br) return;
    deleteBrush(br.id); savePrefs(); const pe = $('#pop', root); if (pe) pe._html = ''; renderPop(); renderDock(); renderOptbar(); window.dispatchEvent(new Event('fusain:brushes'));
    toast(`« ${br.name} » supprimé de tes pinceaux.`, { actionLabel: 'Annuler', duration: 6000, onAction: () => { restoreBrush(br, i); savePrefs(); const p2 = $('#pop', root); if (p2) p2._html = ''; renderPop(); renderDock(); window.dispatchEvent(new Event('fusain:brushes')); } });
  }
}
function attachHold(el) {
  el.addEventListener('pointerdown', holdDown);
  el.addEventListener('pointermove', holdMove);
  el.addEventListener('pointerup', holdCancel);
  el.addEventListener('pointercancel', holdCancel);
  el.addEventListener('contextmenu', e => { if (e.target.closest('.slot, .brush-row, .cswatch')) e.preventDefault(); });
  el.addEventListener('click', e => { if (swallowClick && e.target.closest('.slot, .brush-row, .cswatch') === swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = null; } }, true);
}

function onOptbar(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.slot) {
    if (b.dataset.slot === ed.slotId) popId = popId === 'brush' ? null : 'brush';
    else { applySlot(b.dataset.slot); savePrefs(); if (popId === 'lib-brush') popId = null; }
    renderOptbar(); renderPop(); return;
  }
  if (b.dataset.openfocus) { setFocus(true); return; }
  if (b.dataset.selmode || b.dataset.selop || b.dataset.selact) onSelect(b);
  else if (b.dataset.shape) { ed.shapeKind = b.dataset.shape; savePrefs(); renderToolbar(); renderOptbar(); }
  else if (b.dataset.mask) { ed.maskMode = b.dataset.mask; renderOptbar(); requestRender(); }
  else if (b.dataset.merge) { if (mergePanels(panel().id, b.dataset.merge)) toast('Cases fusionnées.', { actionLabel: 'Annuler', onAction: undo }); }
  else if (b.dataset.split) { if (addCase([panel().id], b.dataset.split)) toast('Case ajoutée.', { actionLabel: 'Annuler', duration: 6000, onAction: undo }); else toast('Cette case est trop petite pour être coupée.'); }
  else if (b.dataset.delpanel) { if (deletePanel()) toast('Case supprimée.', { actionLabel: 'Annuler', duration: 8000, onAction: undo }); }
  else if (b.dataset.freebubble) { ed.bubbleDraw = b.dataset.freebubble === '1'; renderOptbar(); }
  else if (b.dataset.maskpen) { ed.maskErase = b.dataset.maskpen === '1'; savePrefs(); renderOptbar(); }
  else if (b.dataset.opt === 'pressure') { ed.pressure = !ed.pressure; savePrefs(); renderOptbar(); toast(ed.pressure ? 'Pression du stylet activée.' : 'Pression du stylet désactivée.', { duration: 1500 }); }
  else if (b.dataset.pop) { popId = popId === b.dataset.pop ? null : b.dataset.pop; renderOptbar(); renderPop(); }
  else if (b.dataset.addb) { addBubble(b.dataset.addb); popId = 'btext'; renderOptbar(); renderPop(); }
  else if (b.dataset.dupbubble) duplicateBubble();
  else if (b.dataset.delbubble) { const bb = bubble(); if (bb) { deleteBubble(bb); toast('Bulle supprimée.', { actionLabel: 'Annuler', duration: 7000, onAction: undo }); } }
}

function onOptInput(e) {
  const id = e.target.id;
  if (id === 'o-gap') { ed.fillGap = +e.target.value; const v = $('#o-gap-v', root); if (v) v.textContent = ed.fillGap + ' %'; savePrefs(); }
  else if (id === 'o-filled') { ed.shapeFilled = e.target.checked; savePrefs(); }
}

// ───────────────────────── Volet ─────────────────────────

function dockTabTo(id) { dockTab = id; renderDock(); }


// ── Sections repliables : le volet reste court ; l'état ouvert / fermé de chacune est gardé sur l'appareil ──
const SEC_KEY = 'fusain:sections';
let secState = {};
try { secState = JSON.parse(localStorage.getItem(SEC_KEY)) || {}; } catch { /* */ }
const sec = (id, title, body, def = true, extra = '') =>
  `<details class="sec" data-sec="${id}" ${(secState[id] ?? def) ? 'open' : ''}><summary><span>${title}</span>${extra}</summary><div class="sec-body">${body}</div></details>`;
// Glisser une ligne de calque (ou de bulle) vers la gauche découvre « Dupliquer » et « Supprimer », comme dans Procreate.
// Glisser-déposer des calques : la poignée à gauche de la ligne ; la ligne suit le doigt, un trait rouge montre où elle ira.
let gripGest = null;
function gripRows() { return $$('.swipe', root).filter(w => w.querySelector('[data-layer]')); }
// Glisser une ligne par sa poignée : les autres lignes s'écartent en direct pour montrer où elle tombera.
// Les positions sont mesurées au départ (une seule fois) : le décalage des cartes ne fausse pas le calcul.
function gripDown(e) {
  const g = e.target.closest && e.target.closest('[data-grip]');
  if (!g) return false;
  const wrap = g.closest('.swipe');
  e.preventDefault(); g.setPointerCapture(e.pointerId);
  gripGest = { id: e.pointerId, wrap, layer: g.dataset.grip, y0: e.clientY, on: false, drop: null };
  return true;
}
function gripStart(s) {
  const opts = $('.lopts', root);
  if (opts) { opts.style.display = 'none'; s.opts = opts; }   // options repliées le temps du geste
  s.rows = gripRows();
  s.i0 = s.rows.indexOf(s.wrap);
  s.rects = s.rows.map(w => w.getBoundingClientRect());
  const r = s.rects[s.i0], next = s.rects[s.i0 + 1], prev = s.rects[s.i0 - 1];
  s.step = next ? next.top - r.top : prev ? r.top - prev.top : r.height + 4;   // hauteur d'une ligne, marge comprise
  s.rows.forEach(w => { if (w !== s.wrap) w.classList.add('shifting'); });
  s.wrap.classList.add('reordering');
}
function gripMove(e) {
  const s = gripGest;
  if (!s || e.pointerId !== s.id) return;
  const dy = e.clientY - s.y0;
  if (!s.on) { if (Math.abs(dy) < 6) return; s.on = true; gripStart(s); }
  const r0 = s.rects[s.i0], first = s.rects[0], last = s.rects[s.rects.length - 1];
  const ddy = Math.max(first.top - r0.top, Math.min(last.top - r0.top, dy));   // la carte reste dans la liste
  s.wrap.style.transform = `translateY(${ddy}px)`;
  // nouvelle place : le centre de la carte tirée, comparé aux centres d'origine des autres
  const c = r0.top + r0.height / 2 + ddy;
  let to = 0;
  s.rects.forEach((r, k) => { if (k !== s.i0 && r.top + r.height / 2 < c) to++; });
  s.drop = to;
  s.rows.forEach((w, k) => {
    if (k === s.i0) return;
    const shift = k > s.i0 && k <= to ? -s.step : k < s.i0 && k >= to ? s.step : 0;
    w.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}
function gripUp(e, cancel) {
  const s = gripGest;
  if (!s || e.pointerId !== s.id) return;
  gripGest = null;
  if (!s.on) return;
  s.rows.forEach(w => { w.classList.remove('shifting', 'reordering'); w.style.transform = ''; });
  if (s.opts) s.opts.style.display = '';
  swipeJustDone = true; setTimeout(() => { swipeJustDone = false; }, 80);
  if (cancel || s.drop === null || s.drop === s.i0) return;
  moveLayerTo(s.layer, panel().layers.length - 1 - s.drop);   // la liste est affichée à l'envers (le dernier calque est en haut)
}

let swipeGest = null, swipeJustDone = false;
function swipeDown(e) {
  const row = e.target.closest('.swipe > .layer');
  if (!row || e.button > 0) return;
  $$('.swipe.open', root).forEach(x => { if (x !== row.parentElement) x.classList.remove('open'); });
  swipeGest = { row, wrap: row.parentElement, x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId, width: row.parentElement.querySelector('.swipe-actions').offsetWidth };
}
function swipeMove(e) {
  const g = swipeGest;
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (!g.on) {
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { swipeGest = null; return; }   // c'est un défilement vertical
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;
    g.on = true; g.row.setPointerCapture(e.pointerId); g.wrap.classList.add('dragging');
  }
  const base = g.wrap.classList.contains('open') ? -g.width : 0;
  g.dx = Math.max(-g.width - 20, Math.min(0, base + dx));
  g.row.style.transform = `translateX(${g.dx}px)`;
}
function swipeUp(e) {
  const g = swipeGest;
  if (!g || e.pointerId !== g.id) return;
  swipeGest = null;
  if (!g.on) return;
  g.wrap.classList.remove('dragging'); g.row.style.transform = '';
  g.wrap.classList.toggle('open', g.dx < -g.width * 0.45);
  swipeJustDone = true; setTimeout(() => { swipeJustDone = false; }, 80);   // le relâchement ne doit pas compter comme un toucher
}

function onSecToggle(e) {
  const el = e.target;
  if (!el.matches || !el.matches('details[data-sec]')) return;
  secState[el.dataset.sec] = el.open;
  try { localStorage.setItem(SEC_KEY, JSON.stringify(secState)); } catch { /* */ }
}


export function renderDock() {
  const d = $('#dock', root);
  if (!d || !ed.project) return;
  const prevScroll = $('.dock-body', d) ? $('.dock-body', d).scrollTop : 0;
  const foot = `<div class="dock-foot">
    ${canFullscreen() ? `<button class="icon-btn icon-only" data-act="foot-fs" title="Plein écran : masque la barre du navigateur" aria-label="Plein écran" aria-pressed="${isFullscreen()}">${icon(isFullscreen() ? 'arrows-minimize' : 'arrows-maximize')}</button>` : ''}
    ${narrow() ? `<button class="icon-btn icon-only" data-act="foot-dock" title="Masquer le panneau" aria-label="Masquer le panneau">${icon('layout-sidebar-right-collapse')}</button>`
      : dockOpen ? `<button class="icon-btn icon-only" data-act="dock-mini" title="Réduire aux vignettes des calques" aria-label="Réduire le panneau">${icon('layout-sidebar-right-collapse')}</button>`
      : `<button class="icon-btn icon-only" data-act="dock-full" title="Agrandir le panneau" aria-label="Agrandir le panneau">${icon('layout-sidebar-right-expand')}</button>`}
    ${narrow() ? '' : `<button class="icon-btn icon-only" data-act="dock-hide" title="Masquer le panneau" aria-label="Masquer le panneau">${icon('x')}</button>`}</div>`;
  dockTab = ed.focus ? 'layers' : 'page';
  if (!dockOpen && !dockMini) { d.innerHTML = ''; return; }
  d.innerHTML = dockOpen ? `<div class="dock-body" aria-label="${dockTab === 'layers' ? 'Calques de la case' : 'Page'}">${({ layers: () => layersTab() + caseDrawTab(), page: pageTab })[dockTab]()}</div>${foot}`
    : `<div class="dock-mini" aria-label="${dockTab === 'layers' ? 'Calques de la case' : 'Pages'}">${dockTab === 'layers' ? miniLayers() : miniPages()}</div>${foot}`;
  if (dockOpen) { $('.dock-body', d).scrollTop = prevScroll; paintSwatches(d); }
  if (dockMini) paintMiniThumbs(d);
  renderPop();
}

// ── Volet réduit : une vignette par calque (le plus haut en premier) ; toucher = calque actif, œil = afficher / masquer ──
function miniLayers() {
  const p = panel();
  return `<button class="mini-add" data-act="add-layer" title="Nouveau calque" aria-label="Nouveau calque">${icon('plus')}</button>`
    + [...p.layers].reverse().map(l => `<div class="mini-layer ${l.id === p.active ? 'on' : ''} ${l.visible ? '' : 'off'}" data-layer="${l.id}">
      <button class="mini-thumb" data-act="select-layer" title="${esc(l.name)}" aria-label="Calque ${esc(l.name)}${l.id === p.active ? ' (actif)' : ''}" aria-pressed="${l.id === p.active}"><canvas width="104" height="104" data-mthumb="${l.id}"></canvas>
        <span class="mini-badges">${l.reference ? `<i class="ti ti-target" title="Référence"></i>` : ''}${l.alphaLock ? '<b title="Alpha verrouillé">α</b>' : ''}${l.locked ? `<i class="ti ti-lock" title="Verrouillé"></i>` : ''}${l.kind === 'draft' ? `<i class="mini-draft" style="background:rgb(${DRAFT_COLORS[l.color || 'blue'].rgb.join(',')})" title="Brouillon"></i>` : ''}</span></button>
      <button class="mini-eye" data-act="vis" aria-label="${l.visible ? 'Masquer' : 'Afficher'} le calque ${esc(l.name)}">${icon(l.visible ? 'eye' : 'eye-off')}</button></div>`).join('');
}
function miniPages() {
  return ed.project.pages.map((pg, i) => `<button class="mini-page ${i === ed.pageIdx ? 'on' : ''}" data-mpage="${i}" aria-label="Page ${i + 1}" aria-pressed="${i === ed.pageIdx}">${i + 1}</button>`).join('');
}
// Vignette d'un calque : la partie visible de la case, réduite en gardant les traits fins (un pixel de vignette = le plus encré de son bloc).
function paintMiniThumbs(scope) {
  const p = panel();
  $$('canvas[data-mthumb]', scope).forEach(c => {
    const l = p.layers.find(x => x.id === c.dataset.mthumb);
    const cx = c.getContext('2d'), W = c.width, H = c.height, img = cx.createImageData(W, H), out = new Uint32Array(img.data.buffer);
    out.fill(0xFFFFFFFF);
    if (l && l.data) {
      const ox = p.x - p.ex, oy = p.y - p.ey, k = Math.max(p.w / W, p.h / H), b = bppOf(l), dx = (W - p.w / k) / 2, dy = (H - p.h / k) / 2;
      const ink = l.kind === 'draft' ? (DRAFT_COLORS[l.color || 'blue'].rgb) : [26, 23, 20], step = Math.max(1, Math.floor(k / 4));
      for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
        const sx0 = Math.floor((tx - dx) * k), sy0 = Math.floor((ty - dy) * k);
        if (sx0 < 0 || sy0 < 0 || sx0 >= p.w || sy0 >= p.h) { out[ty * W + tx] = 0xFFEEEEEE; continue; }
        let hit = null;
        for (let yy = sy0; yy < Math.min(p.h, sy0 + k) && !hit; yy += step) for (let xx = sx0; xx < Math.min(p.w, sx0 + k); xx += step) {
          const i = (oy + yy) * l.w + ox + xx;
          if (b === 4) { if (l.data[i * 4 + 3] > 40) { hit = [l.data[i * 4], l.data[i * 4 + 1], l.data[i * 4 + 2]]; break; } }
          else if (l.data[i] === 1) { hit = ink; break; }
        }
        if (hit) out[ty * W + tx] = (0xFF000000 | (hit[2] << 16) | (hit[1] << 8) | hit[0]) >>> 0;
      }
      // un trait fin réduit tient sur un pixel : on l'épaissit d'un pixel pour qu'il se voie dans la vignette
      const src = out.slice();
      for (let ty = 0; ty < H - 1; ty++) for (let tx = 0; tx < W - 1; tx++) {
        const v = src[ty * W + tx];
        if (v === 0xFFFFFFFF || v === 0xFFEEEEEE) continue;
        for (const j of [ty * W + tx + 1, (ty + 1) * W + tx, (ty + 1) * W + tx + 1]) if (src[j] === 0xFFFFFFFF) out[j] = v;
      }
    }
    cx.putImageData(img, 0, 0);
  });
}
let miniTimer = null;
function refreshMiniSoon() { if (!dockMini) return; clearTimeout(miniTimer); miniTimer = setTimeout(() => { const d = $('#dock', root); if (d && dockMini) paintMiniThumbs(d); }, 350); }

// Liste déroulante de l'outil Bulle : modèles du programme puis « Mes modèles » ; un toucher sur la page y pose une bulle de ce modèle.
function bubbleTplList() {
  const all = allBubbleTemplates(), cust = all.filter(t => t.id.startsWith('bt')), std = all.filter(t => !t.id.startsWith('bt'));
  const ic = t => icon((BUBBLE_KINDS.find(k => k.id === t.kind) || BUBBLE_KINDS[0]).icon);
  const row = t => `<div class="row tight" style="margin-bottom:4px"><button class="btn ${t.id === ed.bubbleTemplate ? 'primary' : ''}" data-tpl="${t.id}" style="flex:1;justify-content:flex-start">${ic(t)} ${esc(t.name)}</button>${t.id.startsWith('bt') ? `<button class="icon-btn icon-only" data-tpldel="${t.id}" aria-label="Supprimer le modèle ${esc(t.name)}">${icon('trash')}</button>` : ''}</div>`;
  return std.map(row).join('')
    + (cust.length ? sec('btpl', 'Mes modèles', cust.map(row).join(''), true) : '')
    + `<div class="row tight" style="margin:8px 0 2px"><button class="btn small primary" data-act="tpl-save" ${bubble() ? '' : 'disabled'}>${icon('device-floppy')} Enregistrer la bulle sélectionnée…</button></div>
       <small class="note">Touche une case avec l'outil Bulle pour y poser une bulle du modèle choisi.</small>`;
}

// Réglages détaillés de l'outil : fenêtre flottante au-dessus de la barre du bas, jamais dans le volet.
const TOOL_TRAMA = ['pencil', 'fill', 'shape'];
const TOOL_COLOR = ['pencil', 'fill', 'shape'];

// ── Couleurs : deux couleurs (principale, secondaire) dans le widget entre les deux curseurs de gauche ──
const HEXRE = /^#[0-9a-f]{6}$/i;
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
function hsv2rgb({ h, s, v }) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
// Teinte gardée à part : un gris (saturation nulle) ne doit pas faire perdre la teinte choisie dans le sélecteur.
let pick = null;
const pickState = () => {
  const cur = rgb2hsv(hex2rgb(ed.color));
  if (!pick || rgb2hex(hsv2rgb(pick)) !== ed.color) pick = cur.s === 0 && pick ? { ...cur, h: pick.h } : cur;
  return pick;
};
// Harmonies : même saturation et luminosité, teintes voisines (±30°), triade (±120°), complémentaires (180°, 150°, 210°).
const harmoniesOf = hex => { const c = rgb2hsv(hex2rgb(hex)); return [-30, 30, 120, 240, 150, 180, 210].map(d => rgb2hex(hsv2rgb({ ...c, h: (c.h + d + 360) % 360 }))); };
// Nuances immédiates de la couleur : trois plus sombres, elle, trois plus claires.
const shadesOf = hex => { const c = hex2rgb(hex); return [-0.6, -0.4, -0.2, 0, 0.25, 0.5, 0.75].map(t => rgb2hex(c.map(v => (t < 0 ? v * (1 + t) : v + (255 - v) * t)))); };

function colorWidget() {
  return `<div class="cw" role="group" aria-label="Couleurs">
      <button class="cw-sec" data-cw="swap" style="background:${ed.color2}" title="Couleur secondaire ${ed.color2} : toucher pour l'échanger" aria-label="Couleur secondaire ${ed.color2}, toucher pour l'échanger"></button>
      <button class="cw-pri ${popId === 'color' ? 'open' : ''}" data-cw="open" style="background:${ed.color}" title="Couleur ${ed.color} : toucher pour la palette" aria-label="Couleur ${ed.color}, toucher pour la palette" aria-expanded="${popId === 'color'}"></button>
      <button class="cw-swap" data-cw="swap" title="Échanger les deux couleurs (X)" aria-label="Échanger les deux couleurs">${icon('arrows-exchange')}</button>
      <button class="cw-reset" data-cw="reset" title="Noir et blanc (D)" aria-label="Revenir au noir et au blanc"><i></i><i></i></button></div>`;
}
function updateColorWidget() {
  const q = $('#quick', root);
  if (!q) return;
  const p = $('[data-cw="open"]', q), s = $('.cw-sec', q);
  if (p) { p.style.background = ed.color; p.setAttribute('aria-label', `Couleur ${ed.color}, toucher pour la palette`); p.classList.toggle('open', popId === 'color'); p.setAttribute('aria-expanded', popId === 'color'); }
  if (s) s.style.background = ed.color2;
}
// ColorDrop : la couleur principale, tirée hors du widget et lâchée sur le dessin, remplit la zone sous le doigt.
let cdrag = null, cdragSwallow = false;
function cdropDown(e) {
  const b = e.target.closest('[data-cw="open"]');
  if (!b || !ed.focus) return;
  cdrag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, b };
  try { b.setPointerCapture(e.pointerId); } catch { /* */ }
}
function cdropMove(e) {
  const g = cdrag;
  if (!g || e.pointerId !== g.id) return;
  if (!g.on && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 12) {
    g.on = true; g.ghost = document.createElement('div'); g.ghost.className = 'cdrop'; g.ghost.style.background = ed.color; document.body.append(g.ghost);
  }
  if (g.on) { g.ghost.style.left = e.clientX + 'px'; g.ghost.style.top = e.clientY + 'px'; }
}
function cdropUp(e) {
  const g = cdrag;
  if (!g || e.pointerId !== g.id) return;
  cdrag = null;
  if (!g.on) return;
  g.ghost.remove(); cdragSwallow = true; setTimeout(() => { cdragSwallow = false; }, 400);
  if (e.type !== 'pointerup') return;
  const v = $('#view', root), r = v.getBoundingClientRect();
  if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) return;
  const q = toPage(e.clientX - r.left, e.clientY - r.top), layer = colorDrop({ x: q.x, y: q.y });
  if (layer) toast(`Couleur posée dans « ${layer.name} ».`, { actionLabel: 'Annuler', duration: 4000, onAction: undo });
  else toast('Lâche la couleur dans une zone fermée de la case.');
}

function onQuickClick(e) {
  if (cdragSwallow) { cdragSwallow = false; return; }
  const b = e.target.closest('[data-cw]');
  if (!b) return;
  const a = b.dataset.cw;
  if (a === 'open') popId = popId === 'color' ? null : 'color';
  else if (a === 'swap') swapColors();
  else if (a === 'reset') resetColors();
  savePrefs(); updateColorWidget(); renderOptbar(); renderPop();
}

function colorPop() {
  const list = projectColors(), inPal = list.includes(ed.color);
  const sw = (c, pal) => `<button class="cswatch ${c === ed.color ? 'on' : ''}" data-pcolor="${c}" ${pal ? 'data-pal="1"' : ''} style="background:${c}" aria-label="Couleur ${c}${pal ? ' (appui long : retirer de la palette)' : ''}" title="${c}"></button>`;
  return `<div class="cpk">
      <canvas class="cpk-sv" data-hsv="sv" width="240" height="140" aria-label="Saturation et luminosité"></canvas>
      <canvas class="cpk-h" data-hsv="h" width="240" height="18" aria-label="Teinte"></canvas></div>
    <div class="row tight cpk-row">
      <span class="cpk-now" style="background:${ed.color}"></span>
      <input type="text" id="c-hex" class="cpk-hex" value="${ed.color}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Code de la couleur">
      <button class="icon-btn icon-only" data-act="pick-color" title="Pipette : prendre une couleur du dessin" aria-label="Pipette : prendre une couleur du dessin">${icon('color-picker')}</button>
      ${inPal ? '' : `<button class="btn small" data-act="color-add" title="Ajouter à la palette du projet">${icon('plus')} Palette</button>`}</div>
    <div class="clabel">Nuances</div><div class="cshades">${shadesOf(ed.color).map(c => `<button class="cswatch ${c === ed.color ? 'on' : ''}" data-pcolor="${c}" style="background:${c}" aria-label="Nuance ${c}" title="${c}"></button>`).join('')}</div>
    ${rgb2hsv(hex2rgb(ed.color)).s > 0.05 ? `<div class="clabel">Harmonies <span class="clabel-sub">voisines · triade · complémentaires</span></div><div class="cshades">${harmoniesOf(ed.color).map(c => `<button class="cswatch" data-pcolor="${c}" style="background:${c}" aria-label="Harmonie ${c}" title="${c}"></button>`).join('')}</div>` : ''}
    <div class="cpals" role="tablist" aria-label="Palettes du projet">${projectPalettes().map(pl => `<button role="tab" class="cpal ${pl.id === currentPalette().id ? 'on' : ''}" data-palid="${pl.id}" aria-selected="${pl.id === currentPalette().id}">${esc(pl.name)}</button>`).join('')}<button class="cpal add" data-act="pal-new" aria-label="Nouvelle palette" title="Nouvelle palette">${icon('plus')}</button></div>
    <div class="row tight cpal-acts"><button class="btn small" data-act="pal-rename">${icon('pencil')} Renommer</button>${projectPalettes().length > 1 ? `<button class="btn small" data-act="pal-del">${icon('trash')} Supprimer la palette</button>` : ''}</div><div class="cgrid" role="group" aria-label="Couleurs du projet">${list.map(c => sw(c, true)).join('')}<button class="cswatch add" data-act="color-add" aria-label="Ajouter la couleur actuelle à la palette" title="Ajouter la couleur actuelle">${icon('plus')}</button></div>
    ${ed.recentColors.length ? `<div class="clabel">Récentes</div><div class="cgrid">${ed.recentColors.map(c => sw(c, false)).join('')}</div>` : ''}
    <small class="note">Appui long sur une couleur de la palette pour la retirer. La couleur s'applique au pinceau, au remplissage et aux formes, dans leur calque.</small>`;
}
// Dessin du sélecteur : carré saturation × luminosité, bande des teintes, repères.
function paintPicker(scope) {
  const sv = $('canvas[data-hsv="sv"]', scope), hb = $('canvas[data-hsv="h"]', scope);
  if (!sv || !hb) return;
  const st = pickState();
  let c = sv.getContext('2d'), w = sv.width, h = sv.height;
  c.fillStyle = rgb2hex(hsv2rgb({ h: st.h, s: 1, v: 1 })); c.fillRect(0, 0, w, h);
  let g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h);
  g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000'); c.fillStyle = g; c.fillRect(0, 0, w, h);
  const mx = st.s * w, my = (1 - st.v) * h;
  c.lineWidth = 2; c.strokeStyle = '#fff'; c.beginPath(); c.arc(mx, my, 7, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = '#000'; c.beginPath(); c.arc(mx, my, 9, 0, Math.PI * 2); c.stroke();
  c = hb.getContext('2d'); w = hb.width; h = hb.height;
  g = c.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, rgb2hex(hsv2rgb({ h: i * 60, s: 1, v: 1 })));
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  const hx = st.h / 360 * w;
  c.lineWidth = 3; c.strokeStyle = '#fff'; c.strokeRect(hx - 3, 1, 6, h - 2); c.lineWidth = 1; c.strokeStyle = '#000'; c.strokeRect(hx - 4.5, 0.5, 9, h - 1);
}
let pickDrag = null;
function pickerDown(e) {
  const cv = e.target.closest('canvas[data-hsv]');
  if (!cv) return;
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
  pickDrag = { cv, id: e.pointerId };
  pickerMove(e);
}
function pickerMove(e) {
  const g = pickDrag;
  if (!g || e.pointerId !== g.id) return;
  const r = g.cv.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  const st = pickState();
  if (g.cv.dataset.hsv === 'sv') { st.s = x; st.v = 1 - y; } else st.h = Math.min(359.9, x * 360);
  setColor(rgb2hex(hsv2rgb(st)), false);
  const pe = $('#pop', root);
  paintPicker(pe); updateColorWidget();
  const now = $('.cpk-now', pe), hx = $('#c-hex', pe);
  if (now) now.style.background = ed.color;
  if (hx && document.activeElement !== hx) hx.value = ed.color;
}
function pickerUp(e) {
  if (!pickDrag || e.pointerId !== pickDrag.id) return;
  pickDrag = null;
  setColor(ed.color); savePrefs();
  const pe = $('#pop', root); if (pe) pe._html = '';
  renderPop();
}
// Appui long d'un doigt sur le dessin (pinceau, remplissage, formes) : pipette directe.
function onLongPress(sx, sy, undoDot) {
  if (!TOOL_COLOR.includes(ed.tool)) return false;
  undoDot();
  const hex = colorAt(sx, sy);
  if (!hex) return false;
  setColor(hex); savePrefs(); updateColorWidget();
  if (popId === 'color') { const pe = $('#pop', root); if (pe) pe._html = ''; renderPop(); }
  toast(`Couleur prise : ${hex}`, { duration: 1400 });
  return true;
}
// Pipette : le prochain toucher sur le dessin prend sa couleur.
function pickFromCanvas(e) {
  if (!ed.picking || e.target.id !== 'view') return false;
  e.stopPropagation(); e.preventDefault();
  ed.picking = false;
  const r = e.target.getBoundingClientRect(), hex = colorAt(e.clientX - r.left, e.clientY - r.top);
  if (hex) { setColor(hex); savePrefs(); updateColorWidget(); toast(`Couleur prise : ${hex}`, { duration: 1400 }); }
  return true;
}

function renderPop() {
  const el = $('#pop', root);
  if (!el || !ed.project) return;
  const bubbleOnly = /^b(text|shape|tail)$/.test(popId || '');
  if (popId === 'color' && !TOOL_COLOR.includes(ed.tool)) popId = null;
  if (popId && ((bubbleOnly && (!bubble() || ed.tool !== 'bubble')) || (/brush$/.test(popId) && !['pencil', 'eraser'].includes(ed.tool)) || (popId === 'lib-bubble' && ed.tool !== 'bubble') || (/trama$/.test(popId) && !TOOL_TRAMA.includes(ed.tool)))) popId = null;
  if (!popId) { el.hidden = true; el.innerHTML = ''; el.dataset.id = ''; el._html = ''; return; }
  const a = document.activeElement;
  if (el.dataset.id === popId && el.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'))) return;   // on ne reconstruit pas sous les doigts qui tapent
  const html = popHtml();
  if (el.dataset.id === popId && el._html === html) { el.hidden = false; return; }   // rien n'a changé : un bouton qu'on touche ne doit pas disparaître
  const top = el.querySelector('.pop-body'), keep = top && el.dataset.id === popId ? top.scrollTop : 0;
  el.dataset.id = popId; el.hidden = false; el._html = html;
  el.innerHTML = html;
  $('.pop-body', el).scrollTop = keep;
  paintSwatches(el); paintLibrary(el); paintPicker(el);
  paintBprev(el);
}
function paintLibrary(scope) {
  paintBrushPreviews(scope);
  $$('canvas[data-tcell]', scope).forEach(c => drawTramaSwatch(c, tramaById(ed.project, c.dataset.tcell), 2));
}
// Après une frappe ou un curseur, le contenu affiché est déjà à jour : on le note pour ne pas reconstruire la fenêtre au relâchement.
function syncPop() { const el = $('#pop', root); if (el && popId && el.dataset.id === popId) el._html = popHtml(); }
function popHtml() {
  const b = bubble();
  const [title, body] = {
    brush: [esc((activeSlot() || currentBrush()).name), brushPop], 'lib-brush': ['Ajouter à la palette', () => brushesTab()], color: ['Couleur', colorPop], 'lib-bubble': ['Modèles de bulles', bubbleTplList], 'lib-trama': ['Trames', () => tramasTab()], trama: [`Trame · ${esc(tramaById(ed.project, ed.tramaId).name)}`, tramaPop],
    btext: ['Texte de la bulle', () => bubbleText(b)], bshape: ['Forme de la bulle', () => bubbleShape(b)], btail: ['Queue de la bulle', () => bubbleTail(b)],
  }[popId];
  return `<div class="pop-head"><b>${title}</b><button class="icon-btn icon-only" data-act="pop-close" aria-label="Fermer">${icon('x')}</button></div><div class="pop-body">${body()}</div>`;
}

function pageTab() { return pagesTab() + caseTab(); }

function layersTab() {
  const p = panel(), idx = page().panels.indexOf(p), cur = activeLayer(p), pg = page();
  // étiquette : brouillon = pastille de sa couleur ; trame = « trame » ; un calque passé en couleur a l'étiquette en accent
  // seul le brouillon se signale (pastille de sa couleur) : les autres calques sont tous pareils
  const dotc = l => l.kind === 'draft'
    ? `<i class="ldot" style="background:rgb(${DRAFT_COLORS[l.color || 'blue'].rgb.join(',')})" title="Brouillon ${DRAFT_COLORS[l.color || 'blue'].name.toLowerCase()}"></i>` : '';
  const BICON = { parole: 'message-circle', pensee: 'cloud', cri: 'bolt', narration: 'square', texte: 'typography' };
  const swipe = (inner, acts) => `<div class="swipe">${inner}<div class="swipe-actions">${acts}</div></div>`;
  linkBubbles(pg);
  const caseBubbles = pg.bubbles.filter(b => b.panel === p.id);
  const bubRows = caseBubbles.map(b => swipe(`<div class="layer ${b.id === ed.bubbleId ? 'on' : ''}" data-bub="${b.id}">
      <button class="icon-btn icon-only" data-act="bub-vis" aria-label="${b.hidden ? 'Afficher' : 'Masquer'} la bulle">${icon(b.hidden ? 'eye-off' : 'eye')}</button>
      <button class="name" data-act="bub-select">${icon(BICON[b.kind] || 'message-circle')} ${esc(b.text || '(vide)')}</button>
      <button class="icon-btn icon-only" data-act="bub-lock" aria-label="${b.locked ? 'Déverrouiller' : 'Verrouiller'} la bulle">${icon(b.locked ? 'lock' : 'lock-open')}</button>
      <button class="icon-btn icon-only" data-act="bub-del" aria-label="Supprimer la bulle">${icon('x')}</button></div>`, `<button data-act="swipe-bub-dup" data-for="${b.id}">${icon('copy')} Dupliquer</button><button class="danger" data-act="swipe-bub-del" data-for="${b.id}">${icon('trash')} Supprimer</button>`)).join('');
  if (layerOpts && !p.layers.some(l => l.id === layerOpts && l.id === p.active)) layerOpts = null;
  const rows = [...p.layers].reverse().map(l => swipe(`<div class="layer ${l.id === p.active ? 'on' : ''} ${l.alphaLock ? 'alpha-locked' : ''} ${layerOpts === l.id ? 'open' : ''}" data-layer="${l.id}">
      <span class="grip" data-grip="${l.id}" role="button" aria-label="Déplacer le calque ${esc(l.name)} (glisser-déposer)" title="Glisser pour changer l'ordre">${icon('grip-vertical')}</span>
      <button class="icon-btn icon-only" data-act="vis" aria-label="${l.visible ? 'Masquer' : 'Afficher'} le calque ${esc(l.name)}">${icon(l.visible ? 'eye' : 'eye-off')}</button>
      <button class="name" data-act="select-layer" aria-expanded="${layerOpts === l.id}" title="${l.id === p.active ? 'Toucher pour les options du calque' : 'Toucher pour choisir ce calque'}">${esc(l.name)}${l.blend && l.blend !== 'normal' ? ` <small class="lblend">${(BLEND_MODES.find(m => m[0] === l.blend) || ['', ''])[1]}</small>` : ''}</button>
      ${l.reference ? `<span class="tag ref" title="Calque de référence">${icon('target')} réf.</span>` : ''}${l.alphaLock ? `<span class="tag alpha" title="Alpha verrouillé">α</span>` : ''}${dotc(l)}${l.opacity < 100 ? `<span class="tag" style="color:var(--text-muted)">${l.opacity} %</span>` : ''}
      <button class="icon-btn icon-only" data-act="lock" aria-label="${l.locked ? 'Déverrouiller' : 'Verrouiller'} le calque ${esc(l.name)}">${icon(l.locked ? 'lock' : 'lock-open')}</button></div>`,
    `<button data-act="swipe-dup" data-for="${l.id}">${icon('copy')} Dupliquer</button><button class="danger" data-act="swipe-del" data-for="${l.id}">${icon('trash')} Supprimer</button>`) + (layerOpts === l.id ? layerOptions(l) : '')).join('');
  const acts = `<div class="tools-row">
      <button class="btn small" data-act="add-layer">${icon('plus')} Calque</button>
      <button class="btn small" data-act="add-draft">${icon('plus')} Brouillon</button></div>
    <small class="note">Touche le calque actif pour ses options.</small>`;
  const eye = `<button class="icon-btn icon-only sec-eye" data-act="bubs-vis" aria-label="${pg.bubblesHidden ? 'Afficher' : 'Masquer'} toutes les bulles">${icon(pg.bubblesHidden ? 'eye-off' : 'eye')}</button>`;
  return sec('bubs', `Case ${idx + 1} · bulles et textes · ${caseBubbles.length}`, bubRows || '<small class="note">Aucune bulle dans cette case.</small>', caseBubbles.length > 0, eye)
    + sec('lays', `Case ${idx + 1} · calques`, rows + acts, true);
}

// Options du calque, dépliées sous sa ligne : actions, opacité, mode de fusion, et bascules (référence, alpha, brouillon, verrou, seul).
function layerOptions(l) {
  const oneBit = bppOf(l) === 1, tinted = oneBit && l.kind !== 'draft' && /^#[0-9a-f]{6}$/i.test(l.color || '');
  const tog = (prop, ic, label, on, title) => `<button class="lopt-tog ${on ? 'on' : ''}" data-act="ltoggle" data-prop="${prop}" aria-pressed="${!!on}" title="${title}">${icon(ic)}<span>${label}</span></button>`;
  return `<div class="lopts" role="group" aria-label="Options du calque ${esc(l.name)}">
    <div class="lopt-acts">
      <button data-act="rename" title="Renommer">${icon('pencil')}<span>Renommer</span></button>
      <button data-act="dup-layer" title="Dupliquer">${icon('copy')}<span>Dupliquer</span></button>
      <button data-act="merge" title="Fusionner avec le calque du dessous">${icon('stack-pop')}<span>Fusionner</span></button>
      <button data-act="clear" title="Vider le calque">${icon('eraser')}<span>Vider</span></button>
      <button data-act="del-layer" class="danger" title="Supprimer le calque">${icon('trash')}<span>Supprimer</span></button></div>
    <label class="field inline"><span>Opacité : ${l.opacity} %</span><input type="range" id="l-op" min="0" max="100" step="5" value="${l.opacity}"></label>
    <label class="field inline"><span>Mode de fusion</span><select id="l-blend">${BLEND_MODES.map(([v, n]) => `<option value="${v}" ${(l.blend || 'normal') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <div class="lopt-togs">
      ${tog('reference', 'target', 'Référence', l.reference, 'Le remplissage et la couleur glissée suivent ses traits et se posent dans un autre calque')}
      ${tog('alphaLock', 'lock-square', 'Alpha verrouillé', l.alphaLock, 'On ne peint que sur ce qui est déjà dessiné, sans déborder')}
      ${oneBit ? tog('draft', 'pencil-minus', 'Brouillon', l.kind === 'draft', 'Visible à l\'écran, jamais imprimé') : ''}
      ${tog('locked', 'lock', 'Verrouillé', l.locked, 'Plus rien ne se dessine dans ce calque')}
      ${tog('solo', 'eye', 'Afficher seul', ed.solo === l.id, 'Masque les autres calques le temps de travailler')}</div>
    ${l.kind === 'draft' ? `<div class="row tight" style="margin:6px 0">${Object.entries(DRAFT_COLORS).map(([id, c]) =>
      `<button class="ink-btn ${(l.color || 'blue') === id ? 'on' : ''}" data-lcolor="${id}" style="background:rgb(${c.rgb.join(',')});width:32px;height:32px" aria-label="${c.name}" aria-pressed="${(l.color || 'blue') === id}"></button>`).join('')}</div>` : ''}
    ${tinted ? `<div class="row tight" style="margin:6px 0;align-items:center"><i class="ldot" style="background:${l.color}"></i><small class="note" style="margin:0">Teinte d'un ancien réglage</small><button class="btn small" data-act="tint-reset">Retirer</button></div>` : ''}
    ${oneBit && l.kind !== 'draft' && l.opacity < 100 ? '<small class="note">Imprimé en gris tramé.</small>' : ''}</div>`;
}

// Réglages d'un pinceau : [clé, libellé, min, max, pas, format]
const pct = v => `${Math.round(v * 100)} %`;
const BPARAMS = [
  ['press', 'Pression → taille', 0, 1, 0.05, pct], ['pressMin', 'Taille à pression nulle', 0, 1, 0.05, pct],
  ['speed', 'Effilage selon la vitesse', 0, 1, 0.05, pct], ['start', 'Départ effilé', 0, 8, 0.5, v => `${v} Ø`],
  ['smooth', 'Stabilisation', 0, 1, 0.05, pct], ['scatter', 'Dispersion', 0, 1, 0.05, pct], ['spacing', 'Espacement', 0.05, 3, 0.05, v => `${v.toFixed(2)} Ø`],
];
const GRAIN_TYPES = [['none', 'Aucun (plein)'], ['noise', 'Grain fin'], ['paper', 'Papier'], ['bristle', 'Poils'], ['spray', 'Aérographe']];

function brushesTab() { return brushesParts().list; }
function brushesParts() {
  const cur = ed.brushParams, groups = [...BRUSH_GROUPS, 'Mes pinceaux', 'Mes gommes'], list = allBrushes();
  const sl = ([k, label, min, max, step, fmt]) => `<label class="field inline"><span>${label} : ${fmt(cur[k])}</span><input type="range" id="p-${k}" min="${min}" max="${max}" step="${step}" value="${cur[k]}"></label>`;
  const custom = currentBrush().custom, here = currentBrush().group;
  const lists = groups.map(g => { const items = list.filter(b => b.group === g); return items.length ? sec('bg-' + g, esc(g), items.map(b =>
    `<button class="brush-row ${b.id === ed.brushId ? 'on' : ''}" data-brush="${b.id}"><canvas width="120" height="28" data-bp="${b.id}"></canvas><span>${esc(b.name)}</span></button>`).join(''), g === 'Encrage' || g === here) : ''; }).join('');
  const settings = `<label class="field inline"><span>Forme</span><select id="p-shape">${[['round', 'Rond'], ['square', 'Carré'], ['nib', 'Plume (ellipse)'], ['rect', 'Plat (rectangle)']].map(([v, n]) => `<option value="${v}" ${cur.shape === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${cur.shape === 'nib' || cur.shape === 'rect' ? `<label class="field inline"><span>Finesse : ${pct(cur.ratio)}</span><input type="range" id="p-ratio" min="0.05" max="1" step="0.05" value="${cur.ratio}"></label>
      <label class="check compact"><input type="checkbox" id="p-follow" ${cur.follow ? 'checked' : ''}> Perpendiculaire au geste</label>
      ${cur.follow ? '' : `<label class="field inline"><span>Angle : ${cur.angle}°</span><input type="range" id="p-angle" min="0" max="175" step="5" value="${cur.angle}"></label>`}` : ''}
    ${BPARAMS.map(sl).join('')}
    <label class="field inline"><span>Grain</span><select id="p-grainType">${GRAIN_TYPES.map(([v, n]) => `<option value="${v}" ${cur.grainType === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${cur.grainType !== 'none' ? `<label class="field inline"><span>Couverture : ${pct(cur.grain)}</span><input type="range" id="p-grain" min="0.1" max="1" step="0.05" value="${cur.grain}"></label>
      ${cur.grainType !== 'spray' ? `<label class="field inline"><span>Grain : ${cur.grainScale} px</span><input type="range" id="p-grainScale" min="1" max="6" step="0.5" value="${cur.grainScale}"></label>` : ''}` : ''}`;
  const buttons = `<div class="row tight" style="margin:6px 0">
      <button class="btn small" data-act="brush-reset" title="Rétablir les réglages du pinceau">${icon('refresh')} Rétablir</button>
      <button class="btn small primary" data-act="brush-save">${icon('device-floppy')} Enregistrer…</button>
      ${custom ? `<button class="btn small" data-act="brush-update">Mettre à jour</button><button class="btn small danger" data-act="brush-del" aria-label="Supprimer le pinceau">${icon('trash')}</button>` : ''}</div>`;
  const addBtn = `<div class="row tight" style="margin-bottom:6px"><button class="btn small primary" data-act="brush-save">${icon('plus')} Enregistrer ${ed.tool === 'eraser' ? 'cette gomme' : 'ce pinceau'}…</button></div>`;
  void settings;
  return { pop: buttons, list: (popId === 'lib-brush' ? '<small class="note" style="display:block;margin-bottom:6px">Le pinceau choisi entre dans la palette du projet.</small>' : '') + addBtn + lists + '<small class="note">« Mes pinceaux » servent à tous tes projets, sur tous tes appareils connectés ; la palette, elle, suit le projet. Appui long sur un de tes pinceaux, ou sur un pinceau de la palette, pour le retirer.</small>' };
}
// Réglages du pinceau : une seule fenêtre, en groupes (aperçu, trait, trame, forme et texture, dynamique, ce pinceau).
function paintBprev(scope) {
  const t = ed.tool === 'pencil' ? tramaById(ed.project, ed.tramaId) : null;
  $$('canvas[data-bprev]', scope).forEach(c => previewBrush(c, ed.brushParams, Math.min(ed.size, c.width > 100 ? 14 : 8), ed.alpha, t && !t.solid ? t : null, ed.tramaScale));
}
function brushPop() {
  const sl = activeSlot(), list = brushSlots(), i = sl ? list.indexOf(sl) : -1, cur = ed.brushParams, parts = brushesParts();
  const g = (title, body) => `<div class="pgroup"><div class="clabel">${title}</div>${body}</div>`;
  const sl1 = ([k, label, min, max, step, fmt]) => `<label class="field inline"><span>${label} : ${fmt(cur[k])}</span><input type="range" id="p-${k}" min="${min}" max="${max}" step="${step}" value="${cur[k]}"></label>`;
  const preview = `<canvas class="bp-preview" width="300" height="60" data-bprev="1" aria-label="Aperçu du pinceau"></canvas>`;
  const stroke = `<label class="field inline"><span>Taille</span><span class="row tight nowrap"><input type="number" id="o-mm" class="num" min="0.05" max="${maxSizeMm()}" step="0.05" value="${+ed.sizeMm.toFixed(2)}" aria-label="Taille en millimètres"><span class="unit">mm</span></span></label>
    <label class="field inline"><span>Opacité : ${Math.round(ed.alpha * 100)} %</span><input type="range" id="o-alpha" min="5" max="100" step="1" value="${Math.round(ed.alpha * 100)}"></label>
    <label class="check compact"><input type="checkbox" id="o-pressure" ${ed.pressure ? 'checked' : ''}> Pression du stylet (tous les pinceaux)</label>`;
  let trame = '';
  if (ed.tool === 'pencil') {
    const t = tramaById(ed.project, ed.tramaId);
    trame = `<div class="row tight" style="align-items:center;margin-bottom:6px">
        <button class="swatch-btn" data-pop="lib-trama" title="Changer de trame" aria-label="Changer de trame, actuelle : ${esc(t.solid ? 'aucune' : t.name)}">${t.solid ? '<span class="ink-dot"></span>' : `<canvas width="30" height="30" data-swatch="${t.id}"></canvas>`}</button>
        <span>${t.solid ? 'Aucune : encre pleine' : esc(t.name)}</span></div>
      ${t.solid ? '' : `<label class="field inline"><span>Échelle : ×${ed.tramaScale}</span><input type="range" id="d-scale" min="1" max="8" value="${ed.tramaScale}"></label>
      <label class="check compact"><input type="checkbox" id="d-opaque" ${ed.tramaOpaque ? 'checked' : ''}> Fond blanc sous la trame</label>`}`;
  }
  const shape = `<label class="field inline"><span>Forme</span><select id="p-shape">${[['round', 'Rond'], ['square', 'Carré'], ['nib', 'Plume (ellipse)'], ['rect', 'Plat (rectangle)']].map(([v, n]) => `<option value="${v}" ${cur.shape === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${cur.shape === 'nib' || cur.shape === 'rect' ? `<label class="field inline"><span>Finesse : ${pct(cur.ratio)}</span><input type="range" id="p-ratio" min="0.05" max="1" step="0.05" value="${cur.ratio}"></label>
      <label class="check compact"><input type="checkbox" id="p-follow" ${cur.follow ? 'checked' : ''}> Perpendiculaire au geste</label>
      ${cur.follow ? '' : `<label class="field inline"><span>Angle : ${cur.angle}°</span><input type="range" id="p-angle" min="0" max="175" step="5" value="${cur.angle}"></label>`}` : ''}
    <label class="field inline"><span>Grain</span><select id="p-grainType">${GRAIN_TYPES.map(([v, n]) => `<option value="${v}" ${cur.grainType === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${cur.grainType !== 'none' ? `<label class="field inline"><span>Couverture : ${pct(cur.grain)}</span><input type="range" id="p-grain" min="0.1" max="1" step="0.05" value="${cur.grain}"></label>
      ${cur.grainType !== 'spray' ? `<label class="field inline"><span>Grain : ${cur.grainScale} px</span><input type="range" id="p-grainScale" min="1" max="6" step="0.5" value="${cur.grainScale}"></label>` : ''}` : ''}
    ${BPARAMS.filter(r => r[0] === 'scatter' || r[0] === 'spacing').map(sl1).join('')}`;
  const dyn = BPARAMS.filter(r => r[0] !== 'scatter' && r[0] !== 'spacing').map(sl1).join('');
  const own = `${sl ? `<div class="row tight" style="margin-bottom:6px">
      <button class="btn small" data-act="slot-rename">${icon('pencil')} Renommer</button>
      <button class="icon-btn icon-only" data-act="slot-left" aria-label="Déplacer à gauche dans la palette" ${i <= 0 ? 'disabled' : ''}>${icon('arrow-left')}</button>
      <button class="icon-btn icon-only" data-act="slot-right" aria-label="Déplacer à droite dans la palette" ${i >= list.length - 1 ? 'disabled' : ''}>${icon('arrow-right')}</button>
      <button class="icon-btn icon-only danger" data-act="slot-remove" aria-label="Retirer de la palette" ${list.length <= 1 ? 'disabled' : ''}>${icon('trash')}</button></div>` : ''}${parts.pop}`;
  return preview + g('Trait', stroke) + (trame ? g('Trame', trame) : '') + g('Forme et texture', shape) + g('Dynamique', dyn) + g('Ce pinceau', own)
    + `<small class="note">Une opacité sous 100 % trace un gris tramé en noir et blanc, une vraie transparence en couleur.</small>`;
}


function paintBrushPreviews(scope) {
  const dpi = ed.project.dpi;
  $$('canvas[data-bp]', scope).forEach(c => {
    const sp = { ...ed.brushParams, ...(allBrushes().find(b => b.id === c.dataset.bp) || {}) };
    const spec = c.dataset.bp === ed.brushId ? ed.brushParams : sp;
    previewBrush(c, spec, Math.max(2, Math.min(spec.sizeMm / 25.4 * dpi, 9)));
  });
}

function tramasTab() {
  const list = allTramas(ed.project), groups = [...new Set(list.map(t => t.group))];
  const cur = tramaById(ed.project, ed.tramaId);
  const settings = `<div class="row tight" style="margin:4px 0 6px">
      <button class="btn small" data-act="new-trame">${icon('plus')} Nouvelle trame</button>
      <button class="btn small" data-act="tpreset-save" title="Enregistrer la trame, l'échelle et le fond actuels">${icon('plus')} Enregistrer le réglage…</button>
      ${cur.builtin === false ? `<button class="btn small" data-act="edit-trame" aria-label="Modifier la trame">${icon('pencil')}</button><button class="btn small danger" data-act="del-trame" aria-label="Supprimer la trame">${icon('trash')}</button>` : ''}</div>`;
  const presets = ed.tramaPresets.map(t => `<div class="row tight" style="margin-bottom:4px"><button class="btn small" data-tpreset="${t.id}" style="flex:1;justify-content:flex-start">${esc(t.name)}</button><button class="icon-btn icon-only" data-tpdel="${t.id}" aria-label="Supprimer le réglage ${esc(t.name)}">${icon('trash')}</button></div>`).join('');
  const open = g => g === 'Gris' || g === 'Ma bibliothèque' || g === cur.group;
  const solid = list.find(t => t.solid);
  const inkCell = solid ? `<button class="tcell ink ${solid.id === ed.tramaId ? 'on' : ''}" data-trama="${solid.id}" aria-label="Encre pleine, sans trame" title="Encre pleine, sans trame"><span class="ink-dot"></span></button>` : '';
  const tgroups = groups.filter(g => list.some(t => t.group === g && !t.solid));
  return settings
    + (presets ? sec('trpre', 'Mes réglages', presets, true) : '')
    + `<div class="tgrid" style="margin-bottom:8px">${inkCell}</div>`
    + tgroups.map(g => sec('tg-' + g, esc(g), `<div class="tgrid">${list.filter(t => t.group === g && !t.solid).map(t =>
      `<button class="tcell ${t.id === ed.tramaId ? 'on' : ''}" data-trama="${t.id}" aria-label="${esc(t.name)}" title="${esc(t.name)}"><canvas width="36" height="36" data-tcell="${t.id}"></canvas></button>`).join('')}</div>`, open(g))).join('')
    + '<small class="note">La trame est accrochée à la page : deux cases voisines se raccordent sans rupture.</small>';
}

// Fenêtre « Réglages » d'une trame : échelle, fond blanc, enregistrer le réglage.
const tramaPop = () => `<label class="field inline"><span>Échelle : ×${ed.tramaScale}</span><input type="range" id="d-scale" min="1" max="8" value="${ed.tramaScale}"></label>
    <label class="check compact"><input type="checkbox" id="d-opaque" ${ed.tramaOpaque ? 'checked' : ''}> Fond blanc sous la trame</label>
    <div class="row tight" style="margin-top:6px"><button class="btn small" data-act="tpreset-save" title="Enregistrer trame, échelle et fond actuels">${icon('device-floppy')} Enregistrer le réglage</button></div>
    <small class="note">La trame se choisit dans la Bibliothèque.</small>`;

function miniPage(pg) {
  const { w, h } = pageSize(ed.project);
  return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${pg.panels.map(c => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none" stroke="#000" stroke-width="${Math.round(w / 40)}"/>`).join('')}</svg>`;
}

function pagesTab() {
  return `<h3>Pages</h3>
    ${ed.project.pages.map((pg, i) => `<button class="page-btn ${i === ed.pageIdx ? 'on' : ''}" data-page="${i}">${miniPage(pg)}
      <span><b>Page ${i + 1}</b><small>${pg.panels.length} case${pg.panels.length > 1 ? 's' : ''} · ${pg.bubbles.length} bulle${pg.bubbles.length > 1 ? 's' : ''}</small></span></button>`).join('')}
    <div class="tools-row">
      <button class="icon-btn icon-only" data-act="add-page" title="Nouvelle page" aria-label="Nouvelle page">${icon('file-plus')}</button>
      <button class="icon-btn icon-only" data-act="dup-page" title="Dupliquer la page" aria-label="Dupliquer la page">${icon('copy')}</button>
      <button class="icon-btn icon-only" data-act="page-left" title="Reculer la page" aria-label="Reculer la page">${icon('arrow-up')}</button>
      <button class="icon-btn icon-only" data-act="page-right" title="Avancer la page" aria-label="Avancer la page">${icon('arrow-down')}</button>
      <button class="icon-btn icon-only" data-act="relayout" title="Changer la disposition des cases" aria-label="Changer la disposition">${icon('layout-grid')}</button>
      <button class="icon-btn icon-only" data-act="del-page" title="Supprimer la page" aria-label="Supprimer la page">${icon('trash')}</button>
    </div>
    <button class="btn primary" data-act="export-pdf" style="margin-top:8px;width:100%">${icon('file-type-pdf')} Exporter en PDF</button>`;
}

// Curseurs numériques d'une bulle : identifiant → [propriété, libellé]
const SLIDERS = {
  'b-radius': ['radius', v => `Angles arrondis : ${v} %`], 'b-wobble': ['wobble', v => `Imperfections : ${v} %`],
  'b-pad': ['pad', v => `Marge intérieure : ${String(v).replace('.', ',')} mm`], 'b-stroke': ['stroke', v => `Trait : ${v.toFixed(2).replace('.', ',')} mm`],
  'b-lobes': ['lobes', v => `Lobes : ${v ? v : 'auto'}`], 'b-bulge': ['bulge', v => `Bombé des lobes : ${v} %`],
  'b-vround': ['valleyRound', v => `Creux arrondis : ${v} %`], 'b-tround': ['tipRound', v => `Pointes arrondies : ${v} %`],
  'b-spikes': ['spikes', v => `Pointes : ${v}`], 'b-depth': ['depth', v => `Profondeur : ${v} %`],
  'b-rot': ['rot', v => `Rotation : ${v}°`], 'b-edge': ['edge', v => `Marge au bord de la case : ${String(v).replace('.', ',')} mm`],
  'b-tailangle': ['tailAngle', v => `Position de l'origine : ${v}°`],
  'b-tailw': ['tailW', v => `Largeur de la queue : ${v} %`], 'b-tailround': ['tailRound', v => `Arrondi des côtés : ${v > 0 ? '+' : ''}${v}`],
  'b-tailbend': ['tailBend', v => `Courbure : ${v > 0 ? '+' : ''}${v}`], 'b-tailtip': ['tailTip', v => `Pointe émoussée : ${v} %`],
};
const slider = (id, p, min, max, step = 1) => `<label class="field inline"><span>${SLIDERS[id][1](p[SLIDERS[id][0]])}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${p[SLIDERS[id][0]]}"></label>`;

function bubbleText(b) {
  const p = props(b);
  return `<textarea id="b-text" rows="2" aria-label="Texte de la bulle" style="width:100%;font-size:16px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--field-bg);color:var(--text-primary);margin-bottom:8px">${esc(b.text)}</textarea>
      <button class="btn small" data-act="pick-font" style="justify-content:flex-start;width:100%;margin-bottom:6px">${icon('typography')} ${esc(fontName(p.font))}</button>
      <label class="field inline"><span>Corps : ${b.pt} pt</span><input type="range" id="b-ptr" min="0" max="100" step="0.5" value="${ptToV(b.pt)}" aria-label="Corps du texte"></label>
      <div class="bl-step"><button data-act="pt-" aria-label="Plus petit">A−</button><input type="number" id="b-pt" min="5" max="200" step="0.5" value="${b.pt}" aria-label="Corps en points"><span>pt</span><button data-act="pt+" aria-label="Plus grand">A+</button></div>
      <div class="row tight" style="margin:2px 0 6px;align-items:center;gap:6px 10px">
        <span class="seg" role="group" aria-label="Alignement horizontal du texte">${[['left', 'align-left', 'À gauche'], ['center', 'align-center', 'Centré'], ['right', 'align-right', 'À droite']].map(([id, ic, n]) => `<button type="button" data-act="talign" data-v="${id}" class="${p.align === id ? 'on' : ''}" aria-label="${n}" aria-pressed="${p.align === id}" title="${n}">${icon(ic)}</button>`).join('')}</span>
        <span class="seg" role="group" aria-label="Alignement vertical du texte">${[['top', 'layout-align-top', 'En haut'], ['middle', 'layout-align-middle', 'Au milieu'], ['bottom', 'layout-align-bottom', 'En bas']].map(([id, ic, n]) => `<button type="button" data-act="tvalign" data-v="${id}" class="${p.valign === id ? 'on' : ''}" aria-label="${n}" aria-pressed="${p.valign === id}" title="${n}">${icon(ic)}</button>`).join('')}</span></div>
      ${b.auto && p.valign !== 'middle' ? '<small class="note">L\'alignement vertical se voit quand « Taille auto » est décoché.</small>' : ''}
      <div class="row" style="gap:0 14px"><label class="check compact"><input type="checkbox" id="b-caps" ${b.caps ? 'checked' : ''}> Majuscules</label>
        <label class="check compact"><input type="checkbox" id="b-auto" ${b.auto ? 'checked' : ''}> Taille auto</label></div>`;
}
function bubbleShape(b) {
  const p = props(b);
  return `<label class="field inline"><span>Modèle</span><select id="b-kind">${BUBBLE_KINDS.map(k => `<option value="${k.id}" ${k.id === b.kind ? 'selected' : ''}>${k.name}</option>`).join('')}</select></label>
      <label class="field inline"><span>Contour</span><select id="b-shape">${BUBBLE_SHAPES.filter(x => x.id !== 'libre' || b.path).map(x => `<option value="${x.id}" ${x.id === p.shape ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      ${p.shape === 'rect' ? slider('b-radius', p, 0, 100, 5) : ''}
      ${p.shape === 'eclair' ? slider('b-spikes', p, 5, 32) + slider('b-depth', p, 8, 65) + slider('b-vround', p, 0, 100, 5) + slider('b-tround', p, 0, 100, 5) : ''}
      ${p.shape === 'cloud' ? slider('b-lobes', p, 0, 40) + slider('b-bulge', p, 0, 100, 5) + `<label class="check compact"><input type="checkbox" id="b-cloudsoft" ${p.cloudSoft ? 'checked' : ''}> Creux arrondis (nuage doux)</label>` : ''}
      ${p.shape === 'ellipse' || p.shape === 'rect' || p.shape === 'cloud' || p.shape === 'eclair' ? `${slider('b-wobble', p, 0, 100)}<button class="btn small" data-act="reseed" style="margin:-2px 0 8px">${icon('dice-3')} Autre tracé</button>` : ''}
      ${slider('b-pad', p, 0, 10, 0.5)}${b.auto ? '<small class="note">En taille auto, la marge garde toujours le texte à distance du trait.</small>' : ''}${b.sameStroke ? `<small class="note">Trait : ${fmtMm(panelStroke(bubblePanelOf(b, page().panels) || panel()))} mm, comme le cadre de la case.</small>` : slider('b-stroke', p, 0, 2, 0.05)}
      <label class="check compact"><input type="checkbox" id="b-samestroke" ${b.sameStroke ? 'checked' : ''}> Même épaisseur que le cadre des cases</label>
      <label class="check compact"><input type="checkbox" id="b-clip" ${b.clip ? 'checked' : ''}> Rogner à la case (ne sort pas du cadre)</label>
      ${b.clip ? `<label class="check compact"><input type="checkbox" id="b-noframe" ${b.noFrame ? 'checked' : ''}> Pas de trait de case là où la bulle la touche</label>` : ''}
      <button class="btn small" data-act="bubble-lines-all" style="margin:2px 0 8px">Appliquer ces traits à toutes les bulles</button>
      ${b.kind === 'narration' ? `${slider('b-edge', p, 0, 10, 0.5)}<small class="note" style="display:block">Près d'un bord de sa case, la narration s'y cale à cette distance${b.rot ? ' (pas quand elle est tournée)' : ''}.</small>
      <button class="btn small" data-act="edge-all" style="margin:2px 0 8px">Appliquer à toutes les narrations</button>` : ''}
      ${slider('b-rot', p, 0, 359)}
      <button class="btn small" data-act="tpl-save" style="margin-top:6px">${icon('device-floppy')} Enregistrer comme modèle…</button>`;
}
function bubbleTail(b) {
  const p = props(b);
  return `<label class="field inline"><span>Style</span><select id="b-tailstyle">${TAILS.map(x => `<option value="${x.id}" ${x.id === p.tailStyle ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      ${p.tailStyle !== 'none' ? `<label class="check compact"><input type="checkbox" id="b-origin-auto" ${b.tailAngle == null ? 'checked' : ''}> Origine automatique</label>
        ${b.tailAngle == null ? '' : slider('b-tailangle', p, 0, 359)}` : ''}
      ${p.tailStyle === 'pointe' ? slider('b-tailw', p, 4, 70) + slider('b-tailround', p, -100, 100, 5) + slider('b-tailbend', p, -100, 100, 5) + slider('b-tailtip', p, 0, 100, 5) : ''}
      ${p.tailStyle === 'fleche' || p.tailStyle === 'bulles' ? slider('b-tailw', p, 4, 70) + slider('b-tailbend', p, -100, 100, 5) : ''}
      ${p.tailStyle !== 'none' ? '<small class="note">Points rouges sur la page : pointe et origine de la queue.</small>' : ''}`;
}

function caseTab() {
  const p = panel(), idx = page().panels.indexOf(p);
  const notes = `<label class="field"><span>Plan</span><input type="text" id="n-plan" value="${esc(p.note.plan)}" placeholder="Plan large, gros plan…"></label>
    <label class="field"><span>Description</span><textarea id="n-desc" rows="2" placeholder="Ce qu'il faut dessiner">${esc(p.note.description)}</textarea></label>
    <label class="check compact"><input type="checkbox" id="n-show" ${ed.showNotes ? 'checked' : ''}> Afficher les notes sur la page (jamais exportées)</label>`;
  const frame = `<label class="field inline"><span>Trait : ${fmtMm(panelStroke(p))} mm</span><input type="range" id="n-stroke" min="0" max="2" step="0.05" value="${panelStroke(p)}"></label>
    <button class="btn small" data-act="stroke-all">Appliquer à toute la page</button>`;
  const copy = `<div class="row tight"><button class="btn small" data-act="copy-case">${icon('copy')} Copier vers…</button>
    <button class="btn small primary" data-z="focus">${icon('pencil')} Dessiner dans la case</button></div>`;
  return sec('cn', `Case ${idx + 1} · notes`, notes, true) + sec('cf', 'Cadre', frame, false) + sec('cx', 'Copie', copy, false);
}
// Dans la case ouverte : masque et image tramée, sous les calques.
function caseDrawTab() {
  const mask = `<small class="note">Peins une zone avec l'outil Masque, puis choisis « Dans » ou « Hors » pour ne dessiner que dedans ou dehors.</small>
    <div class="row tight" style="margin-top:6px"><button class="btn small" data-act="mask-clear">Vider</button><button class="btn small" data-act="mask-invert">Inverser</button></div>`;
  const img = `<div class="row tight"><button class="btn small" data-act="dither">${icon('photo')} Image tramée…</button></div>`;
  return sec('cm', 'Masque', mask, false) + sec('ci', 'Image tramée', img, false);
}

// ───────────────────────── Événements du volet ─────────────────────────

async function onDock(e) {
  if (swipeJustDone) { e.preventDefault(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { dockTabTo(tab.dataset.tab); return; }
  if (e.target.closest('[data-z="focus"]')) { setFocus(true); return; }
  const mp = e.target.closest('[data-mpage]');
  if (mp) { goToPage(+mp.dataset.mpage); return; }
  const dp = e.target.closest('#pop [data-pop]');
  if (dp) { popBack = popId; popId = dp.dataset.pop; renderOptbar(); renderPop(); return; }
  const br = e.target.closest('[data-brush]');
  if (br) {
    if (!['pencil', 'eraser'].includes(ed.tool)) setTool('pencil');   // seuls ces outils utilisent un pinceau
    const how = brushToPalette(br.dataset.brush); savePrefs(); if (/^lib-/.test(popId)) popId = null; renderDock(); renderOptbar(); renderPop();
    if (how === 'replaced') toast(`Palette pleine (${SLOT_MAX}) : le pinceau actif a été remplacé.`);
    return;
  }
  const tpl = e.target.closest('[data-tpl]'), tpld = e.target.closest('[data-tpldel]');
  if (tpld) { deleteBubbleTemplate(tpld.dataset.tpldel); savePrefs(); renderOptbar(); renderPop(); return; }
  if (tpl) { ed.bubbleTemplate = tpl.dataset.tpl; savePrefs(); popId = null; renderOptbar(); renderPop(); return; }
  const tp = e.target.closest('[data-tpreset]'), tpd = e.target.closest('[data-tpdel]');
  if (tpd) { ed.tramaPresets = ed.tramaPresets.filter(x => x.id !== tpd.dataset.tpdel); savePrefs(); renderDock(); return; }
  if (tp) { applyTramaPreset(tp.dataset.tpreset); return; }
  const tr = e.target.closest('[data-trama]');
  if (tr) {
    if (!TOOL_TRAMA.includes(ed.tool)) setTool('pencil');   // seuls ces outils utilisent une trame
    ed.tramaId = tr.dataset.trama; if (ed.tool === 'pencil') storeSlot(); savePrefs(); if (/^lib-/.test(popId)) { popId = popBack; popBack = null; } renderDock(); renderOptbar(); renderPop(); return;
  }
  const pgb = e.target.closest('[data-page]');
  if (pgb) { goToPage(+pgb.dataset.page); return; }
  const pc = e.target.closest('[data-pcolor]');
  if (pc) { setColor(pc.dataset.pcolor); savePrefs(); updateColorWidget(); renderPop(); return; }
  const pl = e.target.closest('[data-palid]');
  if (pl) { selectPalette(pl.dataset.palid); renderPop(); return; }
  const lk = e.target.closest('[data-lkind]'), lc = e.target.closest('[data-lcolor]');
  if (lk) { setLayerProp(activeLayer().id, 'kind', lk.dataset.lkind); return; }
  if (lc) { setLayerProp(activeLayer().id, 'color', lc.dataset.lcolor); return; }
  const lay = e.target.closest('[data-layer]');
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'vis') toggleLayer(lay.dataset.layer, 'visible');
  else if (a === 'select-layer') {
    const id = lay.dataset.layer;
    if (id === panel().active && !e.target.closest('.dock-mini')) { layerOpts = layerOpts === id ? null : id; renderDock(); }
    else { layerOpts = null; selectLayer(id); }
  }
  else if (a === 'ltoggle') {
    const l = activeLayer(), prop = act.dataset.prop;
    if (prop === 'solo') { setSolo(l.id); toast(ed.solo ? `Seul « ${l.name} » est affiché.` : 'Tous les calques sont affichés.', { duration: 1600 }); }
    else if (prop === 'draft') {
      const on = l.kind !== 'draft';
      if (on) { l.prevKind = l.kind; setLayerProp(l.id, 'kind', 'draft'); } else setLayerProp(l.id, 'kind', l.prevKind || 'ink');
      toast(on ? `« ${l.name} » est un brouillon : jamais imprimé.` : `« ${l.name} » n'est plus un brouillon.`, { duration: 2000 });
    } else {
      setLayerProp(l.id, prop, !l[prop]);
      const said = { reference: ['est une référence : le remplissage suit ses traits.', 'n\'est plus une référence.'], alphaLock: ['a son alpha verrouillé : on ne peint que sur l\'existant.', 'n\'a plus l\'alpha verrouillé.'], locked: ['est verrouillé.', 'est déverrouillé.'] }[prop];
      toast(`« ${l.name} » ${l[prop] ? said[0] : said[1]}`, { duration: 2000 });
    }
    renderDock();
  }
  else if (a === 'add-layer') { addLayer('ink'); toast(`Calque « ${activeLayer().name} » ajouté.`, { actionLabel: 'Annuler', duration: 4000, onAction: undo }); }
  else if (a === 'add-color') addLayer('color');
  else if (a === 'bub-vis') { const bb = page().bubbles.find(x => x.id === e.target.closest('[data-bub]').dataset.bub); setBubbleProp(bb, 'hidden', !bb.hidden); }
  else if (a === 'bub-lock') { const bb = page().bubbles.find(x => x.id === e.target.closest('[data-bub]').dataset.bub); setBubbleProp(bb, 'locked', !bb.locked); }
  else if (a === 'bub-del') { const bb = page().bubbles.find(x => x.id === e.target.closest('[data-bub]').dataset.bub); deleteBubble(bb); }
  else if (a === 'bub-select') { selectBubble(e.target.closest('[data-bub]').dataset.bub); if (ed.tool !== 'bubble') setTool('bubble'); else renderOptbar(); }
  else if (a === 'swipe-del') {
    const l = panel().layers.find(x => x.id === act.dataset.for);
    if (l) { selectLayer(l.id); if (deleteLayer()) toast(`Calque « ${l.name} » supprimé.`, { actionLabel: 'Annuler', duration: 7000, onAction: undo }); else toast('Une case garde au moins un calque.'); }
  }
  else if (a === 'swipe-dup') { selectLayer(act.dataset.for); dupWithToast(); }
  else if (a === 'tint-reset') { setLayerProp(activeLayer().id, 'color', undefined); }
  else if (a === 'edge-all') { const n = applyNarrationEdge(bubble()); if (n) toast(`Marge appliquée à ${n} narration${n > 1 ? 's' : ''}.`, { actionLabel: 'Annuler', duration: 6000, onAction: undo }); }
  else if (a === 'bubble-lines-all') { const n = applyBubbleLines(bubble()); if (n) toast(`Traits appliqués à ${n} bulle${n > 1 ? 's' : ''}.`); }
  else if (a === 'swipe-bub-dup') { const bb = page().bubbles.find(x => x.id === act.dataset.for); if (bb) duplicateBubble(bb); }
  else if (a === 'swipe-bub-del') { const bb = page().bubbles.find(x => x.id === act.dataset.for); if (bb) { deleteBubble(bb); toast('Bulle supprimée.', { actionLabel: 'Annuler', duration: 7000, onAction: undo }); } }
  else if (a === 'bubs-vis') { e.preventDefault(); togglePageBubbles(); }
  else if (a === 'del-layer') { const n = activeLayer().name; layerOpts = null; if (deleteLayer()) toast(`Calque « ${n} » supprimé.`, { actionLabel: 'Annuler', duration: 7000, onAction: undo }); else toast('Une case garde au moins un calque.'); }
  else if (a === 'up') moveLayer(1);
  else if (a === 'down') moveLayer(-1);
  else if (a === 'lock') { const l = panel().layers.find(x => x.id === lay.dataset.layer); setLayerProp(l.id, 'locked', !l.locked); toast(`« ${l.name} » ${l.locked ? 'est verrouillé' : 'est déverrouillé'}.`, { duration: 1600 }); }
  else if (a === 'add-draft') { addLayer('draft'); toast(`Brouillon « ${activeLayer().name} » ajouté.`, { actionLabel: 'Annuler', duration: 4000, onAction: undo }); }
  else if (a === 'dup-layer') dupWithToast();
  else if (a === 'merge') mergeWithToast();
  else if (a === 'clear') clearActiveLayer();
  else if (a === 'rename') {
    const l = activeLayer(), old = l.name, name = await promptModal({ title: 'Renommer le calque', label: 'Nom', value: l.name });
    if (name && name.trim() !== old) { renameLayer(l.id, name); toast(`« ${old} » renommé en « ${l.name} ».`, { actionLabel: 'Annuler', duration: 5000, onAction: () => renameLayer(l.id, old) }); }
  } else if (a === 'new-trame') tramaEditor();
  else if (a === 'edit-trame') tramaEditor(tramaById(ed.project, ed.tramaId));
  else if (a === 'del-trame') {
    if (await confirmModal({ title: 'Supprimer la trame', message: 'Cette trame personnalisée sera retirée de la bibliothèque. Les dessins déjà faits ne changent pas.', confirm: 'Supprimer', danger: true })) {
      if (tramaById(ed.project, ed.tramaId).lib) await removeFromLibrary(ed.tramaId);
      ed.project.tramas = ed.project.tramas.filter(t => t.id !== ed.tramaId); ed.tramaId = 'plein'; markChanged(); renderDock(); renderOptbar();
    }
  }
  else if (a === 'add-page') { const id = await pickLayout('Nouvelle page'); if (id) await addPage(id); }
  else if (a === 'dup-page') await duplicatePage();
  else if (a === 'page-left') movePage(-1);
  else if (a === 'page-right') movePage(1);
  else if (a === 'relayout') {
    const id = await pickLayout('Disposition des cases');
    if (id) { const r = relayoutPage(id); if (r.removed) toast(`${r.removed} case${r.removed > 1 ? 's' : ''} retirée${r.removed > 1 ? 's' : ''} (leur dessin revient avec Annuler).`, { actionLabel: 'Annuler', duration: 9000, onAction: undo }); }
  } else if (a === 'del-page') {
    if (ed.project.pages.length < 2) { toast('Un projet garde au moins une page.'); return; }
    const restore = await deletePage();
    if (restore) toast('Page supprimée.', { actionLabel: 'Annuler', duration: 8000, onAction: restore });
  } else if (a === 'del-bubble') deleteBubble();
  else if (a === 'pick-font') fontModal();
  else if (a === 'reseed') { const b = bubble(); if (b) { const before = snapshotBubble(b); b.seed = Math.floor(Math.random() * 1e6); commitBubbleEdit(b, before); requestRender(); } }
  else if (a === 'copy-case') copyModal();
  else if (a === 'pt-' || a === 'pt+') { const b = bubble(); if (b) { const before = snapshotBubble(b); b.pt = Math.max(5, Math.min(200, +(b.pt + (a === 'pt+' ? 1 : -1) * (b.pt < 24 ? 0.5 : b.pt < 60 ? 1 : 2)).toFixed(1))); refitBubble(b); commitBubbleEdit(b, before); renderDock(); const fl = $('#bfloat', root); if (fl) fl._html = ''; placeBubbleUI(); renderPop(); } }
  else if (a === 'talign' || a === 'tvalign') {
    const b = bubble(), v = act.dataset.v;
    if (b && v) { const before = snapshotBubble(b); b[a === 'talign' ? 'align' : 'valign'] = v; commitBubbleEdit(b, before); rememberBubble(b); renderDock(); const fl = $('#bfloat', root); if (fl) fl._html = ''; placeBubbleUI(); renderPop(); requestRender(); }
  }
  else if (a === 'tpl-save') {
    bfTab = null; placeBubbleUI();
    const b = bubble();
    if (!b) { toast('Sélectionne d\'abord une bulle.'); return; }
    const name = await promptModal({ title: 'Enregistrer le modèle de bulle', label: 'Nom', value: 'Ma bulle' });
    if (name) { saveBubbleTemplate(name, b); savePrefs(); renderOptbar(); renderPop(); toast('Modèle enregistré.'); }
  }
  else if (a === 'brush-reset') { resetBrush(); storeSlot(); renderDock(); renderOptbar(); renderPop(); }
  else if (a === 'color-add') { if (addProjectColor(ed.color)) toast('Couleur ajoutée à la palette du projet.', { duration: 1600 }); renderPop(); }
  else if (a === 'pal-new') {
    const name = await promptModal({ title: 'Nouvelle palette', label: 'Nom', value: 'Palette ' + (projectPalettes().length + 1) });
    if (name) { addPalette(name.trim() || 'Palette'); if (ed.color) addProjectColor(ed.color); renderPop(); }
  }
  else if (a === 'pal-rename') {
    const pal = currentPalette(), name = await promptModal({ title: 'Renommer la palette', label: 'Nom', value: pal.name });
    if (name) { renamePalette(pal.id, name.trim()); renderPop(); }
  }
  else if (a === 'pal-del') {
    const pal = currentPalette(), gone = removePalette(pal.id);
    if (gone) { renderPop(); toast(`Palette « ${pal.name} » supprimée.`, { actionLabel: 'Annuler', duration: 6000, onAction: () => { restorePalette(gone); renderPop(); } }); }
  }
  else if (a === 'pick-color') { ed.picking = true; popId = null; renderPop(); updateColorWidget(); toast('Touche le dessin pour y prendre une couleur.', { duration: 2200 }); }
  else if (a === 'slot-rename') {
    const sl = activeSlot(); if (!sl) return;
    const name = await promptModal({ title: 'Renommer le pinceau', label: 'Nom', value: sl.name });
    if (name) { renameSlot(sl.id, name); renderOptbar(); renderPop(); }
  }
  else if (a === 'slot-left' || a === 'slot-right') { const sl = activeSlot(); if (sl) { moveSlot(sl.id, a === 'slot-left' ? -1 : 1); renderOptbar(); renderPop(); } }
  else if (a === 'slot-remove') {
    const sl = activeSlot(); if (!sl) return;
    if (removeSlot(sl.id)) { savePrefs(); renderOptbar(); renderPop(); toast(`« ${sl.name} » retiré de la palette.`); } else toast('La palette garde au moins un pinceau.');
  }
  else if (a === 'brush-save') {
    const eraser = ed.tool === 'eraser';
    const name = await promptModal({ title: eraser ? 'Enregistrer la gomme' : 'Enregistrer le pinceau', label: 'Nom', value: eraser ? 'Ma gomme' : 'Mon pinceau' });
    if (name) { saveBrushAs(name, eraser ? 'Mes gommes' : 'Mes pinceaux'); savePrefs(); renderDock(); renderOptbar(); renderPop(); toast(eraser ? 'Gomme enregistrée.' : 'Pinceau enregistré.'); }
  }
  else if (a === 'brush-update') { updateBrush(); savePrefs(); toast('Pinceau mis à jour.'); }
  else if (a === 'brush-del') {
    if (await confirmModal({ title: 'Supprimer le pinceau', message: `« ${currentBrush().name} » sera retiré de tes pinceaux.`, confirm: 'Supprimer', danger: true })) { deleteBrush(ed.brushId); savePrefs(); renderDock(); renderOptbar(); }
  }
  else if (a === 'tpreset-save') {
    const name = await promptModal({ title: 'Enregistrer le réglage de trame', label: 'Nom', value: tramaById(ed.project, ed.tramaId).name + ' ×' + ed.tramaScale });
    if (name) { ed.tramaPresets.push({ id: 'tp' + Math.random().toString(36).slice(2, 8), name, tramaId: ed.tramaId, tramaScale: ed.tramaScale, tramaOpaque: ed.tramaOpaque, color: ed.color }); savePrefs(); renderDock(); toast('Réglage enregistré.'); }
  }
  else if (a === 'stroke-all') { setPanelStroke(panelStroke(panel()), true); toast('Trait appliqué à toutes les cases.'); }
  else if (a === 'export-pdf') exportPdf();
  else if (a === 'pop-close') { popId = null; renderOptbar(); renderPop(); }
  else if (a === 'mask-clear') clearMask();
  else if (a === 'mask-invert') invertMask();
  else if (a === 'dither') ditherModal();
}

// Une queue a besoin d'un point à déplacer ; sans queue, on le retire.
function setTail(b, on) {
  if (!on) b.tail = null;
  else if (!b.tail) b.tail = { x: Math.round(b.x + b.w * 0.35), y: Math.round(b.y + b.h + 160) };
}

// Le dernier style réglé pour un type de bulle devient celui des prochaines bulles de ce type.
const STYLE_KEYS = ['edge', 'align', 'valign', 'lobes', 'bulge', 'cloudSoft', 'valleyRound', 'tipRound', 'spikes', 'depth', 'pt', 'caps', 'auto', 'font', 'shape', 'radius', 'pad', 'stroke', 'wobble', 'tailStyle', 'tailW', 'tailRound', 'tailBend', 'tailTip'];
function rememberBubble(b) {
  const d = {};
  for (const k of STYLE_KEYS) if (b[k] !== undefined && !(k === 'shape' && b.shape === 'libre')) d[k] = b[k];
  ed.bubbleDefaults[b.kind] = d; savePrefs();
}

// ───────────── Barre flottante de la bulle sélectionnée et saisie du texte sur la bulle ─────────────

const SHAPE_ORDER = [['ellipse', 'circle', 'Ellipse'], ['rect', 'square-rounded', 'Rectangle'], ['cloud', 'cloud', 'Nuage'], ['eclair', 'bolt', 'Éclair']];
const tailMemory = new Map();
let bfTab = null, editBefore = null;   // bfTab : liste déroulante ouverte sous la barre ('text' | 'shape' | 'tail')
const STRUCTURAL = ['b-kind', 'b-shape', 'b-tailstyle', 'b-origin-auto', 'b-clip', 'b-samestroke'];   // ces réglages changent les curseurs affichés

function initBubbleUI() {
  const fl = $('#bfloat', root), ta = $('#bedit', root);
  // la liste déroulante réutilise les gestionnaires du volet (curseurs, cases, police, modèle…)
  fl.addEventListener('click', e => {
    if (e.target.closest('[data-act]')) { onDock(e); return; }
    const t = e.target.closest('[data-bf]'), b = bubble();
    if (!t || !b) return;
    const a = t.dataset.bf;
    if (a === 'text') { bfTab = null; openBubbleEdit(); return; }
    if (a === 'tab-text' || a === 'tab-shape' || a === 'tab-tail') { const k = a.slice(4); bfTab = bfTab === k ? null : k; placeBubbleUI(); return; }
    if (a === 'shape') {
      const cur = props(b).shape, i = SHAPE_ORDER.findIndex(s => s[0] === cur), next = SHAPE_ORDER[(i + 1) % SHAPE_ORDER.length];
      const before = snapshotBubble(b); b.shape = next[0]; refitBubble(b); commitBubbleEdit(b, before); rememberBubble(b); toast(next[2], { duration: 900 });
    } else if (a === 'tail') {
      const before = snapshotBubble(b);
      if (b.tail) { tailMemory.set(b.id, b.tail); setTail(b, false); }
      else { setTail(b, true); if (tailMemory.has(b.id)) b.tail = tailMemory.get(b.id); if (b.tailStyle === 'none') delete b.tailStyle; }
      commitBubbleEdit(b, before); rememberBubble(b);
    } else if (a === 'dup') duplicateBubble(b);
    else if (a === 'del') { deleteBubble(b); bfTab = null; toast('Bulle supprimée.', { actionLabel: 'Annuler', duration: 7000, onAction: undo }); }
    fl._html = ''; placeBubbleUI();
  });
  fl.addEventListener('input', e => { onDockInput0(e); const id = e.target.id; if (STRUCTURAL.includes(id)) { fl._html = ''; placeBubbleUI(); } });
  fl.addEventListener('change', e => { onDockChange(e); fl._html = ''; placeBubbleUI(); });
  fl.addEventListener('focusin', onDockFocus);
  // pendant qu'on règle un curseur, la barre et la liste ne suivent plus la bulle (elle grossit avec le corps du texte : la liste fuirait sous le doigt)
  fl.addEventListener('pointerdown', () => { fl._frozen = true; });
  // le dégel attend un peu : reconstruire la barre entre le relâchement et le « click » ferait perdre le toucher
  const thaw = () => { if (fl._frozen) setTimeout(() => { fl._frozen = false; fl._html = ''; placeBubbleUI(); }, 80); };
  window.addEventListener('pointerup', thaw); window.addEventListener('pointercancel', thaw);
  ta.addEventListener('input', () => { const b = bubble(); if (!b) return; b.text = ta.value; refitBubble(b); markChanged(); requestRender(); });
  ta.addEventListener('blur', () => {
    const b = bubble();
    ta.hidden = true;
    if (b && editBefore) commitBubbleEdit(b, editBefore);
    editBefore = null; renderDock(); placeBubbleUI();
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); ta.blur(); } });
  const ok = $('#beditok', root);
  ok.addEventListener('pointerdown', e => e.preventDefault());   // garde le focus jusqu'au clic
  ok.addEventListener('click', () => { ta.blur(); ok.hidden = true; requestRender(); });
}

function openBubbleEdit() {
  const b = bubble(), ta = $('#bedit', root);
  if (!b || !ta) return;
  editBefore = snapshotBubble(b);
  ta.value = b.text || ''; ta.hidden = false; placeBubbleUI(); ta.focus(); ta.select();
}

// Posé après chaque image : la barre au-dessus de la poignée de rotation (en dessous si elle sortirait de l'écran), le champ de saisie sur la bulle.
function placeBubbleUI() {
  const fl = $('#bfloat', root), ta = $('#bedit', root);
  if (!fl || !ta) return;
  const b = ed.tool === 'bubble' && !ed.bubbleDraw ? bubble() : null;
  if (!b || b.hidden) { fl.hidden = true; bfTab = null; if (!ta.hidden) ta.hidden = true; const ok = $('#beditok', root); if (ok) ok.hidden = true; return; }
  const k = view.s, c = toScreen(b.x + b.w / 2, b.y + b.h / 2);
  const ok = $('#beditok', root);
  if (!ta.hidden) {
    const tw = Math.max(b.w * k, 170), th = Math.max(b.h * k, 76);   // champ assez grand pour taper même si la bulle est petite
    ta.style.width = tw + 'px'; ta.style.height = th + 'px'; ta.style.left = c.x - tw / 2 + 'px'; ta.style.top = c.y - th / 2 + 'px';
    ta.style.transform = `rotate(${(b.rot || 0) * Math.PI / 180 + view.r}rad)`;
    const R = Math.hypot(tw, th) / 2;   // en haut à droite du champ, même tourné
    if (ok) { ok.hidden = false; ok.style.left = Math.min(view.w - 50, c.x + tw / 2 - 8) + 'px'; ok.style.top = Math.max(4, c.y - Math.min(R, th / 2 + 30) - 22) + 'px'; }
  } else if (ok) ok.hidden = true;
  const cur = props(b).shape, sh = SHAPE_ORDER.find(s => s[0] === cur) || SHAPE_ORDER[0];
  const tab = (id, ico, label) => `<button data-bf="tab-${id}" class="tab ${bfTab === id ? 'on' : ''}" aria-expanded="${bfTab === id}" title="Réglages : ${label}">${icon(ico)}<span>${label}</span>${icon('chevron-down')}</button>`;
  const drop = bfTab === 'text' ? bubbleText(b) : bfTab === 'shape' ? bubbleShape(b) : bfTab === 'tail' ? bubbleTail(b) : '';
  const html = `<div class="bfbar"><button data-bf="text" title="Écrire" aria-label="Écrire le texte">${icon('writing')}</button>
    <button data-bf="shape" title="Forme : ${sh[2]} (touche pour changer)" aria-label="Changer la forme, actuelle : ${sh[2]}">${icon(sh[1])}</button>
    <button data-bf="tail" class="${b.tail ? 'on' : ''}" title="${b.tail ? 'Retirer la queue' : 'Ajouter une queue'}" aria-label="${b.tail ? 'Retirer la queue' : 'Ajouter une queue'}" aria-pressed="${!!b.tail}">${icon(b.tail ? 'message-circle' : 'message-circle-off')}</button>
    <i class="sep"></i>${tab('text', 'typography', 'Texte')}${tab('shape', 'shape', 'Forme')}${tab('tail', 'message-circle-plus', 'Queue')}<i class="sep"></i>
    <button data-bf="dup" title="Dupliquer" aria-label="Dupliquer la bulle">${icon('copy')}</button>
    <button data-bf="del" title="Supprimer" aria-label="Supprimer la bulle">${icon('trash')}</button></div>${drop ? `<div class="bfdrop">${drop}</div>` : ''}`;
  const a = document.activeElement, typing = fl.contains(a) && a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  if (fl._html !== html) {
    fl._html = html;
    if (!typing && !fl._frozen) {   // pas de reconstruction sous un doigt qui règle un curseur ou tape (Safari ne donne pas le focus aux curseurs : on regarde aussi le doigt posé)
      const keep = fl.querySelector('.bfdrop') ? fl.querySelector('.bfdrop').scrollTop : 0;
      fl.innerHTML = html; const d = fl.querySelector('.bfdrop'); if (d) d.scrollTop = keep;
    }
  }
  fl.hidden = !ta.hidden || !!b.locked;
  if (fl.hidden || fl._frozen) return;
  const bar = fl.querySelector('.bfbar'), w = Math.max(bar ? bar.offsetWidth : 360, drop ? 330 : 0), barH = 52, rh = bubbleRotHandle(b);
  let top = rh.y - 20 - barH;
  if (top < 6) { const bottom = toScreen(b.x + b.w / 2, b.y + b.h); top = Math.min(view.h - barH - 6, bottom.y + 44); }
  const left = Math.max(w / 2 + 6, Math.min(view.w - w / 2 - 6, rh.x));
  fl.style.left = left + 'px'; fl.style.top = Math.max(6, top) + 'px';
  const d = fl.querySelector('.bfdrop');
  if (d) {
    d.style.maxHeight = Math.max(160, view.h - Math.max(6, top) - barH - 20) + 'px';
    // la liste se range à côté de la bulle (jamais dessus : on veut voir l'effet des réglages) ; à défaut, sous la barre
    const xs = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => { const q = bubbleToPage(b, x, y); return toScreen(q.x, q.y).x; });
    const minX = Math.min(...xs), maxX = Math.max(...xs), dw = 320, barLeft = left - (bar ? bar.offsetWidth : 360) / 2;
    const roomR = view.w - 6 - (maxX + 16 + dw), roomL = minX - 16 - dw - 6;
    d.classList.toggle('side', roomR >= 0 || roomL >= 0);
    if (roomR >= 0 || roomL >= 0) d.style.left = ((roomR >= roomL ? maxX + 16 : minX - 16 - dw) - barLeft) + 'px'; else d.style.left = '';
  }
}

let bubbleBefore = null;
// Reprend un réglage de trame enregistré (trame, échelle, fond blanc, encre).
function applyTramaPreset(id) {
  const t = ed.tramaPresets.find(x => x.id === id);
  if (!t) return;
  if (!TOOL_TRAMA.includes(ed.tool)) setTool('pencil');
  ed.tramaId = allTramas(ed.project).some(x => x.id === t.tramaId) ? t.tramaId : 'plein';
  ed.tramaScale = t.tramaScale; ed.tramaOpaque = t.tramaOpaque;
  setColor(t.color || (t.ink === 2 ? '#FFFFFF' : t.ink === 3 ? ed.color : '#000000'), false); updateColorWidget();
  savePrefs(); renderDock(); renderOptbar();
}

function onDockFocus(e) { const b = bubble(); if (b && /^b-/.test(e.target.id || '')) bubbleBefore = snapshotBubble(b); }

function onDockInput(e) { onDockInput0(e); syncPop(); }
function onDockInput0(e) {
  const id = e.target.id, b = bubble();
  if (/^p-/.test(id)) {
    const key = id.slice(2);
    if (e.target.type === 'checkbox') ed.brushParams[key] = e.target.checked;
    else if (e.target.tagName === 'SELECT') ed.brushParams[key] = e.target.value;
    else {
      ed.brushParams[key] = +e.target.value;
      const lab = e.target.previousElementSibling, row = BPARAMS.find(r => r[0] === key);
      if (lab) lab.textContent = lab.textContent.replace(/ : .*$/, ' : ' + (row ? row[5](+e.target.value) : key === 'angle' ? e.target.value + '°' : key === 'grainScale' ? e.target.value + ' px' : pct(+e.target.value)));
    }
    afterBrushChange(); paintBprev(root);
    return;
  }
  if (id === 'o-mm') { const mm = parseFloat(String(e.target.value).replace(',', '.')); if (mm > 0) { setSizeMm(mm); updateQuick('size'); storeSlot(); savePrefs(); paintSlots($('#optbar', root)); } return; }
  if (id === 'o-alpha') { setAlpha(+e.target.value / 100); e.target.previousElementSibling.textContent = `Opacité : ${Math.round(ed.alpha * 100)} %`; updateQuick('alpha'); storeSlot(); savePrefs(); paintSlots($('#optbar', root)); return; }
  if (id === 'o-pressure') { ed.pressure = e.target.checked; savePrefs(); return; }
  if (id === 'c-hex') { const v = e.target.value.trim(); const h = v[0] === '#' ? v : '#' + v; if (/^#[0-9a-f]{6}$/i.test(h)) { setColor(h, false); updateColorWidget(); const pe = $('#pop', root); paintPicker(pe); const now = $('.cpk-now', pe); if (now) now.style.background = ed.color; } return; }
  if (id === 'd-scale') { ed.tramaScale = +e.target.value; e.target.previousElementSibling.textContent = 'Échelle : ×' + ed.tramaScale; paintSwatches(root); if (ed.tool === 'pencil') storeSlot(); paintBprev(root); return; }
  if (id === 'd-opaque') { ed.tramaOpaque = e.target.checked; if (ed.tool === 'pencil') storeSlot(); paintBprev(root); return; }
  if (id === 'n-plan') { setNote('plan', e.target.value); return; }
  if (id === 'n-desc') { setNote('description', e.target.value); return; }
  if (id === 'l-tint') { const l = activeLayer(); l.color = e.target.value === '#000000' ? undefined : e.target.value; if (!l.color) delete l.color; invalidate(panel()); markChanged(); return; }
  if (id === 'l-op') { const l = activeLayer(); l.opacity = +e.target.value; e.target.previousElementSibling.textContent = `Opacité : ${l.opacity} %`; invalidate(panel()); markChanged(); return; }
  if (id === 'l-lock') { setLayerProp(activeLayer().id, 'locked', e.target.checked); return; }
  if (id === 'l-blend') { const l = activeLayer(); setLayerProp(l.id, 'blend', e.target.value); toast(`Mode de fusion de « ${l.name} » : ${(BLEND_MODES.find(m => m[0] === e.target.value) || ['', 'Normal'])[1]}.`, { duration: 1800 }); return; }
  if (id === 'l-ref') { setLayerProp(activeLayer().id, 'reference', e.target.checked); return; }
  if (id === 'l-alpha') { setLayerProp(activeLayer().id, 'alphaLock', e.target.checked); return; }
  if (id === 'l-draft') {   // brouillon ↔ son ancien type (encre par défaut)
    const l = activeLayer();
    if (e.target.checked) { l.prevKind = l.kind; setLayerProp(l.id, 'kind', 'draft'); } else setLayerProp(l.id, 'kind', l.prevKind || 'ink');
    return;
  }
  if (id === 'l-solo') { setSolo(activeLayer().id); return; }
  if (id === 'n-stroke') { setPanelStroke(+e.target.value); e.target.previousElementSibling.textContent = `Trait du cadre : ${fmtMm(+e.target.value)} mm`; return; }
  if (id === 'n-show') { ed.showNotes = e.target.checked; savePrefs(); requestRender(); return; }
  if (!b || !/^b-/.test(id)) return;
  if (!bubbleBefore) bubbleBefore = snapshotBubble(b);
  if (id === 'b-text') { b.text = e.target.value; refitBubble(b); }
  else if (id === 'b-ptr' || id === 'b-pt') {   // curseur logarithmique (fin pour les petits corps, large pour les gros) ou champ numérique
    const v = +e.target.value;
    if (id === 'b-ptr') b.pt = vToPt(v); else if (v >= 5 && v <= 200) b.pt = v; else return;
    const host = e.target.closest('.bfdrop, .pop-body') || root, lab = host.querySelector('#b-ptr') && host.querySelector('#b-ptr').previousElementSibling, num = host.querySelector('#b-pt'), rng = host.querySelector('#b-ptr');
    if (lab) lab.textContent = `Corps : ${b.pt} pt`;
    if (id === 'b-ptr' && num) num.value = b.pt; if (id === 'b-pt' && rng) rng.value = ptToV(b.pt);
    refitBubble(b);
  }
  else if (id === 'b-caps') { b.caps = e.target.checked; refitBubble(b); }
  else if (id === 'b-auto') { b.auto = e.target.checked; refitBubble(b); }
  else if (id === 'b-kind') {
    Object.assign(b, preset(e.target.value), ed.bubbleDefaults[e.target.value] || {}); b.kind = e.target.value;
    if (b.path) b.shape = 'libre';
    setTail(b, b.tailStyle !== 'none');
    refitBubble(b);
  } else if (id === 'b-shape') { b.shape = e.target.value; refitBubble(b); }
  else if (SLIDERS[id]) {
    const [key, label] = SLIDERS[id];
    b[key] = +e.target.value; e.target.previousElementSibling.textContent = label(b[key]);
    if (key === 'rot' && !b.rot) delete b.rot;
    if (key === 'pad') refitBubble(b);
    if (key === 'edge') snapNarration(b, page().panels, { zone: mmToPx(10.5, ed.project.dpi) });   // la bulle suit sa marge
  }
  else if (id === 'b-cloudsoft') { if (e.target.checked) b.cloudSoft = 1; else b.cloudSoft = 0; }
  else if (id === 'b-clip') { if (e.target.checked) b.clip = true; else { delete b.clip; delete b.noFrame; } }
  else if (id === 'b-noframe') { if (e.target.checked) b.noFrame = true; else delete b.noFrame; }
  else if (id === 'b-samestroke') { if (e.target.checked) b.sameStroke = true; else delete b.sameStroke; }
  else if (id === 'b-origin-auto') {
    if (e.target.checked) delete b.tailAngle;
    else if (b.tail) b.tailAngle = Math.round(((Math.atan2(b.tail.y - (b.y + b.h / 2), b.tail.x - (b.x + b.w / 2)) * 180 / Math.PI) - (b.rot || 0) + 720) % 360);
  } else if (id === 'b-tailstyle') { b.tailStyle = e.target.value; setTail(b, b.tailStyle !== 'none'); }
  requestRender();
}

function onDockChange(e) {
  if (e.target.id === 'c-hex') { setColor(ed.color); savePrefs(); const pe = $('#pop', root); if (pe) pe._html = ''; renderPop(); return; }
  if (/^p-(shape|grainType|follow)$/.test(e.target.id || '')) { const pe = $('#pop', root); if (pe) pe._html = ''; renderPop(); renderOptbar(); return; }
  if (/^p-/.test(e.target.id || '')) { paintBrushPreviews($('#pop', root)); return; }
  const b = bubble();
  if (b && /^b-/.test(e.target.id || '') && bubbleBefore) {
    commitBubbleEdit(b, bubbleBefore); bubbleBefore = null;
    if (e.target.id !== 'b-text' && e.target.id !== 'b-kind') rememberBubble(b);
    // Pas de reconstruction du volet à chaque champ : un toucher sur un bouton qui suit la sortie d'un champ serait perdu.
    if (['b-kind', 'b-shape', 'b-tailstyle', 'b-origin-auto', 'b-clip', 'b-samestroke'].includes(e.target.id)) { const pe = $('#pop', root); if (pe) pe._html = ''; renderPop(); }
    renderDock();
  } else if (/^n-/.test(e.target.id || '')) markChanged();
}

// ───────────────────────── Fenêtres de l'éditeur ─────────────────────────

function pickLayout(title) {
  return new Promise(resolve => {
    let done = false;
    const m = openModal({
      title, body: `<div class="layout-grid">${LAYOUTS.map(l => `<button type="button" class="layout-opt" data-layout="${l.id}">${layoutSvg(l)}${esc(l.name)}</button>`).join('')}</div>`,
      onClose: () => { if (!done) resolve(null); },
    });
    m.el.addEventListener('click', e => {
      const b = e.target.closest('[data-layout]');
      if (b) { done = true; resolve(b.dataset.layout); m.close(); }
    });
  });
}

function tramaEditor(existing) {
  let size = existing ? existing.w : 8;
  let bits = existing ? existing.bits.slice() : new Uint8Array(size * size);
  const id = existing ? existing.id : 't' + Math.random().toString(36).slice(2, 8);
  const m = openModal({
    title: existing ? 'Modifier la trame' : 'Nouvelle trame',
    body: `<label class="field"><span>Nom</span><input type="text" id="te-name" value="${esc(existing ? existing.name : 'Ma trame')}" maxlength="40"></label>
      <div class="field"><span>Taille de la tuile</span><div class="seg" id="te-size">${[4, 8, 12, 16, 24].map(s => `<button type="button" data-s="${s}" class="${s === size ? 'on' : ''}">${s}</button>`).join('')}</div></div>
      <div id="te-grid" class="trame-editor"></div>
      <div class="row" style="justify-content:center"><canvas id="te-prev" width="160" height="80" style="border:1px solid var(--border);image-rendering:pixelated"></canvas></div>
      <small style="color:var(--text-muted)">Touche ou fais glisser pour allumer ou éteindre les cases. Un 1 est de l'encre.</small>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="te-lib" ${!existing || existing.lib ? 'checked' : ''}> Dans ma bibliothèque (tous les projets, sur cet appareil)</label>`,
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (c, box) => {
      const t = { id, name: $('#te-name', box).value.trim() || 'Ma trame', w: size, h: size, bits };
      const enc = encodeTrama(t), list = ed.project.tramas, i = list.findIndex(x => x.id === id);
      if ($('#te-lib', box).checked) {
        if (i >= 0) list.splice(i, 1);
        await saveToLibrary(t);
      } else {
        if (existing && existing.lib) await removeFromLibrary(id);
        if (i >= 0) list[i] = enc; else list.push(enc);
      }
      ed.tramaId = id; markChanged(); renderDock(); renderOptbar();
    } }],
  });
  const grid = $('#te-grid', m.el);
  function draw() {
    grid.style.gridTemplateColumns = `repeat(${size}, 22px)`;
    grid.innerHTML = Array.from({ length: size * size }, (_, i) => `<i data-i="${i}" class="${bits[i] ? 'on' : ''}"></i>`).join('');
    const pv = $('#te-prev', m.el);
    drawTramaSwatch(pv, { w: size, h: size, bits }, 2);
  }
  draw();
  let paintVal = null;
  const cellAt = e => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.dataset && el.dataset.i !== undefined ? el : null; };
  grid.addEventListener('pointerdown', e => {
    const c = cellAt(e); if (!c) return;
    paintVal = bits[+c.dataset.i] ? 0 : 1; bits[+c.dataset.i] = paintVal; c.classList.toggle('on', !!paintVal);
    grid.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', e => {
    if (paintVal === null) return;
    const c = cellAt(e); if (c && bits[+c.dataset.i] !== paintVal) { bits[+c.dataset.i] = paintVal; c.classList.toggle('on', !!paintVal); }
  });
  grid.addEventListener('pointerup', () => { paintVal = null; drawTramaSwatch($('#te-prev', m.el), { w: size, h: size, bits }, 2); });
  $('#te-size', m.el).addEventListener('click', e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    size = +b.dataset.s; bits = new Uint8Array(size * size);
    $$('#te-size button', m.el).forEach(x => x.classList.toggle('on', x === b)); draw();
  });
}

function ditherModal() {
  const p = panel();
  let bitmap = null, result = null, timer = 0;
  const opts = { method: 'floyd', threshold: 128, brightness: 0, contrast: 0, fit: 'contain', ...ed.ditherOpts };
  const m = openModal({
    title: 'Image tramée', wide: true,
    body: `<p>Transforme une photo ou un dessin en noir et blanc tramé, placé dans un nouveau calque de la case ${page().panels.indexOf(p) + 1}.</p>
      <label class="field" style="margin-top:10px"><span>Image</span><input type="file" id="di-file" accept="image/*"></label>
      <div id="di-ctl" hidden>
        <label class="field"><span>Méthode</span><select id="di-method">${DITHER_METHODS.map(d => `<option value="${d.id}" ${d.id === opts.method ? 'selected' : ''}>${d.name}</option>`).join('')}</select></label>
        <label class="field"><span>Seuil</span><input type="range" id="di-th" min="20" max="235" value="${opts.threshold}"></label>
        <label class="field"><span>Luminosité</span><input type="range" id="di-br" min="-100" max="100" value="${opts.brightness}"></label>
        <label class="field"><span>Contraste</span><input type="range" id="di-co" min="-100" max="100" value="${opts.contrast}"></label>
        <label class="field"><span>Cadrage</span><select id="di-fit"><option value="contain" ${opts.fit === 'contain' ? 'selected' : ''}>Image entière</option><option value="cover" ${opts.fit === 'cover' ? 'selected' : ''}>Remplir la case</option></select></label>
        <canvas id="di-prev" class="dither-prev"></canvas>
      </div>`,
    actions: [{ label: 'Annuler' }, { label: 'Placer dans la case', kind: 'primary', onClick: () => {
      if (!result) { toast('Choisis d\'abord une image.'); return false; }
      addImageLayer('Image tramée', result);
    } }],
  });
  function compute() {
    if (!bitmap) return;
    const gray = imageToGray(bitmap, p.w, p.h, opts);
    result = ditherGray(gray, p.w, p.h, opts.method, opts.threshold);
    const c = $('#di-prev', m.el); c.width = p.w; c.height = p.h;
    const cx = c.getContext('2d'), img = cx.createImageData(p.w, p.h), d = new Uint32Array(img.data.buffer);
    for (let i = 0; i < result.length; i++) d[i] = result[i] ? 0xFF000000 : 0xFFFFFFFF;
    cx.putImageData(img, 0, 0);
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(compute, 120); };
  $('#di-file', m.el).addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { bitmap = await createImageBitmap(f); } catch { toast('Image illisible.', { type: 'error' }); return; }
    $('#di-ctl', m.el).hidden = false; compute();
  });
  m.el.addEventListener('input', e => {
    const id = e.target.id;
    if (id === 'di-method') opts.method = e.target.value; else if (id === 'di-th') opts.threshold = +e.target.value;
    else if (id === 'di-br') opts.brightness = +e.target.value; else if (id === 'di-co') opts.contrast = +e.target.value;
    else if (id === 'di-fit') opts.fit = e.target.value; else return;
    ed.ditherOpts = { ...opts }; savePrefs();
    later();
  });
}

// Choix de la police : chaque nom est écrit dans sa propre police.
function fontModal() {
  const b = bubble();
  if (!b) return;
  const cur = props(b).font;
  const list = () => [...new Set(FONTS.map(f => f.group))].map(g => `<h3>${esc(g)}</h3>${FONTS.filter(f => f.group === g).map(f =>
    `<button class="font-opt ${f.id === cur ? 'on' : ''}" data-font="${f.id}" style="font-family:'${f.family}',sans-serif;font-weight:${f.weight}">${esc(f.name)}<span>Bonjour, ça va ? 0123</span></button>`).join('')}`).join('');
  const m = openModal({
    title: 'Police de la bulle', wide: true,
    body: `<div id="font-list">${list()}</div>
      <div class="modal-sec"><h3>Importer une police</h3>
        <input type="file" id="font-file" accept=".ttf,.otf,.woff,.woff2">
        <small style="display:block;margin-top:6px;color:var(--text-muted)">Une police importée reste sur cet appareil : à réimporter sur les autres pour voir les mêmes lettres.</small></div>`,
  });
  FONTS.forEach(f => loadFont(f.id));   // pour que chaque nom s'affiche dans sa police
  const apply = id => {
    const before = snapshotBubble(b);
    b.font = id;
    loadFont(id).then(() => { refitAutoBubbles(); requestRender(); });
    refitBubble(b); commitBubbleEdit(b, before); rememberBubble(b); renderDock(); m.close();
  };
  m.el.addEventListener('click', e => { const f = e.target.closest('[data-font]'); if (f) apply(f.dataset.font); });
  $('#font-file', m.el).addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { apply(await importFont(file)); toast('Police importée.'); } catch (err) { toast(err.message, { type: 'error' }); }
  });
}

// Copie le contenu de la case active dans une autre case, de cette page ou d'une autre.
function copyModal() {
  const src = panel(), srcIdx = page().panels.indexOf(src);
  let pageIdx = ed.pageIdx, target = null, mode = 'same';
  const m = openModal({
    title: `Copier la case ${srcIdx + 1}`, wide: true,
    body: `<label class="field"><span>Page de destination</span><select id="cp-page">${ed.project.pages.map((_, i) => `<option value="${i}" ${i === pageIdx ? 'selected' : ''}>Page ${i + 1}</option>`).join('')}</select></label>
      <div class="field"><span>Case de destination</span><div id="cp-grid" style="max-width:240px"></div></div>
      <div class="field"><span>Si les cases n'ont pas la même taille</span><div class="seg" id="cp-mode"><button type="button" data-m="same" class="on">Taille d'origine</button><button type="button" data-m="fit">Ajuster</button></div></div>
      <small style="color:var(--text-muted)">Les calques de la case de destination sont remplacés. Les bulles ne sont pas copiées.</small>`,
    actions: [{ label: 'Annuler' }, { label: 'Copier', kind: 'primary', onClick: async () => {
      if (!target) { toast('Touche la case de destination.'); return false; }
      const ok = await copyPanelTo(src, pageIdx, target, mode);
      if (ok) toast(pageIdx === ed.pageIdx ? 'Contenu copié.' : `Contenu copié dans la page ${pageIdx + 1}.`);
    } }],
  });
  const grid = () => {
    const pg = ed.project.pages[pageIdx], { w, h } = pageSize(ed.project);
    $('#cp-grid', m.el).innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;border:1px solid var(--border);background:#fff">${pg.panels.map(c => {
      const isSrc = pageIdx === ed.pageIdx && c.id === src.id, on = c.id === target;
      return `<rect data-p="${c.id}" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${on ? 'rgba(192,57,43,.25)' : isSrc ? 'rgba(0,0,0,.12)' : 'transparent'}" stroke="${on ? '#C0392B' : '#000'}" stroke-width="${Math.round(w / (on ? 60 : 120))}" style="${isSrc ? '' : 'cursor:pointer'}"/>`;
    }).join('')}</svg>`;
  };
  grid();
  m.el.addEventListener('click', e => {
    const r = e.target.closest('[data-p]'), md = e.target.closest('#cp-mode [data-m]');
    if (r && !(pageIdx === ed.pageIdx && r.dataset.p === src.id)) { target = r.dataset.p; grid(); }
    if (md) { mode = md.dataset.m; $$('#cp-mode button', m.el).forEach(x => x.classList.toggle('on', x === md)); }
  });
  $('#cp-page', m.el).addEventListener('change', e => { pageIdx = +e.target.value; target = null; grid(); });
}

// Menu d'export : PDF de toutes les pages, PNG de la page affichée, sauvegarde JSON du projet.
function exportMenu() {
  const m = openModal({
    title: 'Exporter', narrow: true,
    body: `<div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn primary" data-m="pdf">${icon('file-type-pdf')} PDF · ${ed.project.pages.length} page${ed.project.pages.length > 1 ? 's' : ''}, ${ed.project.dpi} dpi</button>
      <button class="btn" data-m="png">${icon('photo')} PNG · page ${ed.pageIdx + 1}</button>
      <button class="btn" data-m="json">${icon('file-export')} Sauvegarde JSON du projet</button></div>
      <p style="margin-top:12px;color:var(--text-muted);font-size:.82rem">Le PDF contient les cases, leurs cadres et les bulles ; les calques « brouillon » et les notes ne sont pas imprimés.</p>`,
  });
  m.el.onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    m.close();
    if (b.dataset.m === 'pdf') exportPdf(); else if (b.dataset.m === 'png') exportPng(); else exportJson();
  };
}

// ───────────────────────── Menu du projet et exports ─────────────────────────

export function projectMenu() {
  const m = openModal({
    title: ed.project.title, narrow: true,
    body: `<div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn" data-m="rename">${icon('pencil')} Renommer</button>
      <button class="btn" data-m="pdf">${icon('file-type-pdf')} Exporter en PDF</button>
      <button class="btn" data-m="png">${icon('photo')} Page en PNG</button>
      <button class="btn" data-m="json">${icon('file-export')} Projet en JSON (sauvegarde)</button></div>`,
  });
  m.el.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    m.close();
    if (b.dataset.m === 'rename') {
      const name = await promptModal({ title: 'Renommer le projet', label: 'Titre', value: ed.project.title });
      if (name) { ed.project.title = name; markChanged(); notify('title'); }
    } else if (b.dataset.m === 'pdf') exportPdf();
    else if (b.dataset.m === 'png') exportPng();
    else exportJson();
  };
}

async function exportPdf() {
  await saveNow();
  const close = toast('Création du PDF…', { duration: 600000 });
  try {
    const blob = await buildPDF(ed.project, {
      prepare: pg => loadPage(ed.project, pg),
      release: pg => { if (pg !== page()) unloadPage(pg); },
    });
    download(blob, safeName(ed.project.title) + '.pdf');
    toast('PDF prêt.');
  } catch (err) { console.error(err); toast('Le PDF n\'a pas pu être créé.', { type: 'error' }); }
  close();
}

async function exportPng() {
  await ensureFonts(ed.project, [page()]);
  const blob = await canvasToBlob(renderPage(ed.project, page(), 1));
  download(blob, `${safeName(ed.project.title)}-page-${ed.pageIdx + 1}.png`);
}

async function exportJson() {
  await saveNow();
  const data = await exportProject(ed.project.id);
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeName(ed.project.title) + '.fusain.json');
}

// ───────────────────────── Bibliothèque en fenêtre (menu Outils) ─────────────────────────

function libraryModal(mode) {
  const m = openModal({ title: 'Bibliothèque', wide: false, body: '<div class="lib-body"></div>' });
  const body = $('.lib-body', m.el);
  const draw = () => {
    const seg = `<div class="seg" role="group" aria-label="Bibliothèque" style="margin-bottom:10px">${[['brushes', 'Pinceaux', 'brush'], ['tramas', 'Trames', 'texture'], ['bubbles', 'Bulles', 'message-circle']].map(([id, n, ic]) =>
      `<button data-lib="${id}" class="${mode === id ? 'on' : ''}">${icon(ic)} ${n}</button>`).join('')}</div>`;
    const bubbles = `<p style="margin-bottom:8px;color:var(--text-secondary)">Choisis un modèle : la bulle est posée dans la case ouverte.</p>
      <div class="row tight">${allBubbleTemplates().map(t => `<button class="btn" data-addtpl="${t.id}">${icon((BUBBLE_KINDS.find(k => k.id === t.kind) || BUBBLE_KINDS[0]).icon)} ${esc(t.name)}</button>`).join('')}
      <button class="btn" data-freebubble="1">${icon('writing')} Dessinée à la main</button></div>`;
    body.innerHTML = seg + (mode === 'brushes' ? brushesParts().list : mode === 'tramas' ? tramasTab() : bubbles);
    paintSwatches(body); paintLibrary(body);
  };
  draw();
  attachHold(m.el);
  const redraw = () => { if (m.el.isConnected) draw(); else window.removeEventListener('fusain:brushes', redraw); };
  window.addEventListener('fusain:brushes', redraw);
  m.el.addEventListener('click', async e => {
    const lib = e.target.closest('[data-lib]'), add = e.target.closest('[data-addtpl]'), free = e.target.closest('[data-freebubble]');
    if (lib) { mode = lib.dataset.lib; draw(); return; }
    if (add || free) {
      m.close();
      if (ed.tool !== 'bubble') setTool('bubble');
      if (add) { ed.bubbleTemplate = add.dataset.addtpl; savePrefs(); addTemplateBubble(); setTimeout(openBubbleEdit, 0); } else ed.bubbleDraw = true;
      renderOptbar(); renderPop(); return;
    }
    const closes = e.target.closest('[data-brush],[data-trama]');
    await onDock(e);
    if (closes) { m.close(); return; }
    if (m.el.isConnected) draw();
  });
}

// ───────────────────────── Commandes du menu de l'en-tête ─────────────────────────

const showDock = tab => { dockTab = tab; toggleDock(true); };
const needLayer = () => { if (!deleteLayer()) toast('Une case garde au moins un calque.'); };
const COMMANDS = {
  'new-project': () => newProjectModal(), 'import-decoupage': () => decoupageModal(),
  rename: async () => { const name = await promptModal({ title: 'Renommer le projet', label: 'Titre', value: ed.project.title }); if (name) { ed.project.title = name; markChanged(); notify('title'); } },
  'export-pdf': exportPdf, 'export-png': exportPng, 'export-json': exportJson,
  undo, redo, 'clear-layer': clearActiveLayer, 'copy-case': copyModal,
  'del-case': () => { if (page().panels.length > 1) { if (deletePanel()) toast('Case supprimée.', { actionLabel: 'Annuler', duration: 8000, onAction: undo }); } else toast('Une page garde au moins une case.'); },
  'del-bubble': () => { const b = bubble(); if (b) deleteBubble(b); else toast('Aucune bulle sélectionnée.'); },
  fit, focus: () => setFocus(!ed.focus), 'zoom-in': () => zoomAt(view.w / 2, view.h / 2, 1.5), 'zoom-out': () => zoomAt(view.w / 2, view.h / 2, 1 / 1.5),
  'tool-layout': () => setTool('layout'),
  'sel-all': () => { if (ed.tool !== 'select') setTool('select'); selectAll(panel()); },
  'sel-none': () => { polyCancel(); clearSelection(); renderOptbar(); },
  'move-case': () => { if (ed.tool !== 'select') setTool('select'); polyCancel(); clearSelection(); ed.selMove = true; renderOptbar(); toast('Fais glisser pour déplacer tout le contenu de la case.', { duration: 3000 }); },
  relayout: async () => { const id = await pickLayout('Disposition des cases'); if (id) { const r = relayoutPage(id); if (r.removed) toast(`${r.removed} case${r.removed > 1 ? 's' : ''} retirée${r.removed > 1 ? 's' : ''} (leur dessin revient avec Annuler).`, { actionLabel: 'Annuler', duration: 9000, onAction: undo }); } },
  frame: () => { secState.cf = true; setFocus(false); showDock('page'); },
  dither: ditherModal,
  'add-color': () => addLayer('color'), 'add-ink': () => addLayer('ink'), 'add-draft': () => addLayer('draft'),
  'rot-view': () => rotateView(Math.PI / 2), 'rot-reset': () => rotateView(),
  'dup-bubble': () => { if (!duplicateBubble()) toast('Sélectionne une bulle.'); }, 'dup-layer': dupWithToast, 'merge-layer': mergeWithToast, 'del-layer': needLayer,
  'lock-layer': () => { const l = activeLayer(); setLayerProp(l.id, 'locked', !l.locked); },
  'solo-layer': () => setSolo(activeLayer().id),
  'add-page': async () => { const id = await pickLayout('Nouvelle page'); if (id) await addPage(id); },
  'dup-page': () => duplicatePage(),
  'del-page': async () => { if (ed.project.pages.length < 2) { toast('Un projet garde au moins une page.'); return; } const restore = await deletePage(); if (restore) toast('Page supprimée.', { actionLabel: 'Annuler', duration: 8000, onAction: restore }); },
  'page-left': () => movePage(-1), 'page-right': () => movePage(1),
  'page-prev': () => goToPage(ed.pageIdx - 1), 'page-next': () => goToPage(ed.pageIdx + 1),
  fullscreen: () => toggleFullscreen(),
  dock: () => setDock(narrow() ? (dockOpen ? 'hidden' : 'full') : { full: 'mini', mini: 'hidden', hidden: 'full' }[dockMode()]),
  notes: () => { ed.showNotes = !ed.showNotes; savePrefs(); requestRender(); },
  'hide-bubbles': () => togglePageBubbles(),
};
Object.assign(COMMANDS, { 'lib-brushes': () => libraryModal('brushes'), 'lib-tramas': () => libraryModal('tramas'), 'lib-bubbles': () => libraryModal('bubbles') });
const CASE_COMMANDS = ['add-color', 'add-ink', 'add-draft', 'dup-layer', 'merge-layer', 'del-layer', 'lock-layer', 'solo-layer', 'clear-layer',
  'sel-all', 'sel-none', 'move-case', 'dither', 'dup-bubble', 'del-bubble', 'lib-brushes', 'lib-tramas', 'lib-bubbles'];
export function runCommand(id) {
  if (id.startsWith('tool:')) { if (ed.project) setTool(id.slice(5)); return; }
  if (ed.project && CASE_COMMANDS.includes(id) && !ed.focus) setFocus(true);
  const fn = COMMANDS[id]; if (fn && ed.project) return fn(); }

// ───────────────────────── Clavier ─────────────────────────

function onKey(e) {
  if (ed.tool === 'layout' && ed.addPreview && !typing(e) && !modalOpen()) {   // aperçu d'ajout de case : Entrée ajoute, Échap abandonne
    if (e.key === 'Enter') { e.preventDefault(); if (confirmAdd()) toast('Case ajoutée.', { actionLabel: 'Annuler', duration: 6000, onAction: undo }); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelAdd(); return; }
  }
  if (e.key === 'Escape' && popId && !modalOpen()) { popId = null; renderOptbar(); renderPop(); return; }
  if (e.key === 'Escape' && ed.tool === 'select' && !modalOpen() && !typing(e)) { polyCancel(); clearSelection(); renderOptbar(); return; }
  if (typing(e) || modalOpen()) return;
  if (e.key === 'Escape' && ed.focus && !popId && !ed.sel) { setFocus(false); return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); if (ed.tool !== 'select') setTool('select'); selectAll(panel()); return; }
  if (mod) return;
  const t = TOOLS.find(x => x.key === k);
  if (t) { setTool(t.id); return; }
  if (k === 'x') { swapColors(); savePrefs(); updateColorWidget(); }
  else if (k === 'd') { resetColors(); savePrefs(); updateColorWidget(); }
  else if (k === 'c') { if (TOOL_COLOR.includes(ed.tool)) { popId = popId === 'color' ? null : 'color'; renderPop(); updateColorWidget(); } }
  else if (k === 't') { if (!TOOL_TRAMA.includes(ed.tool)) setTool('pencil'); popId = popId === 'lib-trama' ? null : 'lib-trama'; renderOptbar(); renderPop(); }
  else if (k === '[' || k === ']') { setSizeMm(k === '[' ? ed.sizeMm / 1.2 : ed.sizeMm * 1.2); updateQuick('size'); afterBrushChange(); }
  else if (k === '0') fit();
  else if (k === 'enter' && ed.tool === 'select' && polyCount()) polyFinish();
  else if (k === 'enter') setFocus(!ed.focus);
  else if (k === 'delete' || k === 'backspace') { if (ed.tool === 'select') eraseSelection(); else if (bubble()) deleteBubble(); }
}

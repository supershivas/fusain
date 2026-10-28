// Interface de l'éditeur : barre d'outils, options de l'outil, volet (calques, trames, pages, bulles, case).
import {
  ed, page, panel, activeLayer, bubble, subscribe, notify, selectLayer, addLayer, deleteLayer, moveLayer, toggleLayer, renameLayer,
  clearLayer, mergeDown, clearMask, invertMask, setNote, addBubble, deleteBubble, selectBubble, commitBubbleEdit, refitBubble,
  snapshotBubble, goToPage, addPage, duplicatePage, deletePage, movePage, relayoutPage, markChanged, saveNow, addImageLayer,
  copyPanelTo, refitAutoBubbles, peekTarget, setBubbleProp, togglePageBubbles, allBrushes, currentBrush, selectBrush, resetBrush, saveBrushAs, updateBrush, deleteBrush, duplicateLayer, setLayerProp, setSolo, storeToolSettings, applyToolSettings, setSizeMm, mergeCandidates, mergePanels, deletePanel, setPanelStroke,
} from './editor.js';
import { FONTS, loadFont, importFont, fontName } from './fonts.js';
import { BRUSH_GROUPS, previewBrush } from './raster.js';
import { attach, fit, view, zoomAt, requestRender, resize, invalidate } from './view.js';
import { attachInput, typing } from './input.js';
import { LAYOUTS, pageSize, panelStroke, DRAFT_COLORS } from './model.js';
import { allTramas, tramaById, drawTramaSwatch, encodeTrama, saveToLibrary, removeFromLibrary, DITHER_METHODS, ditherGray, imageToGray } from './tramas.js';
import { BUBBLE_KINDS, SHAPES as BUBBLE_SHAPES, TAILS, props, preset } from './bubbles.js';
import { openModal, esc, icon, $, $$, confirmModal, promptModal, modalOpen } from './ui-core.js';
import { toast } from './toast.js';
import { canFullscreen, isFullscreen, toggleFullscreen, onFullscreenChange } from './shell.js';
import { layoutSvg } from './home.js';
import { buildPDF, renderPage, canvasToBlob, download, safeName, ensureFonts } from './export.js';
import { loadPage, unloadPage } from './store.js';
import { exportProject } from './portable.js';

const TOOLS = [
  { id: 'pencil', icon: 'pencil', label: 'Crayon et pinceaux (B)', key: 'b' },
  { id: 'texture', icon: 'texture', label: 'Pinceau trame (T)', key: 't' },
  { id: 'eraser', icon: 'eraser', label: 'Gomme (E)', key: 'e' },
  { id: 'fill', icon: 'bucket-droplet', label: 'Remplir (G)', key: 'g' },
  { id: 'shape', icon: 'square', label: 'Formes (S)', key: 's' },
  { id: 'mask', icon: 'mask', label: 'Masque (M)', key: 'm' },
  { id: 'bubble', icon: 'message-circle', label: 'Bulles (V)', key: 'v' },
  { id: 'layout', icon: 'layout-board-split', label: 'Taille des cases (L)', key: 'l' },
  { id: 'pan', icon: 'hand-stop', label: 'Déplacer la vue (H)', key: 'h' },
];
const SHAPES = [{ id: 'line', icon: 'slash', label: 'Ligne' }, { id: 'rect', icon: 'square', label: 'Rectangle' }, { id: 'ellipse', icon: 'circle', label: 'Ellipse' }];
const TABS = [
  { id: 'layers', icon: 'stack-2', label: 'Calques' }, { id: 'brushes', icon: 'brush', label: 'Pinceaux' }, { id: 'tramas', icon: 'texture', label: 'Trames' },
  { id: 'pages', icon: 'files', label: 'Pages' }, { id: 'bubbles', icon: 'message-circle', label: 'Bulles' },
  { id: 'case', icon: 'layout-grid', label: 'Case' },
];

let fsListener = null;
let root, dockTab = 'layers', dockOpen = true, unsub = null, keyHandler = null;

const prefsKey = 'fusain:prefs';
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefsKey)) || {};
    if (typeof p.fingerDraws === 'boolean') ed.fingerDraws = p.fingerDraws;
    if (typeof p.pressure === 'boolean') ed.pressure = p.pressure;
    if (typeof p.pressureGamma === 'number') ed.pressureGamma = p.pressureGamma;
    if (typeof p.showNotes === 'boolean') ed.showNotes = p.showNotes;
    if (p.toolSettings && typeof p.toolSettings === 'object') ed.toolSettings = p.toolSettings;
    if (p.bubbleDefaults && typeof p.bubbleDefaults === 'object') ed.bubbleDefaults = p.bubbleDefaults;
    if (p.ditherOpts && typeof p.ditherOpts === 'object') ed.ditherOpts = p.ditherOpts;
    if (Array.isArray(p.customBrushes)) ed.customBrushes = p.customBrushes;
    if (p.brushSizes && typeof p.brushSizes === 'object') ed.brushSizes = p.brushSizes;
    if (Array.isArray(p.tramaPresets)) ed.tramaPresets = p.tramaPresets;
    if (typeof p.tool === 'string') ed.tool = p.tool === 'bubble' || p.tool === 'layout' ? 'pencil' : p.tool;
  } catch { /* préférences locales seulement */ }
}
// Préférences de l'appareil : réglages de chaque outil, dernier style de chaque type de bulle, options d'image tramée.
export function savePrefs() {
  storeToolSettings();
  try {
    localStorage.setItem(prefsKey, JSON.stringify({ fingerDraws: ed.fingerDraws, pressure: ed.pressure, pressureGamma: ed.pressureGamma, showNotes: ed.showNotes,
      toolSettings: ed.toolSettings, bubbleDefaults: ed.bubbleDefaults, ditherOpts: ed.ditherOpts, tool: ed.tool,
      customBrushes: ed.customBrushes, brushSizes: ed.brushSizes, tramaPresets: ed.tramaPresets }));
  } catch { /* */ }
}

// ───────────────────────── Montage ─────────────────────────

export function mountEditor(el) {
  root = el;
  dockOpen = window.matchMedia('(min-width: 769px)').matches;
  root.innerHTML = `<div class="ed">
    <nav class="toolbar" id="toolbar" aria-label="Outils"></nav>
    <section class="stage" id="stage">
      <div class="optbar" id="optbar"></div>
      <div class="canvas-wrap">
        <canvas id="view" aria-label="Page de BD"></canvas>
        <div class="zoombar" id="zoombar"></div>
      </div>
    </section>
    <aside class="dock" id="dock" ${dockOpen ? '' : 'hidden'}></aside>
  </div>`;
  attach($('#view', root));
  attachInput($('#view', root), { onUndo: undo, onRedo: redo, onClear: clearActiveLayer });
  fit();
  renderAll();

  $('#toolbar', root).onclick = onToolbar;
  $('#zoombar', root).onclick = onZoombar;
  $('#optbar', root).addEventListener('click', onOptbar);
  $('#optbar', root).addEventListener('input', onOptInput);
  $('#dock', root).addEventListener('pointerdown', swipeDown);
  $('#dock', root).addEventListener('pointermove', swipeMove);
  $('#dock', root).addEventListener('pointerup', swipeUp);
  $('#dock', root).addEventListener('pointercancel', swipeUp);
  $('#dock', root).addEventListener('click', onDock);
  $('#dock', root).addEventListener('toggle', onSecToggle, true);
  $('#dock', root).addEventListener('input', onDockInput);
  $('#dock', root).addEventListener('change', onDockChange);
  $('#dock', root).addEventListener('focusin', onDockFocus);

  unsub = subscribe(what => {
    if (what === 'undo') { updateUndo(); if (ed.tool === 'layout') renderOptbar(); }
    else if (what === 'panels') renderAll();
    else if (what === 'project' || what === 'page') { renderAll(); fit(); }
    else if (what === 'panel') { renderDock(); renderOptbar(); }
    else if (what === 'layers' || what === 'bubbles') renderDock();
    else if (what === 'tool') { renderOptbar(); renderDock(); }
  });
  keyHandler = onKey;
  window.addEventListener('keydown', keyHandler);
  fsListener = () => { renderToolbar(); setTimeout(resize, 100); };
  onFullscreenChange(fsListener);
  setTimeout(resize, 0);
}

export function unmountEditor() {
  if (unsub) unsub(); unsub = null;
  if (keyHandler) window.removeEventListener('keydown', keyHandler); keyHandler = null;
}

function renderAll() { renderToolbar(); renderOptbar(); renderZoombar(); renderDock(); updateUndo(); }

// ───────────────────────── Barre d'outils ─────────────────────────

function renderToolbar() {
  $('#toolbar', root).innerHTML = TOOLS.map(t => {
    const ic = t.id === 'shape' ? SHAPES.find(s => s.id === ed.shapeKind).icon : t.icon;
    return `<button class="icon-btn icon-only" data-tool="${t.id}" title="${t.label}" aria-label="${t.label}" aria-pressed="${ed.tool === t.id}">${icon(ic)}</button>`;
  }).join('') + `<span class="sep"></span>
    <span class="undo-redo">
    <button class="icon-btn icon-only" data-act="undo" id="btn-undo" title="Annuler (Ctrl+Z)" aria-label="Annuler">${icon('arrow-back-up')}</button>
    <button class="icon-btn icon-only" data-act="redo" id="btn-redo" title="Rétablir (Ctrl+Maj+Z)" aria-label="Rétablir">${icon('arrow-forward-up')}</button></span>
    <span class="sp"></span>
    <button class="icon-btn icon-only" data-act="export" title="Exporter (PDF, PNG, JSON)" aria-label="Exporter">${icon('file-export')}</button>
    ${canFullscreen() ? `<button class="icon-btn icon-only" data-act="fullscreen" title="Plein écran : masque la barre du navigateur" aria-label="Plein écran" aria-pressed="${isFullscreen()}">${icon(isFullscreen() ? 'arrows-minimize' : 'arrows-maximize')}</button>` : ''}
    <button class="icon-btn icon-only" data-act="dock" title="Panneaux" aria-label="Panneaux" aria-pressed="${dockOpen}">${icon('layout-sidebar-right')}</button>`;
  updateUndo();
}

function updateUndo() {
  for (const [sel, ok] of [['[data-act=undo]', ed.undo.canUndo], ['[data-act=redo]', ed.undo.canRedo]]) {
    $$(sel, root).forEach(b => { b.disabled = !ok; });
  }
}

// Trois doigts qui frottent : vide le calque actif, avec « Annuler » pendant quelques secondes.
function clearActiveLayer() {
  const name = activeLayer().name, r = clearLayer();
  if (r === 'ok') toast(`Calque « ${name} » vidé.`, { actionLabel: 'Annuler', duration: 7000, onAction: undo });
  else if (r === 'locked') toast(`Le calque « ${name} » est verrouillé.`);
}

export function undo() { ed.undo.undo(); markChanged(); requestRender(); }
export function redo() { ed.undo.redo(); markChanged(); requestRender(); }

function setTool(id) {
  storeToolSettings();   // l'outil quitté garde ses réglages ; celui qu'on prend retrouve les siens
  ed.tool = id;
  applyToolSettings();
  savePrefs();
  if (id !== 'bubble') { ed.bubbleId = null; ed.bubbleDraw = false; }
  renderToolbar(); renderOptbar(); if (id === 'bubble') dockTabTo('bubbles'); requestRender();
}

function onToolbar(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) {
    if (b.dataset.tool === 'shape' && ed.tool === 'shape') ed.shapeKind = SHAPES[(SHAPES.findIndex(s => s.id === ed.shapeKind) + 1) % SHAPES.length].id;
    setTool(b.dataset.tool);
  } else if (b.dataset.act === 'undo') undo();
  else if (b.dataset.act === 'redo') redo();
  else if (b.dataset.act === 'export') exportMenu();
  else if (b.dataset.act === 'fullscreen') toggleFullscreen();
  else if (b.dataset.act === 'dock') { dockOpen = !dockOpen; $('#dock', root).hidden = !dockOpen; renderToolbar(); setTimeout(resize, 0); }
}

// ───────────────────────── Zoom et pages ─────────────────────────

function renderZoombar() {
  const n = ed.project.pages.length;
  $('#zoombar', root).innerHTML = `
    <button class="icon-btn icon-only mob-only" data-act="undo" aria-label="Annuler">${icon('arrow-back-up')}</button>
    <button class="icon-btn icon-only mob-only" data-act="redo" aria-label="Rétablir">${icon('arrow-forward-up')}</button>
    <button class="icon-btn icon-only" data-z="prev" aria-label="Page précédente" ${ed.pageIdx === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
    <span style="display:flex;align-items:center;font:500 .8rem var(--font-mono);padding:0 2px">${ed.pageIdx + 1} / ${n}</span>
    <button class="icon-btn icon-only" data-z="next" aria-label="Page suivante" ${ed.pageIdx >= n - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button>
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
  else if (z === 'fit') fit(); else if (z === 'prev') goToPage(ed.pageIdx - 1); else goToPage(ed.pageIdx + 1);
}

// ───────────────────────── Options de l'outil ─────────────────────────

// Tailles courantes des plumes techniques, en millimètres.
const NIBS = [0.1, 0.2, 0.3, 0.5, 0.8, 1, 2, 3, 5, 10, 20];
const fmtMm = v => String(+v.toFixed(2)).replace('.', ',');
const sizeToV = mm => Math.round(100 * Math.log(mm / 0.05) / Math.log(600));
const vToSize = v => {
  const mm = 0.05 * Math.pow(600, v / 100);
  return +(mm < 1 ? Math.round(mm / 0.05) * 0.05 : mm < 5 ? Math.round(mm / 0.1) * 0.1 : Math.round(mm / 0.5) * 0.5).toFixed(2);
};
function sizeControl() {
  return `<span class="opt size"><label class="opt">Taille <input type="range" id="o-size" min="0" max="100" value="${sizeToV(ed.sizeMm)}" aria-label="Taille du trait"></label>
    <label class="opt"><input type="number" id="o-mm" class="num" min="0.05" max="30" step="0.05" value="${+ed.sizeMm.toFixed(2)}" aria-label="Taille en millimètres"> mm</label>
    <select id="o-nib" class="nib" aria-label="Tailles courantes"><option value="">Plumes</option>${NIBS.map(n => `<option value="${n}" ${n === +ed.sizeMm.toFixed(2) ? 'selected' : ''}>${fmtMm(n)} mm</option>`).join('')}</select>
    <span class="val" id="o-size-val">${ed.size} px</span></span>`;
}
// Interrupteur de la pression du stylet, à côté de la taille.
const pressureControl = () => `<button class="icon-btn icon-only" data-opt="pressure" aria-pressed="${ed.pressure}" title="Pression du stylet : ${ed.pressure ? 'active' : 'désactivée'}" aria-label="Pression du stylet">${icon('gauge')}</button>`;
const inkControl = () => `<span class="row tight" role="group" aria-label="Encre">
  <button class="ink-btn ${ed.ink === 1 ? 'on' : ''}" data-ink="1" style="background:#000" aria-label="Encre noire" aria-pressed="${ed.ink === 1}"></button>
  <button class="ink-btn ${ed.ink === 2 ? 'on' : ''}" data-ink="2" style="background:#fff" aria-label="Encre blanche" aria-pressed="${ed.ink === 2}"></button></span>`;
function tramaControl() {
  const t = tramaById(ed.project, ed.tramaId);
  return `<button class="swatch-btn" data-opt="trames" aria-label="Choisir la trame, actuelle : ${esc(t.name)}"><canvas width="30" height="30" data-swatch="${t.id}"></canvas>${esc(t.name)}</button>`;
}

export function renderOptbar() {
  const o = $('#optbar', root), t = ed.tool;
  let html = '';
  if (t === 'pencil') {
    html = `<button class="swatch-btn" data-opt="brushes" aria-label="Choisir le pinceau, actuel : ${esc(currentBrush().name)}"><canvas width="64" height="30" data-bprev="1" style="width:64px"></canvas>${esc(currentBrush().name)}</button>`
      + sizeControl() + pressureControl() + inkControl();
  }
  else if (t === 'eraser') html = sizeControl() + pressureControl();
  else if (t === 'texture') html = sizeControl() + pressureControl() + tramaControl() + inkControl();
  else if (t === 'fill') html = tramaControl() + inkControl();
  else if (t === 'shape') {
    html = `<span class="seg" role="group" aria-label="Forme">${SHAPES.map(s => `<button data-shape="${s.id}" class="${ed.shapeKind === s.id ? 'on' : ''}" aria-label="${s.label}" title="${s.label}">${icon(s.icon)}</button>`).join('')}</span>`
      + (ed.shapeKind !== 'line' ? `<label class="check" style="min-height:40px"><input type="checkbox" id="o-filled" ${ed.shapeFilled ? 'checked' : ''}> Plein</label>` : '')
      + sizeControl() + tramaControl() + inkControl();
  } else if (t === 'mask') {
    html = `<span class="seg" role="group" aria-label="Effet du masque">
        <button data-mask="off" class="${ed.maskMode === 'off' ? 'on' : ''}">Sans effet</button>
        <button data-mask="in" class="${ed.maskMode === 'in' ? 'on' : ''}">Dans</button>
        <button data-mask="out" class="${ed.maskMode === 'out' ? 'on' : ''}">Hors</button></span>
      <span class="seg"><button data-maskpen="0" class="${!ed.maskErase ? 'on' : ''}" aria-label="Ajouter au masque">${icon('pencil')}</button>
        <button data-maskpen="1" class="${ed.maskErase ? 'on' : ''}" aria-label="Retirer du masque">${icon('eraser')}</button></span>`
      + sizeControl();
  } else if (t === 'bubble') {
    html = ed.bubbleDraw
      ? `<span class="hint">Trace le contour de la bulle d'un seul geste.</span><button class="btn small" data-freebubble="0">Annuler</button>`
      : `<button class="btn small" data-freebubble="1">${icon('writing')} Dessiner une bulle</button><span class="hint">Touche une bulle pour la déplacer ; points rouges : taille et queue.</span>`;
  } else if (t === 'layout') {
    const pn = panel(), idx = page().panels.indexOf(pn), ARROW = { left: 'arrow-left', right: 'arrow-right', up: 'arrow-up', down: 'arrow-down' };
    html = `<span class="hint">Glisse une gouttière pour agrandir une case sans rien effacer. Case ${idx + 1} :</span>`
      + mergeCandidates(pn).map(c => `<button class="btn small" data-merge="${c.id}" title="La case ${idx + 1} absorbe la case ${c.index + 1}">${icon(ARROW[c.dir])} Fusionner avec la ${c.index + 1}</button>`).join('')
      + (page().panels.length > 1 ? `<button class="btn small danger" data-delpanel="1">${icon('trash')} Supprimer la case</button>` : '');
  } else if (t === 'pan') {
    html = `<span class="hint">Fais glisser pour déplacer la page. Pincer pour zoomer.</span>`;
  }
  if (ed.maskMode !== 'off' && t !== 'mask' && t !== 'bubble' && t !== 'pan') {
    html += `<button class="btn small" data-mask="off" title="Désactiver le masque">${icon('mask')} Masque : ${ed.maskMode === 'in' ? 'dans' : 'hors'} ${icon('x')}</button>`;
  }
  o.hidden = !html; o.innerHTML = html;
  paintSwatches(o);
  $$('canvas[data-bprev]', o).forEach(c => previewBrush(c, ed.brushParams, Math.min(ed.size, 8)));
}

function paintSwatches(scope) {
  $$('canvas[data-swatch]', scope).forEach(c => {
    const t = tramaById(ed.project, c.dataset.swatch);
    drawTramaSwatch(c, t, t.solid ? 1 : Math.max(1, Math.min(3, ed.tramaScale)) );
  });
}

function onOptbar(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.ink) { ed.ink = +b.dataset.ink; savePrefs(); renderOptbar(); }
  else if (b.dataset.shape) { ed.shapeKind = b.dataset.shape; savePrefs(); renderToolbar(); renderOptbar(); }
  else if (b.dataset.mask) { ed.maskMode = b.dataset.mask; renderOptbar(); requestRender(); }
  else if (b.dataset.merge) { if (mergePanels(panel().id, b.dataset.merge)) toast('Cases fusionnées.', { actionLabel: 'Annuler', onAction: undo }); }
  else if (b.dataset.delpanel) { if (deletePanel()) toast('Case supprimée.', { actionLabel: 'Annuler', duration: 8000, onAction: undo }); }
  else if (b.dataset.freebubble) { ed.bubbleDraw = b.dataset.freebubble === '1'; renderOptbar(); }
  else if (b.dataset.maskpen) { ed.maskErase = b.dataset.maskpen === '1'; savePrefs(); renderOptbar(); }
  else if (b.dataset.opt === 'pressure') { ed.pressure = !ed.pressure; savePrefs(); renderOptbar(); toast(ed.pressure ? 'Pression du stylet activée.' : 'Pression du stylet désactivée.', { duration: 1500 }); }
  else if (b.dataset.opt === 'brushes') { dockOpen = true; $('#dock', root).hidden = false; renderToolbar(); dockTabTo('brushes'); setTimeout(resize, 0); }
  else if (b.dataset.opt === 'trames') { dockOpen = true; $('#dock', root).hidden = false; renderToolbar(); dockTabTo('tramas'); setTimeout(resize, 0); }
}

function showSize(from) {
  const v = $('#o-size-val', root); if (v) v.textContent = `${ed.size} px`;
  if (from !== 'o-size') { const r = $('#o-size', root); if (r) r.value = sizeToV(ed.sizeMm); }
  if (from !== 'o-mm') { const n = $('#o-mm', root); if (n) n.value = +ed.sizeMm.toFixed(2); }
  const nib = $('#o-nib', root); if (nib) nib.value = NIBS.includes(+ed.sizeMm.toFixed(2)) ? +ed.sizeMm.toFixed(2) : '';
  savePrefs();
}

function onOptInput(e) {
  const id = e.target.id;
  if (id === 'o-size') { setSizeMm(vToSize(+e.target.value)); showSize('o-size'); }
  else if (id === 'o-mm') { const mm = parseFloat(String(e.target.value).replace(',', '.')); if (mm > 0) { setSizeMm(mm); showSize('o-mm'); } }
  else if (id === 'o-nib') { if (e.target.value) { setSizeMm(+e.target.value); showSize('o-nib'); } }
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

// Sorte de calque visée par l'outil actuel (pour repérer la cible dans la liste).
function toolRole() {
  const t = ed.tool;
  if (t === 'pencil') return 'ink';
  if (t === 'texture' || t === 'fill' || t === 'shape') return tramaById(ed.project, ed.tramaId).solid ? 'ink' : 'tram';
  return null;
}

export function renderDock() {
  const d = $('#dock', root);
  if (!d || !ed.project) return;
  const prevScroll = $('.dock-body', d) ? $('.dock-body', d).scrollTop : 0;
  d.innerHTML = `<div class="dock-tabs" role="tablist">${TABS.map(t =>
    `<button role="tab" data-tab="${t.id}" class="${dockTab === t.id ? 'on' : ''}" aria-selected="${dockTab === t.id}" aria-label="${t.label}" title="${t.label}">${icon(t.icon)}</button>`).join('')}</div>
    <div class="dock-body">${({ layers: layersTab, brushes: brushesTab, tramas: tramasTab, pages: pagesTab, bubbles: bubblesTab, case: caseTab })[dockTab]()}</div>`;
  $('.dock-body', d).scrollTop = prevScroll;
  paintSwatches(d);
  if (dockTab === 'brushes') paintBrushPreviews(d);
  if (dockTab === 'tramas') $$('canvas[data-tcell]', d).forEach(c => drawTramaSwatch(c, tramaById(ed.project, c.dataset.tcell), 2));
}

function layersTab() {
  const p = panel(), idx = page().panels.indexOf(p), cur = activeLayer(p), pg = page(), role = toolRole();
  const target = role ? peekTarget(p, role) : null;
  const dot = l => l.kind === 'draft' ? `<i class="ldot" style="background:rgb(${DRAFT_COLORS[l.color || 'blue'].rgb.join(',')})" title="Brouillon ${DRAFT_COLORS[l.color || 'blue'].name.toLowerCase()}"></i>` : l.kind === 'tram' ? `<span class="tag" title="Calque de trame">trame</span>` : '';
  const BICON = { parole: 'message-circle', pensee: 'cloud', narration: 'square', texte: 'typography' };
  const swipe = (inner, acts) => `<div class="swipe">${inner}<div class="swipe-actions">${acts}</div></div>`;
  const bubRows = pg.bubbles.map(b => swipe(`<div class="layer ${b.id === ed.bubbleId ? 'on' : ''}" data-bub="${b.id}">
      <button class="icon-btn icon-only" data-act="bub-vis" aria-label="${b.hidden ? 'Afficher' : 'Masquer'} la bulle">${icon(b.hidden ? 'eye-off' : 'eye')}</button>
      <button class="name" data-act="bub-select">${icon(BICON[b.kind] || 'message-circle')} ${esc(b.text || '(vide)')}</button>
      <button class="icon-btn icon-only" data-act="bub-lock" aria-label="${b.locked ? 'Déverrouiller' : 'Verrouiller'} la bulle">${icon(b.locked ? 'lock' : 'lock-open')}</button>
      <button class="icon-btn icon-only" data-act="bub-del" aria-label="Supprimer la bulle">${icon('x')}</button></div>`, `<button class="danger" data-act="swipe-bub-del" data-for="${b.id}">${icon('trash')} Supprimer</button>`)).join('');
  const rows = [...p.layers].reverse().map(l => swipe(`<div class="layer ${l.id === p.active ? 'on' : ''} ${target === l ? 'target' : ''}" data-layer="${l.id}">
      <button class="icon-btn icon-only" data-act="vis" aria-label="${l.visible ? 'Masquer' : 'Afficher'} le calque ${esc(l.name)}">${icon(l.visible ? 'eye' : 'eye-off')}</button>
      <button class="name" data-act="select-layer">${esc(l.name)}</button>
      ${dot(l)}${l.opacity < 100 ? `<span class="tag" style="color:var(--text-muted)">${l.opacity} %</span>` : ''}
      <button class="icon-btn icon-only" data-act="lock" aria-label="${l.locked ? 'Déverrouiller' : 'Verrouiller'} le calque ${esc(l.name)}">${icon(l.locked ? 'lock' : 'lock-open')}</button></div>`,
    `<button data-act="swipe-dup" data-for="${l.id}">${icon('copy')} Dupliquer</button><button class="danger" data-act="swipe-del" data-for="${l.id}">${icon('trash')} Supprimer</button>`)).join('');
  const acts = `<div class="tools-row">
      <button class="btn small" data-act="add-layer">${icon('plus')} Encre</button>
      <button class="btn small" data-act="add-tram">${icon('plus')} Trame</button>
      <button class="btn small" data-act="add-draft">${icon('plus')} Brouillon</button>
      <button class="icon-btn icon-only" data-act="dup-layer" title="Dupliquer le calque" aria-label="Dupliquer le calque">${icon('copy')}</button>
      <button class="icon-btn icon-only" data-act="up" title="Monter" aria-label="Monter le calque">${icon('arrow-up')}</button>
      <button class="icon-btn icon-only" data-act="down" title="Descendre" aria-label="Descendre le calque">${icon('arrow-down')}</button>
      <button class="icon-btn icon-only" data-act="rename" title="Renommer" aria-label="Renommer le calque">${icon('pencil')}</button>
      <button class="icon-btn icon-only" data-act="merge" title="Fusionner vers le bas" aria-label="Fusionner vers le bas">${icon('stack-pop')}</button>
      <button class="icon-btn icon-only" data-act="clear" title="Vider le calque" aria-label="Vider le calque">${icon('eraser')}</button>
      <button class="icon-btn icon-only" data-act="del-layer" title="Supprimer le calque" aria-label="Supprimer le calque">${icon('trash')}</button></div>`;
  const kinds = [['ink', 'Encre'], ['tram', 'Trame'], ['draft', 'Brouillon']];
  const props = `<div class="seg" role="group" aria-label="Type de calque" style="margin-bottom:8px">${kinds.map(([k, n]) => `<button data-lkind="${k}" class="${cur.kind === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${cur.kind === 'draft' ? `<div class="row tight" style="margin-bottom:8px">${Object.entries(DRAFT_COLORS).map(([id, c]) =>
      `<button class="ink-btn ${(cur.color || 'blue') === id ? 'on' : ''}" data-lcolor="${id}" style="background:rgb(${c.rgb.join(',')});width:32px;height:32px" aria-label="${c.name}" aria-pressed="${(cur.color || 'blue') === id}"></button>`).join('')}</div>` : ''}
    <label class="field inline"><span>Opacité : ${cur.opacity} %</span><input type="range" id="l-op" min="0" max="100" step="5" value="${cur.opacity}"></label>
    <div class="row" style="gap:4px 14px"><label class="check compact"><input type="checkbox" id="l-lock" ${cur.locked ? 'checked' : ''}> Verrouillé</label>
      <label class="check compact"><input type="checkbox" id="l-solo" ${ed.solo === cur.id ? 'checked' : ''}> Afficher seul</label></div>
    <small class="note">${cur.kind === 'draft' ? 'Brouillon : visible à l\'écran, jamais imprimé.' : cur.kind === 'tram' ? 'Les trames ne se posent que dans les calques de trame.' : 'L\'encrage ne se pose que dans les calques d\'encre.'}${cur.kind !== 'draft' && cur.opacity < 100 ? ' Imprimé en gris tramé.' : ''}</small>`;
  const eye = `<button class="icon-btn icon-only sec-eye" data-act="bubs-vis" aria-label="${pg.bubblesHidden ? 'Afficher' : 'Masquer'} toutes les bulles">${icon(pg.bubblesHidden ? 'eye-off' : 'eye')}</button>`;
  return sec('bubs', `Bulles et textes · ${pg.bubbles.length}`, bubRows || '<small class="note">Aucune bulle sur cette page.</small>', pg.bubbles.length > 0, eye)
    + sec('lays', `Case ${idx + 1} · calques`, rows + acts, true)
    + sec('layp', `Calque « ${esc(cur.name)} »`, props, true);
}

// Réglages d'un pinceau : [clé, libellé, min, max, pas, format]
const pct = v => `${Math.round(v * 100)} %`;
const BPARAMS = [
  ['press', 'Pression → taille', 0, 1, 0.05, pct], ['pressMin', 'Taille à pression nulle', 0, 1, 0.05, pct],
  ['speed', 'Effilage selon la vitesse', 0, 1, 0.05, pct], ['start', 'Départ effilé', 0, 8, 0.5, v => `${v} Ø`],
  ['smooth', 'Stabilisation', 0, 1, 0.05, pct], ['scatter', 'Dispersion', 0, 1, 0.05, pct], ['spacing', 'Espacement', 0.05, 3, 0.05, v => `${v.toFixed(2)} Ø`],
];
const GRAIN_TYPES = [['none', 'Aucun (plein)'], ['noise', 'Grain fin'], ['paper', 'Papier'], ['bristle', 'Poils'], ['spray', 'Aérographe']];

function brushesTab() {
  const cur = ed.brushParams, groups = [...BRUSH_GROUPS, 'Mes pinceaux'], list = allBrushes();
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
  return buttons + sec('brset', `Réglages · ${esc(currentBrush().name)}`, settings, false) + lists
    + '<small class="note">Les pinceaux enregistrés restent sur cet appareil. Le grain donne un aspect crayon ou fusain, rendu en noir et blanc.</small>';
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
  const settings = `<label class="field inline"><span>Échelle : ×${ed.tramaScale}</span><input type="range" id="d-scale" min="1" max="8" value="${ed.tramaScale}"></label>
    <label class="check compact"><input type="checkbox" id="d-opaque" ${ed.tramaOpaque ? 'checked' : ''}> Fond blanc sous la trame</label>
    <div class="row tight" style="margin-top:4px">
      <button class="btn small" data-act="new-trame">${icon('plus')} Nouvelle</button>
      <button class="btn small" data-act="tpreset-save" title="Enregistrer trame, échelle et fond actuels">${icon('device-floppy')} Enregistrer le réglage</button>
      ${cur.builtin === false ? `<button class="btn small" data-act="edit-trame" aria-label="Modifier la trame">${icon('pencil')}</button><button class="btn small danger" data-act="del-trame" aria-label="Supprimer la trame">${icon('trash')}</button>` : ''}</div>`;
  const presets = ed.tramaPresets.map(t => `<div class="row tight" style="margin-bottom:4px"><button class="btn small" data-tpreset="${t.id}" style="flex:1;justify-content:flex-start">${esc(t.name)}</button><button class="icon-btn icon-only" data-tpdel="${t.id}" aria-label="Supprimer le réglage ${esc(t.name)}">${icon('trash')}</button></div>`).join('');
  const open = g => g === 'Plein' || g === 'Gris' || g === 'Ma bibliothèque' || g === cur.group;
  return sec('trset', `Trame · ${esc(cur.name)}`, settings, true)
    + (presets ? sec('trpre', 'Mes réglages', presets, true) : '')
    + groups.map(g => sec('tg-' + g, esc(g), `<div class="tgrid">${list.filter(t => t.group === g).map(t =>
      `<button class="tcell ${t.id === ed.tramaId ? 'on' : ''}" data-trama="${t.id}" aria-label="${esc(t.name)}" title="${esc(t.name)}">${t.solid ? '<span class="solid">Plein</span>' : `<canvas width="36" height="36" data-tcell="${t.id}"></canvas>`}</button>`).join('')}</div>`, open(g))).join('')
    + '<small class="note">La trame est accrochée à la page : deux cases voisines se raccordent sans rupture.</small>';
}

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

function bubblesTab() {
  const pg = page(), b = bubble();
  return `<div class="tools-row" style="margin:0 0 6px">${BUBBLE_KINDS.map(k =>
    `<button class="icon-btn icon-only" data-addb="${k.id}" title="Ajouter : ${k.name}" aria-label="Ajouter : ${k.name}">${icon(k.icon)}</button>`).join('')}
    <button class="icon-btn icon-only ${ed.bubbleDraw ? 'on' : ''}" data-act="free-bubble" title="Dessiner une bulle à la main" aria-label="Dessiner une bulle à la main">${icon('writing')}</button></div>`
    + (pg.bubbles.length ? `<div class="blist">${pg.bubbles.map(x => `<button data-b="${x.id}" class="${x.id === ed.bubbleId ? 'on' : ''}">${x.who ? esc(x.who) + ' : ' : ''}${esc(x.text || '(vide)')}</button>`).join('')}</div>` : '<small class="note">Aucune bulle sur cette page.</small>')
    + (b ? bubbleProps(b) : '');
}

// Curseurs numériques d'une bulle : identifiant → [propriété, libellé]
const SLIDERS = {
  'b-radius': ['radius', v => `Angles arrondis : ${v} %`], 'b-wobble': ['wobble', v => `Imperfections : ${v} %`],
  'b-pad': ['pad', v => `Marge intérieure : ${String(v).replace('.', ',')} mm`], 'b-stroke': ['stroke', v => `Trait : ${v.toFixed(2).replace('.', ',')} mm`],
  'b-tailangle': ['tailAngle', v => `Position de l'origine : ${v}°`],
  'b-tailw': ['tailW', v => `Largeur de la queue : ${v} %`], 'b-tailround': ['tailRound', v => `Arrondi des côtés : ${v > 0 ? '+' : ''}${v}`],
  'b-tailbend': ['tailBend', v => `Courbure : ${v > 0 ? '+' : ''}${v}`], 'b-tailtip': ['tailTip', v => `Pointe émoussée : ${v} %`],
};
const slider = (id, p, min, max, step = 1) => `<label class="field inline"><span>${SLIDERS[id][1](p[SLIDERS[id][0]])}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${p[SLIDERS[id][0]]}"></label>`;

function bubbleProps(b) {
  const p = props(b);
  const text = `<label class="field inline"><span>Modèle</span><select id="b-kind">${BUBBLE_KINDS.map(k => `<option value="${k.id}" ${k.id === b.kind ? 'selected' : ''}>${k.name}</option>`).join('')}</select></label>
      <textarea id="b-text" rows="2" aria-label="Texte de la bulle" style="width:100%;font-size:16px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--field-bg);color:var(--text-primary);margin-bottom:8px">${esc(b.text)}</textarea>
      <button class="btn small" data-act="pick-font" style="justify-content:flex-start;width:100%;margin-bottom:6px">${icon('typography')} ${esc(fontName(p.font))}</button>
      <label class="field inline"><span>Corps : ${b.pt} pt</span><input type="range" id="b-pt" min="5" max="24" step="0.5" value="${b.pt}"></label>
      <div class="row" style="gap:0 14px"><label class="check compact"><input type="checkbox" id="b-caps" ${b.caps ? 'checked' : ''}> Majuscules</label>
        <label class="check compact"><input type="checkbox" id="b-auto" ${b.auto ? 'checked' : ''}> Taille auto</label></div>`;
  const shape = `<label class="field inline"><span>Contour</span><select id="b-shape">${BUBBLE_SHAPES.filter(x => x.id !== 'libre' || b.path).map(x => `<option value="${x.id}" ${x.id === p.shape ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      ${p.shape === 'rect' ? slider('b-radius', p, 0, 100, 5) : ''}
      ${p.shape === 'ellipse' || p.shape === 'rect' || p.shape === 'cloud' ? `${slider('b-wobble', p, 0, 100)}<button class="btn small" data-act="reseed" style="margin:-2px 0 8px">${icon('dice-3')} Autre tracé</button>` : ''}
      ${slider('b-pad', p, 0, 10, 0.5)}${slider('b-stroke', p, 0, 2, 0.05)}`;
  const tail = `<label class="field inline"><span>Style</span><select id="b-tailstyle">${TAILS.map(x => `<option value="${x.id}" ${x.id === p.tailStyle ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      ${p.tailStyle !== 'none' ? `<label class="check compact"><input type="checkbox" id="b-origin-auto" ${b.tailAngle == null ? 'checked' : ''}> Origine automatique</label>
        ${b.tailAngle == null ? '' : slider('b-tailangle', p, 0, 359)}` : ''}
      ${p.tailStyle === 'pointe' ? slider('b-tailw', p, 4, 70) + slider('b-tailround', p, -100, 100, 5) + slider('b-tailbend', p, -100, 100, 5) + slider('b-tailtip', p, 0, 100, 5) : ''}
      ${p.tailStyle === 'fleche' || p.tailStyle === 'bulles' ? slider('b-tailw', p, 4, 70) + slider('b-tailbend', p, -100, 100, 5) : ''}
      ${p.tailStyle !== 'none' ? '<small class="note">Points rouges sur la page : pointe et origine de la queue.</small>' : ''}`;
  return sec('bt', 'Texte', text, true) + sec('bf', 'Forme', shape, false) + sec('bq', 'Queue', tail, false);
}

function caseTab() {
  const p = panel(), idx = page().panels.indexOf(p);
  const notes = `<label class="field"><span>Plan</span><input type="text" id="n-plan" value="${esc(p.note.plan)}" placeholder="Plan large, gros plan…"></label>
    <label class="field"><span>Description</span><textarea id="n-desc" rows="2" placeholder="Ce qu'il faut dessiner">${esc(p.note.description)}</textarea></label>
    <label class="check compact"><input type="checkbox" id="n-show" ${ed.showNotes ? 'checked' : ''}> Afficher les notes sur la page (jamais exportées)</label>`;
  const frame = `<label class="field inline"><span>Trait : ${fmtMm(panelStroke(p))} mm</span><input type="range" id="n-stroke" min="0" max="2" step="0.05" value="${panelStroke(p)}"></label>
    <button class="btn small" data-act="stroke-all">Appliquer à toute la page</button>`;
  const mask = `<small class="note">Peins une zone avec l'outil Masque, puis choisis « Dans » ou « Hors » pour ne dessiner que dedans ou dehors.</small>
    <div class="row tight" style="margin-top:6px"><button class="btn small" data-act="mask-clear">Vider</button><button class="btn small" data-act="mask-invert">Inverser</button></div>`;
  const more = `<div class="row tight"><button class="btn small" data-act="dither">${icon('photo')} Image tramée…</button>
    <button class="btn small" data-act="copy-case">${icon('copy')} Copier vers…</button></div>`;
  return sec('cn', `Case ${idx + 1} · notes`, notes, true) + sec('cf', 'Cadre', frame, false) + sec('cm', 'Masque', mask, false) + sec('cx', 'Image et copie', more, false);
}

// ───────────────────────── Événements du volet ─────────────────────────

async function onDock(e) {
  if (swipeJustDone) { e.preventDefault(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { dockTabTo(tab.dataset.tab); return; }
  const br = e.target.closest('[data-brush]');
  if (br) { selectBrush(br.dataset.brush); savePrefs(); renderDock(); renderOptbar(); return; }
  const tp = e.target.closest('[data-tpreset]'), tpd = e.target.closest('[data-tpdel]');
  if (tpd) { ed.tramaPresets = ed.tramaPresets.filter(x => x.id !== tpd.dataset.tpdel); savePrefs(); renderDock(); return; }
  if (tp) { applyTramaPreset(tp.dataset.tpreset); return; }
  const tr = e.target.closest('[data-trama]');
  if (tr) {
    if (!['texture', 'fill', 'shape'].includes(ed.tool)) setTool('texture');   // seuls ces outils utilisent une trame
    ed.tramaId = tr.dataset.trama; savePrefs(); renderDock(); renderOptbar(); return;
  }
  const pgb = e.target.closest('[data-page]');
  if (pgb) { goToPage(+pgb.dataset.page); return; }
  const bb = e.target.closest('[data-b]');
  if (bb) { selectBubble(bb.dataset.b); if (ed.tool !== 'bubble') ed.tool = 'bubble', renderToolbar(), renderOptbar(); return; }
  const ab = e.target.closest('[data-addb]');
  if (ab) { if (ed.tool !== 'bubble') { ed.tool = 'bubble'; renderToolbar(); renderOptbar(); } addBubble(ab.dataset.addb); return; }
  const lk = e.target.closest('[data-lkind]'), lc = e.target.closest('[data-lcolor]');
  if (lk) { setLayerProp(activeLayer().id, 'kind', lk.dataset.lkind); return; }
  if (lc) { setLayerProp(activeLayer().id, 'color', lc.dataset.lcolor); return; }
  const lay = e.target.closest('[data-layer]');
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'vis') toggleLayer(lay.dataset.layer, 'visible');
  else if (a === 'select-layer') selectLayer(lay.dataset.layer);
  else if (a === 'add-layer') addLayer('ink');
  else if (a === 'add-tram') addLayer('tram');
  else if (a === 'bub-vis') { const bb = page().bubbles.find(x => x.id === e.target.closest('[data-bub]').dataset.bub); setBubbleProp(bb, 'hidden', !bb.hidden); }
  else if (a === 'bub-lock') { const bb = page().bubbles.find(x => x.id === e.target.closest('[data-bub]').dataset.bub); setBubbleProp(bb, 'locked', !bb.locked); }
  else if (a === 'bub-del') { const bb = page().bubbles.find(x => x.id === e.target.closest('[data-bub]').dataset.bub); deleteBubble(bb); }
  else if (a === 'bub-select') { selectBubble(e.target.closest('[data-bub]').dataset.bub); if (ed.tool !== 'bubble') setTool('bubble'); }
  else if (a === 'swipe-del') {
    const l = panel().layers.find(x => x.id === act.dataset.for);
    if (l) { selectLayer(l.id); if (deleteLayer()) toast(`Calque « ${l.name} » supprimé.`, { actionLabel: 'Annuler', duration: 7000, onAction: undo }); else toast('Une case garde au moins un calque.'); }
  }
  else if (a === 'swipe-dup') { selectLayer(act.dataset.for); duplicateLayer(); }
  else if (a === 'swipe-bub-del') { const bb = page().bubbles.find(x => x.id === act.dataset.for); if (bb) { deleteBubble(bb); toast('Bulle supprimée.', { actionLabel: 'Annuler', duration: 7000, onAction: undo }); } }
  else if (a === 'bubs-vis') { e.preventDefault(); togglePageBubbles(); }
  else if (a === 'del-layer') { if (!deleteLayer()) toast('Une case garde au moins un calque.'); }
  else if (a === 'up') moveLayer(1);
  else if (a === 'down') moveLayer(-1);
  else if (a === 'lock') setLayerProp(lay.dataset.layer, 'locked', !panel().layers.find(l => l.id === lay.dataset.layer).locked);
  else if (a === 'add-draft') addLayer('draft');
  else if (a === 'dup-layer') duplicateLayer();
  else if (a === 'merge') { if (!mergeDown()) toast('Pas de calque en dessous.'); }
  else if (a === 'clear') clearActiveLayer();
  else if (a === 'rename') {
    const l = activeLayer(), name = await promptModal({ title: 'Renommer le calque', label: 'Nom', value: l.name });
    if (name) renameLayer(l.id, name);
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
  else if (a === 'brush-reset') { resetBrush(); renderDock(); renderOptbar(); }
  else if (a === 'brush-save') {
    const name = await promptModal({ title: 'Enregistrer le pinceau', label: 'Nom', value: 'Mon pinceau' });
    if (name) { saveBrushAs(name); savePrefs(); renderDock(); renderOptbar(); toast('Pinceau enregistré.'); }
  }
  else if (a === 'brush-update') { updateBrush(); savePrefs(); toast('Pinceau mis à jour.'); }
  else if (a === 'brush-del') {
    if (await confirmModal({ title: 'Supprimer le pinceau', message: `« ${currentBrush().name} » sera retiré de tes pinceaux.`, confirm: 'Supprimer', danger: true })) { deleteBrush(ed.brushId); savePrefs(); renderDock(); renderOptbar(); }
  }
  else if (a === 'tpreset-save') {
    const name = await promptModal({ title: 'Enregistrer le réglage de trame', label: 'Nom', value: tramaById(ed.project, ed.tramaId).name + ' ×' + ed.tramaScale });
    if (name) { ed.tramaPresets.push({ id: 'tp' + Math.random().toString(36).slice(2, 8), name, tramaId: ed.tramaId, tramaScale: ed.tramaScale, tramaOpaque: ed.tramaOpaque, ink: ed.ink }); savePrefs(); renderDock(); toast('Réglage enregistré.'); }
  }
  else if (a === 'stroke-all') { setPanelStroke(panelStroke(panel()), true); toast('Trait appliqué à toutes les cases.'); }
  else if (a === 'export-pdf') exportPdf();
  else if (a === 'free-bubble') { ed.tool = 'bubble'; ed.bubbleDraw = true; renderToolbar(); renderOptbar(); renderDock(); }
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
const STYLE_KEYS = ['pt', 'caps', 'auto', 'font', 'shape', 'radius', 'pad', 'stroke', 'wobble', 'tailStyle', 'tailW', 'tailRound', 'tailBend', 'tailTip'];
function rememberBubble(b) {
  const d = {};
  for (const k of STYLE_KEYS) if (b[k] !== undefined && !(k === 'shape' && b.shape === 'libre')) d[k] = b[k];
  ed.bubbleDefaults[b.kind] = d; savePrefs();
}

let bubbleBefore = null;
// Reprend un réglage de trame enregistré (trame, échelle, fond blanc, encre).
function applyTramaPreset(id) {
  const t = ed.tramaPresets.find(x => x.id === id);
  if (!t) return;
  if (!['texture', 'fill', 'shape'].includes(ed.tool)) setTool('texture');
  ed.tramaId = allTramas(ed.project).some(x => x.id === t.tramaId) ? t.tramaId : 'plein';
  ed.tramaScale = t.tramaScale; ed.tramaOpaque = t.tramaOpaque; ed.ink = t.ink;
  savePrefs(); renderDock(); renderOptbar();
}

function onDockFocus(e) { const b = bubble(); if (b && /^b-/.test(e.target.id || '')) bubbleBefore = snapshotBubble(b); }

function onDockInput(e) {
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
    savePrefs(); $$('canvas[data-bprev]', root).forEach(c => previewBrush(c, ed.brushParams, Math.min(ed.size, 8)));
    return;
  }
  if (id === 'd-scale') { ed.tramaScale = +e.target.value; e.target.previousElementSibling.textContent = 'Échelle de la trame : ×' + ed.tramaScale; paintSwatches(root); return; }
  if (id === 'd-opaque') { ed.tramaOpaque = e.target.checked; return; }
  if (id === 'n-plan') { setNote('plan', e.target.value); return; }
  if (id === 'n-desc') { setNote('description', e.target.value); return; }
  if (id === 'l-op') { const l = activeLayer(); l.opacity = +e.target.value; e.target.previousElementSibling.textContent = `Opacité : ${l.opacity} %`; invalidate(panel()); markChanged(); return; }
  if (id === 'l-lock') { setLayerProp(activeLayer().id, 'locked', e.target.checked); return; }
  if (id === 'l-solo') { setSolo(activeLayer().id); return; }
  if (id === 'n-stroke') { setPanelStroke(+e.target.value); e.target.previousElementSibling.textContent = `Trait du cadre : ${fmtMm(+e.target.value)} mm`; return; }
  if (id === 'n-show') { ed.showNotes = e.target.checked; savePrefs(); requestRender(); return; }
  if (!b || !/^b-/.test(id)) return;
  if (!bubbleBefore) bubbleBefore = snapshotBubble(b);
  if (id === 'b-text') { b.text = e.target.value; refitBubble(b); }
  else if (id === 'b-pt') { b.pt = +e.target.value; e.target.previousElementSibling.textContent = `Corps : ${b.pt} pt`; refitBubble(b); }
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
    if (key === 'pad') refitBubble(b);
  }
  else if (id === 'b-origin-auto') {
    if (e.target.checked) delete b.tailAngle;
    else if (b.tail) b.tailAngle = Math.round(((Math.atan2(b.tail.y - (b.y + b.h / 2), b.tail.x - (b.x + b.w / 2)) * 180 / Math.PI) + 360) % 360);
  } else if (id === 'b-tailstyle') { b.tailStyle = e.target.value; setTail(b, b.tailStyle !== 'none'); }
  requestRender();
}

function onDockChange(e) {
  if (/^p-(shape|grainType|follow)$/.test(e.target.id || '')) { renderDock(); renderOptbar(); return; }
  if (/^p-/.test(e.target.id || '')) { paintBrushPreviews($('#dock', root)); return; }
  const b = bubble();
  if (b && /^b-/.test(e.target.id || '') && bubbleBefore) {
    commitBubbleEdit(b, bubbleBefore); bubbleBefore = null;
    if (e.target.id !== 'b-text' && e.target.id !== 'b-kind') rememberBubble(b);
    // Pas de reconstruction du volet à chaque champ : un toucher sur un bouton qui suit la sortie d'un champ serait perdu.
    if (['b-kind', 'b-shape', 'b-tailstyle', 'b-origin-auto'].includes(e.target.id)) renderDock();
    else if (e.target.id === 'b-text') { const li = $('.blist button.on', root); if (li) li.textContent = (b.who ? b.who + ' : ' : '') + (b.text || '(vide)'); }
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

// ───────────────────────── Clavier ─────────────────────────

function onKey(e) {
  if (typing(e) || modalOpen()) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod) return;
  const t = TOOLS.find(x => x.key === k);
  if (t) { setTool(t.id); return; }
  if (k === 'x') { ed.ink = ed.ink === 1 ? 2 : 1; renderOptbar(); }
  else if (k === '[') { setSizeMm(ed.sizeMm / 1.2); savePrefs(); renderOptbar(); }
  else if (k === ']') { setSizeMm(ed.sizeMm * 1.2); savePrefs(); renderOptbar(); }
  else if (k === '0') fit();
  else if (k === 'delete' || k === 'backspace') { if (bubble()) deleteBubble(); }
}

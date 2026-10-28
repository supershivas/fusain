// Interface de l'éditeur : barre d'outils, options de l'outil, volet (calques, trames, pages, bulles, case).
import {
  ed, page, panel, activeLayer, bubble, subscribe, notify, selectLayer, addLayer, deleteLayer, moveLayer, toggleLayer, renameLayer,
  clearLayer, mergeDown, clearMask, invertMask, setNote, addBubble, deleteBubble, selectBubble, commitBubbleEdit, refitBubble,
  snapshotBubble, goToPage, addPage, duplicatePage, deletePage, movePage, relayoutPage, markChanged, saveNow, addImageLayer,
  copyPanelTo, refitAutoBubbles,
} from './editor.js';
import { FONTS, loadFont, importFont, fontName } from './fonts.js';
import { attach, fit, view, zoomAt, requestRender, resize } from './view.js';
import { attachInput, typing } from './input.js';
import { LAYOUTS, pageSize } from './model.js';
import { allTramas, tramaById, drawTramaSwatch, encodeTrama, DITHER_METHODS, ditherGray, imageToGray } from './tramas.js';
import { BUBBLE_KINDS, SHAPES as BUBBLE_SHAPES, TAILS, props, preset } from './bubbles.js';
import { openModal, esc, icon, $, $$, confirmModal, promptModal, modalOpen } from './ui-core.js';
import { toast } from './toast.js';
import { layoutSvg } from './home.js';
import { buildPDF, renderPage, canvasToBlob, download, safeName, ensureFonts } from './export.js';
import { loadPage, unloadPage } from './store.js';
import { exportProject } from './portable.js';

const TOOLS = [
  { id: 'pencil', icon: 'pencil', label: 'Crayon (B)', key: 'b' },
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
  { id: 'layers', icon: 'stack-2', label: 'Calques' }, { id: 'tramas', icon: 'texture', label: 'Trames' },
  { id: 'pages', icon: 'files', label: 'Pages' }, { id: 'bubbles', icon: 'message-circle', label: 'Bulles' },
  { id: 'case', icon: 'layout-grid', label: 'Case' },
];

let root, dockTab = 'layers', dockOpen = true, unsub = null, keyHandler = null;

const prefsKey = 'fusain:prefs';
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefsKey)) || {};
    if (typeof p.fingerDraws === 'boolean') ed.fingerDraws = p.fingerDraws;
    if (typeof p.pressure === 'boolean') ed.pressure = p.pressure;
    if (typeof p.showNotes === 'boolean') ed.showNotes = p.showNotes;
    if (typeof p.size === 'number') ed.size = p.size;
  } catch { /* préférences locales seulement */ }
}
export function savePrefs() {
  try { localStorage.setItem(prefsKey, JSON.stringify({ fingerDraws: ed.fingerDraws, pressure: ed.pressure, showNotes: ed.showNotes, size: ed.size })); } catch { /* */ }
}

// ───────────────────────── Montage ─────────────────────────

export function mountEditor(el) {
  root = el;
  dockOpen = window.matchMedia('(min-width: 769px)').matches;
  root.innerHTML = `<div class="ed">
    <nav class="toolbar" id="toolbar" aria-label="Outils"></nav>
    <section class="stage" id="stage">
      <canvas id="view" aria-label="Page de BD"></canvas>
      <div class="optbar" id="optbar"></div>
      <div class="zoombar" id="zoombar"></div>
    </section>
    <aside class="dock" id="dock" ${dockOpen ? '' : 'hidden'}></aside>
  </div>`;
  attach($('#view', root));
  attachInput($('#view', root), { onUndo: undo, onRedo: redo });
  fit();
  renderAll();

  $('#toolbar', root).onclick = onToolbar;
  $('#zoombar', root).onclick = onZoombar;
  $('#optbar', root).addEventListener('click', onOptbar);
  $('#optbar', root).addEventListener('input', onOptInput);
  $('#dock', root).addEventListener('click', onDock);
  $('#dock', root).addEventListener('input', onDockInput);
  $('#dock', root).addEventListener('change', onDockChange);
  $('#dock', root).addEventListener('focusin', onDockFocus);

  unsub = subscribe(what => {
    if (what === 'undo') updateUndo();
    else if (what === 'project' || what === 'page') { renderAll(); fit(); }
    else if (what === 'panel') { renderDock(); renderOptbar(); }
    else if (what === 'layers' || what === 'bubbles') renderDock();
    else if (what === 'tool') { renderOptbar(); renderDock(); }
  });
  keyHandler = onKey;
  window.addEventListener('keydown', keyHandler);
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
    <button class="icon-btn icon-only" data-act="dock" title="Panneaux" aria-label="Panneaux" aria-pressed="${dockOpen}">${icon('layout-sidebar-right')}</button>`;
  updateUndo();
}

function updateUndo() {
  for (const [sel, ok] of [['[data-act=undo]', ed.undo.canUndo], ['[data-act=redo]', ed.undo.canRedo]]) {
    $$(sel, root).forEach(b => { b.disabled = !ok; });
  }
}

export function undo() { ed.undo.undo(); markChanged(); requestRender(); }
export function redo() { ed.undo.redo(); markChanged(); requestRender(); }

function setTool(id) {
  ed.tool = id;
  if (id !== 'bubble') ed.bubbleId = null;
  if (id === 'mask' && ed.maskMode === 'off') ed.maskMode = 'off';
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

const mmOf = px => (px / ed.project.dpi * 25.4).toFixed(2).replace('.', ',');

function sizeControl() {
  return `<label class="opt">Taille <input type="range" id="o-size" min="1" max="80" value="${ed.size}" aria-label="Taille du trait">
    <span class="val" id="o-size-val">${ed.size} px · ${mmOf(ed.size)} mm</span></label>`;
}
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
  if (t === 'pencil') html = sizeControl() + inkControl();
  else if (t === 'eraser') html = sizeControl();
  else if (t === 'texture') html = sizeControl() + tramaControl() + inkControl();
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
    html = `<span class="hint">Fais glisser une tirette sur une gouttière : une case grandit, sa voisine rétrécit.</span>`;
  } else if (t === 'pan') {
    html = `<span class="hint">Fais glisser pour déplacer la page. Pincer pour zoomer.</span>`;
  }
  if (ed.maskMode !== 'off' && t !== 'mask' && t !== 'bubble' && t !== 'pan') {
    html += `<button class="btn small" data-mask="off" title="Désactiver le masque">${icon('mask')} Masque : ${ed.maskMode === 'in' ? 'dans' : 'hors'} ${icon('x')}</button>`;
  }
  o.hidden = !html; o.innerHTML = html;
  paintSwatches(o);
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
  if (b.dataset.ink) { ed.ink = +b.dataset.ink; renderOptbar(); }
  else if (b.dataset.shape) { ed.shapeKind = b.dataset.shape; renderToolbar(); renderOptbar(); }
  else if (b.dataset.mask) { ed.maskMode = b.dataset.mask; renderOptbar(); requestRender(); }
  else if (b.dataset.freebubble) { ed.bubbleDraw = b.dataset.freebubble === '1'; renderOptbar(); }
  else if (b.dataset.maskpen) { ed.maskErase = b.dataset.maskpen === '1'; renderOptbar(); }
  else if (b.dataset.opt === 'trames') { dockOpen = true; $('#dock', root).hidden = false; renderToolbar(); dockTabTo('tramas'); setTimeout(resize, 0); }
}

function onOptInput(e) {
  if (e.target.id === 'o-size') {
    ed.size = +e.target.value; savePrefs();
    $('#o-size-val', root).textContent = `${ed.size} px · ${mmOf(ed.size)} mm`;
  } else if (e.target.id === 'o-filled') ed.shapeFilled = e.target.checked;
}

// ───────────────────────── Volet ─────────────────────────

function dockTabTo(id) { dockTab = id; renderDock(); }

export function renderDock() {
  const d = $('#dock', root);
  if (!d || !ed.project) return;
  const prevScroll = $('.dock-body', d) ? $('.dock-body', d).scrollTop : 0;
  d.innerHTML = `<div class="dock-tabs" role="tablist">${TABS.map(t =>
    `<button role="tab" data-tab="${t.id}" class="${dockTab === t.id ? 'on' : ''}" aria-selected="${dockTab === t.id}" aria-label="${t.label}" title="${t.label}">${icon(t.icon)}</button>`).join('')}</div>
    <div class="dock-body">${({ layers: layersTab, tramas: tramasTab, pages: pagesTab, bubbles: bubblesTab, case: caseTab })[dockTab]()}</div>`;
  $('.dock-body', d).scrollTop = prevScroll;
  paintSwatches(d);
  if (dockTab === 'tramas') $$('canvas[data-tcell]', d).forEach(c => drawTramaSwatch(c, tramaById(ed.project, c.dataset.tcell), 2));
}

function layersTab() {
  const p = panel(), idx = page().panels.indexOf(p);
  return `<h3>Case ${idx + 1}</h3>
    ${[...p.layers].reverse().map(l => `<div class="layer ${l.id === p.active ? 'on' : ''}" data-layer="${l.id}">
      <button class="icon-btn icon-only" data-act="vis" aria-label="${l.visible ? 'Masquer' : 'Afficher'} le calque ${esc(l.name)}">${icon(l.visible ? 'eye' : 'eye-off')}</button>
      <button class="name" data-act="select-layer">${esc(l.name)}</button>
      ${l.draft ? '<span class="tag">brouillon</span>' : ''}</div>`).join('')}
    <div class="tools-row">
      <button class="icon-btn icon-only" data-act="add-layer" title="Nouveau calque" aria-label="Nouveau calque">${icon('plus')}</button>
      <button class="icon-btn icon-only" data-act="up" title="Monter" aria-label="Monter le calque">${icon('arrow-up')}</button>
      <button class="icon-btn icon-only" data-act="down" title="Descendre" aria-label="Descendre le calque">${icon('arrow-down')}</button>
      <button class="icon-btn icon-only" data-act="rename" title="Renommer" aria-label="Renommer le calque">${icon('pencil')}</button>
      <button class="icon-btn icon-only" data-act="draft" title="Brouillon : visible à l'écran, jamais exporté" aria-label="Basculer en brouillon">${icon('ruler-2')}</button>
      <button class="icon-btn icon-only" data-act="merge" title="Fusionner vers le bas" aria-label="Fusionner vers le bas">${icon('stack-pop')}</button>
      <button class="icon-btn icon-only" data-act="clear" title="Vider le calque" aria-label="Vider le calque">${icon('eraser')}</button>
      <button class="icon-btn icon-only" data-act="del-layer" title="Supprimer le calque" aria-label="Supprimer le calque">${icon('trash')}</button>
    </div>
    <p style="color:var(--text-muted);font-size:.8rem">Un calque « brouillon » sert au crayonné : il se voit à l'écran en bleu mais n'est ni exporté ni imprimé.</p>`;
}

function tramasTab() {
  const list = allTramas(ed.project), groups = [...new Set(list.map(t => t.group))];
  const cur = tramaById(ed.project, ed.tramaId);
  return `${groups.map(g => `<h3>${esc(g)}</h3><div class="tgrid">${list.filter(t => t.group === g).map(t =>
    `<button class="tcell ${t.id === ed.tramaId ? 'on' : ''}" data-trama="${t.id}" aria-label="${esc(t.name)}" title="${esc(t.name)}">${t.solid ? '<span class="solid">Plein</span>' : `<canvas width="36" height="36" data-tcell="${t.id}"></canvas>`}</button>`).join('')}</div>`).join('')}
    <h3>Réglages</h3>
    <label class="field"><span>Échelle de la trame : ×${ed.tramaScale}</span><input type="range" id="d-scale" min="1" max="8" value="${ed.tramaScale}"></label>
    <label class="check"><input type="checkbox" id="d-opaque" ${ed.tramaOpaque ? 'checked' : ''}> Fond blanc sous la trame</label>
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-act="new-trame">${icon('plus')} Nouvelle trame</button>
      ${cur.builtin === false ? `<button class="btn small" data-act="edit-trame">${icon('pencil')} Modifier</button><button class="btn small danger" data-act="del-trame">${icon('trash')}</button>` : ''}
    </div>
    <p style="color:var(--text-muted);font-size:.8rem;margin-top:10px">La trame est accrochée à la page : deux cases voisines se raccordent sans rupture.</p>`;
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
    </div>`;
}

function bubblesTab() {
  const pg = page(), b = bubble();
  return `<h3>Ajouter</h3><div class="tools-row">${BUBBLE_KINDS.map(k =>
    `<button class="icon-btn icon-only" data-addb="${k.id}" title="${k.name}" aria-label="Ajouter : ${k.name}">${icon(k.icon)}</button>`).join('')}
    <button class="icon-btn icon-only ${ed.bubbleDraw ? 'on' : ''}" data-act="free-bubble" title="Dessiner une bulle à la main" aria-label="Dessiner une bulle à la main">${icon('writing')}</button></div>
    <h3>Sur cette page</h3>
    <div class="blist">${pg.bubbles.length ? pg.bubbles.map(x => `<button data-b="${x.id}" class="${x.id === ed.bubbleId ? 'on' : ''}">${x.who ? esc(x.who) + ' : ' : ''}${esc(x.text || '(vide)')}</button>`).join('') : '<p style="color:var(--text-muted)">Aucune bulle.</p>'}</div>
    ${b ? bubbleProps(b) : ''}`;
}

// Curseurs numériques d'une bulle : identifiant → [propriété, libellé]
const SLIDERS = {
  'b-radius': ['radius', v => `Angles arrondis : ${v} %`], 'b-wobble': ['wobble', v => `Imperfections : ${v} %`],
  'b-pad': ['pad', v => `Marge intérieure : ${String(v).replace('.', ',')} mm`], 'b-stroke': ['stroke', v => `Trait : ${v.toFixed(2).replace('.', ',')} mm`],
  'b-tailw': ['tailW', v => `Largeur de la queue : ${v} %`], 'b-tailround': ['tailRound', v => `Arrondi des côtés : ${v > 0 ? '+' : ''}${v}`],
  'b-tailbend': ['tailBend', v => `Courbure : ${v > 0 ? '+' : ''}${v}`], 'b-tailtip': ['tailTip', v => `Pointe émoussée : ${v} %`],
};
const slider = (id, p, min, max, step = 1) => `<label class="field"><span>${SLIDERS[id][1](p[SLIDERS[id][0]])}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${p[SLIDERS[id][0]]}"></label>`;

function bubbleProps(b) {
  const p = props(b);
  return `<h3>Bulle sélectionnée</h3>
      <label class="field"><span>Modèle</span><select id="b-kind">${BUBBLE_KINDS.map(k => `<option value="${k.id}" ${k.id === b.kind ? 'selected' : ''}>${k.name}</option>`).join('')}</select>
        <small>Un modèle règle d'un coup la forme, le trait, la police et la queue ; chaque réglage reste modifiable.</small></label>
      <label class="field"><span>Texte</span><textarea id="b-text" rows="3">${esc(b.text)}</textarea></label>
      <div class="field"><span>Police</span><button class="btn" data-act="pick-font" style="justify-content:flex-start">${icon('typography')} ${esc(fontName(p.font))}</button></div>
      <label class="field"><span>Corps : ${b.pt} pt</span><input type="range" id="b-pt" min="5" max="24" step="0.5" value="${b.pt}"></label>
      <h3>Forme</h3>
      <label class="field"><span>Contour</span><select id="b-shape">${BUBBLE_SHAPES.filter(x => x.id !== 'libre' || b.path).map(x => `<option value="${x.id}" ${x.id === p.shape ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      ${p.shape === 'rect' ? slider('b-radius', p, 0, 100, 5) : ''}
      ${p.shape === 'ellipse' || p.shape === 'rect' || p.shape === 'cloud' ? `${slider('b-wobble', p, 0, 100)}<button class="btn small" data-act="reseed" style="margin:-6px 0 14px">${icon('dice-3')} Autre tracé</button>` : ''}
      ${slider('b-pad', p, 0, 10, 0.5)}
      ${slider('b-stroke', p, 0, 2, 0.05)}
      <h3>Queue</h3>
      <label class="field"><span>Style</span><select id="b-tailstyle">${TAILS.map(x => `<option value="${x.id}" ${x.id === p.tailStyle ? 'selected' : ''}>${x.name}</option>`).join('')}</select>
        <small>Déplace le point rouge pour orienter la queue.</small></label>
      ${p.tailStyle === 'pointe' ? slider('b-tailw', p, 4, 70) + slider('b-tailround', p, -100, 100, 5) + slider('b-tailbend', p, -100, 100, 5) + slider('b-tailtip', p, 0, 100, 5) : ''}
      ${p.tailStyle === 'fleche' || p.tailStyle === 'bulles' ? slider('b-tailw', p, 4, 70) + slider('b-tailbend', p, -100, 100, 5) : ''}
      <h3>Texte</h3>
      <label class="check"><input type="checkbox" id="b-caps" ${b.caps ? 'checked' : ''}> Majuscules</label>
      <label class="check"><input type="checkbox" id="b-auto" ${b.auto ? 'checked' : ''}> Taille automatique</label>
      <button class="btn small danger" data-act="del-bubble" style="margin-top:8px">${icon('trash')} Supprimer la bulle</button>`;
}

function caseTab() {
  const p = panel(), idx = page().panels.indexOf(p);
  return `<h3>Case ${idx + 1}</h3>
    <label class="field"><span>Plan</span><input type="text" id="n-plan" value="${esc(p.note.plan)}" placeholder="Plan large, gros plan…"></label>
    <label class="field"><span>Description</span><textarea id="n-desc" rows="3" placeholder="Ce qu'il faut dessiner">${esc(p.note.description)}</textarea></label>
    <label class="check"><input type="checkbox" id="n-show" ${ed.showNotes ? 'checked' : ''}> Afficher les notes sur la page</label>
    <p style="color:var(--text-muted);font-size:.8rem">Les notes aident à dessiner ; elles ne sont jamais exportées.</p>
    <h3>Masque</h3>
    <p style="color:var(--text-muted);font-size:.8rem;margin-bottom:8px">Peins une zone avec l'outil Masque, puis choisis « Dans » ou « Hors » pour ne dessiner que dedans ou dehors.</p>
    <div class="row"><button class="btn small" data-act="mask-clear">Vider le masque</button><button class="btn small" data-act="mask-invert">Inverser</button></div>
    <h3>Image</h3>
    <button class="btn small" data-act="dither">${icon('photo')} Importer une image tramée</button>
    <h3>Copie</h3>
    <button class="btn small" data-act="copy-case">${icon('copy')} Copier le contenu vers une autre case</button>`;
}

// ───────────────────────── Événements du volet ─────────────────────────

async function onDock(e) {
  const tab = e.target.closest('[data-tab]');
  if (tab) { dockTabTo(tab.dataset.tab); return; }
  const tr = e.target.closest('[data-trama]');
  if (tr) { ed.tramaId = tr.dataset.trama; renderDock(); renderOptbar(); return; }
  const pgb = e.target.closest('[data-page]');
  if (pgb) { goToPage(+pgb.dataset.page); return; }
  const bb = e.target.closest('[data-b]');
  if (bb) { selectBubble(bb.dataset.b); if (ed.tool !== 'bubble') ed.tool = 'bubble', renderToolbar(), renderOptbar(); return; }
  const ab = e.target.closest('[data-addb]');
  if (ab) { if (ed.tool !== 'bubble') { ed.tool = 'bubble'; renderToolbar(); renderOptbar(); } addBubble(ab.dataset.addb); return; }
  const lay = e.target.closest('[data-layer]');
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'vis') toggleLayer(lay.dataset.layer, 'visible');
  else if (a === 'select-layer') selectLayer(lay.dataset.layer);
  else if (a === 'add-layer') addLayer(false);
  else if (a === 'del-layer') { if (!deleteLayer()) toast('Une case garde au moins un calque.'); }
  else if (a === 'up') moveLayer(1);
  else if (a === 'down') moveLayer(-1);
  else if (a === 'draft') toggleLayer(activeLayer().id, 'draft');
  else if (a === 'merge') { if (!mergeDown()) toast('Pas de calque en dessous.'); }
  else if (a === 'clear') clearLayer();
  else if (a === 'rename') {
    const l = activeLayer(), name = await promptModal({ title: 'Renommer le calque', label: 'Nom', value: l.name });
    if (name) renameLayer(l.id, name);
  } else if (a === 'new-trame') tramaEditor();
  else if (a === 'edit-trame') tramaEditor(tramaById(ed.project, ed.tramaId));
  else if (a === 'del-trame') {
    if (await confirmModal({ title: 'Supprimer la trame', message: 'Cette trame personnalisée sera retirée de la bibliothèque du projet. Les dessins déjà faits ne changent pas.', confirm: 'Supprimer', danger: true })) {
      ed.project.tramas = ed.project.tramas.filter(t => t.id !== ed.tramaId); ed.tramaId = 'plein'; markChanged(); renderDock(); renderOptbar();
    }
  }
  else if (a === 'add-page') { const id = await pickLayout('Nouvelle page'); if (id) await addPage(id); }
  else if (a === 'dup-page') await duplicatePage();
  else if (a === 'page-left') movePage(-1);
  else if (a === 'page-right') movePage(1);
  else if (a === 'relayout') {
    const id = await pickLayout('Disposition des cases');
    if (id) relayoutPage(id);
  } else if (a === 'del-page') {
    if (ed.project.pages.length < 2) { toast('Un projet garde au moins une page.'); return; }
    const restore = await deletePage();
    if (restore) toast('Page supprimée.', { actionLabel: 'Annuler', duration: 8000, onAction: restore });
  } else if (a === 'del-bubble') deleteBubble();
  else if (a === 'pick-font') fontModal();
  else if (a === 'reseed') { const b = bubble(); if (b) { const before = snapshotBubble(b); b.seed = Math.floor(Math.random() * 1e6); commitBubbleEdit(b, before); requestRender(); } }
  else if (a === 'copy-case') copyModal();
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

let bubbleBefore = null;
function onDockFocus(e) { const b = bubble(); if (b && /^b-/.test(e.target.id || '')) bubbleBefore = snapshotBubble(b); }

function onDockInput(e) {
  const id = e.target.id, b = bubble();
  if (id === 'd-scale') { ed.tramaScale = +e.target.value; e.target.previousElementSibling.textContent = 'Échelle de la trame : ×' + ed.tramaScale; paintSwatches(root); return; }
  if (id === 'd-opaque') { ed.tramaOpaque = e.target.checked; return; }
  if (id === 'n-plan') { setNote('plan', e.target.value); return; }
  if (id === 'n-desc') { setNote('description', e.target.value); return; }
  if (id === 'n-show') { ed.showNotes = e.target.checked; savePrefs(); requestRender(); return; }
  if (!b || !/^b-/.test(id)) return;
  if (!bubbleBefore) bubbleBefore = snapshotBubble(b);
  if (id === 'b-text') { b.text = e.target.value; refitBubble(b); }
  else if (id === 'b-pt') { b.pt = +e.target.value; e.target.previousElementSibling.textContent = `Corps : ${b.pt} pt`; refitBubble(b); }
  else if (id === 'b-caps') { b.caps = e.target.checked; refitBubble(b); }
  else if (id === 'b-auto') { b.auto = e.target.checked; refitBubble(b); }
  else if (id === 'b-kind') {
    Object.assign(b, preset(e.target.value)); b.kind = e.target.value;
    if (b.path) b.shape = 'libre';
    setTail(b, b.tailStyle !== 'none');
    refitBubble(b);
  } else if (id === 'b-shape') { b.shape = e.target.value; refitBubble(b); }
  else if (SLIDERS[id]) {
    const [key, label] = SLIDERS[id];
    b[key] = +e.target.value; e.target.previousElementSibling.textContent = label(b[key]);
    if (key === 'pad') refitBubble(b);
  }
  else if (id === 'b-tailstyle') { b.tailStyle = e.target.value; setTail(b, b.tailStyle !== 'none'); }
  requestRender();
}

function onDockChange(e) {
  const b = bubble();
  if (b && /^b-/.test(e.target.id || '') && bubbleBefore) {
    commitBubbleEdit(b, bubbleBefore); bubbleBefore = null;
    // Pas de reconstruction du volet à chaque champ : un toucher sur un bouton qui suit la sortie d'un champ serait perdu.
    if (['b-kind', 'b-shape', 'b-tailstyle'].includes(e.target.id)) renderDock();
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
      <small style="color:var(--text-muted)">Touche ou fais glisser pour allumer ou éteindre les cases. Un 1 est de l'encre.</small>`,
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: (c, box) => {
      const t = { id, name: $('#te-name', box).value.trim() || 'Ma trame', w: size, h: size, bits };
      const enc = encodeTrama(t), list = ed.project.tramas, i = list.findIndex(x => x.id === id);
      if (i >= 0) list[i] = enc; else list.push(enc);
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
  const opts = { method: 'floyd', threshold: 128, brightness: 0, contrast: 0, fit: 'contain' };
  const m = openModal({
    title: 'Image tramée', wide: true,
    body: `<p>Transforme une photo ou un dessin en noir et blanc tramé, placé dans un nouveau calque de la case ${page().panels.indexOf(p) + 1}.</p>
      <label class="field" style="margin-top:10px"><span>Image</span><input type="file" id="di-file" accept="image/*"></label>
      <div id="di-ctl" hidden>
        <label class="field"><span>Méthode</span><select id="di-method">${DITHER_METHODS.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}</select></label>
        <label class="field"><span>Seuil</span><input type="range" id="di-th" min="20" max="235" value="128"></label>
        <label class="field"><span>Luminosité</span><input type="range" id="di-br" min="-100" max="100" value="0"></label>
        <label class="field"><span>Contraste</span><input type="range" id="di-co" min="-100" max="100" value="0"></label>
        <label class="field"><span>Cadrage</span><select id="di-fit"><option value="contain">Image entière</option><option value="cover">Remplir la case</option></select></label>
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
    refitBubble(b); commitBubbleEdit(b, before); renderDock(); m.close();
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
  else if (k === '[') { ed.size = Math.max(1, ed.size - Math.ceil(ed.size / 8)); renderOptbar(); }
  else if (k === ']') { ed.size = Math.min(80, ed.size + Math.ceil(ed.size / 8)); renderOptbar(); }
  else if (k === '0') fit();
  else if (k === 'delete' || k === 'backspace') { if (bubble()) deleteBubble(); }
}

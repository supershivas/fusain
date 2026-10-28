// Barre de menus de l'en-tête (Fichier, Édition, Image, Calque, Page, Affichage) ; un seul bouton « Menu » sur téléphone.
import { ed, page, panel, activeLayer, bubble } from './editor.js';
import { runCommand, TOOLS } from './editor-ui.js';
import { openSettings } from './settings.js';
import { esc, icon, $ } from './ui-core.js';
import { canFullscreen, isFullscreen } from './shell.js';

// [commande, libellé, icône, raccourci, désactivée ?] ; null = séparateur
const menus = () => {
  const pg = page(), layer = activeLayer(), many = ed.project.pages.length > 1, idx = pg.panels.indexOf(panel());
  return [
    ['Fichier', [
      ['home', 'Mes dessins', 'home-2'], ['new-project', 'Nouveau projet…', 'file-plus'], ['rename', 'Renommer le projet…', 'pencil'], null,
      ['export-pdf', 'Exporter en PDF', 'file-type-pdf'], ['export-png', `Exporter la page ${ed.pageIdx + 1} en PNG`, 'photo'], ['export-json', 'Sauvegarde JSON du projet', 'file-export'], null,
      ['import-decoupage', 'Importer un découpage…', 'file-import'], ['settings', 'Réglages…', 'settings']]],
    ['Édition', [
      ['undo', 'Annuler', 'arrow-back-up', 'Ctrl+Z', !ed.undo.canUndo], ['redo', 'Rétablir', 'arrow-forward-up', 'Ctrl+Maj+Z', !ed.undo.canRedo], null,
      ['clear-layer', 'Vider le calque', 'eraser'], ['copy-case', 'Copier la case vers…', 'copy'], null,
      ['del-case', 'Supprimer la case', 'trash', '', pg.panels.length < 2], ['del-bubble', 'Supprimer la bulle', 'message-circle-off', 'Suppr', !bubble()]]],
    ['Outils', [
      ...TOOLS.map(t => ['tool:' + t.id, t.label.replace(/ \(.\)$/, ''), t.icon, t.key.toUpperCase()]), null,
      ['lib-brushes', 'Bibliothèque de pinceaux…', 'brush'], ['lib-tramas', 'Bibliothèque de trames…', 'texture'], ['lib-bubbles', 'Modèles de bulles…', 'message-circle']]],
    ['Image', [
      ['fit', 'Ajuster à l\'écran', 'zoom-scan', '0'], ['zoom-in', 'Zoom avant', 'zoom-in'], ['zoom-out', 'Zoom arrière', 'zoom-out'], null,
      ['tool-layout', 'Taille des cases', 'layout-board-split', 'L'], ['relayout', 'Disposition des cases…', 'layout-grid'], ['frame', `Trait du cadre (case ${idx + 1})`, 'border-style'], ['dither', 'Image tramée…', 'photo']]],
    ['Calque', [
      ['add-ink', 'Nouveau calque d\'encre', 'plus'], ['add-tram', 'Nouveau calque de trame', 'plus'], ['add-draft', 'Nouveau brouillon', 'plus'], null,
      ['dup-layer', 'Dupliquer', 'copy'], ['dup-bubble', 'Dupliquer la bulle', 'message-circle'], ['merge-layer', 'Fusionner vers le bas', 'stack-pop'], ['del-layer', 'Supprimer', 'trash', '', panel().layers.length < 2], null,
      ['lock-layer', layer.locked ? 'Déverrouiller' : 'Verrouiller', layer.locked ? 'lock-open' : 'lock'], ['solo-layer', ed.solo === layer.id ? 'Afficher tous les calques' : 'Afficher seul', 'eye']]],
    ['Page', [
      ['add-page', 'Nouvelle page…', 'file-plus'], ['dup-page', 'Dupliquer', 'copy'], ['del-page', 'Supprimer', 'trash', '', !many], null,
      ['page-left', 'Reculer', 'arrow-up', '', ed.pageIdx === 0], ['page-right', 'Avancer', 'arrow-down', '', ed.pageIdx >= ed.project.pages.length - 1], null,
      ['page-prev', 'Page précédente', 'chevron-left', '', ed.pageIdx === 0], ['page-next', 'Page suivante', 'chevron-right', '', ed.pageIdx >= ed.project.pages.length - 1]]],
    ['Affichage', [
      ...(canFullscreen() ? [['fullscreen', isFullscreen() ? 'Quitter le plein écran' : 'Plein écran', 'arrows-maximize']] : []),
      ['dock', 'Panneau de droite', 'layout-sidebar-right'], ['notes', ed.showNotes ? 'Masquer les notes' : 'Afficher les notes', 'notes'],
      ['hide-bubbles', pg.bubblesHidden ? 'Afficher les bulles' : 'Masquer les bulles', pg.bubblesHidden ? 'eye' : 'eye-off']]],
  ];
};

const LOCAL = { home: () => { location.hash = ''; }, settings: () => openSettings() };
let bar, pop, openIdx = null;   // openIdx : index du menu ouvert, -1 pour le menu unique du téléphone

const mobile = () => window.matchMedia('(max-width: 768px)').matches;

export function initMenus() {
  bar = $('#menubar');
  pop = document.createElement('div'); pop.className = 'menu-pop'; pop.setAttribute('role', 'menu'); pop.hidden = true;
  document.body.appendChild(pop);
  bar.addEventListener('click', e => { const b = e.target.closest('[data-menu]'); if (b) toggle(+b.dataset.menu); });
  bar.addEventListener('pointerover', e => { const b = e.target.closest('[data-menu]'); if (b && openIdx !== null && openIdx !== +b.dataset.menu && e.pointerType === 'mouse') show(+b.dataset.menu); });
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]'); if (!b || b.disabled) return;
    const id = b.dataset.cmd; close();
    if (LOCAL[id]) LOCAL[id](); else runCommand(id);
  });
  document.addEventListener('pointerdown', e => { if (openIdx !== null && !e.target.closest('#menubar') && !e.target.closest('.menu-pop')) close(); }, true);
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && openIdx !== null) { close(); } });
  window.addEventListener('resize', () => { if (!bar.hidden) { render(); close(); } });
  setVisible(false);
}

function render() {
  if (!ed.project) { bar.innerHTML = ''; return; }
  bar.innerHTML = mobile()
    ? `<button type="button" class="menu-btn" data-menu="-1" aria-haspopup="menu" aria-expanded="false" aria-label="Menu">${icon('menu-2')}<span>Menu</span></button>`
    : menus().map(([name], i) => `<button type="button" class="menu-btn" data-menu="${i}" aria-haspopup="menu" aria-expanded="false">${name}</button>`).join('');
}

export function setVisible(on) {
  if (!bar) return;
  bar.hidden = !on; close();
  if (on) render(); else bar.innerHTML = '';
}

function toggle(i) { if (openIdx === i) close(); else show(i); }

const item = it => it === null ? '<div class="menu-sep" role="separator"></div>'
  : `<button type="button" role="menuitem" class="menu-item" data-cmd="${it[0]}" ${it[4] ? 'disabled' : ''}>${icon(it[2])}<span>${esc(it[1])}</span>${it[3] ? `<kbd>${esc(it[3])}</kbd>` : ''}</button>`;

function show(i) {
  const all = menus();
  pop.innerHTML = i === -1
    ? all.map(([name, items]) => `<div class="menu-title">${name}</div>${items.map(item).join('')}`).join('')
    : all[i][1].map(item).join('');
  pop.hidden = false; openIdx = i;
  $$btn().forEach(b => { const on = +b.dataset.menu === i; b.setAttribute('aria-expanded', on); b.classList.toggle('on', on); });
  const anchor = bar.querySelector(`[data-menu="${i}"]`), r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 4 + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.maxHeight = window.innerHeight - r.bottom - 16 + 'px';
}
const $$btn = () => [...bar.querySelectorAll('[data-menu]')];

function close() {
  if (!pop) return;
  pop.hidden = true; openIdx = null;
  if (bar) $$btn().forEach(b => { b.setAttribute('aria-expanded', 'false'); b.classList.remove('on'); });
}

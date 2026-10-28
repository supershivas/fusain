// Point d'entrée : en-tête, routage (accueil / éditeur), mise à jour automatique, synchronisation.
import { startUpdateCheck, isBusyDefault } from './app-update.js';
import { openProject as loadProjectRecord } from './store.js';
import { onBroadcast } from './store.js';
import { ed, openInEditor, closeEditor, hasPendingSave, subscribe, saveNow } from './editor.js';
import { mountEditor, unmountEditor, projectMenu, loadPrefs } from './editor-ui.js';
import { renderHome, setOpenProject } from './home.js';
import { openSettings, syncDotClass } from './settings.js';
import * as sync from './sync.js';
import * as tools from './tools.js';
import { closeAllModals, esc, icon, $ } from './ui-core.js';
import { toast } from './toast.js';
import { loadImportedFonts } from './fonts.js';

const root = document.getElementById('app');
let inEditor = false;

// ───────────────────────── En-tête ─────────────────────────

function renderCrumb() {
  const c = $('#crumb');
  c.innerHTML = inEditor && ed.project
    ? `<span class="sep">${icon('chevron-right')}</span><button type="button" id="crumb-btn" aria-label="Menu du projet ${esc(ed.project.title)}">${esc(ed.project.title)}</button>`
    : '';
  const b = $('#crumb-btn');
  if (b) b.onclick = projectMenu;
}

function renderSyncDot() {
  const st = sync.getStatus(), dot = $('#sync-dot');
  dot.className = 'sync-dot ' + syncDotClass(st);
  dot.hidden = st.status === 'off';
}

$('#home').addEventListener('click', e => {
  e.preventDefault();
  closeAllModals();
  if (location.hash) location.hash = ''; else showHome();
});
$('#settings').addEventListener('click', () => openSettings({ onImported: () => { if (!inEditor) showHome(); } }));
sync.onStatus(renderSyncDot);

// ───────────────────────── Routage ─────────────────────────

setOpenProject(id => { location.hash = '#/p/' + id; });

async function leaveEditor() {
  if (!inEditor) return;
  inEditor = false;
  unmountEditor();
  await closeEditor();
}

async function showHome() {
  await leaveEditor();
  renderCrumb();
  document.title = 'Fusain';
  await renderHome(root);
}

async function showEditor(id) {
  await leaveEditor();
  const opened = await loadProjectRecord(id);
  if (!opened) { toast('Projet introuvable.', { type: 'error' }); location.hash = ''; return; }
  await openInEditor(opened.project, 0);
  inEditor = true;
  mountEditor(root);
  renderCrumb();
  document.title = opened.project.title + ' — Fusain';
}

async function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) await showEditor(m[1]); else await showHome();
}
window.addEventListener('hashchange', route);

subscribe(what => { if (what === 'title' || what === 'project') { renderCrumb(); if (ed.project) document.title = ed.project.title + ' — Fusain'; } });

// ───────────────────────── Onglets et appareils ─────────────────────────

onBroadcast(msg => {
  if (msg.type !== 'saved') return;
  if (!inEditor) { renderHome(root); return; }
  if (ed.project && msg.id === ed.project.id) {
    toast('Ce projet a été modifié dans un autre onglet.', { actionLabel: 'Recharger', duration: 10000, onAction: () => showEditor(ed.project.id) });
  }
});

window.addEventListener('fusain:remote-updated', e => {
  const { id, gone } = e.detail;
  if (!inEditor) { renderHome(root); return; }
  if (ed.project && id === ed.project.id) {
    if (gone) { toast('Ce projet a été supprimé sur un autre appareil.'); location.hash = ''; }
    else if (!hasPendingSave()) { toast('Mis à jour depuis un autre appareil.'); showEditor(id); }
  }
});
window.addEventListener('fusain:conflict', e => toast('Modifié sur deux appareils : ta version est gardée dans « copie locale ».', { duration: 9000 }));

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', () => saveNow());

// ───────────────────────── Démarrage ─────────────────────────

loadPrefs();
startUpdateCheck({
  onUpdated: v => toast(`Mis à jour en v${v}`),
  isBusy: () => isBusyDefault() || tools.busy() || hasPendingSave(),
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* hors ligne désactivé, l'app marche quand même */ });
}

(async () => {
  try { const mail = await sync.handleAuthRedirect(); if (mail) toast('Connecté : ' + mail); }
  catch (err) { toast(err.message, { type: 'error' }); }
  renderSyncDot();
  loadImportedFonts().catch(() => {});
  sync.startAutoSync();
  await route();
})();

window.fusain = { ed };   // aide au débogage et aux tests

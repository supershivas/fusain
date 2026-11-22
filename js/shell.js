// Coque de l'app sur tablette : plein écran, installation sur l'écran d'accueil, et blocage de ce que le navigateur
// ajoute par-dessus un outil de dessin (sélection de texte, menu de pression longue, zoom de la page, double toucher).

export const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const root = document.documentElement;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

// Safari iPad sait passer une page en plein écran (pas l'iPhone) ; installée sur l'écran d'accueil, l'app n'a déjà plus de barre.
export const canFullscreen = () => !isStandalone() && !!(root.requestFullscreen || root.webkitRequestFullscreen);
export const isFullscreen = () => !!fsElement();

export function toggleFullscreen() {
  if (fsElement()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  return Promise.resolve(req.call(root)).catch(() => {});
}

export function onFullscreenChange(fn) {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
}

// Conseil affiché une fois sur iPad ou iPhone dans Safari : l'installation masque la barre du navigateur.
export const shouldSuggestInstall = () => {
  if (!isIOS() || isStandalone()) return false;
  try { return !localStorage.getItem('fusain:tip-install'); } catch { return false; }
};
export const markInstallTipSeen = () => { try { localStorage.setItem('fusain:tip-install', '1'); } catch { /* */ } };

const editable = t => t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');

export function installGuards() {
  if (isStandalone()) root.classList.add('standalone');
  // pas de sélection ni de menu contextuel, sauf dans les champs de saisie
  document.addEventListener('contextmenu', e => { if (!editable(e.target)) e.preventDefault(); });
  document.addEventListener('selectstart', e => { if (!editable(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', e => { if (!editable(e.target)) e.preventDefault(); });
  // Filet de sécurité (Firefox et Chrome sur iPad ignorent parfois user-select) : toute sélection hors champ est aussitôt retirée,
  // donc le menu « Rechercher sur Firefox / dans la page » n'a plus de texte sur lequel s'afficher
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !editable(document.activeElement)) sel.removeAllRanges();
  });
  // Firefox : « / » et « ' » ouvrent la recherche rapide (Rechercher dans la page) dès qu'on tape hors d'un champ
  document.addEventListener('keydown', e => {
    if ((e.key === '/' || e.key === "'" || e.key === '\u2019') && !e.ctrlKey && !e.metaKey && !editable(e.target)) e.preventDefault();
  });
  // Safari : pas de zoom de la page au pincement (l'app zoome sa propre vue) ni au double toucher
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(n => document.addEventListener(n, e => e.preventDefault()));
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
  let last = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - last < 320 && !editable(e.target)) e.preventDefault();
    last = now;
  }, { passive: false });
}

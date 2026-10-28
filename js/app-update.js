/* ─── Version et mise à jour automatique — partagé entre les apps ────────────
   Source de vérité : supershivas/design-system/app-update.js
   Mis à jour par scripts/sync-design-system.sh dans chaque app qui l'utilise.
   Applique les sections 2 à 4 de CONVENTIONS.md : version.json, CHANGELOG.md,
   vérification au retour au premier plan et toutes les 5 minutes, rechargement
   seulement hors saisie, toast « Mis à jour en vX.Y.Z » après rechargement.

   Module ES sans dépendance :
     import { startUpdateCheck, loadChangelog } from './app-update.js'
     startUpdateCheck({ onUpdated: v => toast(`Mis à jour en v${v}`) })
     const entries = await loadChangelog()   // 5 dernières versions
   Les URL par défaut sont relatives au document (version.json, CHANGELOG.md) :
   passer versionUrl / changelogUrl si l'app est servie ailleurs.
   ─────────────────────────────────────────────────────────────────────────── */

const CHECK_EVERY_MS = 5 * 60 * 1000;
const BUSY_RETRY_MS = 5000;
const UPDATED_FLAG = 'app-update:updated-to';

async function fetchVersion(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('version.json ' + res.status);
  const data = await res.json();
  return data.version;
}

// Une saisie est en cours : champ ou éditeur focalisé, ou modale ouverte.
export function isBusyDefault() {
  const el = document.activeElement;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
  return !!document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]');
}

// Démarre la surveillance. `onUpdated(version)` est appelé une fois, au
// chargement qui suit une mise à jour, pour afficher le toast.
export function startUpdateCheck({
  versionUrl = 'version.json',
  isBusy = isBusyDefault,
  onUpdated,
} = {}) {
  try {
    const updatedTo = sessionStorage.getItem(UPDATED_FLAG);
    if (updatedTo) {
      sessionStorage.removeItem(UPDATED_FLAG);
      if (onUpdated) setTimeout(() => onUpdated(updatedTo), 600);
    }
  } catch {
    // sessionStorage indisponible : pas de toast, la mise à jour marche quand même.
  }

  let current = null;
  let reloading = false;

  function reloadWhenIdle(next) {
    if (reloading) return;
    if (isBusy()) {
      setTimeout(() => reloadWhenIdle(next), BUSY_RETRY_MS);
      return;
    }
    reloading = true;
    try { sessionStorage.setItem(UPDATED_FLAG, next); } catch { /* voir plus haut */ }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration()
        .then(reg => {
          if (!reg) return;
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          return reg.update();
        })
        .catch(() => {})
        .finally(() => window.location.reload());
    } else {
      window.location.reload();
    }
  }

  async function check() {
    if (reloading) return;
    try {
      const version = await fetchVersion(versionUrl);
      if (!version) return;
      // La première lecture sert de référence : la version affichée est
      // celle du fichier servi, jamais une valeur écrite dans le code.
      if (current === null) { current = version; return; }
      if (version !== current) reloadWhenIdle(version);
    } catch {
      // Hors ligne ou déploiement en cours : on s'abstient.
    }
  }

  check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, CHECK_EVERY_MS);
}

// Version courante (pour l'afficher dans les Réglages).
export async function loadVersion(versionUrl = 'version.json') {
  try { return await fetchVersion(versionUrl); } catch { return null; }
}

// Les `count` dernières versions de CHANGELOG.md :
// [{ version, date, changes: [...] }]. Format attendu : « ## 1.4.2 — 2026-09-24 »
// suivi de lignes « - … ».
export async function loadChangelog(changelogUrl = 'CHANGELOG.md', count = 5) {
  try {
    const res = await fetch(changelogUrl, { cache: 'no-store' });
    if (!res.ok) return [];
    const md = await res.text();
    return md.split(/^## /m).slice(1, count + 1).map(block => {
      const [title, ...lines] = block.split('\n');
      const [version, date] = title.split('—').map(s => s.trim());
      const changes = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
      return { version, date: date || '', changes };
    });
  } catch {
    return [];
  }
}

// Télécharge `data` en JSON (export des Réglages).
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Réglages en trois onglets : Stylet (doigt, paume, pression), Compte (synchronisation, connexion, serveur replié),
// App (affichage, labo, puis version, 5 dernières versions, export / import JSON).
import { openModal, esc, icon, $ } from './ui-core.js';
import { toast } from './toast.js';
import * as sync from './sync.js';
import { ed } from './editor.js';
import { savePrefs } from './editor-ui.js';
import { loadVersion, loadChangelog, downloadJSON } from './app-update.js';
import { exportAll, importBackup } from './portable.js';
import { canFullscreen, isFullscreen, toggleFullscreen, isIOS, isStandalone } from './shell.js';

const STATUS_TEXT = {
  off: 'Pas encore configurée : tes dessins restent sur cet appareil.',
  signedout: 'Configurée, mais tu n\'es pas connecté.',
  idle: 'Synchronisé', syncing: 'Synchronisation en cours…', error: 'Erreur de synchronisation.', offline: 'Hors ligne : la synchronisation reprendra seule.',
};

const agoText = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`; };
const gammaLabel = g => g < 0.9 ? 'douce' : g > 1.1 ? 'ferme' : 'normale';

export function syncDotClass(st) {
  return st.status === 'idle' ? 'ok' : st.status === 'syncing' ? 'busy' : st.status === 'error' ? 'err' : '';
}

export async function openSettings({ onImported } = {}) {
  const [version, changes] = await Promise.all([loadVersion(), loadChangelog('CHANGELOG.md', 5)]);
  const cfg = sync.getConfig() || { url: '', key: '' };

  const TAB_KEY = 'fusain:settings-tab';
  let tab = 'stylet'; try { tab = localStorage.getItem(TAB_KEY) || 'stylet'; } catch { /* */ }
  if (!['stylet', 'compte', 'app'].includes(tab)) tab = 'stylet';
  const TABS = [['stylet', 'Stylet', 'pencil'], ['compte', 'Compte', 'cloud'], ['app', 'App', 'apps']];
  const install = isStandalone() ? '<small class="note">Fusain est installé : il s\'ouvre sans barre de navigateur.</small>'
    : isIOS() ? `<small class="note">Pour l'ouvrir sans barre : ${icon('share-2')} Partager → <b>Sur l'écran d'accueil</b>.</small>`
    : '<small class="note">Installe Fusain depuis le menu du navigateur pour l\'ouvrir sans barre d\'adresse.</small>';

  const m = openModal({
    title: 'Réglages', wide: false, noFocus: true,
    body: `
    <div class="seg set-tabs" role="tablist" aria-label="Rubriques des réglages">${TABS.map(([id, label, ic]) =>
      `<button type="button" role="tab" data-stab="${id}" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}">${icon(ic)} ${label}</button>`).join('')}</div>

    <section class="set-pane" data-pane="stylet" ${tab === 'stylet' ? '' : 'hidden'}>
      <label class="check"><input type="checkbox" id="s-finger" ${ed.fingerDraws ? 'checked' : ''}> Le doigt dessine aussi</label>
      <small class="note">Sinon, dès qu'un stylet est utilisé, le doigt déplace la vue.</small>
      <label class="field inline"><span>Rejet de la paume</span><select id="s-palm" data-tip="Rejet de la paume|Un doigt posé seul pendant ou juste après le stylet est ignoré ; deux doigts restent des gestes (zoom, annuler).">${[['strong', 'Fort (1,6 s)'], ['normal', 'Normal (0,7 s)'], ['off', 'Désactivé']].map(([v, n]) => `<option value="${v}" ${ed.palm === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="s-pressure" ${ed.pressure ? 'checked' : ''}> Pression du stylet</label>
      <label class="field inline"><span>Courbe : <span id="s-gamma-v">${gammaLabel(ed.pressureGamma)}</span></span>
        <input type="range" id="s-gamma" min="0.4" max="2.2" step="0.1" value="${ed.pressureGamma}" aria-label="Courbe de pression" data-tip="Courbe de pression|Douce : un toucher léger donne déjà un trait épais. Ferme : il faut appuyer davantage."></label>
      <div id="s-pad" class="set-pad">
        <span id="s-pad-t">Zone d'essai : pose le stylet ici</span>
        <div class="set-pad-bar"><div id="s-pad-bar"></div></div>
      </div>
    </section>

    <section class="set-pane" data-pane="compte" ${tab === 'compte' ? '' : 'hidden'}>
      <div class="status-line" id="s-status"></div>
      <div id="s-auth"></div>
      <details class="set-more" ${sync.configured() ? '' : 'open'}><summary>${icon('chevron-right')} Serveur Supabase</summary>
        <label class="field"><span>URL du projet</span><input type="url" id="s-url" value="${esc(cfg.url)}" placeholder="https://xxxx.supabase.co" autocapitalize="off" autocomplete="off"></label>
        <label class="field"><span>Clé anon (publique)</span><input type="text" id="s-key" value="${esc(cfg.key)}" placeholder="eyJ…" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <small class="note">Gardées sur cet appareil seulement.</small>
        <div class="row" style="margin-top:6px"><button class="btn small" id="s-save-cfg">Enregistrer</button></div>
      </details>
    </section>

    <section class="set-pane" data-pane="app" ${tab === 'app' ? '' : 'hidden'}>
      <h3 class="sec-title">Affichage</h3>
      ${canFullscreen() ? `<button class="btn" id="s-fs">${icon('arrows-maximize')} ${isFullscreen() ? 'Quitter le plein écran' : 'Plein écran'}</button>` : ''}
      ${install}
      <div class="row" style="margin-top:10px"><a class="btn small" href="labo.html">${icon('flask')} Labo</a></div>
      <h3 class="sec-title">Version</h3>
      <div class="version-tag">v${esc(version || '?')}</div>
      <details class="set-more"><summary>${icon('chevron-right')} Nouveautés récentes</summary>
        <ul class="ver-list">${changes.map(c => `<li><b>v${esc(c.version)}</b><span>${esc(c.date)}</span><ul>${c.changes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></li>`).join('') || '<li>Historique indisponible hors ligne.</li>'}</ul>
      </details>
      <h3 class="sec-title">Mes données</h3>
      <div class="row"><button class="btn small" id="s-export">${icon('file-export')} Exporter (JSON)</button>
      <button class="btn small" id="s-import">${icon('file-import')} Importer</button></div>
      <small class="note">Tous les projets, avec leurs calques.</small>
      <input type="file" id="s-import-file" accept=".json,application/json" hidden>
    </section>`,
  });

  const box = m.el;
  const pad = $('#s-pad', box);   // zone d'essai : montre le type de pointeur et la pression reçue
  const probe = e => {
    const pr = e.pointerType === 'pen' ? Math.pow(Math.max(0.02, e.pressure), ed.pressureGamma) : null;
    $('#s-pad-t', box).textContent = e.pointerType === 'pen' ? `Stylet · pression ${Math.round(e.pressure * 100)} % → trait ${Math.round(pr * 100)} %` : `${e.pointerType === 'touch' ? 'Doigt' : 'Souris'} : pas de pression`;
    $('#s-pad-bar', box).style.width = (pr === null ? 0 : pr * 100) + '%';
  };
  ['pointerdown', 'pointermove'].forEach(n => pad.addEventListener(n, probe));
  pad.addEventListener('pointerup', () => { $('#s-pad-bar', box).style.width = '0'; });
  const renderStatus = () => {
    const st = sync.getStatus();
    const when = st.status === 'idle' && st.lastSync ? ` · ${agoText(st.lastSync)}` : '';
    $('#s-status', box).innerHTML = `${st.status === 'off' ? '' : `<span class="sync-dot ${syncDotClass(st)}" style="position:static;display:inline-block;border-color:var(--card-bg)"></span>`} ${esc(STATUS_TEXT[st.status] || '')}${when}${st.lastError ? `<br><small style="color:var(--accent)">${esc(st.lastError)}</small>` : ''}${sync.libraryTableMissing() ? '<br><small class="note">Table <code>fusain_library</code> absente : exécute <code>supabase/fusain.sql</code> pour partager la bibliothèque.</small>' : ''}`;
    renderAuth();
  };
  function renderAuth() {
    const a = $('#s-auth', box);
    if (!sync.configured()) { a.innerHTML = '<small class="note">Renseigne le serveur ci-dessous, puis connecte-toi par email.</small>'; return; }
    if (sync.signedIn()) {
      a.innerHTML = `<p style="margin-top:6px">${esc(sync.userEmail())}</p>
        <div class="row" style="margin-top:8px"><button class="btn small" id="s-sync">${icon('refresh')} Synchroniser</button>
        <button class="btn small" id="s-out">${icon('logout')} Se déconnecter</button></div>`;
    } else {
      a.innerHTML = `<label class="field"><span>Email</span><input type="email" id="s-mail" autocomplete="email" placeholder="toi@exemple.fr"></label>
        <button class="btn small primary" id="s-link">${icon('mail')} Envoyer le lien de connexion</button>
        <label class="field" style="margin-top:14px"><span>Code ou lien reçu par email</span><input type="text" id="s-code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" placeholder="123456 ou https://…">
          <small>Sur iPad installé : copie le lien de l'email (appui long) et colle-le ici.</small></label>
        <button class="btn small" id="s-verify">Se connecter</button>`;
    }
  }
  renderStatus();
  const off = sync.onStatus(renderStatus);

  box.addEventListener('change', e => {
    if (e.target.id === 's-finger') { ed.fingerDraws = e.target.checked; savePrefs(); }
    else if (e.target.id === 's-palm') { ed.palm = e.target.value; savePrefs(); }
    else if (e.target.id === 's-pressure') { ed.pressure = e.target.checked; savePrefs(); }
    else if (e.target.id === 's-gamma') { ed.pressureGamma = +e.target.value; $('#s-gamma-v', box).textContent = gammaLabel(ed.pressureGamma); savePrefs(); }
    else if (e.target.id === 's-import-file') doImport(e.target.files[0]);
  });
  box.addEventListener('click', async e => {
    const tb = e.target.closest('[data-stab]');
    if (tb) {   // onglet : une seule rubrique visible, la dernière ouverte est retenue
      tab = tb.dataset.stab; try { localStorage.setItem(TAB_KEY, tab); } catch { /* */ }
      box.querySelectorAll('[data-stab]').forEach(x => { const on = x === tb; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
      box.querySelectorAll('[data-pane]').forEach(pn => { pn.hidden = pn.dataset.pane !== tab; });
      return;
    }
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.id === 's-save-cfg') { sync.setConfig($('#s-url', box).value, $('#s-key', box).value); $('#s-url', box).value = sync.getConfig()?.url || ''; toast('Connexion enregistrée.'); renderStatus(); }
      else if (b.id === 's-link') {
        const mail = $('#s-mail', box).value.trim(); if (!mail) { toast('Saisis ton adresse email.'); return; }
        await sync.sendMagicLink(mail); toast('Lien envoyé : regarde ta boîte mail.');
      } else if (b.id === 's-verify') {
        await sync.verifyCode($('#s-mail', box).value.trim(), $('#s-code', box).value);
        toast('Connecté.'); sync.syncAll(); renderStatus();
      } else if (b.id === 's-out') { sync.signOut(); renderStatus(); }
      else if (b.id === 's-fs') { await toggleFullscreen(); m.close(); }
      else if (b.id === 's-sync') { sync.syncAll(); toast('Synchronisation lancée.'); }
      else if (b.id === 's-export') {
        const data = await exportAll();
        downloadJSON(data, `fusain-${new Date().toISOString().slice(0, 10)}.json`);
      } else if (b.id === 's-import') $('#s-import-file', box).click();
    } catch (err) { toast(err.message || 'Une erreur est survenue.', { type: 'error' }); }
  });

  async function doImport(file) {
    if (!file) return;
    try {
      const n = await importBackup(JSON.parse(await file.text()));
      toast(`${n} projet${n > 1 ? 's' : ''} restauré${n > 1 ? 's' : ''}.`);
      sync.syncSoon(500); if (onImported) onImported(); m.close();
    } catch (err) { toast(err.message || 'Sauvegarde illisible.', { type: 'error' }); }
  }

  // se désabonne à la fermeture
  const obs = new MutationObserver(() => { if (!document.body.contains(box)) { off(); obs.disconnect(); } });
  obs.observe(document.getElementById('modals'), { childList: true });
}

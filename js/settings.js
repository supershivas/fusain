// Réglages : dessin, compte et synchronisation, puis en bas version, 5 dernières versions, export JSON.
import { openModal, esc, icon, $ } from './ui-core.js';
import { toast } from './toast.js';
import * as sync from './sync.js';
import { ed } from './editor.js';
import { savePrefs } from './editor-ui.js';
import { loadVersion, loadChangelog, downloadJSON } from './app-update.js';
import { exportAll, importBackup } from './portable.js';

const STATUS_TEXT = {
  off: 'Pas encore configurée : tes dessins restent sur cet appareil.',
  signedout: 'Configurée, mais tu n\'es pas connecté.',
  idle: 'Synchronisée.', syncing: 'Synchronisation en cours…', error: 'Erreur de synchronisation.', offline: 'Hors ligne : la synchronisation reprendra seule.',
};

export function syncDotClass(st) {
  return st.status === 'idle' ? 'ok' : st.status === 'syncing' ? 'busy' : st.status === 'error' ? 'err' : '';
}

export async function openSettings({ onImported } = {}) {
  const [version, changes] = await Promise.all([loadVersion(), loadChangelog('CHANGELOG.md', 5)]);
  const cfg = sync.getConfig() || { url: '', key: '' };

  const m = openModal({
    title: 'Réglages', wide: false,
    body: `
    <section><h3 class="sec-title">Dessin</h3>
      <label class="check"><input type="checkbox" id="s-finger" ${ed.fingerDraws ? 'checked' : ''}> Le doigt dessine aussi
        </label><small style="color:var(--text-muted)">Désactivé, le doigt déplace la vue dès qu'un stylet a été détecté (la paume ne laisse aucune trace).</small>
      <label class="check"><input type="checkbox" id="s-pressure" ${ed.pressure ? 'checked' : ''}> Sensibilité à la pression du stylet</label>
    </section>
    <section class="modal-sec"><h3>Synchronisation (Supabase)</h3>
      <div class="status-line" id="s-status"></div>
      <label class="field"><span>URL du projet</span><input type="url" id="s-url" value="${esc(cfg.url)}" placeholder="https://xxxx.supabase.co" autocapitalize="off" autocomplete="off"></label>
      <label class="field"><span>Clé anon (publique)</span><input type="text" id="s-key" value="${esc(cfg.key)}" placeholder="eyJ…" autocapitalize="off" autocomplete="off" spellcheck="false">
        <small>Gardées dans ce navigateur seulement. Elles ne sont jamais envoyées ailleurs ni écrites dans le dépôt.</small></label>
      <div class="row"><button class="btn small" id="s-save-cfg">Enregistrer</button></div>
      <div id="s-auth" style="margin-top:14px"></div>
    </section>
    <section class="modal-sec"><h3>Labo</h3>
      <a class="btn" href="labo.html">${icon('flask')} Labo</a>
    </section>
    <section class="modal-sec"><h3>Version</h3>
      <div class="version-tag">v${esc(version || '?')}</div>
      <ul class="ver-list">${changes.map(c => `<li><b>v${esc(c.version)}</b><span>${esc(c.date)}</span><ul>${c.changes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></li>`).join('') || '<li>Historique indisponible hors ligne.</li>'}</ul>
    </section>
    <section class="modal-sec"><h3>Mes données</h3>
      <div class="row"><button class="btn" id="s-export">${icon('file-export')} Exporter (JSON)</button>
      <button class="btn" id="s-import">${icon('file-import')} Importer une sauvegarde</button></div>
      <small style="display:block;margin-top:8px;color:var(--text-muted)">L'export contient tous les projets, avec leurs calques en images PNG.</small>
      <input type="file" id="s-import-file" accept=".json,application/json" hidden>
    </section>`,
  });

  const box = m.el;
  const renderStatus = () => {
    const st = sync.getStatus();
    $('#s-status', box).innerHTML = `${st.status === 'off' ? '' : `<span class="sync-dot ${syncDotClass(st)}" style="position:static;display:inline-block;border-color:var(--card-bg)"></span>`} ${esc(STATUS_TEXT[st.status] || '')}${st.lastError ? `<br><small style="color:var(--accent)">${esc(st.lastError)}</small>` : ''}`;
    renderAuth();
  };
  function renderAuth() {
    const a = $('#s-auth', box);
    if (!sync.configured()) { a.innerHTML = '<small style="color:var(--text-muted)">Renseigne l\'URL et la clé, puis connecte-toi par lien magique.</small>'; return; }
    if (sync.signedIn()) {
      a.innerHTML = `<p>Connecté : <b>${esc(sync.userEmail())}</b></p>
        <div class="row" style="margin-top:8px"><button class="btn small" id="s-sync">${icon('refresh')} Synchroniser maintenant</button>
        <button class="btn small" id="s-out">${icon('logout')} Se déconnecter</button></div>`;
    } else {
      a.innerHTML = `<label class="field"><span>Email</span><input type="email" id="s-mail" autocomplete="email" placeholder="toi@exemple.fr"></label>
        <button class="btn small primary" id="s-link">${icon('mail')} Envoyer le lien de connexion</button>
        <label class="field" style="margin-top:14px"><span>Code reçu par email (6 chiffres)</span><input type="text" id="s-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
          <small>Sur iPad, ouvre le lien dans le même navigateur que l'app, ou saisis ici le code si ton modèle d'email le contient.</small></label>
        <button class="btn small" id="s-verify">Valider le code</button>`;
    }
  }
  renderStatus();
  const off = sync.onStatus(renderStatus);

  box.addEventListener('change', e => {
    if (e.target.id === 's-finger') { ed.fingerDraws = e.target.checked; savePrefs(); }
    else if (e.target.id === 's-pressure') { ed.pressure = e.target.checked; savePrefs(); }
    else if (e.target.id === 's-import-file') doImport(e.target.files[0]);
  });
  box.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.id === 's-save-cfg') { sync.setConfig($('#s-url', box).value, $('#s-key', box).value); toast('Connexion enregistrée.'); renderStatus(); }
      else if (b.id === 's-link') {
        const mail = $('#s-mail', box).value.trim(); if (!mail) { toast('Saisis ton adresse email.'); return; }
        await sync.sendMagicLink(mail); toast('Lien envoyé : regarde ta boîte mail.');
      } else if (b.id === 's-verify') {
        await sync.verifyCode($('#s-mail', box).value.trim(), $('#s-code', box).value);
        toast('Connecté.'); sync.syncAll(); renderStatus();
      } else if (b.id === 's-out') { sync.signOut(); renderStatus(); }
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

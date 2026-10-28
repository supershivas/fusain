// Écran d'accueil : mes projets, nouveau projet, import de découpage, corbeille.
import { listRecords, putRecord, deleteProjectHard, getRecord, getLayerRec, putLayerRec, saveProject, getThumb, setThumb } from './store.js';
import { FORMATS, DPIS, LAYOUTS, newProject, projectFromMeta, uid } from './model.js';
import { openModal, esc, icon, $, $$, confirmModal, promptModal, formatDate } from './ui-core.js';
import { toast } from './toast.js';
import { syncSoon, deleteRemote } from './sync.js';
import { DECOUPAGE_EXEMPLE, validateDecoupage, projectFromDecoupage } from './portable.js';
import { download } from './export.js';

let openProjectCb = () => {};
export const setOpenProject = fn => { openProjectCb = fn; };

export function layoutSvg(layout) {
  const W = 60, H = 80, m = 4, g = 2;
  const total = layout.rows.reduce((s, r) => s + r.h, 0), unit = (H - 2 * m - g * (layout.rows.length - 1)) / total;
  let y = m, out = '';
  for (const row of layout.rows) {
    const sum = row.c.reduce((s, c) => s + c, 0), uw = (W - 2 * m - g * (row.c.length - 1)) / sum;
    let x = m;
    for (const c of row.c) { out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(c * uw).toFixed(1)}" height="${(row.h * unit).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.6"/>`; x += c * uw + g; }
    y += row.h * unit + g;
  }
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${out}</svg>`;
}

export async function renderHome(root) {
  const records = (await listRecords()).sort((a, b) => b.updatedAt - a.updatedAt);
  await Promise.all(records.map(async r => { r.thumb = await getThumb(r.id); }));
  const live = records.filter(r => !r.deleted), trash = records.filter(r => r.deleted);
  root.innerHTML = `<div class="home"><div class="home-inner">
    <h1>Mes dessins</h1>
    <p class="lede">Des pages de BD en noir et blanc, à la trame. Elles se reprennent sur n'importe quel appareil.</p>
    <div class="home-actions">
      <button class="btn primary" data-act="new">${icon('plus')} Nouveau projet</button>
      <button class="btn" data-act="import-decoupage">${icon('file-import')} Importer un découpage</button>
    </div>
    ${live.length ? `<div class="cards">${live.map(card).join('')}</div>` :
      `<div class="empty">${icon('pencil')}<p>Aucun projet pour l'instant.</p><p>Crée une page de quatre cases pour commencer.</p></div>`}
    ${trash.length ? `<div class="trash-head">${icon('trash')} Corbeille (${trash.length})</div><div class="cards">${trash.map(trashCard).join('')}</div>` : ''}
  </div></div>`;

  root.onclick = async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = el.dataset.id, act = el.dataset.act;
    if (act === 'new') newProjectModal();
    else if (act === 'import-decoupage') decoupageModal();
    else if (act === 'open') openProjectCb(id);
    else if (act === 'menu') cardMenu(id, root);
    else if (act === 'restore') { await setDeleted(id, false); toast('Projet restauré.'); renderHome(root); }
    else if (act === 'purge') {
      if (await confirmModal({ title: 'Supprimer définitivement', message: 'Ce projet et tous ses dessins seront effacés, sur cet appareil et dans le cloud. Impossible de revenir en arrière.', confirm: 'Supprimer', danger: true })) {
        const rec = await getRecord(id), project = projectFromMeta(rec.meta);
        await deleteRemote(project); await deleteProjectHard(project);
        renderHome(root);
      }
    }
  };
}

function card(r) {
  const pages = r.meta.pages.length;
  return `<div class="card">
    <button class="card-open" data-act="open" data-id="${r.id}" aria-label="Ouvrir ${esc(r.title)}">
      <div class="card-thumb">${r.thumb ? `<img src="${r.thumb}" alt="">` : icon('pencil')}</div>
      <div class="card-meta"><div class="card-title">${esc(r.title)}</div>
      <div class="card-sub">${pages} page${pages > 1 ? 's' : ''} · ${formatDate(r.updatedAt)}</div></div>
    </button>
    <button class="icon-btn icon-only card-menu" data-act="menu" data-id="${r.id}" aria-label="Options du projet ${esc(r.title)}">${icon('dots')}</button>
  </div>`;
}

function trashCard(r) {
  return `<div class="card"><div class="card-thumb">${r.thumb ? `<img src="${r.thumb}" alt="" style="opacity:.5">` : icon('pencil')}</div>
    <div class="card-meta"><div class="card-title">${esc(r.title)}</div>
    <div class="row tight" style="margin-top:8px"><button class="btn small" data-act="restore" data-id="${r.id}">Restaurer</button>
    <button class="btn small danger" data-act="purge" data-id="${r.id}">Supprimer</button></div></div></div>`;
}

async function setDeleted(id, deleted) {
  const rec = await getRecord(id);
  rec.deleted = deleted; rec.meta.deleted = deleted; rec.meta.updatedAt = rec.updatedAt = Date.now(); rec.dirty = true;
  await putRecord(rec);
  syncSoon();
}

function cardMenu(id, root) {
  const m = openModal({
    title: 'Projet', narrow: true,
    body: `<div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn" data-m="rename">${icon('pencil')} Renommer</button>
      <button class="btn" data-m="dup">${icon('copy')} Dupliquer</button>
      <button class="btn danger" data-m="trash">${icon('trash')} Mettre à la corbeille</button></div>`,
  });
  m.el.onclick = async e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const rec = await getRecord(id);
    m.close();
    if (b.dataset.m === 'rename') {
      const name = await promptModal({ title: 'Renommer le projet', label: 'Titre', value: rec.title });
      if (name) { rec.title = rec.meta.title = name; rec.meta.updatedAt = rec.updatedAt = Date.now(); rec.dirty = true; await putRecord(rec); syncSoon(); renderHome(root); }
    } else if (b.dataset.m === 'dup') {
      await duplicateProject(rec); renderHome(root); toast('Projet dupliqué.');
    } else {
      await setDeleted(id, true); renderHome(root);
      toast('Projet placé dans la corbeille.', { actionLabel: 'Annuler', duration: 8000, onAction: async () => { await setDeleted(id, false); renderHome(root); } });
    }
  };
}

async function duplicateProject(rec) {
  const meta = JSON.parse(JSON.stringify(rec.meta));
  meta.id = uid(); meta.title += ' (copie)'; meta.updatedAt = meta.createdAt = Date.now();
  for (const p of meta.pages) for (const c of p.panels) for (const l of [...c.layers, ...(c.mask ? [c.mask] : [])]) {
    const lr = await getLayerRec(rec.id, l.id);
    if (lr) await putLayerRec(meta.id, l.id, { ...lr, pushed: null });
  }
  await putRecord({ id: meta.id, meta, title: meta.title, updatedAt: meta.updatedAt, deleted: false, dirty: true, base: 0 });
  const thumb = await getThumb(rec.id);
  if (thumb) await setThumb(meta.id, thumb);
  syncSoon();
}

function newProjectModal() {
  let layoutId = '2x2', dpi = 300;
  const m = openModal({
    title: 'Nouveau projet', wide: false,
    body: `<label class="field"><span>Titre</span><input type="text" id="np-title" placeholder="Sans titre" maxlength="120"></label>
      <label class="field"><span>Format de la page</span><select id="np-format">${FORMATS.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>
      <div class="field"><span>Résolution</span><div class="seg" id="np-dpi">${DPIS.map(d => `<button type="button" data-dpi="${d}" class="${d === dpi ? 'on' : ''}">${d} dpi</button>`).join('')}</div>
        <small>300 dpi pour imprimer ; 150 dpi pour un dessin plus léger sur mobile.</small></div>
      <div class="field"><span>Disposition de la première page</span>
        <div class="layout-grid" id="np-layout">${LAYOUTS.map(l => `<button type="button" class="layout-opt ${l.id === layoutId ? 'on' : ''}" data-layout="${l.id}">${layoutSvg(l)}${esc(l.name)}</button>`).join('')}</div></div>`,
    actions: [
      { label: 'Annuler' },
      { label: 'Créer', kind: 'primary', onClick: async (close, box) => {
        const format = FORMATS.find(f => f.id === $('#np-format', box).value);
        const project = newProject({ title: $('#np-title', box).value.trim() || 'Sans titre', format, dpi, layoutId });
        await saveProject(project, { changed: true });
        openProjectCb(project.id);
      } },
    ],
  });
  m.el.addEventListener('click', e => {
    const d = e.target.closest('[data-dpi]'), l = e.target.closest('[data-layout]');
    if (d) { dpi = +d.dataset.dpi; $$('#np-dpi button', m.el).forEach(b => b.classList.toggle('on', b === d)); }
    if (l) { layoutId = l.dataset.layout; $$('#np-layout .layout-opt', m.el).forEach(b => b.classList.toggle('on', b === l)); }
  });
}

function decoupageModal() {
  const m = openModal({
    title: 'Importer un découpage', wide: true,
    body: `<p>Un découpage est un fichier JSON (pages, cases, plans, dialogues) préparé hors de l'app. Fusain crée les pages, annote chaque case et pose les bulles ; il n'écrit aucune image.</p>
      <label class="field" style="margin-top:12px"><span>Fichier JSON</span><input type="file" id="dc-file" accept=".json,application/json"></label>
      <label class="field"><span>… ou colle le contenu ici</span><textarea id="dc-text" placeholder='{ "titre": "…", "pages": [ … ] }' style="font-family:var(--font-mono)"></textarea></label>
      <p id="dc-errors" style="color:var(--accent)"></p>
      <button class="btn small" type="button" id="dc-example">${icon('download')} Télécharger un exemple</button>`,
    actions: [
      { label: 'Annuler' },
      { label: 'Importer', kind: 'primary', onClick: async (close, box) => {
        const err = $('#dc-errors', box);
        let data;
        try { data = JSON.parse($('#dc-text', box).value); } catch { err.textContent = 'Ce texte n\'est pas du JSON valide.'; return false; }
        const errors = validateDecoupage(data);
        if (errors.length) { err.innerHTML = errors.slice(0, 6).map(esc).join('<br>'); return false; }
        const project = projectFromDecoupage(data);
        await saveProject(project, { changed: true });
        toast(`« ${project.title} » importé : ${project.pages.length} page${project.pages.length > 1 ? 's' : ''}.`);
        openProjectCb(project.id);
      } },
    ],
  });
  $('#dc-file', m.el).addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) $('#dc-text', m.el).value = await f.text();
  });
  $('#dc-example', m.el).addEventListener('click', () => download(new Blob([JSON.stringify(DECOUPAGE_EXEMPLE, null, 2)], { type: 'application/json' }), 'decoupage-exemple.json'));
}

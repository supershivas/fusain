// Export et import JSON (secours : tous les projets, calques en PNG), et import d'un découpage généré hors de l'app.
import { listRecords, getLayerRec, putImportedProject, getRecord } from './store.js';
import { uid, newProject, newPanel, newBubble, FORMATS, pageSize, layoutRects, mmToPx, autoLayout, LAYOUTS } from './model.js';
import { autoSize } from './bubbles.js';

const toDataURL = buf => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej;
  r.readAsDataURL(new Blob([buf], { type: 'image/png' }));
});
const fromDataURL = async url => (await fetch(url)).arrayBuffer();

async function exportRecord(rec) {
  const layers = {};
  const meta = rec.meta;
  for (const p of meta.pages) for (const c of p.panels) for (const l of [...c.layers, ...(c.mask ? [c.mask] : [])]) {
    const lr = await getLayerRec(meta.id, l.id);
    if (lr && lr.png) layers[l.id] = await toDataURL(lr.png);
  }
  return { meta, layers };
}

export async function exportAll() {
  const records = await listRecords();
  return {
    format: 'fusain-export', schema: 1, exportedAt: new Date().toISOString(),
    projects: await Promise.all(records.map(exportRecord)),
  };
}

export async function exportProject(id) {
  const rec = await getRecord(id);
  return { format: 'fusain-export', schema: 1, exportedAt: new Date().toISOString(), projects: [await exportRecord(rec)] };
}

// Restaure une sauvegarde : chaque projet devient une copie (nouveaux identifiants) si son identifiant existe déjà.
export async function importBackup(json) {
  if (!json || json.format !== 'fusain-export' || !Array.isArray(json.projects)) throw new Error('Ce fichier n\'est pas une sauvegarde Fusain.');
  const existing = new Set((await listRecords()).map(r => r.id));
  let n = 0;
  for (const item of json.projects) {
    const meta = JSON.parse(JSON.stringify(item.meta));
    if (existing.has(meta.id)) { meta.id = uid(); meta.title += ' (restauré)'; }
    meta.updatedAt = Date.now();
    const pngs = {};
    for (const [lid, url] of Object.entries(item.layers || {})) pngs[lid] = await fromDataURL(url);
    await putImportedProject(meta, pngs, { dirty: true, base: 0 });
    n++;
  }
  return n;
}

// ───────────────────────── Découpage JSON ─────────────────────────
// {
//   "titre": "Mon récit",
//   "pages": [ {
//     "disposition": "2x2",                       (facultatif ; sinon selon le nombre de cases)
//     "cases": [ {
//        "plan": "plan large", "description": "Le port au lever du jour",
//        "dialogues": [ { "personnage": "Léa", "texte": "On y va ?", "type": "parole" } ]
//     } ]
//   } ]
// }

export const DECOUPAGE_EXEMPLE = {
  titre: 'Le Phare',
  pages: [{
    disposition: '2x2',
    cases: [
      { plan: 'Plan large', description: 'Un phare sur une falaise, au crépuscule.',
        dialogues: [{ type: 'narration', texte: 'Cette nuit-là, la mer était calme.' }] },
      { plan: 'Plan moyen', description: 'Léa monte l\'escalier en colimaçon.',
        dialogues: [{ personnage: 'Léa', texte: 'Encore dix marches…', type: 'parole' }] },
      { plan: 'Gros plan', description: 'La lampe s\'éteint.',
        dialogues: [{ personnage: 'Léa', texte: 'Quelqu\'un a coupé le courant ?', type: 'pensee' }] },
      { plan: 'Plan d\'ensemble', description: 'Le phare plongé dans le noir.', dialogues: [] },
    ],
  }],
};

const TYPES = { parole: 'parole', pensee: 'pensee', pensée: 'pensee', narration: 'narration', texte: 'texte' };

export function validateDecoupage(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['Le fichier doit contenir un objet JSON.'];
  if (!Array.isArray(d.pages) || !d.pages.length) errors.push('« pages » doit être une liste d\'au moins une page.');
  (d.pages || []).forEach((p, i) => {
    if (!Array.isArray(p.cases) || !p.cases.length) errors.push(`Page ${i + 1} : « cases » doit être une liste d'au moins une case.`);
    else if (p.cases.length > 9) errors.push(`Page ${i + 1} : 9 cases au maximum par page.`);
    (p.cases || []).forEach((c, j) => {
      if (c.dialogues && !Array.isArray(c.dialogues)) errors.push(`Page ${i + 1}, case ${j + 1} : « dialogues » doit être une liste.`);
      (c.dialogues || []).forEach((dl, k) => {
        if (typeof dl.texte !== 'string' || !dl.texte.trim()) errors.push(`Page ${i + 1}, case ${j + 1}, dialogue ${k + 1} : « texte » manque.`);
        if (dl.type && !TYPES[String(dl.type).toLowerCase()]) errors.push(`Page ${i + 1}, case ${j + 1}, dialogue ${k + 1} : type inconnu « ${dl.type} » (parole, pensee, narration, texte).`);
      });
    });
  });
  return errors;
}

// Crée un projet : une page par entrée, des cases annotées (plan, description), des bulles posées dans chaque case.
export function projectFromDecoupage(d, { format = FORMATS[0], dpi = 300 } = {}) {
  const project = newProject({ title: (d.titre || d.title || 'Découpage importé').toString().slice(0, 120), format, dpi, layoutId: '1' });
  project.pages = [];
  const measure = document.createElement('canvas').getContext('2d');
  for (const pd of d.pages) {
    const layout = LAYOUTS.find(l => l.id === pd.disposition && l.rows.flatMap(r => r.c).length === pd.cases.length) || autoLayout(pd.cases.length);
    const { w, h } = pageSize(project);
    const rects = layoutRects(layout, w, h, mmToPx(project.margin, dpi), mmToPx(project.gutter, dpi));
    const page = { id: uid(), panels: rects.map(newPanel), bubbles: [] };
    pd.cases.forEach((cd, i) => {
      const panel = page.panels[i];
      panel.note = { plan: String(cd.plan || ''), description: String(cd.description || '') };
      let y = panel.y + panel.h * 0.12;   // sous l'étiquette de la note
      (cd.dialogues || []).forEach((dl, k) => {
        const kind = TYPES[String(dl.type || 'parole').toLowerCase()];
        const b = newBubble(kind, 0, 0);
        b.text = dl.texte; if (dl.personnage) b.who = String(dl.personnage);
        b.pt = 8;
        autoSize(measure, b, dpi);
        b.w = Math.min(b.w, panel.w * 0.8);
        const left = k % 2 === 0;
        b.x = Math.round(left ? panel.x + panel.w * 0.05 : panel.x + panel.w - b.w - panel.w * 0.05);
        b.y = Math.round(y);
        y += b.h + panel.h * 0.05;
        if (b.tail) b.tail = { x: Math.round(b.x + b.w * (left ? 0.3 : 0.7)), y: Math.round(b.y + b.h + panel.h * 0.07) };
        page.bubbles.push(b);
      });
    });
    project.pages.push(page);
  }
  return project;
}

// Export et import JSON (secours : tous les projets, calques en PNG), et import d'un découpage généré hors de l'app.
import { listRecords, getLayerRec, putImportedProject, getRecord } from './store.js';
import { uid, newProject, newPanel, newBubble, FORMATS, pageSize, layoutRects, mmToPx, autoLayout, LAYOUTS } from './model.js';
import { autoSize, props, wrapForWidth } from './bubbles.js';
import { loadFont } from './fonts.js';

const toDataURL = buf => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej;
  r.readAsDataURL(new Blob([buf], { type: 'image/png' }));
});
const fromDataURL = async url => (await fetch(url)).arrayBuffer();

// Format des sauvegardes JSON. 1 : champ `schema` seul ; 2 : `schemaVersion`, projets numérotés (PROJECT_SCHEMA).
export const EXPORT_SCHEMA = 2;
const header = () => ({ format: 'fusain-export', schemaVersion: EXPORT_SCHEMA, schema: EXPORT_SCHEMA, exportedAt: new Date().toISOString() });

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
  return { ...header(), projects: await Promise.all(records.map(exportRecord)) };
}

export async function exportProject(id) {
  const rec = await getRecord(id);
  return { ...header(), projects: [await exportRecord(rec)] };
}

// Restaure une sauvegarde : chaque projet devient une copie (nouveaux identifiants) si son identifiant existe déjà.
export async function importBackup(json) {
  if (!json || json.format !== 'fusain-export' || !Array.isArray(json.projects)) throw new Error('Ce fichier n\'est pas une sauvegarde Fusain.');
  const version = json.schemaVersion ?? json.schema ?? 1;
  if (version > EXPORT_SCHEMA) throw new Error('Cette sauvegarde vient d\'une version plus récente de Fusain : recharge l\'app pour la mettre à jour.');
  // Schéma 1 → 2 : même structure ; chaque projet est migré à son ouverture (projectFromMeta).
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

// Place les dialogues d'une case du découpage, dans l'ordre de lecture : une narration en haut à gauche, calée au bord
// de la case (sa marge `edge`) ; les répliques alternent à gauche et à droite, chacune un peu plus bas que la précédente
// (elles se chevauchent en hauteur quand elles tiennent côte à côte), queue vers le bas, vers l'intérieur de la case.
// `styles` : le dernier style réglé pour chaque type de bulle (préférences), pour que les bulles importées ressemblent aux autres.
export function placeDialogues(panel, dialogues, dpi, styles = {}, measure = document.createElement('canvas').getContext('2d')) {
  const out = [], mm = v => mmToPx(v, dpi), gap = mm(2), inset = mm(3);
  const L = panel.x + inset, R = panel.x + panel.w - inset;
  let top = panel.y + inset, y = top, prev = null, side = 0;
  for (const dl of dialogues || []) {
    const kind = TYPES[String(dl.type || 'parole').toLowerCase()] || 'parole';
    const b = newBubble(kind, 0, 0);
    Object.assign(b, styles[kind] || {});
    b.text = String(dl.texte || '').trim(); b.auto = true; delete b.wrap; delete b.path; b.rot = 0;
    if (dl.personnage) b.who = String(dl.personnage);
    const fit = maxW => { autoSize(measure, b, dpi); if (b.w > maxW) { b.wrap = Math.round(wrapForWidth(b, maxW, dpi)); autoSize(measure, b, dpi); } };
    if (kind === 'narration' || kind === 'texte') {
      const e = mm(props(b).edge ?? 2);
      fit(panel.w - 2 * e);
      b.x = panel.x + e; b.y = out.length ? y : panel.y + e;
      top = y = b.y + b.h + gap; prev = null; side = 0;
    } else {
      fit((R - L) * 0.6);
      b.x = side === 0 ? L : R - b.w;
      const beside = prev && prev.side !== side && prev.b.w + b.w + gap <= R - L;
      b.y = beside ? Math.max(top, prev.b.y + prev.b.h * 0.55) : y;
      y = Math.max(y, b.y + b.h + gap);
      if (b.tail) b.tail = { x: Math.round(b.x + b.w * (side === 0 ? 0.35 : 0.65)), y: Math.round(b.y + b.h + Math.min(mm(9), panel.h * 0.12)) };
      prev = { b, side }; side = 1 - side;
    }
    b.x = Math.round(b.x); b.y = Math.round(b.y); b.panel = panel.id;
    out.push(b);
  }
  return out;
}

// Polices des styles de bulle : chargées avant de mesurer le texte (sinon les bulles seraient mal dimensionnées).
export const loadBubbleFonts = (styles = {}) => Promise.all([...new Set(['architects', ...Object.values(styles).map(st => st && st.font).filter(Boolean)])].map(loadFont));

// Crée un projet : une page par entrée, des cases annotées (plan, description), des bulles posées dans chaque case.
export async function projectFromDecoupage(d, { format = FORMATS[0], dpi = 300, styles = {} } = {}) {
  const project = newProject({ title: (d.titre || d.title || 'Découpage importé').toString().slice(0, 120), format, dpi, layoutId: '1' });
  project.pages = [];
  await loadBubbleFonts(styles);
  const measure = document.createElement('canvas').getContext('2d');
  for (const pd of d.pages) {
    const layout = LAYOUTS.find(l => l.id === pd.disposition && l.rows.flatMap(r => r.c).length === pd.cases.length) || autoLayout(pd.cases.length);
    const { w, h } = pageSize(project);
    const rects = layoutRects(layout, w, h, mmToPx(project.margin, dpi), mmToPx(project.gutter, dpi));
    const page = { id: uid(), panels: rects.map(newPanel), bubbles: [] };
    pd.cases.forEach((cd, i) => {
      const panel = page.panels[i];
      panel.note = { plan: String(cd.plan || ''), description: String(cd.description || '') };
      page.bubbles.push(...placeDialogues(panel, cd.dialogues, dpi, styles, measure));
    });
    project.pages.push(page);
  }
  return project;
}

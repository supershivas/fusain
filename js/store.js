// Cache local (IndexedDB) : un enregistrement par projet (description sans pixels) et un par calque
// (image PNG 1-bit). C'est la copie de travail ; la synchronisation Supabase (sync.js) la reflète.
import { projectMeta, projectFromMeta, pageLayers, allLayers } from './model.js';
import { encodePNG2, canEncodePNG } from './png.js';

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('fusain', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('layers');
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const kvGet = key => tx('kv', 'readonly', s => wrap(s.get(key)));
export const kvSet = (key, value) => tx('kv', 'readwrite', s => wrap(s.put(value, key)));

export const listRecords = () => tx('projects', 'readonly', s => wrap(s.getAll()));
export const getRecord = id => tx('projects', 'readonly', s => wrap(s.get(id)));
export const putRecord = rec => tx('projects', 'readwrite', s => wrap(s.put(rec)));
// Lecture-modification-écriture en une seule transaction : l'éditeur et la synchronisation écrivent le même enregistrement.
// `mutate(actuel)` renvoie le nouvel enregistrement, ou null pour ne rien écrire.
export const updateRecord = (id, mutate) => tx('projects', 'readwrite', async s => {
  const next = mutate(await wrap(s.get(id)));
  if (next) await wrap(s.put(next));
  return next;
});
export const getThumb = id => kvGet('thumb:' + id);
export const getLayerRec = (pid, lid) => tx('layers', 'readonly', s => wrap(s.get(pid + '/' + lid)));
export const putLayerRec = (pid, lid, rec) => tx('layers', 'readwrite', s => wrap(s.put(rec, pid + '/' + lid)));

export async function deleteProjectHard(project) {
  const ids = allLayers(project).map(l => project.id + '/' + l.id);
  await tx('layers', 'readwrite', s => { ids.forEach(k => s.delete(k)); });
  await tx('projects', 'readwrite', s => wrap(s.delete(project.id)));
}

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fusain') : null;
export const onBroadcast = fn => { if (channel) channel.onmessage = e => fn(e.data); };
export const broadcast = msg => { if (channel) channel.postMessage(msg); };

// ───────────────────────── PNG ↔ tampon d'octets ─────────────────────────

const canvasFor = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export function isBlank(data) {
  if (!data) return true;
  for (let i = 0; i < data.length; i++) if (data[i]) return false;
  return true;
}

export async function encodeLayer(layer) {
  if (isBlank(layer.data)) return null;
  if (canEncodePNG()) return encodePNG2(layer.data, layer.w, layer.h);
  const c = canvasFor(layer.w, layer.h), ctx = c.getContext('2d');
  const img = ctx.createImageData(layer.w, layer.h), u32 = new Uint32Array(img.data.buffer), d = layer.data;
  for (let i = 0; i < d.length; i++) u32[i] = d[i] === 1 ? 0xFF000000 : d[i] === 2 ? 0xFFFFFFFF : 0;
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

export async function decodeLayer(png, w, h) {
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const c = canvasFor(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const px = ctx.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] < 128 ? 0 : px[i * 4] < 128 ? 1 : 2;
  return out;
}

const newRev = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ───────────────────────── Projets ─────────────────────────

export async function loadLayers(project, layers) {
  await Promise.all(layers.filter(l => !l.loaded).map(async l => {
    const rec = await getLayerRec(project.id, l.id);
    l.data = rec && rec.png ? await decodeLayer(rec.png, l.w, l.h) : null;
    l.loaded = true; l.dirty = false;
    if (rec && rec.rev) l.rev = rec.rev;
  }));
}
export const loadPage = (project, page) => loadLayers(project, pageLayers(page));

// Libère les pixels d'une page enregistrée, pour ne garder en mémoire que la page ouverte.
export function unloadPage(page) {
  for (const l of pageLayers(page)) if (!l.dirty && l.loaded) { l.data = null; l.loaded = false; }
}

export async function openProject(id) {
  const rec = await getRecord(id);
  if (!rec) return null;
  return { project: projectFromMeta(rec.meta), record: rec };
}

// Écrit les calques modifiés puis la description. `changed` : le contenu a bougé (met `updatedAt` à jour).
export async function saveProject(project, { changed = true } = {}) {
  if (changed) project.updatedAt = Date.now();
  for (const l of allLayers(project)) {
    if (!l.dirty || !l.loaded) continue;
    // `encodeLayer` copie les pixels tout de suite : un trait tracé pendant l'écriture remet le drapeau
    l.dirty = false;
    try {
      const png = await encodeLayer(l);
      l.rev = newRev();
      const old = await getLayerRec(project.id, l.id);
      await putLayerRec(project.id, l.id, { rev: l.rev, png, pushed: old ? old.pushed : null });
    } catch (e) { l.dirty = true; throw e; }
  }
  const meta = projectMeta(project);
  const rec = await updateRecord(project.id, prev => ({
    id: project.id, meta, title: project.title, updatedAt: project.updatedAt, deleted: project.deleted,
    dirty: changed || (prev ? prev.dirty : true), base: prev ? prev.base || 0 : 0,
  }));
  broadcast({ type: 'saved', id: project.id });
  return rec;
}

export const setThumb = (id, thumb) => kvSet('thumb:' + id, thumb);

// Import d'un projet complet (export JSON, synchronisation) : calques déjà encodés en PNG.
export async function putImportedProject(meta, pngs, { dirty = true, base = 0, pushed = false } = {}) {
  for (const [lid, png] of Object.entries(pngs)) {
    const l = findLayerMeta(meta, lid);
    await putLayerRec(meta.id, lid, { rev: l ? l.rev : null, png, pushed: pushed ? (l ? l.rev : null) : null });
  }
  await putRecord({ id: meta.id, meta, title: meta.title, updatedAt: meta.updatedAt, deleted: !!meta.deleted, dirty, base });
}

function findLayerMeta(meta, lid) {
  for (const p of meta.pages) for (const c of p.panels) {
    const hit = c.layers.find(l => l.id === lid) || (c.mask && c.mask.id === lid ? c.mask : null);
    if (hit) return hit;
  }
  return null;
}

export { newRev };

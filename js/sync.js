// Synchronisation Supabase : authentification par lien magique, table `fusain_projects`
// (description du projet), bucket Storage `fusain` (un PNG par calque). Aucune bibliothèque :
// des appels `fetch` vers l'API REST. L'URL et la clé anon sont saisies dans les Réglages et gardées
// dans ce navigateur (jamais dans le dépôt).
import { listRecords, putRecord, updateRecord, getLayerRec, putLayerRec, deleteProjectHard, newRev } from './store.js';
import { projectFromMeta, allLayers } from './model.js';

const CFG = 'fusain:supabase', SES = 'fusain:session', BUCKET = 'fusain';

const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, v) => { try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

export const getConfig = () => read(CFG);
export function setConfig(url, key) {
  url = (url || '').trim().replace(/\/+$/, '');
  key = (key || '').trim();
  write(CFG, url && key ? { url, key } : null);
  emit();
}
export const getSession = () => read(SES);
export const configured = () => !!getConfig();
export const signedIn = () => !!(getConfig() && getSession());
export const userEmail = () => (getSession() && getSession().user && getSession().user.email) || '';
const userId = () => getSession().user.id;

// ───────────────────────── État ─────────────────────────

let status = 'off', lastError = '', lastSync = 0;
const listeners = new Set();
export const onStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getStatus = () => ({ status, lastError, lastSync });
function setStatus(s, err = '') { status = s; lastError = err; if (s === 'idle') lastSync = Date.now(); emit(); }
function emit() {
  if (!configured()) status = 'off';
  else if (!signedIn() && status !== 'error') status = 'signedout';
  else if (status === 'off' || status === 'signedout') status = 'idle';
  listeners.forEach(fn => fn(getStatus()));
}

// ───────────────────────── Authentification ─────────────────────────

async function authCall(path, body, query = '') {
  const cfg = getConfig();
  if (!cfg) throw new Error('Supabase n\'est pas configuré.');
  const res = await fetch(cfg.url + '/auth/v1/' + path + query, {
    method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.msg || json.error_description || json.message || 'Erreur ' + res.status);
  return json;
}

export const sendMagicLink = email => authCall('otp', { email, create_user: true },
  '?redirect_to=' + encodeURIComponent(location.origin + location.pathname));

function keepSession(s) {
  write(SES, { access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: s.user });
  emit();
}

export async function verifyCode(email, token) {
  keepSession(await authCall('verify', { type: 'email', email, token: token.trim() }));
}

// Au retour du lien magique, les jetons arrivent dans le fragment de l'adresse.
export async function handleAuthRedirect() {
  const h = location.hash;
  if (!/access_token=|error_description=/.test(h)) return null;
  const q = new URLSearchParams(h.replace(/^#\/?/, ''));
  history.replaceState(null, '', location.pathname + location.search);
  if (q.get('error_description')) throw new Error(q.get('error_description').replace(/\+/g, ' '));
  const cfg = getConfig();
  if (!cfg) return null;
  const res = await fetch(cfg.url + '/auth/v1/user', { headers: { apikey: cfg.key, Authorization: 'Bearer ' + q.get('access_token') } });
  if (!res.ok) throw new Error('Lien de connexion invalide ou expiré.');
  keepSession({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'),
    expires_in: +q.get('expires_in') || 3600, user: await res.json() });
  return userEmail();
}

async function refresh() {
  const s = getSession();
  if (!s) throw new Error('Non connecté');
  const r = await authCall('token', { refresh_token: s.refresh_token }, '?grant_type=refresh_token');
  keepSession({ ...r, user: r.user || s.user });
}

export function signOut() { write(SES, null); status = 'signedout'; emit(); }

// Appel authentifié : renouvelle le jeton s'il expire, et une fois si le serveur répond 401.
async function api(path, opts = {}, retry = true) {
  const cfg = getConfig(), s = getSession();
  if (!cfg || !s) throw new Error('Non connecté');
  if (s.expires_at - 60 < Date.now() / 1000) await refresh();
  const res = await fetch(cfg.url + path, {
    ...opts, headers: { apikey: cfg.key, Authorization: 'Bearer ' + getSession().access_token, ...(opts.headers || {}) },
  });
  if (res.status === 401 && retry) { await refresh(); return api(path, opts, false); }
  return res;
}

async function check(res, what) {
  if (res.ok) return res;
  const t = await res.text().catch(() => '');
  throw new Error(what + ' : ' + res.status + ' ' + t.slice(0, 160));
}

// ───────────────────────── Projets distants ─────────────────────────

const objPath = (pid, lid) => `${userId()}/${pid}/${lid}.png`;

async function listRemote() {
  const res = await check(await api('/rest/v1/fusain_projects?select=id,title,data,updated_at,deleted&order=updated_at.desc'), 'Lecture des projets');
  return res.json();
}

async function uploadLayer(pid, lid, png) {
  await check(await api(`/storage/v1/object/${BUCKET}/${objPath(pid, lid)}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: new Blob([png], { type: 'image/png' }),
  }), 'Envoi du calque');
}
async function removeLayer(pid, lid) {
  await api(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [objPath(pid, lid)] }) });
}
async function downloadLayer(pid, lid) {
  const res = await api(`/storage/v1/object/authenticated/${BUCKET}/${objPath(pid, lid)}`);
  if (res.status === 404 || res.status === 400) return null;   // calque vide : rien d'envoyé
  return (await check(res, 'Téléchargement du calque')).arrayBuffer();
}

const layerMetas = meta => meta.pages.flatMap(p => p.panels.flatMap(c => [...c.layers, ...(c.mask ? [c.mask] : [])]));

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function push(rec) {
  const meta = rec.meta;
  await pool(layerMetas(meta), 4, async l => {
    const lr = await getLayerRec(meta.id, l.id);
    if (!lr) return;                                   // jamais dessiné : vide des deux côtés
    if (lr.pushed === lr.rev) return;
    if (lr.png) await uploadLayer(meta.id, l.id, lr.png);
    else if (lr.pushed) await removeLayer(meta.id, l.id);   // effacé depuis le dernier envoi
    await putLayerRec(meta.id, l.id, { ...lr, pushed: lr.rev });
  });
  await check(await api('/rest/v1/fusain_projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: meta.id, title: meta.title, data: meta, deleted: !!meta.deleted, updated_at: new Date(meta.updatedAt).toISOString() }),
  }), 'Envoi du projet');
  // l'éditeur a pu enregistrer pendant l'envoi : le projet reste « à envoyer » s'il a changé depuis
  await updateRecord(meta.id, fresh => fresh && ({ ...fresh, base: meta.updatedAt, dirty: fresh.updatedAt !== meta.updatedAt }));
}

async function pull(rec, row) {
  const meta = row.data;
  await pool(layerMetas(meta), 4, async l => {
    if (!l.rev) return;
    const lr = await getLayerRec(meta.id, l.id);
    if (lr && lr.rev === l.rev) return;
    const png = await downloadLayer(meta.id, l.id);
    await putLayerRec(meta.id, l.id, { rev: l.rev, png, pushed: l.rev });
  });
  const ms = Date.parse(row.updated_at);
  // si le projet a changé ici pendant le téléchargement, on ne l'écrase pas : le prochain passage tranchera
  await updateRecord(meta.id, cur => (cur && rec && cur.updatedAt !== rec.updatedAt) ? null
    : { id: meta.id, meta, title: meta.title, updatedAt: meta.updatedAt, deleted: !!meta.deleted, dirty: false, base: ms });
  window.dispatchEvent(new CustomEvent('fusain:remote-updated', { detail: { id: meta.id } }));
}

// Les deux côtés ont changé : on garde la version locale comme copie, puis on prend la version distante.
async function conflict(rec, row) {
  const copyId = crypto.randomUUID();
  const meta = { ...rec.meta, id: copyId, title: rec.meta.title + ' (copie locale)', updatedAt: Date.now() };
  for (const l of allLayers(projectFromMeta(rec.meta))) {
    const lr = await getLayerRec(rec.id, l.id);
    if (lr) await putLayerRec(copyId, l.id, { ...lr, pushed: null });
  }
  await putRecord({ id: copyId, meta, title: meta.title, updatedAt: meta.updatedAt, deleted: false, dirty: true, base: 0 });
  await pull(rec, row);
  window.dispatchEvent(new CustomEvent('fusain:conflict', { detail: { id: rec.id, copyId } }));
}

async function syncOne(rec, row) {
  const remoteMs = row ? Date.parse(row.updated_at) : 0;
  if (!row) {
    if (rec.base > 0 && !rec.dirty) { await deleteProjectHard(projectFromMeta(rec.meta)); window.dispatchEvent(new CustomEvent('fusain:remote-updated', { detail: { id: rec.id, gone: true } })); }
    else await push(rec);
  } else if (rec.dirty) {
    if (remoteMs > rec.base && remoteMs !== rec.updatedAt) await conflict(rec, row); else await push(rec);
  } else if (remoteMs > rec.base) await pull(rec, row);
}

let running = false, again = false;
export async function syncAll() {
  if (!signedIn()) return;
  if (running) { again = true; return; }
  running = true;
  try {
    setStatus('syncing');
    const rows = await listRemote(), byId = new Map(rows.map(r => [r.id, r]));
    const locals = await listRecords(), localIds = new Set(locals.map(r => r.id));
    for (const row of rows) if (!localIds.has(row.id)) await pull(null, row);
    for (const rec of locals) await syncOne(rec, byId.get(rec.id));
    setStatus('idle');
  } catch (e) {
    setStatus(navigator.onLine ? 'error' : 'offline', e.message || String(e));
  } finally {
    running = false;
    if (again) { again = false; syncSoon(500); }
  }
}

let timer = null;
export function syncSoon(ms = 4000) {
  if (!signedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(syncAll, ms);
}

// Suppression définitive (corbeille vidée) : ligne et images distantes.
export async function deleteRemote(project) {
  if (!signedIn()) return;
  try {
    await api(`/rest/v1/fusain_projects?id=eq.${project.id}`, { method: 'DELETE' });
    await api(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: allLayers(project).map(l => objPath(project.id, l.id)) }) });
  } catch { /* le prochain passage nettoiera */ }
}

// Passage régulier (au retour au premier plan, toutes les minutes) : appareils et onglets à jour.
export function startAutoSync() {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });
  window.addEventListener('online', () => syncAll());
  setInterval(() => { if (document.visibilityState === 'visible') syncAll(); }, 60000);
  syncAll();
}

export { newRev };

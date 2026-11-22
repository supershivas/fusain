// Bibliothèque personnelle partagée entre projets et appareils : « Mes pinceaux » et « Mes gommes » (customBrushes),
// réglages de trame (tramaPresets), modèles de bulles (bubbleTemplates). Gardée dans ce navigateur (fusain:prefs)
// et synchronisée par sync.js dans la table `fusain_library` (une ligne par utilisateur).
//
// Fusion élément par élément : chaque élément porte `at` (dernière modification) ; une suppression laisse une
// trace datée (`deleted`), pour qu'un appareil qui avait encore l'élément ne le fasse pas revenir.

export const LIB_SCHEMA = 1;
const KEYS = ['customBrushes', 'tramaPresets', 'bubbleTemplates'];
const STATE = 'fusain:library';
const TOMBSTONE_DAYS = 180;

let state = { seen: {}, deleted: {} };
try { state = { seen: {}, deleted: {}, ...JSON.parse(localStorage.getItem(STATE)) }; } catch { /* préférence locale */ }
const saveState = () => { try { localStorage.setItem(STATE, JSON.stringify(state)); } catch { /* */ } };

const strip = item => { const { at, ...rest } = item; return JSON.stringify(rest); };

// Après chaque enregistrement des préférences : date les éléments nouveaux ou modifiés, note les disparus.
// Renvoie true si la bibliothèque a changé (il faut alors la synchroniser).
export function stampLibrary(ed) {
  const now = Date.now(), present = new Set();
  let changed = false;
  for (const k of KEYS) {
    for (const item of ed[k] || []) {
      if (!item || !item.id) continue;
      present.add(item.id);
      const h = strip(item);
      if (state.seen[item.id] !== h) { item.at = now; state.seen[item.id] = h; changed = true; }
      else if (!item.at) item.at = now;
    }
  }
  for (const id of Object.keys(state.seen)) if (!present.has(id)) { delete state.seen[id]; state.deleted[id] = now; changed = true; }
  if (changed) saveState();
  return changed;
}

export function libraryDoc(ed) {
  const doc = { schemaVersion: LIB_SCHEMA, deleted: { ...state.deleted } };
  for (const k of KEYS) doc[k] = (ed[k] || []).map(x => ({ ...x }));
  return doc;
}

// Migration des anciens formats (aucun pour l'instant : la version 1 est la première).
const migrate = doc => (doc && typeof doc === 'object' ? { schemaVersion: LIB_SCHEMA, deleted: {}, ...doc } : null);

// Union élément par élément (le plus récent l'emporte), moins les supprimés. L'ordre local est gardé.
export function mergeLibrary(local, remote) {
  remote = migrate(remote);
  if (!remote) return local;
  const deleted = { ...remote.deleted };
  for (const [id, t] of Object.entries(local.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, t);
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  for (const id of Object.keys(deleted)) if (deleted[id] < cutoff) delete deleted[id];
  const out = { schemaVersion: LIB_SCHEMA, deleted };
  for (const k of KEYS) {
    const mine = local[k] || [], theirs = Array.isArray(remote[k]) ? remote[k] : [], byId = new Map(theirs.map(x => [x.id, x]));
    const list = mine.map(x => { const r = byId.get(x.id); return r && (r.at || 0) > (x.at || 0) ? r : x; });
    for (const r of theirs) if (!mine.some(x => x.id === r.id)) list.push(r);
    out[k] = list.filter(x => x && x.id && !((deleted[x.id] || 0) >= (x.at || 0)));
  }
  return out;
}

// Deux bibliothèques ont-elles le même contenu (sans tenir compte de l'ordre) ?
const canon = doc => JSON.stringify(KEYS.map(k => (doc[k] || []).map(x => JSON.stringify(x)).sort()).concat([Object.entries(doc.deleted || {}).sort()]));
export const sameLibrary = (a, b) => !!a && !!b && canon(a) === canon(b);

// Installe une bibliothèque fusionnée dans l'état local, sans la re-dater.
export function applyLibrary(ed, doc) {
  for (const k of KEYS) ed[k] = doc[k].map(x => ({ ...x }));
  state.deleted = { ...doc.deleted };
  state.seen = {};
  for (const k of KEYS) for (const x of ed[k]) state.seen[x.id] = strip(x);
  saveState();
}

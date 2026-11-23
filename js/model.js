// Modèle de document : projet → pages → cases → calques, plus bulles et textes.
// Les pixels d'un calque sont des octets : 0 transparent, 1 encre, 2 blanc opaque.
// Un calque sans `data` est vide ; `loaded` dit si ses pixels stockés ont été lus.

export const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  }));

// Trait du cadre d'une case, en millimètres (réglable par case ; 0,5 mm par défaut).
export const panelStroke = p => (p.stroke ?? 0.5);

export const mmToPx = (mm, dpi) => Math.round(mm / 25.4 * dpi);
export const pxToMm = (px, dpi) => px / dpi * 25.4;

export const FORMATS = [
  { id: 'a4', name: 'A4 (210 × 297 mm)', wmm: 210, hmm: 297 },
  { id: 'a5', name: 'A5 (148 × 210 mm)', wmm: 148, hmm: 210 },
  { id: 'bd', name: 'Album BD (225 × 300 mm)', wmm: 225, hmm: 300 },
  { id: 'carre', name: 'Carré (210 × 210 mm)', wmm: 210, hmm: 210 },
];
export const DPIS = [150, 300];

const rowsOf = (...counts) => counts.map(c => ({ h: 1, c: Array(c).fill(1) }));
export const LAYOUTS = [
  { id: '2x2', name: '4 cases (2 × 2)', rows: rowsOf(2, 2) },
  { id: '4bandes', name: '4 bandes', rows: rowsOf(1, 1, 1, 1) },
  { id: '1+3', name: '1 grande case + 3', rows: [{ h: 1.3, c: [1] }, { h: 1, c: [1, 1, 1] }] },
  { id: '3+1', name: '3 cases + 1 grande', rows: [{ h: 1, c: [1, 1, 1] }, { h: 1.3, c: [1] }] },
  { id: '3bandes', name: '3 bandes', rows: rowsOf(1, 1, 1) },
  { id: '2x3', name: '6 cases (2 × 3)', rows: rowsOf(2, 2, 2) },
  { id: '1', name: 'Pleine page', rows: rowsOf(1) },
];

// Disposition automatique pour n cases : en colonne jusqu'à 3, sinon deux par ligne.
export function autoLayout(n) {
  if (n <= 3) return { id: 'auto', name: 'Automatique', rows: rowsOf(...Array(Math.max(1, n)).fill(1)) };
  const counts = [];
  for (let left = n; left > 0; left -= 2) counts.push(Math.min(2, left));
  return { id: 'auto', name: 'Automatique', rows: rowsOf(...counts) };
}

export function layoutById(id, count) {
  return LAYOUTS.find(l => l.id === id) || autoLayout(count || 1);
}

// Rectangles des cases, en pixels de page.
export function layoutRects(layout, W, H, marginPx, gutterPx) {
  const availW = W - 2 * marginPx, availH = H - 2 * marginPx;
  const totalH = layout.rows.reduce((s, r) => s + r.h, 0);
  const unitH = (availH - (layout.rows.length - 1) * gutterPx) / totalH;
  const rects = [];
  let y = marginPx;
  for (const row of layout.rows) {
    const totalW = row.c.reduce((s, c) => s + c, 0);
    const unitW = (availW - (row.c.length - 1) * gutterPx) / totalW;
    let x = marginPx;
    for (const c of row.c) {
      rects.push({ x: Math.round(x), y: Math.round(y), w: Math.round(c * unitW), h: Math.round(row.h * unitH) });
      x += c * unitW + gutterPx;
    }
    y += row.h * unitH + gutterPx;
  }
  return rects;
}

// Numéro de format des projets enregistrés (table, IndexedDB, export). 1 : sans numéro (avant novembre 2026).
// Les anciens formats se migrent à la lecture (`projectFromMeta`), jamais refusés.
export const PROJECT_SCHEMA = 2;

// Numéros de page (folio) : project.folio = { on, pos, start, skipFirst }. Absent : pas de numéro. Une couverture (page.cover) n'en a jamais.
export const FOLIO_POSITIONS = [
  { id: 'bottom-center', name: 'En bas, au centre' },
  { id: 'bottom-outer', name: 'En bas, à l\'extérieur' },
  { id: 'top-outer', name: 'En haut, à l\'extérieur' },
];
// Numéro imprimé sur la page d'indice idx, ou null. Les pages impaires sont à droite, comme dans un album ouvert.
export function folioOf(project, idx) {
  const f = project.folio;
  if (!f || !f.on || (f.skipFirst && idx === 0) || (project.pages[idx] && project.pages[idx].cover)) return null;
  return { n: (Number.isFinite(f.start) ? f.start : 1) + idx, pos: f.pos || 'bottom-center', right: idx % 2 === 0 };
}

// Fond perdu : une case qui touche un bord de la page se dessine jusqu'à BLEED_MM au-delà (pour l'imprimeur, qui coupe dans le dessin).
export const BLEED_MM = 3;
// Zone où l'on dessine dans la case, en pixels de page : le cadre, prolongé du fond perdu sur les bords qui touchent la page.
export function paintRect(project, p) {
  const { w, h } = pageSize(project), b = mmToPx(BLEED_MM, project.dpi), tol = 2;
  const x0 = p.x <= tol ? -b : p.x, y0 = p.y <= tol ? -b : p.y;
  const x1 = p.x + p.w >= w - tol ? w + b : p.x + p.w, y1 = p.y + p.h >= h - tol ? h + b : p.y + p.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const hasBleed = (project, p) => { const r = paintRect(project, p); return r.w !== p.w || r.h !== p.h; };

export function pageSize(project) {
  return {
    w: mmToPx(project.format.wmm, project.dpi),
    h: mmToPx(project.format.hmm, project.dpi),
  };
}

// Couleurs des calques brouillon (à l'écran seulement : un brouillon n'est jamais imprimé).
export const DRAFT_COLORS = {
  blue: { name: 'Bleu', rgb: [90, 140, 220] }, orange: { name: 'Orange', rgb: [240, 140, 40] },
  green: { name: 'Vert', rgb: [63, 163, 77] }, pink: { name: 'Rose', rgb: [224, 88, 155] },
  purple: { name: 'Violet', rgb: [142, 91, 208] }, red: { name: 'Rouge', rgb: [214, 69, 69] },
  gray: { name: 'Gris', rgb: [138, 138, 138] },
};

// Carte de dégradé (calque de réglage, comme dans Photoshop) : la luminosité de ce qui est dessous devient une couleur
// prise sur le dégradé (sombre = début, clair = fin). Le calque n'a pas de pixels ; `gradient.stops` = [[position 0–1, '#rrggbb'], …].
export const GRADIENT_PRESETS = [
  { id: 'sepia', name: 'Sépia', stops: [[0, '#2B1A0E'], [0.55, '#A2794A'], [1, '#F6EBD3']] },
  { id: 'nuit', name: 'Nuit', stops: [[0, '#0D1B3D'], [0.5, '#5A6FA8'], [1, '#E8ECF7']] },
  { id: 'duo', name: 'Bleu et orange', stops: [[0, '#1E2A5A'], [0.5, '#E8873A'], [1, '#FFF2D9']] },
  { id: 'feu', name: 'Feu', stops: [[0, '#000000'], [0.35, '#8B1A00'], [0.7, '#FF8C1A'], [1, '#FFFBE0']] },
  { id: 'menthe', name: 'Menthe', stops: [[0, '#0F3B34'], [0.6, '#5FB39E'], [1, '#EFFAF5']] },
  { id: 'nb', name: 'Noir et blanc', stops: [[0, '#000000'], [1, '#FFFFFF']] },
  { id: 'negatif', name: 'Négatif', stops: [[0, '#FFFFFF'], [1, '#000000']] },
];
export const cloneStops = stops => stops.map(([t, c]) => [t, c]);
// Table de 256 couleurs [r, g, b] pour une luminosité 0–255.
export function gradientLut(stops) {
  const st = [...stops].sort((a, b) => a[0] - b[0]), hex = c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16)), lut = new Uint8Array(256 * 3);
  for (let L = 0; L < 256; L++) {
    const t = L / 255;
    let i = 0; while (i < st.length - 1 && st[i + 1][0] < t) i++;
    const a = st[i], b = st[Math.min(i + 1, st.length - 1)], k = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
    const ca = hex(a[1]), cb = hex(b[1]);
    for (let j = 0; j < 3; j++) lut[L * 3 + j] = Math.round(ca[j] + (cb[j] - ca[j]) * (t <= st[0][0] ? 0 : k));
  }
  return lut;
}
// Nom du dégradé : le modèle qu'il reproduit (éventuellement inversé), sinon « Personnalisé ».
const sameStops = (a, b) => a.length === b.length && a.every(([t, c], i) => Math.abs(t - b[i][0]) < 0.006 && c.toUpperCase() === b[i][1].toUpperCase());
const sortStops = st => [...st].sort((a, b) => a[0] - b[0]);
export function gradientPreset(stops) {
  const st = sortStops(stops);
  for (const pr of GRADIENT_PRESETS) {
    if (sameStops(st, sortStops(pr.stops))) return { preset: pr, reversed: false };
    if (sameStops(st, sortStops(pr.stops.map(([t, c]) => [1 - t, c])))) return { preset: pr, reversed: true };
  }
  return null;
}
export const gradientName = stops => { const m = gradientPreset(stops); return m ? m.preset.name + (m.reversed ? ' inversé' : '') : 'Personnalisé'; };
export const cssGradient = stops => `linear-gradient(90deg, ${[...stops].sort((a, b) => a[0] - b[0]).map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(', ')})`;

// opacity : 0 à 100 ; locked : on ne peut plus y dessiner ; color : couleur d'un brouillon.
// kind : 'ink' (encrage), 'tram' (trames), 'draft' (brouillon) ou 'color' (couleur). Les outils ne dessinent que dans les calques de leur sorte.
// Encre, trame et brouillon : un octet par pixel (0 transparent, 1 encre, 2 blanc). Couleur : RVBA, 4 octets par pixel,
// non prémultiplié ; un calque de couleur couvre l'étendue de sa case, comme les autres.
export function newLayer(name, w, h, opts = {}) {
  const kind = opts.kind || (opts.draft ? 'draft' : 'ink');
  if (kind === 'gradmap') return {
    id: uid(), name, visible: true, kind, draft: false, opacity: 100, locked: false, w, h, data: null, loaded: true, dirty: false, rev: null,
    gradient: { stops: cloneStops((opts.gradient && opts.gradient.stops) || GRADIENT_PRESETS[0].stops) },
  };
  return {
    id: uid(), name, visible: true, kind, draft: kind === 'draft', opacity: 100, locked: false, color: kind === 'draft' ? (opts.color || 'blue') : kind === 'color' ? undefined : opts.color,
    w, h, data: null, loaded: true, dirty: false, rev: null,
  };
}

// Anciens projets : le type se déduit du brouillon ou du nom du calque.
const kindOf = l => l.kind ?? (l.draft ? 'draft' : /tram/i.test(l.name || '') ? 'tram' : 'ink');

export const bppOf = l => (l && (l.kind === 'color' || l.rgba) ? 4 : 1);
export function ensureData(layer) {
  if (!layer.data) layer.data = new Uint8Array(layer.w * layer.h * bppOf(layer));
  return layer.data;
}

export function newPanel(rect) {
  // Calques tous pareils : on dessine dans le calque actif. Le dessin sert de référence au remplissage.
  const layers = [
    newLayer('Brouillon', rect.w, rect.h, { draft: true }),
    Object.assign(newLayer('Dessin', rect.w, rect.h), { reference: true }),
  ];
  // La case montre le rectangle x,y,w,h ; les calques couvrent l'étendue ex,ey,ew,eh (au moins ce rectangle).
  // Réduire une case ne coupe donc jamais le dessin : il reste en réserve hors du cadre.
  return {
    id: uid(), x: rect.x, y: rect.y, w: rect.w, h: rect.h, ex: rect.x, ey: rect.y, ew: rect.w, eh: rect.h,
    layers, active: layers[1].id, mask: null,
    note: { plan: '', description: '' },
  };
}

export function newPage(project, layoutId, count) {
  const { w, h } = pageSize(project);
  const layout = layoutById(layoutId, count);
  const rects = layoutRects(layout, w, h, mmToPx(project.margin, project.dpi), mmToPx(project.gutter, project.dpi));
  return { id: uid(), panels: rects.map(newPanel), bubbles: [] };
}

export function newProject({ title, format, dpi, layoutId }) {
  const now = Date.now();
  const project = {
    id: uid(), title: title || 'Sans titre', createdAt: now, updatedAt: now, deleted: false,
    format, dpi, margin: 8, gutter: 4, tramas: [], pages: [],
  };
  project.pages.push(newPage(project, layoutId));
  return project;
}

export function newBubble(kind, x, y) {
  const textual = kind === 'texte';
  return {
    id: uid(), kind, x, y, w: 500, h: 300, text: '', pt: 9, caps: false, auto: true, font: 'architects',
    tail: kind === 'parole' || kind === 'pensee' || kind === 'cri' ? { x: x + 120, y: y + 460 } : null,
  };
}

// Description du projet sans pixels : ce qui part dans la table et dans l'export JSON.
// Copie GÉNÉRIQUE : toute propriété d'un projet, d'une page, d'une case ou d'un calque voyage (nouveaux types de calques,
// nouveaux réglages…), sauf l'état de travail ci-dessous et les clés en « _ ». Rien n'est à ajouter ici pour une nouveauté.
const LAYER_RUNTIME = new Set(['data', 'loaded', 'dirty', 'w', 'h']);
const metaOf = (o, skip) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!skip.has(k) && k[0] !== '_' && v !== undefined && typeof v !== 'function') out[k] = v;
  return out;
};
const layerMeta = l => metaOf(l, LAYER_RUNTIME);
export function projectMeta(project) {
  return {
    ...metaOf(project, new Set(['pages'])),
    schemaVersion: PROJECT_SCHEMA,
    pages: project.pages.map(p => ({
      ...metaOf(p, new Set(['panels'])),
      panels: p.panels.map(c => ({ ...metaOf(c, new Set(['layers', 'mask'])), layers: c.layers.map(layerMeta), mask: c.mask ? layerMeta(c.mask) : null })),
    })),
  };
}

// Reconstruit un projet depuis ses métadonnées ; les pixels restent à charger (`loaded: false`).
// Migration du schéma 1 : étendue des calques (ex, ey, ew, eh) = cadre, type de calque déduit du nom, notes vides.
export function projectFromMeta(meta) {
  // tout ce que porte le calque est gardé (générique) ; seuls les réglages connus reçoivent une valeur par défaut
  const layer = (l, w, h) => ({ ...l, visible: l.visible !== false, kind: kindOf(l), draft: kindOf(l) === 'draft', opacity: l.opacity ?? 100, locked: !!l.locked, color: kindOf(l) === 'draft' ? (l.color || 'blue') : l.color, rgba: !!l.rgba, reference: !!l.reference, alphaLock: !!l.alphaLock, noInkHint: !!l.noInkHint, blend: l.blend || 'normal', gradient: kindOf(l) === 'gradmap' ? { stops: cloneStops((l.gradient && l.gradient.stops) || GRADIENT_PRESETS[0].stops) } : undefined,
    w, h, data: null, loaded: false, dirty: false, rev: l.rev || null });
  return {
    ...meta,
    schemaVersion: PROJECT_SCHEMA,
    tramas: meta.tramas || [],
    pages: meta.pages.map(p => ({
      ...p, bubbles: p.bubbles || [], bubblesHidden: !!p.bubblesHidden, cover: !!p.cover,
      panels: p.panels.map(c => ({
        ...c, note: c.note || { plan: '', description: '' },
        ex: c.ex ?? c.x, ey: c.ey ?? c.y, ew: c.ew ?? c.w, eh: c.eh ?? c.h,
        layers: c.layers.map(l => layer(l, c.ew ?? c.w, c.eh ?? c.h)),
        mask: c.mask ? layer(c.mask, c.ew ?? c.w, c.eh ?? c.h) : null,
      })),
    })),
  };
}

export function pageLayers(page) {
  const out = [];
  for (const c of page.panels) { out.push(...c.layers); if (c.mask) out.push(c.mask); }
  return out;
}

export function allLayers(project) {
  return project.pages.flatMap(pageLayers);
}

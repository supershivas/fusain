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

// opacity : 0 à 100 ; locked : on ne peut plus y dessiner ; color : couleur d'un brouillon.
// kind : 'ink' (encrage), 'tram' (trames) ou 'draft' (brouillon). Les outils ne dessinent que dans les calques de leur sorte.
export function newLayer(name, w, h, opts = {}) {
  const kind = opts.kind || (opts.draft ? 'draft' : 'ink');
  return {
    id: uid(), name, visible: true, kind, draft: kind === 'draft', opacity: 100, locked: false, color: kind === 'draft' ? (opts.color || 'blue') : opts.color,
    w, h, data: null, loaded: true, dirty: false, rev: null,
  };
}

// Anciens projets : le type se déduit du brouillon ou du nom du calque.
const kindOf = l => l.kind ?? (l.draft ? 'draft' : /tram/i.test(l.name || '') ? 'tram' : 'ink');

export function ensureData(layer) {
  if (!layer.data) layer.data = new Uint8Array(layer.w * layer.h);
  return layer.data;
}

export function newPanel(rect) {
  const layers = [
    newLayer('Brouillon', rect.w, rect.h, { draft: true }),
    newLayer('Trames', rect.w, rect.h, { kind: 'tram' }),
    newLayer('Encrage', rect.w, rect.h),
  ];
  // La case montre le rectangle x,y,w,h ; les calques couvrent l'étendue ex,ey,ew,eh (au moins ce rectangle).
  // Réduire une case ne coupe donc jamais le dessin : il reste en réserve hors du cadre.
  return {
    id: uid(), x: rect.x, y: rect.y, w: rect.w, h: rect.h, ex: rect.x, ey: rect.y, ew: rect.w, eh: rect.h,
    layers, active: layers[2].id, mask: null,
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
    id: uid(), kind, x, y, w: 500, h: 300, text: '', pt: 9, caps: !textual, auto: true,
    tail: kind === 'parole' || kind === 'pensee' || kind === 'cri' ? { x: x + 120, y: y + 460 } : null,
  };
}

// Description du projet sans pixels : ce qui part dans la table et dans l'export JSON.
export function projectMeta(project) {
  const layerMeta = l => ({ id: l.id, name: l.name, visible: l.visible, kind: l.kind, draft: l.draft, opacity: l.opacity, locked: l.locked, color: l.color, rev: l.rev });
  return {
    id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt,
    deleted: project.deleted, format: project.format, dpi: project.dpi,
    margin: project.margin, gutter: project.gutter, tramas: project.tramas,
    pages: project.pages.map(p => ({
      id: p.id, bubbles: p.bubbles, bubblesHidden: p.bubblesHidden,
      panels: p.panels.map(c => ({
        id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, ex: c.ex, ey: c.ey, ew: c.ew, eh: c.eh, stroke: c.stroke, active: c.active, note: c.note,
        layers: c.layers.map(layerMeta), mask: c.mask ? layerMeta(c.mask) : null,
      })),
    })),
  };
}

// Reconstruit un projet depuis ses métadonnées ; les pixels restent à charger (`loaded: false`).
export function projectFromMeta(meta) {
  const layer = (l, w, h) => ({ id: l.id, name: l.name, visible: l.visible !== false, kind: kindOf(l), draft: kindOf(l) === 'draft', opacity: l.opacity ?? 100, locked: !!l.locked, color: kindOf(l) === 'draft' ? (l.color || 'blue') : l.color,
    w, h, data: null, loaded: false, dirty: false, rev: l.rev || null });
  return {
    ...meta,
    tramas: meta.tramas || [],
    pages: meta.pages.map(p => ({
      id: p.id, bubbles: p.bubbles || [], bubblesHidden: !!p.bubblesHidden,
      panels: p.panels.map(c => ({
        id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, stroke: c.stroke, active: c.active, note: c.note || { plan: '', description: '' },
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

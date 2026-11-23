// Guides de tracé d'une page : règle (traits parallèles à la règle, ou le long de son bord) et perspective à 1 ou 2 points de fuite.
// page.guide = { mode: 'off' | 'ruler' | 'persp1' | 'persp2', ruler: { x0, y0, x1, y1 }, vps: [{ x, y }, { x, y }] } en pixels de page.
// Un trait part libre ; dès qu'il a bougé de quelques pixels, il se cale sur la direction de guide la plus proche de son départ.

export const GUIDE_MODES = [
  { id: 'off', name: 'Aucun guide', icon: 'ruler-off' },
  { id: 'ruler', name: 'Règle', icon: 'ruler-2' },
  { id: 'persp1', name: 'Perspective à 1 point', icon: 'perspective' },
  { id: 'persp2', name: 'Perspective à 2 points', icon: 'box' },
];
export const guideMode = pg => (pg && pg.guide && pg.guide.mode) || 'off';

// Crée les positions par défaut (au premier usage) et change de mode.
export function setGuideMode(pg, mode, { w, h }) {
  const g = pg.guide || (pg.guide = {});
  if (!g.ruler) g.ruler = { x0: Math.round(w * 0.25), y0: Math.round(h * 0.5), x1: Math.round(w * 0.75), y1: Math.round(h * 0.5) };
  if (!g.vps) g.vps = [{ x: Math.round(w * 0.5), y: Math.round(h * 0.4) }, { x: Math.round(w * 0.9), y: Math.round(h * 0.4) }];
  if (mode === 'persp2' && Math.abs(g.vps[0].x - g.vps[1].x) < w * 0.2) { g.vps[0] = { x: Math.round(w * 0.1), y: g.vps[0].y }; g.vps[1] = { x: Math.round(w * 0.9), y: g.vps[0].y }; }
  g.mode = mode;
}

// Poignées déplaçables : extrémités et milieu de la règle, points de fuite.
export function guideHandles(pg) {
  const g = pg && pg.guide, mode = guideMode(pg);
  if (mode === 'ruler') {
    const r = g.ruler;
    return [{ key: 'r0', x: r.x0, y: r.y0 }, { key: 'r1', x: r.x1, y: r.y1 }, { key: 'rm', x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }];
  }
  if (mode === 'persp1') return [{ key: 'v0', ...g.vps[0] }];
  if (mode === 'persp2') return [{ key: 'v0', ...g.vps[0] }, { key: 'v1', ...g.vps[1] }];
  return [];
}
export function hitHandle(pg, pt, radius) {
  let best = null, bd = radius;
  for (const h of guideHandles(pg)) { const d = Math.hypot(h.x - pt.x, h.y - pt.y); if (d <= bd) { bd = d; best = h; } }
  return best;
}
// Déplace une poignée (from : état du guide au début du geste, dx, dy : déplacement depuis le début).
export function dragHandle(pg, key, from, dx, dy) {
  const g = pg.guide;
  dx = Math.round(dx); dy = Math.round(dy);
  if (key === 'r0') Object.assign(g.ruler, { x0: from.ruler.x0 + dx, y0: from.ruler.y0 + dy });
  else if (key === 'r1') Object.assign(g.ruler, { x1: from.ruler.x1 + dx, y1: from.ruler.y1 + dy });
  else if (key === 'rm') g.ruler = { x0: from.ruler.x0 + dx, y0: from.ruler.y0 + dy, x1: from.ruler.x1 + dx, y1: from.ruler.y1 + dy };
  else if (key === 'v0' || key === 'v1') {
    const i = +key[1];
    g.vps[i] = { x: Math.round(from.vps[i].x + dx), y: Math.round(from.vps[i].y + dy) };
    if (g.mode === 'persp2') g.vps[1 - i] = { x: g.vps[1 - i].x, y: g.vps[i].y };   // deux points sur la même ligne d'horizon
  }
}

const unit = (x, y) => { const n = Math.hypot(x, y); return n > 1e-6 ? { x: x / n, y: y / n } : null; };
const rulerDir = r => unit(r.x1 - r.x0, r.y1 - r.y0) || { x: 1, y: 0 };

// Point de départ d'un trait : collé au bord de la règle s'il en est tout près (snap, en pixels de page).
export function snapStart(pg, pt, snap) {
  if (guideMode(pg) !== 'ruler') return pt;
  const r = pg.guide.ruler, u = rulerDir(r), t = (pt.x - r.x0) * u.x + (pt.y - r.y0) * u.y;
  const q = { x: r.x0 + u.x * t, y: r.y0 + u.y * t };
  return Math.hypot(q.x - pt.x, q.y - pt.y) <= snap ? { ...pt, x: q.x, y: q.y } : pt;
}

// Directions possibles depuis le point de départ.
function directions(pg, s) {
  const g = pg.guide, mode = guideMode(pg);
  if (mode === 'ruler') return [rulerDir(g.ruler)];
  const toVp = v => unit(v.x - s.x, v.y - s.y);
  if (mode === 'persp1') return [toVp(g.vps[0]), { x: 1, y: 0 }, { x: 0, y: 1 }].filter(Boolean);
  if (mode === 'persp2') return [toVp(g.vps[0]), toVp(g.vps[1]), { x: 0, y: 1 }].filter(Boolean);
  return [];
}

// Suivi d'un trait guidé. st = { start, dir } ; renvoie le point contraint, ou null tant que la direction n'est pas choisie.
export function guidedPoint(pg, st, pt, lockDist) {
  if (!st.dir) {
    const mx = pt.x - st.start.x, my = pt.y - st.start.y;
    if (Math.hypot(mx, my) < lockDist) return null;
    let best = null, bd = -1;
    for (const u of directions(pg, st.start)) { const d = Math.abs(mx * u.x + my * u.y); if (d > bd) { bd = d; best = u; } }
    if (!best) return pt;
    st.dir = best;
  }
  const u = st.dir, t = (pt.x - st.start.x) * u.x + (pt.y - st.start.y) * u.y;
  return { ...pt, x: st.start.x + u.x * t, y: st.start.y + u.y * t };
}

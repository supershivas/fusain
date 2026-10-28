// Bulles et textes : dessinés en vectoriel sur la page (aperçu écran et export PDF partagent ce code).
// Coordonnées en pixels de page ; marge intérieure et trait en millimètres ; le reste en pourcentages.
import { fontSpec, touchFont, DEFAULT_FONT } from './fonts.js';

export const BUBBLE_KINDS = [
  { id: 'parole', name: 'Parole', icon: 'message-circle' },
  { id: 'pensee', name: 'Pensée', icon: 'cloud' },
  { id: 'narration', name: 'Narration', icon: 'square' },
  { id: 'texte', name: 'Texte libre', icon: 'typography' },
];

export const SHAPES = [
  { id: 'ellipse', name: 'Ellipse' }, { id: 'rect', name: 'Rectangle' }, { id: 'cloud', name: 'Nuage' },
  { id: 'libre', name: 'Dessinée à la main' }, { id: 'none', name: 'Sans contour' },
];
export const TAILS = [
  { id: 'pointe', name: 'Pointe' }, { id: 'fleche', name: 'Flèche' }, { id: 'bulles', name: 'Bulles de pensée' }, { id: 'none', name: 'Aucune' },
];

// Réglages d'origine de chaque type ; ce que la bulle porte elle-même les remplace.
//  wobble : imperfection du contour (0 = géométrique, 100 = très tremblé)
//  tailW : largeur de la base de la queue, en % du petit côté ; tailRound : -100 creuse … +100 bombée ;
//  tailBend : courbure d'ensemble (-100 … +100) ; tailTip : pointe émoussée (0 = aiguë)
const BASE = { radius: 0, pad: 2.5, stroke: 0.35, wobble: 18, tailW: 24, tailRound: 25, tailBend: 0, tailTip: 0, font: DEFAULT_FONT };
const PRESETS = {
  parole: { ...BASE, shape: 'ellipse', tailStyle: 'pointe' },
  pensee: { ...BASE, shape: 'cloud', tailStyle: 'bulles', wobble: 0 },
  narration: { ...BASE, shape: 'rect', tailStyle: 'none', pad: 2, wobble: 12 },
  texte: { ...BASE, shape: 'none', tailStyle: 'none', pad: 0, wobble: 0 },
};
export const preset = kind => ({ ...(PRESETS[kind] || PRESETS.parole) });
const KEYS = Object.keys(BASE).concat(['shape', 'tailStyle', 'tailAngle']);

export function props(b) {
  const p = preset(b.kind);
  for (const k of KEYS) if (b[k] !== undefined && b[k] !== null) p[k] = b[k];
  if (!b.tail) p.tailStyle = 'none';
  p.rot = b.rot || 0;
  return p;
}

// Rotation d'une bulle (degrés, autour de son centre) : on dessine la bulle tournée, la pointe de la queue reste à sa place sur la page.
const spin = (b, x, y, deg) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = x - cx, dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
};
export const bubbleToPage = (b, x, y) => b.rot ? spin(b, x, y, b.rot) : { x, y };
export const bubbleToLocal = (b, x, y) => b.rot ? spin(b, x, y, -b.rot) : { x, y };
const localBubble = b => b.rot && b.tail ? { ...b, tail: bubbleToLocal(b, b.tail.x, b.tail.y) } : b;

const mm = (v, dpi) => v / 25.4 * dpi;
export const fontPx = (b, dpi) => b.pt / 72 * dpi;
export const lineWidth = dpi => Math.max(2, Math.round(0.35 / 25.4 * dpi));

function setFont(ctx, b, dpi) { const p = props(b); touchFont(p.font); ctx.font = fontSpec(p.font, fontPx(b, dpi)); }
const shown = b => (b.caps ? b.text.toLocaleUpperCase('fr') : b.text);
const roundy = shape => shape === 'ellipse' || shape === 'cloud' || shape === 'libre';

// Coupe le texte en lignes qui tiennent dans maxW.
export function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

// Taille qui contient le texte avec sa marge intérieure (un ovale demande plus de place qu'un rectangle).
export function fitSize(ctx, b, dpi) {
  setFont(ctx, b, dpi);
  const p = props(b), fp = fontPx(b, dpi), pad = mm(p.pad, dpi), text = shown(b) || ' ';
  const target = Math.max(fp * 6, Math.min(fp * 14, Math.sqrt(ctx.measureText(text).width * fp * 3.2)));
  const lines = wrapText(ctx, text, target);
  const tw = Math.max(...lines.map(l => ctx.measureText(l).width)), th = lines.length * fp * 1.2;
  const k = roundy(p.shape) ? 1.42 : 1;
  return { w: Math.round(tw * k + pad * 2), h: Math.round(th * k + pad * 2) };
}

export function autoSize(ctx, b, dpi) {
  const s = fitSize(ctx, b, dpi);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (b.path && b.path.length) {
    // une bulle dessinée garde sa forme : on la met à l'échelle autour de son centre
    const kx = s.w / b.w, ky = s.h / b.h;
    b.path = b.path.map(q => ({ x: Math.round(cx + (q.x - cx) * kx), y: Math.round(cy + (q.y - cy) * ky) }));
  }
  b.w = s.w; b.h = s.h; b.x = Math.round(cx - s.w / 2); b.y = Math.round(cy - s.h / 2);
}

// Boîte englobante d'un tracé à main levée.
export function pathBounds(path) {
  const xs = path.map(q => q.x), ys = path.map(q => q.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ───────────────────────── Imperfections ─────────────────────────

// Bruit périodique sur [0, 1[ : somme de sinus dont les phases viennent de l'identifiant de la bulle,
// donc le même contour à chaque affichage, et un autre pour chaque bulle (ou après « autre tracé »).
function noiseFn(b) {
  let h = 2166136261;
  for (const ch of String(b.id || '') + ':' + (b.seed || 0)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) + 374761393 | 0) >>> 0) / 4294967296;
  const waves = [[2, 1], [3, .8], [5, .55], [7, .4], [11, .25], [17, .15]].map(([k, a]) => [k, a, rnd() * Math.PI * 2]);
  const norm = waves.reduce((s, w) => s + w[1], 0);
  return t => waves.reduce((s, [k, a, ph]) => s + a * Math.sin(Math.PI * 2 * k * t + ph), 0) / norm;
}

// Contour sous forme de points, déformé selon `wobble` : sert au tracé et au calcul de l'attache de la queue.
function outlinePoints(b, p) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2, ry = b.h / 2, small = Math.min(b.w, b.h);
  const amp = p.wobble / 100 * small * 0.07, noise = noiseFn(b), pts = [];
  if (p.shape === 'libre' && b.path && b.path.length > 2) return b.path.map(q => ({ x: q.x, y: q.y }));
  if (p.shape === 'rect') {
    const r = Math.min(p.radius / 100 * small / 2, small / 2), step = Math.max(small / 7, 12);
    const corner = (ox, oy, a0) => Array.from({ length: r > 0 ? 9 : 1 }, (_, i) => {
      const a = a0 + (r > 0 ? i / 8 : 0) * Math.PI / 2;
      return { x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r };
    });
    const edge = (a, c) => {
      const n = Math.max(1, Math.round(Math.hypot(c.x - a.x, c.y - a.y) / step)), out = [];
      for (let i = 1; i < n; i++) out.push({ x: a.x + (c.x - a.x) * i / n, y: a.y + (c.y - a.y) * i / n });
      return out;
    };
    const corners = [corner(b.x + b.w - r, b.y + r, -Math.PI / 2), corner(b.x + b.w - r, b.y + b.h - r, 0),
      corner(b.x + r, b.y + b.h - r, Math.PI / 2), corner(b.x + r, b.y + r, Math.PI)];
    for (let i = 0; i < 4; i++) {
      const cur = corners[i], nxt = corners[(i + 1) % 4];
      pts.push(...cur, ...edge(cur[cur.length - 1], nxt[0]));
    }
  } else {
    const n = p.shape === 'cloud' ? 96 : 72;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * rx * (p.shape === 'cloud' ? 1.08 : 1), y: cy + Math.sin(a) * ry * (p.shape === 'cloud' ? 1.08 : 1) });
    }
  }
  if (amp <= 0) return pts;
  // déplacement le long de la normale (vers l'extérieur du centre), selon l'abscisse curviligne
  let total = 0; const cum = [0];
  for (let i = 1; i <= pts.length; i++) { const a = pts[i - 1], c = pts[i % pts.length]; total += Math.hypot(c.x - a.x, c.y - a.y); cum.push(total); }
  return pts.map((q, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], c = pts[(i + 1) % pts.length];
    let nx = c.y - a.y, ny = -(c.x - a.x);
    if (nx * (q.x - cx) + ny * (q.y - cy) < 0) { nx = -nx; ny = -ny; }
    const len = Math.hypot(nx, ny) || 1, d = amp * noise(cum[i] / total);
    return { x: q.x + nx / len * d, y: q.y + ny / len * d };
  });
}

// Premier point où le rayon centre → cible sort du contour (le plus éloigné), avec le sens du bord.
function rayHit(pts, cx, cy, tx, ty) {
  const dx = tx - cx, dy = ty - cy, n = pts.length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n], ex = c.x - a.x, ey = c.y - a.y, den = dx * ey - dy * ex;
    if (!den) continue;
    const u = ((a.x - cx) * ey - (a.y - cy) * ex) / den, w = ((a.x - cx) * dy - (a.y - cy) * dx) / den;
    if (u > 0 && w >= 0 && w <= 1 && (!best || u > best.u)) {
      const len = Math.hypot(ex, ey) || 1;
      best = { u, x: cx + dx * u, y: cy + dy * u, edge: { x: ex / len, y: ey / len } };
    }
  }
  return best;
}

// ───────────────────────── Tracés ─────────────────────────

// Courbe fermée passant au milieu des segments (ellipse, nuage, bulle dessinée).
function smooth(ctx, pts) {
  const mid = (a, c) => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  const n = pts.length, m0 = mid(pts[n - 1], pts[0]);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) { const m = mid(pts[i], pts[(i + 1) % n]); ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y); }
  ctx.closePath();
}

function polygon(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function traceCloud(ctx, b, p, lw) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2, ry = b.h / 2, noise = noiseFn(b);
  const n = Math.max(10, Math.round((rx + ry) / (Math.max(lw, 2) * 4)));
  const bump = i => 1.16 + p.wobble / 100 * 0.14 * noise((i + 0.5) / n);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2, k = bump(i);
    if (i === 0) ctx.moveTo(cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry);
    ctx.quadraticCurveTo(cx + Math.cos(am) * rx * k, cy + Math.sin(am) * ry * k, cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry);
  }
  ctx.closePath();
}

function traceShape(ctx, b, p, pts, lw) {
  ctx.beginPath();
  if (p.shape === 'cloud') traceCloud(ctx, b, p, lw);
  else if (p.shape === 'rect') {
    if (p.wobble > 0) polygon(ctx, pts);
    else { const r = p.radius / 100 * Math.min(b.w, b.h) / 2; if (r > 0 && ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, r); else ctx.rect(b.x, b.y, b.w, b.h); }
  } else if (p.shape === 'libre') smooth(ctx, pts);
  else if (p.wobble > 0) smooth(ctx, pts);
  else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
}

// ───────────────────────── Queue ─────────────────────────

// Point d'attache de la queue sur le contour : choisi par l'angle `tailAngle` (degrés depuis le centre, 0 = droite),
// sinon dans la direction de la pointe.
function tailAnchor(pts, b, p) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (p.tailAngle !== undefined) {
    const a = p.tailAngle * Math.PI / 180;
    return rayHit(pts, cx, cy, cx + Math.cos(a) * 4000, cy + Math.sin(a) * 4000);
  }
  return rayHit(pts, cx, cy, b.tail.x, b.tail.y);
}

// Origine actuelle de la queue (pour la poignée d'édition).
export function tailOrigin(b) {
  b = localBubble(b);
  const p = props(b);
  if (!b.tail || p.tailStyle === 'none') return null;
  const A = tailAnchor(outlinePoints(b, p.shape === 'none' ? { ...p, shape: 'ellipse', wobble: 0 } : p), b, p);
  return A ? bubbleToPage(b, A.x, A.y) : null;
}

function drawTail(ctx, b, p, pts, lw) {
  const t = b.tail, cx = b.x + b.w / 2, cy = b.y + b.h / 2, small = Math.min(b.w, b.h);
  const A = tailAnchor(pts, b, p);
  if (!A) return;
  const len = Math.hypot(t.x - A.x, t.y - A.y) || 1, ux = (t.x - A.x) / len, uy = (t.y - A.y) / len, nx = -uy, ny = ux;
  const half = p.tailW / 100 * small / 2;

  if (p.tailStyle === 'pointe') {
    // les deux coins de la base sont ramenés sur le contour, quelle que soit sa forme
    const hit = s => rayHit(pts, cx, cy, A.x + nx * half * s, A.y + ny * half * s) || A;
    const B1 = hit(1), B2 = hit(-1);
    const round = Math.max(-half * 0.45, p.tailRound / 100 * len * 0.22), bend = p.tailBend / 100 * len * 0.4;
    const C1 = { x: (B1.x + t.x) / 2 + nx * (round + bend), y: (B1.y + t.y) / 2 + ny * (round + bend) };
    const C2 = { x: (B2.x + t.x) / 2 - nx * (round - bend), y: (B2.y + t.y) / 2 - ny * (round - bend) };
    const tw = p.tailTip / 100 * half * 0.9, T1 = { x: t.x + nx * tw, y: t.y + ny * tw }, T2 = { x: t.x - nx * tw, y: t.y - ny * tw };
    const inward = q => { const k = Math.min(0.5, (small * 0.06 + lw * 2) / (Math.hypot(cx - q.x, cy - q.y) || 1)); return { x: q.x + (cx - q.x) * k, y: q.y + (cy - q.y) * k }; };
    const edges = () => {
      ctx.moveTo(B1.x, B1.y); ctx.quadraticCurveTo(C1.x, C1.y, T1.x, T1.y);
      if (tw > 0) ctx.quadraticCurveTo(t.x + ux * tw * 1.2, t.y + uy * tw * 1.2, T2.x, T2.y);
      ctx.quadraticCurveTo(C2.x, C2.y, B2.x, B2.y);
    };
    ctx.beginPath(); edges(); ctx.lineTo(inward(B2).x, inward(B2).y); ctx.lineTo(inward(B1).x, inward(B1).y); ctx.closePath(); ctx.fill();
    if (lw > 0) { ctx.beginPath(); edges(); ctx.stroke(); }
  } else if (p.tailStyle === 'fleche') {
    const w = Math.max(lw, 2) * 1.3, bend = p.tailBend / 100 * len * 0.4, head = Math.max(w * 5, p.tailW / 100 * small * 0.7);
    const C = { x: (A.x + t.x) / 2 + nx * bend, y: (A.y + t.y) / 2 + ny * bend };
    const ang = Math.atan2(t.y - C.y, t.x - C.x);
    ctx.save(); ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(C.x, C.y, t.x, t.y);
    ctx.moveTo(t.x, t.y); ctx.lineTo(t.x - Math.cos(ang - 0.45) * head, t.y - Math.sin(ang - 0.45) * head);
    ctx.moveTo(t.x, t.y); ctx.lineTo(t.x - Math.cos(ang + 0.45) * head, t.y - Math.sin(ang + 0.45) * head);
    ctx.stroke(); ctx.restore();
  } else if (p.tailStyle === 'bulles') {
    const sx = A.x + (A.x - cx) * 0.1, sy = A.y + (A.y - cy) * 0.1, k = p.tailW / 24;
    [0.3, 0.62, 0.92].forEach((s, i) => {
      const r = Math.max(lw * 1.5, small * (0.08 - i * 0.02) * k);
      const bend = Math.sin(s * Math.PI) * p.tailBend / 100 * len * 0.4;
      ctx.beginPath(); ctx.arc(sx + (t.x - sx) * s + nx * bend, sy + (t.y - sy) * s + ny * bend, r, 0, Math.PI * 2); ctx.fill(); if (lw > 0) ctx.stroke();
    });
  }
}

// lwOverride : épaisseur du trait en pixels (le Labo compare des épaisseurs).
export function drawBubble(ctx, b, dpi, lwOverride) {
  b = localBubble(b);
  const p = props(b), lw = lwOverride !== undefined ? lwOverride : mm(p.stroke, dpi);
  ctx.save();
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (b.rot) { ctx.translate(cx, cy); ctx.rotate(b.rot * Math.PI / 180); ctx.translate(-cx, -cy); }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(lw, 0.001);
  const pts = outlinePoints(b, p.shape === 'none' ? { ...p, shape: 'ellipse', wobble: 0 } : p);

  if (p.shape !== 'none') { traceShape(ctx, b, p, pts, lw); ctx.fill(); if (lw > 0) ctx.stroke(); }
  if (b.tail && p.tailStyle !== 'none') drawTail(ctx, b, p, pts, lw);

  if (b.text) {
    setFont(ctx, b, dpi);
    const fp = fontPx(b, dpi), pad = mm(p.pad, dpi);
    const maxW = roundy(p.shape) ? b.w * 0.74 - pad : b.w - pad * 2;
    const lines = wrapText(ctx, shown(b), Math.max(fp, maxW));
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const top = cy - (lines.length * fp * 1.2) / 2 + fp * 0.6;
    lines.forEach((l, i) => ctx.fillText(l, cx, top + i * fp * 1.2));
  }
  ctx.restore();
}

// Dessine une bulle sur la page ; avec `clip`, elle est rognée au cadre de la case où se trouve son centre.
export function drawPageBubble(ctx, b, dpi, panels) {
  if (!b.clip) { drawBubble(ctx, b, dpi); return; }
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const p = panels.find(q => q.id === b.panel) || panels.find(q => cx >= q.x && cx <= q.x + q.w && cy >= q.y && cy <= q.y + q.h)
    || panels.find(q => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
  if (!p) { drawBubble(ctx, b, dpi); return; }
  ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
  drawBubble(ctx, b, dpi); ctx.restore();
}

export function hitBubble(b, x, y) {
  ({ x, y } = bubbleToLocal(b, x, y));
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

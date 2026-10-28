// Bulles et textes : dessinés en vectoriel sur la page (aperçu écran et export PDF partagent ce code).
// Toutes les coordonnées sont en pixels de page ; marge intérieure et trait sont en millimètres.

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

// Réglages d'origine de chaque type ; ce que la bulle porte elle-même (shape, radius, pad, stroke, tailStyle) les remplace.
const PRESETS = {
  parole: { shape: 'ellipse', tailStyle: 'pointe', radius: 0, pad: 2.5, stroke: 0.35 },
  pensee: { shape: 'cloud', tailStyle: 'bulles', radius: 0, pad: 2.5, stroke: 0.35 },
  narration: { shape: 'rect', tailStyle: 'none', radius: 0, pad: 2, stroke: 0.35 },
  texte: { shape: 'none', tailStyle: 'none', radius: 0, pad: 0, stroke: 0.35 },
};
export const preset = kind => ({ ...(PRESETS[kind] || PRESETS.parole) });

export function props(b) {
  const p = preset(b.kind);
  for (const k of ['shape', 'tailStyle', 'radius', 'pad', 'stroke']) if (b[k] !== undefined) p[k] = b[k];
  if (!b.tail) p.tailStyle = 'none';
  return p;
}

const FONT = "600 %px 'Inter', 'Helvetica Neue', Arial, sans-serif";
const mm = (v, dpi) => v / 25.4 * dpi;

export const fontPx = (b, dpi) => b.pt / 72 * dpi;
export const lineWidth = dpi => Math.max(2, Math.round(0.35 / 25.4 * dpi));

function setFont(ctx, b, dpi) { ctx.font = FONT.replace('%', fontPx(b, dpi).toFixed(1)); }
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

// Tracé lissé et fermé passant au milieu des segments.
function tracePath(ctx, pts) {
  const mid = (a, c) => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  const n = pts.length, m0 = mid(pts[n - 1], pts[0]);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) { const m = mid(pts[i], pts[(i + 1) % n]); ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y); }
  ctx.closePath();
}

function traceCloud(ctx, b, lw) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2, ry = b.h / 2;
  const n = Math.max(10, Math.round((rx + ry) / (Math.max(lw, 2) * 4)));
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    if (i === 0) ctx.moveTo(cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry);
    ctx.quadraticCurveTo(cx + Math.cos(am) * rx * 1.16, cy + Math.sin(am) * ry * 1.16, cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry);
  }
  ctx.closePath();
}

function traceShape(ctx, b, p, lw) {
  ctx.beginPath();
  if (p.shape === 'rect') {
    const r = p.radius / 100 * Math.min(b.w, b.h) / 2;
    if (r > 0 && ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, r); else ctx.rect(b.x, b.y, b.w, b.h);
  } else if (p.shape === 'cloud') traceCloud(ctx, b, lw);
  else if (p.shape === 'libre' && b.path && b.path.length > 2) tracePath(ctx, b.path);
  else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
}

// Point du contour dans la direction de la queue, et sens du bord (pour la base de la queue).
function anchor(b, p, t) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2, ry = b.h / 2;
  if (p.shape === 'libre' && b.path && b.path.length > 2) {
    // contour dessiné : le point d'attache est la dernière intersection du rayon centre → queue avec le tracé
    const dx = t.x - cx, dy = t.y - cy, n = b.path.length;
    let best = null;
    for (let i = 0; i < n; i++) {
      const a = b.path[i], c = b.path[(i + 1) % n], ex = c.x - a.x, ey = c.y - a.y;
      const den = dx * ey - dy * ex;
      if (!den) continue;
      const u = ((a.x - cx) * ey - (a.y - cy) * ex) / den, w = ((a.x - cx) * dy - (a.y - cy) * dx) / den;
      if (u > 0 && u <= 1 && w >= 0 && w <= 1 && (!best || u > best.u)) {
        const len = Math.hypot(ex, ey) || 1;
        best = { u, x: cx + dx * u, y: cy + dy * u, edge: { x: ex / len, y: ey / len }, ellipse: false };
      }
    }
    if (best) return best;
  }
  if (p.shape === 'rect') {
    const dx = t.x - cx, dy = t.y - cy;
    const kx = dx ? rx / Math.abs(dx) : Infinity, ky = dy ? ry / Math.abs(dy) : Infinity, k = Math.min(kx, ky);
    return { x: cx + dx * k, y: cy + dy * k, edge: ky <= kx ? { x: 1, y: 0 } : { x: 0, y: 1 }, ellipse: false };
  }
  const a = Math.atan2((t.y - cy) / ry, (t.x - cx) / rx);
  return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, angle: a, ellipse: true };
}

function drawTail(ctx, b, p, lw) {
  const t = b.tail, cx = b.x + b.w / 2, cy = b.y + b.h / 2, A = anchor(b, p, t);
  const toward = q => ({ x: q.x + (cx - q.x) * 0.07, y: q.y + (cy - q.y) * 0.07 });
  if (p.tailStyle === 'pointe') {
    let p1, p2;
    if (A.ellipse) {
      const d = 0.32, rx = b.w / 2, ry = b.h / 2;
      p1 = { x: cx + Math.cos(A.angle - d) * rx, y: cy + Math.sin(A.angle - d) * ry };
      p2 = { x: cx + Math.cos(A.angle + d) * rx, y: cy + Math.sin(A.angle + d) * ry };
    } else {
      const hw = Math.min(b.w, b.h) * 0.14;
      p1 = { x: A.x + A.edge.x * hw, y: A.y + A.edge.y * hw }; p2 = { x: A.x - A.edge.x * hw, y: A.y - A.edge.y * hw };
    }
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(t.x, t.y); ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(toward(p2).x, toward(p2).y); ctx.lineTo(toward(p1).x, toward(p1).y); ctx.closePath();
    ctx.fill();
    if (lw > 0) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(t.x, t.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
  } else if (p.tailStyle === 'fleche') {
    const w = Math.max(lw, 2), ang = Math.atan2(t.y - A.y, t.x - A.x), head = Math.max(w * 5, Math.min(b.w, b.h) * 0.16);
    ctx.save(); ctx.lineWidth = w * 1.3;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(t.x, t.y);
    ctx.moveTo(t.x, t.y); ctx.lineTo(t.x - Math.cos(ang - 0.45) * head, t.y - Math.sin(ang - 0.45) * head);
    ctx.moveTo(t.x, t.y); ctx.lineTo(t.x - Math.cos(ang + 0.45) * head, t.y - Math.sin(ang + 0.45) * head);
    ctx.stroke(); ctx.restore();
  } else if (p.tailStyle === 'bulles') {
    const sx = A.x + (A.x - cx) * 0.2, sy = A.y + (A.y - cy) * 0.2;
    [0.3, 0.62, 0.92].forEach((k, i) => {
      const r = Math.max(lw * 1.5, Math.min(b.w, b.h) * (0.08 - i * 0.02));
      ctx.beginPath(); ctx.arc(sx + (t.x - sx) * k, sy + (t.y - sy) * k, r, 0, Math.PI * 2); ctx.fill(); if (lw > 0) ctx.stroke();
    });
  }
}

// lwOverride : épaisseur du trait en pixels (le Labo compare des épaisseurs).
export function drawBubble(ctx, b, dpi, lwOverride) {
  const p = props(b), lw = lwOverride !== undefined ? lwOverride : mm(p.stroke, dpi);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(lw, 0.001);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;

  if (p.shape !== 'none') { traceShape(ctx, b, p, lw); ctx.fill(); if (lw > 0) ctx.stroke(); }
  if (b.tail && p.tailStyle !== 'none') drawTail(ctx, b, p, lw);

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

export function hitBubble(b, x, y) {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

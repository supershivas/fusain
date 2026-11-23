// Rendu d'une page à pleine résolution, PNG, vignettes et PDF (écrit à la main : aucune dépendance).
import { pageSize, panelStroke, mmToPx, folioOf } from './model.js';
import { compositeRect } from './raster.js';
import { drawPageBubble, props, bubbleToPage } from './bubbles.js';
import { loadFont, fontSpec, touchFont } from './fonts.js';
import { encodePNGRGBA, encodePNG2, canEncodePNG } from './png.js';
import { BAYER8 } from './dither.js';

// Les polices des bulles doivent être chargées avant de dessiner la page sur un canevas.
export const ensureFonts = (project, pages) =>
  Promise.all([...new Set([...pages.flatMap(p => p.bubbles.map(b => props(b).font)), ...(project.folio && project.folio.on ? [FOLIO_FONT] : [])])].map(loadFont));

// Numéro de page, centré dans la marge du haut ou du bas ; « à l'extérieur » : à droite sur une page impaire, à gauche sur une paire.
const FOLIO_FONT = 'inter', FOLIO_PT = 9;
export function drawFolio(ctx, project, idx) {
  const f = folioOf(project, idx);
  if (!f) return;
  touchFont(FOLIO_FONT);
  const { w, h } = pageSize(project), dpi = project.dpi, m = mmToPx(Math.max(4, project.margin ?? 8), dpi), side = mmToPx(Math.max(4, project.margin ?? 8) + 2, dpi);
  ctx.save();
  ctx.font = fontSpec(FOLIO_FONT, FOLIO_PT / 72 * dpi);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'middle';
  const y = f.pos === 'top-outer' ? m / 2 : h - m / 2;
  if (f.pos === 'bottom-center') { ctx.textAlign = 'center'; ctx.fillText(String(f.n), w / 2, y); }
  else { ctx.textAlign = f.right ? 'right' : 'left'; ctx.fillText(String(f.n), f.right ? w - side : side, y); }
  ctx.restore();
}

// Bleu « non photo » : on imprime le crayonné dans ce bleu pour l'encrer à la main sur papier.
export const BLUELINE = [164, 221, 237];
const blueOf = (L, k) => Math.round(BLUELINE[k] + (255 - BLUELINE[k]) * L / 255);

// Dessine la page (cases, cadres, bulles) sans aide visuelle.
// opts : drafts (imprimer les brouillons), bubbles (bulles et textes), blue (tout en bleu non photo).
export function renderPage(project, page, scale = 1, opts = {}) {
  const { drafts = false, bubbles = true, blue = false } = opts;
  const { w, h } = pageSize(project);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  for (const p of page.panels) {
    const pc = document.createElement('canvas'); pc.width = p.ew; pc.height = p.eh;
    const pctx = pc.getContext('2d'), img = pctx.createImageData(p.ew, p.eh);
    compositeRect(p, new Uint32Array(img.data.buffer), { x: 0, y: 0, w: p.ew, h: p.eh }, drafts, { export: true });
    pctx.putImageData(img, 0, 0);
    ctx.drawImage(pc, p.x - p.ex, p.y - p.ey, p.w, p.h, p.x, p.y, p.w, p.h);   // seul le cadre visible est imprimé
    const bw = mmToPx(panelStroke(p), project.dpi);
    if (bw > 0) { ctx.strokeStyle = '#000'; ctx.lineWidth = bw; ctx.strokeRect(p.x, p.y, p.w, p.h); }
  }
  if (bubbles && !page.bubblesHidden) for (const b of page.bubbles) if (!b.hidden) drawPageBubble(ctx, b, project.dpi, page.panels);
  drawFolio(ctx, project, project.pages.indexOf(page));
  if (blue) toBlue(c);
  return c;
}

// Le noir devient bleu non photo, le blanc reste blanc, les gris entre les deux.
function toBlue(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true }), img = ctx.getImageData(0, 0, c.width, c.height), px = img.data;
  const lut = [0, 1, 2].map(k => Uint8Array.from({ length: 256 }, (_, L) => blueOf(L, k)));
  for (let i = 0; i < px.length; i += 4) {
    const L = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    px[i] = lut[0][L]; px[i + 1] = lut[1][L]; px[i + 2] = lut[2][L];
  }
  ctx.putImageData(img, 0, 0);
}

export const canvasToBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));

export async function pageThumb(project, page, width = 240) {
  const { w } = pageSize(project);
  const c = renderPage(project, page, width / w);
  return c.toDataURL('image/jpeg', 0.7);
}

// ───────────────────────── PDF ─────────────────────────
// Une image 1 bit par page (DeviceGray), compressée en Flate quand le navigateur sait le faire.

const enc = new TextEncoder();

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Pixels du canevas → bits (1 = blanc), lignes alignées sur l'octet. `dither` : les gris et les couleurs
// passent par un seuil de Bayer 8 × 8 (noir et blanc imposé à une planche en couleur), sinon seuil à mi-gris.
function packBits(canvas, dither = false) {
  const { width: w, height: h } = canvas, px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const rowBytes = (w + 7) >> 3, out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const row = BAYER8[y & 7];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, L = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
      if (L >= (dither ? row[x & 7] * 4 + 2 : 128)) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

// CMJN 8 bits : un gris neutre ne prend que du noir (K), pour un trait net sans repérage ; une couleur, conversion simple.
function packCMYK(canvas) {
  const { width: w, height: h } = canvas, px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (Math.abs(r - g) < 3 && Math.abs(g - b) < 3) { out[j + 3] = 255 - Math.round((r + g + b) / 3); continue; }
    const k = 255 - Math.max(r, g, b), d = 255 - k;
    out[j] = Math.round((d - r) / d * 255); out[j + 1] = Math.round((d - g) / d * 255); out[j + 2] = Math.round((d - b) / d * 255); out[j + 3] = k;
  }
  return out;
}

// Trames trop fines : part de la page couverte de points isolés d'un seul pixel (encre entourée de blanc ou l'inverse).
// À 300 dpi un tel point fait 0,08 mm : il risque de se boucher ou de disparaître à l'impression.
export function fineDotShare(canvas) {
  const { width: w, height: h } = canvas, px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < ink.length; i += 4, j++) ink[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8 < 128 ? 1 : 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1, k = y * w + 1; x < w - 1; x++, k++) {
    const v = ink[k];
    if (ink[k - 1] !== v && ink[k + 1] !== v && ink[k - w] !== v && ink[k + w] !== v) n++;
  }
  return n / (w * h);
}
export const FINE_DOT_LIMIT = 0.001;   // au-delà de 0,1 % de la page (environ 0,6 cm² de damier sur une A4), on prévient
export const fineDotsMatter = project => 25.4 / project.dpi < 0.1;   // à 150 dpi, un pixel fait 0,17 mm : pas de souci

// Fond perdu : la page agrandie de `b` pixels de chaque côté, ses bords étirés dans la marge (une case à fond perdu
// déborde ainsi sans filet blanc ; une page à marge blanche reste blanche).
function withBleed(canvas, b) {
  const { width: w, height: h } = canvas, c = document.createElement('canvas');
  c.width = w + 2 * b; c.height = h + 2 * b;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(canvas, b, b);
  x.drawImage(canvas, 0, 0, w, 1, b, 0, w, b); x.drawImage(canvas, 0, h - 1, w, 1, b, h + b, w, b);
  x.drawImage(canvas, 0, 0, 1, h, 0, b, b, h); x.drawImage(canvas, w - 1, 0, 1, h, w + b, b, b, h);
  x.drawImage(canvas, 0, 0, 1, 1, 0, 0, b, b); x.drawImage(canvas, w - 1, 0, 1, 1, w + b, 0, b, b);
  x.drawImage(canvas, 0, h - 1, 1, 1, 0, h + b, b, b); x.drawImage(canvas, w - 1, h - 1, 1, 1, w + b, h + b, b, b);
  return c;
}
export const BLEED_MM = 3, SLUG_MM = 10;   // fond perdu ; marge totale autour de la page coupée, traits de coupe compris

export const COLOR_MODES = [
  { id: 'auto', name: 'Automatique', help: 'Noir et blanc 1 bit, ou couleur RVB si la planche a de la couleur ou des brouillons.' },
  { id: 'bw', name: 'Noir et blanc', help: 'Un bit par pixel : le plus net pour une planche à la trame. Les gris et les couleurs sont tramés.' },
  { id: 'gray', name: 'Niveaux de gris', help: 'Gris 8 bits, pour un lavis ou un crayonné.' },
  { id: 'rgb', name: 'Couleur (RVB)', help: 'Pour l\'écran et les imprimantes de bureau.' },
  { id: 'cmyk', name: 'Couleur (CMJN)', help: 'Pour un imprimeur : le noir et les gris en noir seul (K), les couleurs converties simplement. Fais valider le fichier par l\'imprimeur (pas de profil ICC).' },
];
// Gris ou noir et blanc imposé pour l'impression directe : le canevas est converti sur place.
function convertCanvas(canvas, color) {
  if (color !== 'gray' && color !== 'bw') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data, w = canvas.width;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    let L = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    if (color === 'bw') L = L >= BAYER8[((j / w) | 0) & 7][(j % w) & 7] * 4 + 2 ? 255 : 0;
    px[i] = px[i + 1] = px[i + 2] = L;
  }
  ctx.putImageData(img, 0, 0);
}

// Image RVB 8 bits (pages avec des calques en couleur).
function packRGB(canvas) {
  const { width: w, height: h } = canvas, px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2]; }
  return out;
}
const usesColor = project => project.pages.some(pg => pg.panels.some(p => p.layers.some(l => l.kind === 'color' || l.rgba || (!l.draft && /^#[0-9a-f]{6}$/i.test(l.color || '')))));

// Luminance 8 bits, pour le PDF en bleu non photo (image indexée : 1 octet par pixel).
function packGray(canvas) {
  const { width: w, height: h } = canvas, px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) out[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  return out;
}
const hex2 = v => v.toString(16).padStart(2, '0');
const BLUE_PALETTE = '<' + Array.from({ length: 256 }, (_, L) => hex2(blueOf(L, 0)) + hex2(blueOf(L, 1)) + hex2(blueOf(L, 2))).join('') + '>';

// Chaîne PDF en UTF-16BE (accents corrects dans le titre du document).
const pdfString = s => '<FEFF' + Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('').toUpperCase() + '>';

// ───────────────────────── Choix des pages et imposition ─────────────────────────

// « 1-3, 5 » → [0, 1, 2, 4] (indices, dans l'ordre, sans doublon) ; null si la saisie est illisible ou vide.
export function parsePageRange(text, count) {
  const out = new Set();
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:[-–](\d*))?$/);
    if (!m) return null;
    const a = +m[1], b = m[2] === undefined ? a : m[2] === '' ? count : +m[2];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

export const IMPOSITIONS = [
  { id: 'single', name: 'Une page par feuille', icon: 'file', help: 'Chaque page sur sa feuille, à son format.' },
  { id: 'spread', name: 'Planches en regard', icon: 'book-2', help: 'Deux pages côte à côte, comme dans l\'album ouvert : les pages impaires à droite.' },
  { id: 'booklet', name: 'Livret à plier', icon: 'notebook', help: 'Feuilles de deux pages, à imprimer recto verso (retourner sur le bord court), à plier et agrafer au milieu. Complété par des pages blanches jusqu\'à un multiple de 4.' },
  { id: 'proof', name: '4 pages par feuille', icon: 'layout-grid', help: 'Épreuve réduite, avec le numéro de chaque page.' },
];

// Feuilles à imprimer : { wmm, hmm, slots: [{ page (indice dans le projet), x, y, w, h (mm, depuis le coin haut gauche), label }] }.
// Un emplacement sans `page` est une page blanche.
export function impose(pageIdx, mode, { wmm, hmm }) {
  if (mode === 'spread') {
    const sheets = new Map();   // la page n (1, 2, 3…) va sur la planche ⌊n / 2⌋ : impaire à droite, paire à gauche
    for (const i of pageIdx) {
      const n = i + 1, key = n >> 1;
      if (!sheets.has(key)) sheets.set(key, { wmm: 2 * wmm, hmm, slots: [] });
      sheets.get(key).slots.push({ page: i, x: n % 2 ? wmm : 0, y: 0, w: wmm, h: hmm });
    }
    return [...sheets.values()];
  }
  if (mode === 'booklet') {
    const n = Math.max(4, Math.ceil(pageIdx.length / 4) * 4), at = k => pageIdx[k] ?? null, sheets = [];
    const side = (l, r) => ({ wmm: 2 * wmm, hmm, slots: [{ page: at(l), x: 0, y: 0, w: wmm, h: hmm }, { page: at(r), x: wmm, y: 0, w: wmm, h: hmm }].filter(s => s.page !== null) });
    for (let s = 0; s < n / 4; s++) sheets.push(side(n - 1 - 2 * s, 2 * s), side(2 * s + 1, n - 2 - 2 * s));
    return sheets;
  }
  if (mode === 'proof') {
    const m = 10, gap = 8, label = 6, cw = (wmm - 2 * m - gap) / 2, ch = (hmm - 2 * m - gap) / 2 - label;
    const k = Math.min(cw / wmm, ch / hmm), w = wmm * k, h = hmm * k, sheets = [];
    pageIdx.forEach((i, j) => {
      if (j % 4 === 0) sheets.push({ wmm, hmm, slots: [] });
      const col = j % 2, row = (j >> 1) % 2;
      sheets[sheets.length - 1].slots.push({ page: i, x: m + col * (cw + gap) + (cw - w) / 2, y: m + row * (ch + label + gap), w, h, label: 'Page ' + (i + 1) });
    });
    return sheets;
  }
  return pageIdx.map(i => ({ wmm, hmm, slots: [{ page: i, x: 0, y: 0, w: wmm, h: hmm }] }));
}

// ───────────────────────── PDF ─────────────────────────
// Une image par page du projet : 1 bit (DeviceGray) en noir et blanc, RVB s'il y a de la couleur ou des brouillons,
// indexée sur le bleu non photo en mode bleu ; compressée en Flate quand le navigateur sait le faire.
// Chaque feuille du PDF place une ou plusieurs de ces images (imposition).
// opts : pages (indices, toutes par défaut), imposition, drafts, bubbles, blue.

// color : 'auto', 'bw', 'gray', 'rgb', 'cmyk' (COLOR_MODES) ; bleed : fond perdu, TrimBox / BleedBox et traits de coupe
// (une page par feuille seulement) ; onFine(i) : la page d'indice i a des trames trop fines pour l'impression.
export async function buildPDF(project, { onProgress = () => {}, prepare = async () => {}, release = () => {}, onFine = () => {}, pages: pageIdx, imposition = 'single', drafts = false, bubbles = true, blue = false, color = 'auto', bleed = false } = {}) {
  const chunks = [], offsets = [];
  let length = 0;
  const write = bytes => { chunks.push(bytes); length += bytes.length; };
  const text = s => write(enc.encode(s));
  text('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  pageIdx = pageIdx || project.pages.map((_, i) => i);
  const pages = pageIdx.map(i => project.pages[i]), n = pages.length;
  const colored = usesColor(project) || drafts;
  const mode = blue ? 'blue' : color === 'auto' ? (colored ? 'rgb' : 'bits') : color === 'bw' ? 'bits' : color;
  if (imposition !== 'single') bleed = false;
  const bPx = bleed ? mmToPx(BLEED_MM, project.dpi) : 0, checkDots = fineDotsMatter(project) && !blue;
  const letters = bubbles && !blue;   // lettrage à part, en masques 1 bit à 1200 dpi (net à l'impression), sauf en bleu non photo
  const pdfx = mode === 'cmyk';       // CMJN : visé PDF/X-1a (intention de sortie FOGRA39, zone de coupe sur chaque feuille)
  await ensureFonts(project, pages);
  const sheets = impose(pageIdx, imposition, project.format);
  // numéros d'objets : 1 catalogue, 2 liste des feuilles, 3 info, 4 police des légendes, puis par page : image, masque blanc
  // et masque noir du lettrage (objet vide s'il n'y a pas de bulle), puis par feuille : feuille et contenu
  const imageObj = j => 5 + j * 3, whiteObj = j => 6 + j * 3, blackObj = j => 7 + j * 3, sheetObj = s => 5 + 3 * n + s * 2, contentObj = s => 6 + 3 * n + s * 2;
  const obj = (num, body) => { offsets[num] = length; text(num + ' 0 obj\n' + body + '\nendobj\n'); };
  const stream = async (num, dict, raw) => {
    const packed = await deflate(raw), data = packed || raw;
    offsets[num] = length;
    text(num + ' 0 obj\n<< ' + dict + (packed ? ' /Filter /FlateDecode' : '') + ' /Length ' + data.length + ' >>\nstream\n');
    write(data); text('\nendstream\nendobj\n');
  };
  const date = 'D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';

  obj(1, '<< /Type /Catalog /Pages 2 0 R' + (pdfx ? ' /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (FOGRA39) /RegistryName (http://www.color.org) /Info (Coated FOGRA39 \\(ISO 12647-2:2004\\)) >>]' : '') + ' >>');
  obj(2, '<< /Type /Pages /Count ' + sheets.length + ' /Kids [' + sheets.map((_, s) => sheetObj(s) + ' 0 R').join(' ') + '] >>');
  obj(3, '<< /Title ' + pdfString(project.title) + ' /Producer (Fusain) /Creator (Fusain) /CreationDate (' + date + ') /ModDate (' + date + ')' +
    (pdfx ? ' /GTS_PDFXVersion (PDF/X-1a:2003) /GTS_PDFXConformance (PDF/X-1a:2003) /Trapped /False' : '') + ' >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const lettering = [];

  for (let j = 0; j < n; j++) {
    onProgress(j, n);
    await prepare(pages[j]);
    let canvas = renderPage(project, pages[j], 1, { drafts, bubbles: bubbles && !letters });
    release(pages[j]);
    if (checkDots && fineDotShare(canvas) > FINE_DOT_LIMIT) onFine(pageIdx[j]);
    if (bPx) canvas = withBleed(canvas, bPx);
    const raw = mode === 'blue' || mode === 'gray' ? packGray(canvas) : mode === 'rgb' ? packRGB(canvas) : mode === 'cmyk' ? packCMYK(canvas) : packBits(canvas, colored);
    const space = mode === 'blue' ? '/ColorSpace [/Indexed /DeviceRGB 255 ' + BLUE_PALETTE + '] /BitsPerComponent 8'
      : mode === 'gray' ? '/ColorSpace /DeviceGray /BitsPerComponent 8'
      : mode === 'cmyk' ? '/ColorSpace /DeviceCMYK /BitsPerComponent 8'
      : mode === 'rgb' ? '/ColorSpace /DeviceRGB /BitsPerComponent 8' : '/ColorSpace /DeviceGray /BitsPerComponent 1';
    await stream(imageObj(j), '/Type /XObject /Subtype /Image /Width ' + canvas.width + ' /Height ' + canvas.height + ' ' + space, raw);
    canvas = null;
    const lt = letters ? letteringMasks(project, pages[j]) : null;
    lettering[j] = lt;
    if (lt) {
      const dict = '/Type /XObject /Subtype /Image /Width ' + lt.W + ' /Height ' + lt.H + ' /ImageMask true /BitsPerComponent 1 /Decode [1 0]';
      await stream(whiteObj(j), dict, lt.white); await stream(blackObj(j), dict, lt.black);
      lt.white = lt.black = null;
    } else { obj(whiteObj(j), 'null'); obj(blackObj(j), 'null'); }
  }
  const pagePx = pageSize(project);

  const pt = mm => +(mm / 25.4 * 72).toFixed(2);
  sheets.forEach((sh, s) => {
    const off = bleed ? SLUG_MM : 0;   // la page coupée est décalée de la marge des traits de coupe
    const W = pt(sh.wmm + 2 * off), H = pt(sh.hmm + 2 * off), used = new Set();
    let content = '', boxes = '';
    for (const sl of sh.slots) {
      const j = pageIdx.indexOf(sl.page); used.add(j);
      const e = bleed ? BLEED_MM : 0;
      const w = pt(sl.w + 2 * e), h = pt(sl.h + 2 * e), x = pt(sl.x + off - e), y = +(H - pt(sl.y + off - e) - h).toFixed(2);
      content += 'q ' + w + ' 0 0 ' + h + ' ' + x + ' ' + y + ' cm /Im' + j + ' Do Q\n';
      const lt = lettering[j];
      if (lt) {   // lettrage : d'abord le fond blanc des bulles, puis l'encre, posés à leur place sur la page
        const k = sl.w / pagePx.w, mw = pt(lt.box.w * k), mh = pt(lt.box.h * k), mx = pt(sl.x + off + lt.box.x * k), my = +(H - pt(sl.y + off + lt.box.y * k) - mh).toFixed(2);
        const [white, black] = mode === 'cmyk' ? ['0 0 0 0 k', '0 0 0 1 k'] : ['1 g', '0 g'];
        content += 'q ' + white + ' ' + mw + ' 0 0 ' + mh + ' ' + mx + ' ' + my + ' cm /Wm' + j + ' Do Q\n';
        content += 'q ' + black + ' ' + mw + ' 0 0 ' + mh + ' ' + mx + ' ' + my + ' cm /Bm' + j + ' Do Q\n';
      }
      if (bleed) {
        const tx = pt(off), ty = pt(off), tw = pt(sl.w), th = pt(sl.h), b = pt(BLEED_MM);
        boxes = ' /TrimBox [' + [tx, ty, +(tx + tw).toFixed(2), +(ty + th).toFixed(2)].join(' ') + '] /BleedBox [' + [+(tx - b).toFixed(2), +(ty - b).toFixed(2), +(tx + tw + b).toFixed(2), +(ty + th + b).toFixed(2)].join(' ') + ']';
        content += cropMarks(tx, ty, tw, th, b, pt, mode === 'cmyk');
      }
      if (sl.label) content += '0.6 G 0.5 w ' + x + ' ' + y + ' ' + w + ' ' + h + ' re S 0 g BT /F1 9 Tf ' + x + ' ' + (y - 12).toFixed(2) + ' Td (' + sl.label + ') Tj ET\n';
    }
    if (pdfx && !boxes) boxes = ' /TrimBox [0 0 ' + W + ' ' + H + ']';
    obj(sheetObj(s), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + ']' + boxes + ' /Contents ' + contentObj(s) + ' 0 R /Resources << /XObject << ' +
      [...used].map(j => '/Im' + j + ' ' + imageObj(j) + ' 0 R' + (lettering[j] ? ' /Wm' + j + ' ' + whiteObj(j) + ' 0 R /Bm' + j + ' ' + blackObj(j) + ' 0 R' : '')).join(' ') + ' >> /Font << /F1 4 0 R >> >> >>');
    obj(contentObj(s), '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream');
  });

  const count = 4 + 3 * n + sheets.length * 2, xref = length;
  let table = 'xref\n0 ' + (count + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  const id = '<' + Array.from(crypto.getRandomValues(new Uint8Array(16)), v => v.toString(16).padStart(2, '0')).join('') + '>';
  text(table + 'trailer\n<< /Size ' + (count + 1) + ' /Root 1 0 R /Info 3 0 R /ID [' + id + ' ' + id + '] >>\nstartxref\n' + xref + '\n%%EOF\n');

  onProgress(n, n);
  return new Blob(chunks, { type: 'application/pdf' });
}

// ───────────────────────── Lettrage net ─────────────────────────
// Les bulles et textes sont rendus à part, à 1200 dpi, en deux masques 1 bit : le blanc des bulles et l'encre (trait, texte).
// Posés par-dessus l'image de la page, ils donnent un texte aussi net qu'en vectoriel à l'impression.
// Rendu par bandes : le canevas ne dépasse jamais la limite de Safari.
export const LETTER_DPI = 1200;
function bubblesBox(project, list) {
  const { w, h } = pageSize(project), pad = mmToPx(3, project.dpi);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const b of list) {
    const m = Math.max(b.w, b.h) * 0.2 + pad;
    for (const [x, y] of [[b.x - m, b.y - m], [b.x + b.w + m, b.y - m], [b.x - m, b.y + b.h + m], [b.x + b.w + m, b.y + b.h + m]]) { const q = bubbleToPage(b, x, y); add(q.x, q.y); }
    if (b.tail) { add(b.tail.x - pad, b.tail.y - pad); add(b.tail.x + pad, b.tail.y + pad); }
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
// Dessine les bulles `list` agrandies k fois dans le rectangle `box`, par bandes, et passe chaque pixel couvert à
// put(x, y, encre) (encre : vrai pour le trait et le texte, faux pour le fond blanc). Renvoie vrai si un pixel est couvert.
function rasterLettering(project, page, list, box, k, W, H, put) {
  const band = Math.max(64, Math.min(1024, Math.floor(4e6 / W))), c = document.createElement('canvas');
  c.width = W; c.height = band;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let any = false;
  for (let top = 0; top < H; top += band) {
    const rows = Math.min(band, H - top);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, band);
    ctx.setTransform(k, 0, 0, k, -box.x * k, -box.y * k - top);
    for (const b of list) drawPageBubble(ctx, b, project.dpi, page.panels);
    const px = ctx.getImageData(0, 0, W, rows).data;
    for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i + 3] < 128) continue;
      any = true;
      put(x, top + y, (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8 < 128);
    }
  }
  c.width = c.height = 1;
  return any;
}
const visibleBubbles = page => (page.bubblesHidden ? [] : page.bubbles.filter(b => !b.hidden));

export function letteringMasks(project, page) {
  const list = visibleBubbles(page), box = list.length ? bubblesBox(project, list) : null;
  if (!box) return null;
  const k = Math.max(1, LETTER_DPI / project.dpi), W = Math.ceil(box.w * k), H = Math.ceil(box.h * k), rowBytes = (W + 7) >> 3;
  const white = new Uint8Array(rowBytes * H), black = new Uint8Array(rowBytes * H);
  const any = rasterLettering(project, page, list, box, k, W, H, (x, y, ink) => { (ink ? black : white)[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7); });
  return any ? { box, W, H, white, black } : null;
}

// Impression directe : une image PNG par bulle (0 transparent, 1 encre, 2 blanc), au plus 16 Mpx, posée sur la page.
async function letteringImages(project, page) {
  const out = [];
  for (const b of visibleBubbles(page)) {
    const box = bubblesBox(project, [b]);
    if (!box) continue;
    const k = Math.max(1, Math.min(LETTER_DPI / project.dpi, Math.sqrt(16e6 / (box.w * box.h)))), W = Math.ceil(box.w * k), H = Math.ceil(box.h * k);
    const data = new Uint8Array(W * H);
    if (!rasterLettering(project, page, [b], box, k, W, H, (x, y, ink) => { data[y * W + x] = ink ? 1 : 2; })) continue;
    out.push({ box, url: URL.createObjectURL(new Blob([await encodePNG2(data, W, H)], { type: 'image/png' })) });
  }
  return out;
}

// Traits de coupe aux quatre coins de la page coupée (tx, ty, tw, th en points) : filets de 0,25 pt, en noir de repérage
// (toutes les encres) en CMJN, noir ailleurs ; ils commencent 2 mm au-delà du fond perdu.
function cropMarks(tx, ty, tw, th, b, pt, cmyk) {
  const gap = b + pt(2), len = pt(5), r = v => +v.toFixed(2);
  let c = 'q 0.25 w ' + (cmyk ? '1 1 1 1 K' : '0 G') + '\n';
  for (const [x, sx] of [[tx, -1], [tx + tw, 1]]) for (const [y, sy] of [[ty, -1], [ty + th, 1]]) {
    c += r(x + sx * gap) + ' ' + r(y) + ' m ' + r(x + sx * (gap + len)) + ' ' + r(y) + ' l S\n';
    c += r(x) + ' ' + r(y + sy * gap) + ' m ' + r(x) + ' ' + r(y + sy * (gap + len)) + ' l S\n';
  }
  return c + 'Q\n';
}

// ───────────────────────── Impression directe ─────────────────────────
// Les feuilles sont posées dans la page (images PNG placées en mm), puis le navigateur imprime
// (AirPrint sur iPad). Pas de grand canevas : une planche double dépasserait la limite de Safari.

let printCleanup = null;
const pngOf = async canvas => {
  if (!canEncodePNG()) return canvasToBlob(canvas);
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  return new Blob([await encodePNGRGBA(img.data, canvas.width, canvas.height)], { type: 'image/png' });
};

export async function printProject(project, { onProgress = () => {}, prepare = async () => {}, release = () => {}, onFine = () => {}, pages: pageIdx, imposition = 'single', drafts = false, bubbles = true, blue = false, color = 'auto' } = {}, ready = () => {}) {
  pageIdx = pageIdx || project.pages.map((_, i) => i);
  await ensureFonts(project, pageIdx.map(i => project.pages[i]));
  const urls = new Map(), overlays = new Map();
  const letters = bubbles && !blue && canEncodePNG();   // lettrage net : chaque bulle à 1200 dpi, posée sur la page
  for (const [j, i] of pageIdx.entries()) {
    onProgress(j, pageIdx.length);
    const pg = project.pages[i];
    await prepare(pg);
    const canvas = renderPage(project, pg, 1, { drafts, bubbles: bubbles && !letters, blue });
    release(pg);
    if (letters) overlays.set(i, await letteringImages(project, pg));
    if (fineDotsMatter(project) && !blue && fineDotShare(canvas) > FINE_DOT_LIMIT) onFine(i);
    if (!blue) convertCanvas(canvas, color);
    urls.set(i, URL.createObjectURL(await pngOf(canvas)));
  }
  onProgress(pageIdx.length, pageIdx.length);
  const sheets = impose(pageIdx, imposition, project.format), pageW = pageSize(project).w;
  const over = sl => (overlays.get(sl.page) || []).map(o => { const k = sl.w / pageW;
    return `<img src="${o.url}" alt="" style="left:${sl.x + o.box.x * k}mm;top:${sl.y + o.box.y * k}mm;width:${o.box.w * k}mm;height:${o.box.h * k}mm">`; }).join('');
  const host = document.createElement('div'), style = document.createElement('style');
  host.id = 'print-sheets';
  style.id = 'print-page';
  style.textContent = `@page { size: ${sheets[0].wmm}mm ${sheets[0].hmm}mm; margin: 0; }`;
  host.innerHTML = sheets.map(sh => `<div class="print-sheet" style="width:${sh.wmm}mm;height:${sh.hmm}mm">${sh.slots.map(sl =>
    `<img src="${urls.get(sl.page)}" alt="" style="left:${sl.x}mm;top:${sl.y}mm;width:${sl.w}mm;height:${sl.h}mm${sl.label ? ';outline:0.2mm solid #999' : ''}">` + over(sl) +
    (sl.label ? `<span style="left:${sl.x}mm;top:${sl.y + sl.h + 1.5}mm">${sl.label}</span>` : '')).join('')}</div>`).join('');
  document.head.appendChild(style);
  document.body.appendChild(host);
  await Promise.all([...host.querySelectorAll('img')].map(im => im.decode().catch(() => {})));
  // Safari (iPad) rend la main et lance « afterprint » avant d'avoir fini d'imprimer : les feuilles, invisibles à l'écran,
  // restent en place jusqu'à la prochaine impression ou 10 min.
  printCleanup?.();
  const timer = setTimeout(() => printCleanup?.(), 600000);
  printCleanup = () => { clearTimeout(timer); host.remove(); style.remove(); urls.forEach(u => URL.revokeObjectURL(u)); overlays.forEach(l => l.forEach(o => URL.revokeObjectURL(o.url))); printCleanup = null; };
  ready();
  window.print();
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = s => (s || 'fusain').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'fusain';

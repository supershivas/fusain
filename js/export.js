// Rendu d'une page à pleine résolution, PNG, vignettes et PDF (écrit à la main : aucune dépendance).
import { pageSize, panelStroke, mmToPx } from './model.js';
import { compositeRect } from './raster.js';
import { drawPageBubble, props } from './bubbles.js';
import { loadFont } from './fonts.js';
import { encodePNGRGBA, canEncodePNG } from './png.js';

// Les polices des bulles doivent être chargées avant de dessiner la page sur un canevas.
export const ensureFonts = (project, pages) =>
  Promise.all([...new Set(pages.flatMap(p => p.bubbles.map(b => props(b).font)))].map(loadFont));

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

// Pixels du canevas → bits (1 = blanc), lignes alignées sur l'octet.
function packBits(canvas) {
  const { width: w, height: h } = canvas, px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const rowBytes = (w + 7) >> 3, out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4] >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
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

export async function buildPDF(project, { onProgress = () => {}, prepare = async () => {}, release = () => {}, pages: pageIdx, imposition = 'single', drafts = false, bubbles = true, blue = false } = {}) {
  const chunks = [], offsets = [];
  let length = 0;
  const write = bytes => { chunks.push(bytes); length += bytes.length; };
  const text = s => write(enc.encode(s));
  text('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  pageIdx = pageIdx || project.pages.map((_, i) => i);
  const pages = pageIdx.map(i => project.pages[i]), n = pages.length;
  const mode = blue ? 'blue' : usesColor(project) || drafts ? 'rgb' : 'bits';
  await ensureFonts(project, pages);
  const sheets = impose(pageIdx, imposition, project.format);
  // numéros d'objets : 1 catalogue, 2 liste des feuilles, 3 info, 4 police des légendes, puis une image par page,
  // puis par feuille : feuille et contenu
  const imageObj = j => 5 + j, sheetObj = s => 5 + n + s * 2, contentObj = s => 6 + n + s * 2;
  const obj = (num, body) => { offsets[num] = length; text(num + ' 0 obj\n' + body + '\nendobj\n'); };

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Count ' + sheets.length + ' /Kids [' + sheets.map((_, s) => sheetObj(s) + ' 0 R').join(' ') + '] >>');
  obj(3, '<< /Title ' + pdfString(project.title) + ' /Producer (Fusain) /CreationDate (D:' +
    new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z) >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let j = 0; j < n; j++) {
    onProgress(j, n);
    await prepare(pages[j]);
    const canvas = renderPage(project, pages[j], 1, { drafts, bubbles });
    release(pages[j]);
    const raw = mode === 'blue' ? packGray(canvas) : mode === 'rgb' ? packRGB(canvas) : packBits(canvas), packed = await deflate(raw);
    const data = packed || raw;
    const space = mode === 'blue' ? '/ColorSpace [/Indexed /DeviceRGB 255 ' + BLUE_PALETTE + '] /BitsPerComponent 8'
      : mode === 'rgb' ? '/ColorSpace /DeviceRGB /BitsPerComponent 8' : '/ColorSpace /DeviceGray /BitsPerComponent 1';
    offsets[imageObj(j)] = length;
    text(imageObj(j) + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + canvas.width + ' /Height ' + canvas.height + ' ' + space +
      (packed ? ' /Filter /FlateDecode' : '') + ' /Length ' + data.length + ' >>\nstream\n');
    write(data);
    text('\nendstream\nendobj\n');
  }

  const pt = mm => +(mm / 25.4 * 72).toFixed(2);
  sheets.forEach((sh, s) => {
    const W = pt(sh.wmm), H = pt(sh.hmm), used = new Set();
    let content = '';
    for (const sl of sh.slots) {
      const j = pageIdx.indexOf(sl.page); used.add(j);
      const w = pt(sl.w), h = pt(sl.h), x = pt(sl.x), y = +(H - pt(sl.y) - h).toFixed(2);
      content += 'q ' + w + ' 0 0 ' + h + ' ' + x + ' ' + y + ' cm /Im' + j + ' Do Q\n';
      if (sl.label) content += '0.6 G 0.5 w ' + x + ' ' + y + ' ' + w + ' ' + h + ' re S 0 g BT /F1 9 Tf ' + x + ' ' + (y - 12).toFixed(2) + ' Td (' + sl.label + ') Tj ET\n';
    }
    obj(sheetObj(s), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Contents ' + contentObj(s) + ' 0 R /Resources << /XObject << ' +
      [...used].map(j => '/Im' + j + ' ' + imageObj(j) + ' 0 R').join(' ') + ' >> /Font << /F1 4 0 R >> >> >>');
    obj(contentObj(s), '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream');
  });

  const count = 4 + n + sheets.length * 2, xref = length;
  let table = 'xref\n0 ' + (count + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  text(table + 'trailer\n<< /Size ' + (count + 1) + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  onProgress(n, n);
  return new Blob(chunks, { type: 'application/pdf' });
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

export async function printProject(project, { onProgress = () => {}, prepare = async () => {}, release = () => {}, pages: pageIdx, imposition = 'single', drafts = false, bubbles = true, blue = false } = {}, ready = () => {}) {
  pageIdx = pageIdx || project.pages.map((_, i) => i);
  await ensureFonts(project, pageIdx.map(i => project.pages[i]));
  const urls = new Map();
  for (const [j, i] of pageIdx.entries()) {
    onProgress(j, pageIdx.length);
    const pg = project.pages[i];
    await prepare(pg);
    const canvas = renderPage(project, pg, 1, { drafts, bubbles, blue });
    release(pg);
    urls.set(i, URL.createObjectURL(await pngOf(canvas)));
  }
  onProgress(pageIdx.length, pageIdx.length);
  const sheets = impose(pageIdx, imposition, project.format);
  const host = document.createElement('div'), style = document.createElement('style');
  host.id = 'print-sheets';
  style.id = 'print-page';
  style.textContent = `@page { size: ${sheets[0].wmm}mm ${sheets[0].hmm}mm; margin: 0; }`;
  host.innerHTML = sheets.map(sh => `<div class="print-sheet" style="width:${sh.wmm}mm;height:${sh.hmm}mm">${sh.slots.map(sl =>
    `<img src="${urls.get(sl.page)}" alt="" style="left:${sl.x}mm;top:${sl.y}mm;width:${sl.w}mm;height:${sl.h}mm${sl.label ? ';outline:0.2mm solid #999' : ''}">` +
    (sl.label ? `<span style="left:${sl.x}mm;top:${sl.y + sl.h + 1.5}mm">${sl.label}</span>` : '')).join('')}</div>`).join('');
  document.head.appendChild(style);
  document.body.appendChild(host);
  await Promise.all([...host.querySelectorAll('img')].map(im => im.decode().catch(() => {})));
  // Safari (iPad) rend la main et lance « afterprint » avant d'avoir fini d'imprimer : les feuilles, invisibles à l'écran,
  // restent en place jusqu'à la prochaine impression ou 10 min.
  printCleanup?.();
  const timer = setTimeout(() => printCleanup?.(), 600000);
  printCleanup = () => { clearTimeout(timer); host.remove(); style.remove(); urls.forEach(u => URL.revokeObjectURL(u)); printCleanup = null; };
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

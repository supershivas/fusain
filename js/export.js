// Rendu d'une page à pleine résolution, PNG, vignettes et PDF (écrit à la main : aucune dépendance).
import { pageSize } from './model.js';
import { compositeRect } from './raster.js';
import { drawBubble, lineWidth, props } from './bubbles.js';
import { loadFont } from './fonts.js';

// Les polices des bulles doivent être chargées avant de dessiner la page sur un canevas.
export const ensureFonts = (project, pages) =>
  Promise.all([...new Set(pages.flatMap(p => p.bubbles.map(b => props(b).font)))].map(loadFont));

// Dessine la page (cases, cadres, bulles) sans brouillons ni aide visuelle.
export function renderPage(project, page, scale = 1) {
  const { w, h } = pageSize(project);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  const lw = lineWidth(project.dpi);
  for (const p of page.panels) {
    const pc = document.createElement('canvas'); pc.width = p.w; pc.height = p.h;
    const pctx = pc.getContext('2d'), img = pctx.createImageData(p.w, p.h);
    compositeRect(p, new Uint32Array(img.data.buffer), { x: 0, y: 0, w: p.w, h: p.h }, false);
    pctx.putImageData(img, 0, 0);
    ctx.drawImage(pc, p.x, p.y);
    ctx.strokeStyle = '#000'; ctx.lineWidth = lw * 1.5;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
  }
  for (const b of page.bubbles) drawBubble(ctx, b, project.dpi);
  return c;
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

// Chaîne PDF en UTF-16BE (accents corrects dans le titre du document).
const pdfString = s => '<FEFF' + Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('').toUpperCase() + '>';

export async function buildPDF(project, { onProgress = () => {}, prepare = async () => {}, release = () => {} } = {}) {
  const chunks = [], offsets = [];
  let length = 0;
  const write = bytes => { chunks.push(bytes); length += bytes.length; };
  const text = s => write(enc.encode(s));
  text('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const pages = project.pages, n = pages.length;
  await ensureFonts(project, pages);
  // numéros d'objets : 1 catalogue, 2 liste des pages, 3 info, puis par page : page, contenu, image
  const pageObj = i => 4 + i * 3, contentObj = i => 5 + i * 3, imageObj = i => 6 + i * 3;
  const obj = (num, body) => { offsets[num] = length; text(num + ' 0 obj\n' + body + '\nendobj\n'); };

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Count ' + n + ' /Kids [' + pages.map((_, i) => pageObj(i) + ' 0 R').join(' ') + '] >>');
  obj(3, '<< /Title ' + pdfString(project.title) + ' /Producer (Fusain) /CreationDate (D:' +
    new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z) >>');

  const wpt = (project.format.wmm / 25.4 * 72).toFixed(2), hpt = (project.format.hmm / 25.4 * 72).toFixed(2);
  for (let i = 0; i < n; i++) {
    onProgress(i, n);
    await prepare(pages[i]);
    const canvas = renderPage(project, pages[i], 1);
    release(pages[i]);
    const bits = packBits(canvas), packed = await deflate(bits);
    const { width: pw, height: ph } = canvas;
    obj(pageObj(i), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + wpt + ' ' + hpt + '] /Contents ' + contentObj(i) +
      ' 0 R /Resources << /XObject << /Im0 ' + imageObj(i) + ' 0 R >> >> >>');
    const content = 'q ' + wpt + ' 0 0 ' + hpt + ' 0 0 cm /Im0 Do Q';
    obj(contentObj(i), '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    const data = packed || bits;
    offsets[imageObj(i)] = length;
    text(imageObj(i) + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pw + ' /Height ' + ph +
      ' /ColorSpace /DeviceGray /BitsPerComponent 1 ' + (packed ? '/Filter /FlateDecode ' : '') +
      '/Length ' + data.length + ' >>\nstream\n');
    write(data);
    text('\nendstream\nendobj\n');
  }

  const count = 3 + n * 3, xref = length;
  let table = 'xref\n0 ' + (count + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  text(table + 'trailer\n<< /Size ' + (count + 1) + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  onProgress(n, n);
  return new Blob(chunks, { type: 'application/pdf' });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = s => (s || 'fusain').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'fusain';

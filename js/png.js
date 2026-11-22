// Encodeur PNG indexé à 2 bits pour les calques (0 transparent, 1 noir, 2 blanc) : le PNG est une image
// ordinaire, lisible partout, mais écrite sans passer par la compression du canevas (cent fois plus lente sur grand format).
// La compression vient de CompressionStream ; sans lui, l'appelant retombe sur canvas.toBlob.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export const canEncodePNG = () => typeof CompressionStream !== 'undefined';

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// PNG RVBA 8 bits (calques de couleur), filtre « Sub » sur chaque ligne : les aplats compressent bien.
export async function encodePNGRGBA(data, w, h) {
  const rb = w * 4, raw = new Uint8Array((rb + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rb + 1), s = y * rb;
    raw[o] = 1;
    for (let x = 0; x < rb; x++) raw[o + 1 + x] = (data[s + x] - (x >= 4 ? data[s + x - 4] : 0)) & 0xFF;
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  return assemble([chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))]);
}
function assemble(chunks) {
  const parts = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), ...chunks];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

export async function encodePNG2(data, w, h) {
  const rowBytes = (w + 3) >> 2, raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rowBytes + 1) + 1, row = y * w;
    for (let x = 0; x < w; x++) {
      const v = data[row + x];
      if (v) raw[o + (x >> 2)] |= v << (6 - 2 * (x & 3));
    }
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 2; ihdr[9] = 3;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('PLTE', new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255])),
    chunk('tRNS', new Uint8Array([0, 255, 255])),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

// Lecture exacte d'un PNG RVBA 8 bits non entrelacé (sans passer par le canevas, qui prémultiplie l'alpha et arrondit).
// Renvoie null si le fichier est d'un autre type : l'appelant retombe alors sur le canevas.
export async function decodePNGRGBA(buf, w, h) {
  if (typeof DecompressionStream === 'undefined') return null;
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0) !== 0x89504E47) return null;
  let at = 8, pw = 0, ph = 0;
  const idat = [];
  while (at + 8 <= b.length) {
    const len = dv.getUint32(at), type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    if (type === 'IHDR') {
      pw = dv.getUint32(at + 8); ph = dv.getUint32(at + 12);
      if (b[at + 16] !== 8 || b[at + 17] !== 6 || b[at + 20] !== 0 || pw !== w || ph !== h) return null;
    } else if (type === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + len));
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!pw || !idat.length) return null;
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer()), rb = w * 4, out = new Uint8Array(rb * h);
  if (raw.length < (rb + 1) * h) return null;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rb + 1)], s = y * (rb + 1) + 1, o = y * rb;
    for (let x = 0; x < rb; x++) {
      const a = x >= 4 ? out[o + x - 4] : 0, up = y ? out[o - rb + x] : 0, c = x >= 4 && y ? out[o - rb + x - 4] : 0;
      let p = raw[s + x];
      if (f === 1) p += a; else if (f === 2) p += up; else if (f === 3) p += (a + up) >> 1;
      else if (f === 4) { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[o + x] = p & 0xFF;
    }
  }
  return out;
}

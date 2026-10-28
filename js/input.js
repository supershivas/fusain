// Pointeur : Pointer Events, rejet de la paume, pincer pour zoomer, gestes à plusieurs doigts.
// Repris de Pixel Studio (touch.js) : le stylet dessine toujours, ses appuis font ignorer les doigts ;
// deux doigts zooment et déplacent (tape à deux doigts : annuler, à trois : rétablir).
import { ed } from './editor.js';
import { view, toPage, zoomAt, panBy, setView, setOverlay, canvasEl } from './view.js';
import * as tools from './tools.js';

const pointers = new Map();          // id → { x, y, type }
let penSeen = false, penDown = false, spaceHeld = false;
let gesture = null, panning = null, pending = null, drawingId = null;

try { penSeen = localStorage.getItem('fusain:pen') === '1'; } catch { /* préférence locale seulement */ }

const touchCount = () => [...pointers.values()].filter(p => p.type === 'touch').length;

function point(e, el) {
  const r = el.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, p = toPage(sx, sy);
  return { x: p.x, y: p.y, sx, sy, pressure: e.pressure || 0.5, type: e.pointerType, shift: e.shiftKey };
}

export function attachInput(el, { onUndo, onRedo }) {
  el.style.touchAction = 'none';
  el.addEventListener('contextmenu', e => e.preventDefault());

  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') { penSeen = true; penDown = true; try { localStorage.setItem('fusain:pen', '1'); } catch { /* */ } }
    if (e.pointerType === 'touch' && penDown) return;                 // paume posée pendant que le stylet dessine
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (e.pointerType === 'touch') {
      const n = touchCount();
      if (n === 2) { cancelDrawing(); stopPan(); startGesture(); return; }
      if (n > 2) { if (gesture) gesture.max = Math.max(gesture.max, n); return; }
    }
    const fingerPans = e.pointerType === 'touch' && ((penSeen && !ed.fingerDraws) || ed.tool === 'pan');
    const mousePan = e.pointerType !== 'touch' && (e.button === 1 || spaceHeld || ed.tool === 'pan');
    if (fingerPans || mousePan) { startPan(e); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // au doigt, on attend un instant : un second doigt (zoom, annuler) ne doit pas laisser de point
    if (e.pointerType === 'touch') {
      pending = { e, timer: setTimeout(() => flushPending(el), 70) };
    } else beginDraw(e, el);
  });

  el.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' && penDown) return;
    const rec = pointers.get(e.pointerId);
    if (!rec) { hover(e, el); return; }
    rec.x = e.clientX; rec.y = e.clientY;
    if (gesture && rec.type === 'touch') { moveGesture(); e.preventDefault(); return; }
    if (panning && panning.id === e.pointerId) { panBy(e.clientX - panning.x, e.clientY - panning.y); panning.x = e.clientX; panning.y = e.clientY; return; }
    if (drawingId === e.pointerId) {
      e.preventDefault();
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of list.length ? list : [e]) tools.move(point(ce, el));
      hover(e, el);
    } else if (pending && pending.e.pointerId === e.pointerId) pending.e = e;
  });

  const end = e => {
    if (e.pointerType === 'pen') penDown = false;
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    if (pending && pending.e.pointerId === e.pointerId) { flushPending(el); }
    pointers.delete(e.pointerId);
    if (drawingId === e.pointerId) { tools.up(); drawingId = null; }
    if (panning && panning.id === e.pointerId) stopPan();
    if (gesture && rec.type === 'touch' && touchCount() === 0) {
      const tap = !gesture.moved && performance.now() - gesture.t0 < 350 && e.type === 'pointerup';
      if (tap && gesture.max === 2) onUndo();
      else if (tap && gesture.max === 3) onRedo();
      gesture = null;
    }
    if (e.pointerType === 'touch') setOverlay({ cursor: null });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', e => { if (drawingId === e.pointerId) { tools.cancel(); drawingId = null; } end(e); });
  el.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') setOverlay({ cursor: null }); });

  el.addEventListener('wheel', e => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else panBy(e.shiftKey ? -e.deltaY : -e.deltaX, e.shiftKey ? 0 : -e.deltaY);
  }, { passive: false });

  window.addEventListener('keydown', e => { if (e.code === 'Space' && !typing(e)) { spaceHeld = true; if (e.target === document.body) e.preventDefault(); } });
  window.addEventListener('keyup', e => { if (e.code === 'Space') spaceHeld = false; });
  window.addEventListener('blur', () => { pointers.clear(); gesture = null; panning = null; penDown = false; spaceHeld = false; });
  // Safari : pas de zoom de la page au pincement ; la vue gère son propre zoom
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(n => el.addEventListener(n, e => e.preventDefault()));
}

export const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName) || (e.target && e.target.isContentEditable);

function flushPending(el) {
  if (!pending) return;
  clearTimeout(pending.timer);
  const e = pending.e; pending = null;
  if (pointers.has(e.pointerId)) beginDraw(e, el);
}

function beginDraw(e, el) {
  drawingId = e.pointerId;
  tools.down(point(e, el));
  hover(e, el);
}

function hover(e, el) {
  if (e.pointerType === 'touch') return;
  const t = ed.tool, r = ed.size / 2 * view.s;
  const brush = t === 'pencil' || t === 'texture' || t === 'eraser' || t === 'mask';
  const p = point(e, el);
  setOverlay({ cursor: brush && r > 1 ? { x: p.sx, y: p.sy, r } : null });
}

function cancelDrawing() {
  if (pending) { clearTimeout(pending.timer); pending = null; }
  if (drawingId !== null) { tools.cancel(); drawingId = null; }
}

function startPan(e) { panning = { id: e.pointerId, x: e.clientX, y: e.clientY }; }
function stopPan() { panning = null; }

// ───────────────────────── Deux doigts : zoom et déplacement ─────────────────────────

function metrics() {
  const [a, b] = [...pointers.values()].filter(p => p.type === 'touch');
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

function startGesture() {
  const m = metrics(), r = canvasEl().getBoundingClientRect();
  const anchor = toPage(m.mx - r.left, m.my - r.top);
  gesture = { t0: performance.now(), dist0: m.dist, mx0: m.mx, my0: m.my, s0: view.s, anchor, moved: false, max: 2, left: r.left, top: r.top };
}

function moveGesture() {
  if (touchCount() < 2) return;
  const m = metrics(), g = gesture;
  if (!g.moved && (Math.abs(m.dist - g.dist0) > 14 || Math.hypot(m.mx - g.mx0, m.my - g.my0) > 14)) g.moved = true;
  if (!g.moved) return;
  const s = g.s0 * m.dist / g.dist0;
  // la page sous le milieu des doigts au départ reste sous le milieu des doigts : zoom ET déplacement
  setView(s, (m.mx - g.left) - g.anchor.x * s, (m.my - g.top) - g.anchor.y * s);
}

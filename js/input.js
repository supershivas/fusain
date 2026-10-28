// Pointeur : Pointer Events, rejet de la paume, pincer pour zoomer, gestes à plusieurs doigts.
// Repris de Pixel Studio (touch.js) : le stylet dessine toujours, ses appuis font ignorer les doigts ;
// deux doigts zooment et déplacent (tape à deux doigts : annuler, à trois : rétablir).
import { ed, page, selectPanel } from './editor.js';
import { view, toPage, zoomAt, panBy, setView, setOverlay, canvasEl } from './view.js';
import * as tools from './tools.js';

const pointers = new Map();          // id → { x, y, type }
let penSeen = false, penDown = false, spaceHeld = false;
let gesture = null, panning = null, pending = null, drawingId = null, lastPen = 0, penInfo = null;

try { penSeen = localStorage.getItem('fusain:pen') === '1'; } catch { /* préférence locale seulement */ }

// Rejet de la paume : seul le déplacement dû à la paume est évité. Un doigt posé pendant ou juste après le stylet est « paume » :
// il ne dessine ni ne déplace la vue, et ne compte pas dans les gestes. Les gestes à deux ou trois doigts restent libres.
// Délai réglable dans les Réglages.
const palmMs = () => ({ off: 0, normal: 700, strong: 1600 }[ed.palm] ?? 1600);
const penStuck = () => penDown && performance.now() - lastPen > 3000;   // un « stylet levé » perdu ne doit jamais bloquer les doigts
const penRecent = () => penSeen && !ed.fingerDraws && palmMs() > 0 && performance.now() - lastPen < palmMs();

const touchCount = () => [...pointers.values()].filter(p => p.type === 'touch' && !p.palm).length;

function point(e, el) {
  const r = el.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, p = toPage(sx, sy);
  return { x: p.x, y: p.y, sx, sy, pressure: e.pointerType === 'pen' ? Math.max(0.02, e.pressure) : 0.5, type: e.pointerType, shift: e.shiftKey };
}

export function attachInput(el, { onUndo, onRedo, onClear, onPenToggle, onPenEraser }) {
  el.style.touchAction = 'none';
  el.addEventListener('contextmenu', e => e.preventDefault());
  // WebKit (Safari, Firefox et Chrome sur iPad) lance toucher long et menu « Rechercher » sur touchstart, que pointerdown n'annule pas
  el.addEventListener('touchstart', e => e.preventDefault(), { passive: false });

  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') {
      penSeen = true; penDown = true; lastPen = performance.now();
      try { localStorage.setItem('fusain:pen', '1'); } catch { /* */ }
      // le stylet se pose : le trait ou le déplacement commencé au doigt était une paume (les gestes à plusieurs doigts restent)
      if (!ed.fingerDraws && palmMs() > 0) {
        if (drawingId !== null && pointers.get(drawingId) && pointers.get(drawingId).type === 'touch') { tools.cancel(); drawingId = null; }
        if (pending) { clearTimeout(pending.timer); pending = null; }
        if (!gesture) for (const r of pointers.values()) if (r.type === 'touch') r.palm = true;
        stopPan();
      }
      penInfo = null;
      // bouton du stylet (flanc) : change d'outil ; gomme au bout du stylet : gomme le temps du trait
      if (e.buttons & 2 && onPenToggle) { e.preventDefault(); onPenToggle(); penDown = false; return; }
      if (e.buttons & 32 && onPenEraser) { onPenEraser(true); penInfo = { erase: true }; }
      penInfo = Object.assign(penInfo || {}, { t: performance.now(), x: e.clientX, y: e.clientY, max: 0, ptr: ed.undo.ptr });
    }
    if (penStuck()) penDown = false;
    // un second doigt, même tout juste après le stylet, fait un vrai geste : seul un doigt isolé est suspect
    const alone = ![...pointers.values()].some(r => r.type === 'touch');
    const palm = e.pointerType === 'touch' && (penDown || (penRecent() && alone));
    if (e.pointerType === 'touch' && !palm) for (const r of pointers.values()) if (r.type === 'touch') r.palm = false;
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, palm });
    if (palm) return;

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
    if (e.pointerType === 'pen' && penDown) lastPen = performance.now();
    if (penStuck()) penDown = false;
    const rec = pointers.get(e.pointerId);
    if (!rec) { hover(e, el); return; }
    rec.x = e.clientX; rec.y = e.clientY;
    if (rec.palm) return;
    if (e.pointerType === 'pen' && penInfo && penInfo.t) penInfo.max = Math.max(penInfo.max, Math.hypot(e.clientX - penInfo.x, e.clientY - penInfo.y));
    if (gesture && rec.type === 'touch') {
      e.preventDefault();
      // trois doigts : on ne zoome plus ; un frottement ou une rotation vide le calque (geste de Procreate)
      if (touchCount() >= 3) { if (!gesture.cleared && !penRecent() && scrubbed()) { gesture.cleared = true; gesture.moved = true; onClear(); } return; }
      moveGesture(); return;
    }
    if (panning && panning.id === e.pointerId) {
      // un doigt qui déplace la vue (stylet en usage) doit bouger franchement : une paume qui frôle l'écran ne fait rien
      if (!panning.moved) { if (Math.hypot(e.clientX - panning.x0, e.clientY - panning.y0) < (e.pointerType === 'touch' && penSeen ? 18 : 3)) return; panning.moved = true; panning.x = e.clientX; panning.y = e.clientY; return; }
      panBy(e.clientX - panning.x, e.clientY - panning.y); panning.x = e.clientX; panning.y = e.clientY; return;
    }
    if (drawingId === e.pointerId) {
      e.preventDefault();
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of list.length ? list : [e]) tools.move(point(ce, el));
      hover(e, el);
    } else if (pending && pending.e.pointerId === e.pointerId) pending.e = e;
  });

  const end = e => {
    if (e.pointerType === 'pen') { penDown = false; lastPen = performance.now(); }
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    if (pending && pending.e.pointerId === e.pointerId) { flushPending(el); }
    pointers.delete(e.pointerId);
    if (drawingId === e.pointerId) { tools.up(); drawingId = null; }
    if (e.pointerType === 'pen' && e.type === 'pointerup' && penInfo) {
      const info = penInfo; penInfo = null;
      if (info.erase && onPenEraser) onPenEraser(false);
    }
    if (panning && panning.id === e.pointerId) {
      // un simple toucher en mode déplacement (main, ou doigt avec le stylet) change de case sans rien dessiner
      if (!panning.moved && e.type === 'pointerup') { const q = toPage(e.clientX - el.getBoundingClientRect().left, e.clientY - el.getBoundingClientRect().top); const c = page().panels.find(p => q.x >= p.x && q.y >= p.y && q.x < p.x + p.w && q.y < p.y + p.h); if (c) selectPanel(c.id); }
      stopPan();
    }
    if (gesture && rec.type === 'touch' && touchCount() === 0) {
      const tap = !gesture.moved && performance.now() - gesture.t0 < 350 && e.type === 'pointerup';
      if (gesture.cleared) { /* le calque vient d'être vidé */ }
      else if (tap && gesture.max === 2) onUndo();
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

function startPan(e) { panning = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false }; }
function stopPan() { panning = null; }

// ───────────────────────── Deux doigts : zoom et déplacement ─────────────────────────

function metrics() {
  const [a, b] = [...pointers.values()].filter(p => p.type === 'touch');
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ang: Math.atan2(b.y - a.y, b.x - a.x) };
}

function startGesture() {
  const m = metrics(), r = canvasEl().getBoundingClientRect();
  const anchor = toPage(m.mx - r.left, m.my - r.top);
  gesture = { t0: performance.now(), dist0: m.dist, mx0: m.mx, my0: m.my, s0: view.s, r0: view.r, ang0: m.ang, spin: 0, anchor, moved: false, max: 2, left: r.left, top: r.top };
}

// Frottement (va-et-vient du centre des trois doigts) ou rotation répétée : déclenche le vidage du calque.
function scrubbed() {
  const ts = [...pointers.values()].filter(p => p.type === 'touch').slice(0, 3);
  if (ts.length < 3) return false;
  const cx = (ts[0].x + ts[1].x + ts[2].x) / 3, cy = (ts[0].y + ts[1].y + ts[2].y) / 3;
  const sc = gesture.scrub || (gesture.scrub = { last: null, dir: 0, since: 0, rev: 0, ang: 0, lastAng: null });
  const ang = Math.atan2(ts[0].y - cy, ts[0].x - cx);
  if (sc.lastAng !== null) { const d = ang - sc.lastAng; sc.ang += Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); }
  sc.lastAng = ang;
  if (!sc.c0) sc.c0 = { x: cx, y: cy };
  if (Math.hypot(cx - sc.c0.x, cy - sc.c0.y) > 14 || sc.ang > 0.25) gesture.moved = true;   // plus un simple tape : pas de « rétablir » au relâchement
  if (sc.last) {
    const dx = cx - sc.last.x, dy = cy - sc.last.y, along = Math.abs(dx) >= Math.abs(dy) ? dx : dy;   // axe dominant du geste
    if (Math.abs(along) > 4) {
      const dir = Math.sign(along);
      if (sc.dir && dir !== sc.dir) { if (sc.since > 36) sc.rev++; sc.since = 0; }
      sc.dir = dir; sc.since += Math.abs(along);
      sc.last = { x: cx, y: cy };
    }
  } else sc.last = { x: cx, y: cy };
  return sc.rev >= 4 || sc.ang > 5.5;
}

function moveGesture() {
  if (touchCount() < 2) return;
  const m = metrics(), g = gesture;
  // rotation des deux doigts, comptée seulement au-delà de 8° (un zoom ne fait pas tourner la page)
  let da = m.ang - g.ang0; da = Math.atan2(Math.sin(da), Math.cos(da));
  if (Math.abs(da) > 0.14) g.spin = da - Math.sign(da) * 0.14; else if (!g.spin) g.spin = 0;
  if (!g.moved && (Math.abs(m.dist - g.dist0) > 14 || Math.hypot(m.mx - g.mx0, m.my - g.my0) > 14 || g.spin)) g.moved = true;
  if (!g.moved) return;
  const s = g.s0 * m.dist / g.dist0;
  let r = g.r0 + g.spin;
  // aimant aux angles courants (0, 45, 90…) à moins de 5°
  const step = Math.PI / 4, near = Math.round(r / step) * step;
  if (g.spin && Math.abs(r - near) < 0.087) r = near;
  r = ((r + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const c = Math.cos(r), sn = Math.sin(r), ax = g.anchor.x * s, ay = g.anchor.y * s;
  // la page sous le milieu des doigts au départ reste sous le milieu des doigts : zoom, rotation ET déplacement
  setView(s, (m.mx - g.left) - (ax * c - ay * sn), (m.my - g.top) - (ax * sn + ay * c), r);
}

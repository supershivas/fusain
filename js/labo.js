// Labo : on compare des variantes avant d'en adopter une. Données d'exemple en dur : rien n'est lu ni écrit
// dans Supabase, IndexedDB ou localStorage. Ajouter un sujet ou une variante = ajouter une entrée à GROUPS.
import { BUILTIN_TRAMAS, drawTramaSwatch } from './tramas.js';
import { drawBubble, lineWidth } from './bubbles.js';
import { previewBrush, brushSpec } from './raster.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function swatch(t, scale, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; drawTramaSwatch(c, t, scale); return c;
}
const fig = (t, scale, w, h, label) => { const f = document.createElement('figure'); f.append(swatch(t, scale, w, h)); f.append(label); return f; };

const grises = () => BUILTIN_TRAMAS.filter(t => t.group === 'Gris');

function bubbleDemo(el, { lw, pt, tail, extra = {} }) {
  const c = document.createElement('canvas'), dpi = 300;
  c.width = 1500; c.height = 700; c.style.cssText = 'width:100%;height:auto;image-rendering:auto';
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const base = { text: 'Encore dix marches…', pt, caps: true, auto: false, ...extra };
  const kinds = [
    { ...base, kind: 'parole', x: 40, y: 40, w: 540, h: 280, tail: tail ? { x: 180, y: 470 } : null },
    { ...base, kind: 'pensee', x: 640, y: 40, w: 540, h: 280, text: 'Quelqu\'un a coupé le courant ?', tail: tail ? { x: 760, y: 430 } : null },
    { ...base, kind: 'narration', x: 640, y: 520, w: 540, h: 140, text: 'Cette nuit-là, la mer était calme.' },
  ];
  for (const b of kinds) drawBubble(ctx, b, dpi, lineWidth(dpi) * lw);
  el.append(c);
}


// ───────────────────────── Ergonomie de l'outil Bulle : bancs d'essai interactifs ─────────────────────────
// Chaque variante est une mini-page (deux cases, une bulle) où l'on peut vraiment déplacer, redimensionner, tirer la queue, taper le texte.
// Le dessin de la bulle est celui de l'app (drawBubble) ; l'état est local à la démonstration.

const PW = 1200, PH = 760, DPI = 300;
const SHAPE_CYCLE = [['ellipse', 'circle', 'Ellipse'], ['rect', 'square-rounded', 'Rectangle'], ['cloud', 'cloud', 'Nuage'], ['eclair', 'bolt', 'Éclair']];
const TAIL_STYLES = [['none', 'Aucune'], ['pointe', 'Pointe'], ['fleche', 'Flèche'], ['bulles', 'Bulles']];
const KINDS = [['parole', 'message-circle', 'Parole'], ['pensee', 'cloud', 'Pensée'], ['cri', 'bolt', 'Cri'], ['narration', 'square', 'Narration']];
const PANELS = [{ x: 40, y: 40, w: 560, h: 680 }, { x: 620, y: 40, w: 540, h: 680 }];

function newDemoBubble(kind = 'parole', x = 250, y = 120, w = 520, h = 240) {
  const tail = kind === 'narration' ? null : { x: x + w * 0.35, y: y + h + 150 };
  const b = { id: 'lab' + Math.random().toString(36).slice(2, 6), kind, x, y, w, h, text: kind === 'cri' ? 'ATTENTION !' : 'Encore dix marches…', pt: 12, caps: true, auto: false, tail };
  if (kind === 'cri') b.shape = 'eclair';
  return b;
}

function bubbleLab(el, mode) {
  const b = newDemoBubble();
  let sel = true, pop = null, drag = null, kindSel = 'parole', lastTail = null;
  const root = document.createElement('div'); root.className = 'blab';
  root.innerHTML = `<div class="blab-bar"></div><div class="blab-main"><div class="blab-stage"><canvas width="${PW}" height="${PH}"></canvas><div class="blab-float" hidden></div>
    <textarea class="blab-edit" hidden aria-label="Texte de la bulle"></textarea></div><aside class="blab-insp" hidden></aside></div><p class="blab-hint"></p>`;
  el.append(root);
  const $ = q => root.querySelector(q), cv = $('canvas'), ctx = cv.getContext('2d'), bar = $('.blab-bar'), flo = $('.blab-float'), ed = $('.blab-edit'), insp = $('.blab-insp'), hint = $('.blab-hint');
  const HINT = {
    A: 'Comme dans l\'app : une barre, puis une fenêtre par famille de réglages (Texte, Forme, Queue). Pour retirer la queue : Queue → Style → Aucune.',
    B: 'Touche la bulle : une barre flottante apparaît au-dessus. Un bouton pour la forme (il tourne), un pour la queue (marche / arrêt), deux touches pour le texte.',
    C: 'Tire depuis le bord de la bulle pour en sortir une queue ; ramène la pointe dans la bulle pour la retirer. Double toucher = écrire.',
    D: 'Un seul panneau, des vignettes pour choisir la forme et la queue d\'un coup d\'œil ; les curseurs sont repliés sous « Plus de réglages ».',
    E: 'Choisis un type puis trace un rectangle dans une case : sa taille est celle de la bulle, la saisie du texte s\'ouvre aussitôt, la queue est posée dessous.',
  }[mode];
  hint.textContent = HINT;
  const W = () => cv.getBoundingClientRect().width, pct = (v, t) => (v / t * 100) + '%';

  const pt = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * PW, y: (e.clientY - r.top) / r.height * PH }; };
  const R = 30;   // zone de saisie des poignées, en pixels de page
  const corner = () => ({ x: b.x + b.w, y: b.y + b.h });
  const inside = (q, k = 0) => q.x >= b.x - k && q.x <= b.x + b.w + k && q.y >= b.y - k && q.y <= b.y + b.h + k;
  const ellipseIn = q => { const rx = b.w / 2, ry = b.h / 2; return ((q.x - b.x - rx) / rx) ** 2 + ((q.y - b.y - ry) / ry) ** 2 <= 1; };

  function redraw() {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PW, PH);
    for (const p of PANELS) {
      ctx.strokeStyle = '#d9d9d9'; ctx.lineWidth = 3;
      for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.moveTo(p.x + 20 + i * 55, p.y + p.h - 20); ctx.lineTo(p.x + 90 + i * 55, p.y + p.h - 160 - (i % 3) * 40); ctx.stroke(); }
      ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.strokeRect(p.x, p.y, p.w, p.h);
    }
    if (b.hidden !== true) drawBubble(ctx, b, DPI);
    if (sel && !b.hidden) {
      ctx.strokeStyle = '#C0392B'; ctx.fillStyle = '#C0392B'; ctx.lineWidth = 3; ctx.setLineDash([14, 9]); ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16); ctx.setLineDash([]);
      const dot = (q, col = '#C0392B') => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(q.x, q.y, 15, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); };
      dot(corner());
      if (b.tail) dot(b.tail, drag && drag.mode === 'tail' && drag.removing ? '#555' : '#C0392B');
      if (mode === 'C' && !b.tail) { ctx.strokeStyle = 'rgba(192,57,43,.45)'; ctx.lineWidth = 36; ctx.beginPath(); ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2 + 16, b.h / 2 + 16, 0, 0, 7); ctx.stroke(); }
    }
    if (drag && drag.mode === 'draw') { ctx.strokeStyle = '#C0392B'; ctx.lineWidth = 4; ctx.setLineDash([16, 10]); ctx.strokeRect(drag.x, drag.y, drag.w, drag.h); ctx.setLineDash([]); }
    place();
  }

  // Éléments HTML posés sur la bulle : barre flottante (B), champ de saisie.
  function place() {
    if (mode === 'B') {
      flo.hidden = !(sel && !b.hidden);
      if (!flo.hidden) { flo.style.left = pct(b.x + b.w / 2, PW); flo.style.top = pct(b.y - 20, PH); }
    }
    ed.style.left = pct(b.x, PW); ed.style.top = pct(b.y, PH); ed.style.width = pct(b.w, PW); ed.style.height = pct(b.h, PH);
  }
  const edit = on => { ed.hidden = !on; if (on) { ed.value = b.text; ed.focus(); ed.select(); } };
  ed.addEventListener('input', () => { b.text = ed.value; redraw(); });
  ed.addEventListener('blur', () => { ed.hidden = true; });
  ed.addEventListener('keydown', e => { if (e.key === 'Escape') ed.blur(); });

  const ensureTail = () => { if (!b.tail) b.tail = lastTail || { x: b.x + b.w * 0.35, y: b.y + b.h + 150 }; if (!b.tailStyle || b.tailStyle === 'none') delete b.tailStyle; };
  const toggleTail = () => { if (b.tail) { lastTail = b.tail; b.tail = null; } else ensureTail(); redraw(); ui(); };
  const cycleShape = () => { const i = SHAPE_CYCLE.findIndex(s => s[0] === (b.shape || (b.kind === 'pensee' ? 'cloud' : b.kind === 'narration' ? 'rect' : 'ellipse'))); b.shape = SHAPE_CYCLE[(i + 1) % SHAPE_CYCLE.length][0]; redraw(); ui(); };
  const shapeNow = () => b.shape || (b.kind === 'pensee' ? 'cloud' : b.kind === 'narration' ? 'rect' : b.kind === 'cri' ? 'eclair' : 'ellipse');

  cv.addEventListener('pointerdown', e => {
    const q = pt(e); cv.setPointerCapture(e.pointerId); ed.blur();
    if (sel && !b.hidden) {
      if (b.tail && Math.hypot(q.x - b.tail.x, q.y - b.tail.y) < R) { drag = { mode: 'tail' }; return; }
      const c = corner(); if (Math.hypot(q.x - c.x, q.y - c.y) < R) { drag = { mode: 'resize', q, w: b.w, h: b.h }; return; }
      if (mode === 'C' && !b.tail && inside(q, 42) && !ellipseIn(q)) { b.tail = { x: q.x, y: q.y }; drag = { mode: 'tail' }; redraw(); return; }
    }
    if (!b.hidden && inside(q)) { sel = true; drag = { mode: 'move', q, x: b.x, y: b.y, tail: b.tail && { ...b.tail }, t0: performance.now() }; if (mode === 'B') pop = null; redraw(); ui(); return; }
    if (mode === 'E' && PANELS.some(p => q.x > p.x && q.x < p.x + p.w && q.y > p.y && q.y < p.y + p.h)) { sel = false; drag = { mode: 'draw', q, x: q.x, y: q.y, w: 0, h: 0 }; redraw(); return; }
    sel = false; drag = null; redraw(); ui();
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const q = pt(e);
    if (drag.mode === 'move') { const dx = q.x - drag.q.x, dy = q.y - drag.q.y; b.x = drag.x + dx; b.y = drag.y + dy; if (drag.tail) b.tail = { x: drag.tail.x + dx, y: drag.tail.y + dy }; }
    else if (drag.mode === 'resize') { b.w = Math.max(160, drag.w + q.x - drag.q.x); b.h = Math.max(110, drag.h + q.y - drag.q.y); }
    else if (drag.mode === 'tail') { b.tail = { x: q.x, y: q.y }; drag.removing = mode === 'C' && ellipseIn(q); }
    else if (drag.mode === 'draw') { drag.x = Math.min(q.x, drag.q.x); drag.y = Math.min(q.y, drag.q.y); drag.w = Math.abs(q.x - drag.q.x); drag.h = Math.abs(q.y - drag.q.y); }
    redraw();
  });
  const up = () => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.mode === 'tail' && d.removing) { lastTail = null; b.tail = null; }
    if (d.mode === 'draw' && d.w > 140 && d.h > 90) {
      const nb = newDemoBubble(kindSel, d.x, d.y, d.w, d.h); nb.text = ''; Object.keys(b).forEach(k => delete b[k]); Object.assign(b, nb); sel = true; redraw(); ui(); edit(true); return;
    }
    if (d.mode === 'move' && performance.now() - d.t0 < 260 && Math.hypot(b.x - d.x, b.y - d.y) < 6) { if (mode !== 'A' && mode !== 'D') edit(true); }
    redraw(); ui();
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', e => { if (inside(pt(e))) edit(true); });

  // ── Interface propre à chaque variante ──
  const ic = n => `<i class="ti ti-${n}" aria-hidden="true"></i>`;
  const range = (k, label, min, max, step, v) => `<label class="bl-r"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
  function ui() {
    if (mode === 'A') {
      const tabs = [['texte', 'typography', 'Texte'], ['forme', 'shape', 'Forme'], ['queue', 'message-circle-plus', 'Queue']];
      bar.innerHTML = `<span class="bl-chip">${ic('message-circle')} Parole ${ic('chevron-down')}</span><span class="bl-ico">${ic('writing')}</span>
        ${tabs.map(([id, i, n]) => `<button class="btn small ${pop === id ? 'on' : ''}" data-pop="${id}">${ic(i)} ${n}</button>`).join('')}<button class="bl-ico" data-act="dup">${ic('copy')}</button><button class="bl-ico" data-act="del">${ic('trash')}</button>`;
      let h = '';
      if (pop === 'texte') h = `<textarea data-k="text" rows="2">${b.text}</textarea>${range('pt', `Corps : ${b.pt} pt`, 5, 40, 0.5, b.pt)}<label class="bl-c"><input type="checkbox" data-k="caps" ${b.caps ? 'checked' : ''}> Majuscules</label>`;
      if (pop === 'forme') h = `<label class="bl-r"><span>Contour</span><select data-k="shape">${SHAPE_CYCLE.map(([v, , n]) => `<option value="${v}" ${shapeNow() === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
      if (pop === 'queue') h = `<label class="bl-r"><span>Style</span><select data-k="tailstyle">${TAIL_STYLES.map(([v, n]) => `<option value="${v}" ${(b.tail ? b.tailStyle || 'pointe' : 'none') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${b.tail ? range('tailW', 'Largeur de la queue', 4, 70, 1, b.tailW ?? 24) + range('tailBend', 'Courbure', -100, 100, 5, b.tailBend ?? 0) : ''}`;
      insp.hidden = true;
      let pp = root.querySelector('.bl-pop'); if (!pp) { pp = document.createElement('div'); pp.className = 'bl-pop'; $('.blab-stage').append(pp); }
      pp.hidden = !pop || !sel; if (pop) pp.innerHTML = h;
      return;
    }
    if (mode === 'B') {
      bar.innerHTML = `<span class="hint">Touche la bulle pour la régler ; la barre flottante suit la bulle.</span>`;
      flo.innerHTML = `<button data-act="text" title="Écrire">${ic('typography')}</button><button data-act="shape" title="Forme : ${SHAPE_CYCLE.find(s => s[0] === shapeNow())[2]} (touche pour changer)">${ic(SHAPE_CYCLE.find(s => s[0] === shapeNow())[1])}</button>
        <button data-act="tail" class="${b.tail ? 'on' : ''}" title="${b.tail ? 'Retirer la queue' : 'Ajouter une queue'}">${ic(b.tail ? 'message-circle' : 'message')}${b.tail ? '' : ''}</button><button data-act="more" title="Réglages" class="${pop ? 'on' : ''}">${ic('adjustments-horizontal')}</button>
        <button data-act="dup" title="Dupliquer">${ic('copy')}</button><button data-act="del" title="Supprimer">${ic('trash')}</button>`;
      let pp = root.querySelector('.bl-pop'); if (!pp) { pp = document.createElement('div'); pp.className = 'bl-pop'; $('.blab-stage').append(pp); }
      pp.hidden = !pop; pp.innerHTML = `${range('pt', `Corps : ${b.pt} pt`, 5, 40, 0.5, b.pt)}${b.tail ? range('tailBend', 'Courbure de la queue', -100, 100, 5, b.tailBend ?? 0) : ''}
        <label class="bl-r"><span>Style de queue</span><select data-k="tailstyle">${TAIL_STYLES.filter(t => t[0] !== 'none').map(([v, n]) => `<option value="${v}" ${(b.tailStyle || 'pointe') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
      return;
    }
    if (mode === 'C') { bar.innerHTML = `<span class="hint">${b.tail ? 'Queue : tire la pointe ; ramène-la dans la bulle pour la retirer.' : 'Pas de queue : tire depuis le bord de la bulle (anneau rouge).'}</span><button class="bl-ico" data-act="reset" title="Remettre l'exemple">${ic('refresh')}</button>`; return; }
    if (mode === 'D') {
      bar.innerHTML = `<span class="hint">Réglages dans le panneau.</span>`;
      insp.hidden = false;
      insp.innerHTML = `<h4>Forme</h4><div class="bl-thumbs">${SHAPE_CYCLE.map(([v, , n]) => `<button class="${shapeNow() === v ? 'on' : ''}" data-shape="${v}" title="${n}"><canvas width="240" height="140" data-sh="${v}"></canvas><span>${n}</span></button>`).join('')}</div>
        <h4>Queue</h4><div class="bl-thumbs">${TAIL_STYLES.map(([v, n]) => `<button class="${(b.tail ? b.tailStyle || 'pointe' : 'none') === v ? 'on' : ''}" data-tail="${v}" title="${n}"><canvas width="240" height="140" data-tl="${v}"></canvas><span>${n}</span></button>`).join('')}</div>
        <h4>Texte</h4><textarea data-k="text" rows="2">${b.text}</textarea><div class="bl-step"><button data-act="smaller">A−</button><span>${b.pt} pt</span><button data-act="bigger">A+</button></div>
        <details ${root._adv ? 'open' : ''}><summary>Plus de réglages</summary>${range('stroke', 'Trait', 0.1, 1.5, 0.05, b.stroke ?? 0.35)}${range('wobble', 'Imperfections', 0, 100, 5, b.wobble ?? 18)}${b.tail ? range('tailBend', 'Courbure de la queue', -100, 100, 5, b.tailBend ?? 0) : ''}</details>`;
      insp.querySelectorAll('canvas[data-sh]').forEach(c => { const x = c.getContext('2d'); drawBubble(x, { kind: 'parole', shape: c.dataset.sh, x: 30, y: 16, w: 180, h: 90, text: '', tail: null }, DPI, 3); });
      insp.querySelectorAll('canvas[data-tl]').forEach(c => { const x = c.getContext('2d'); drawBubble(x, { kind: 'parole', shape: 'ellipse', x: 40, y: 10, w: 160, h: 80, text: '', tail: c.dataset.tl === 'none' ? null : { x: 80, y: 128 }, tailStyle: c.dataset.tl === 'none' ? undefined : c.dataset.tl }, DPI, 3); });
      return;
    }
    if (mode === 'E') {
      bar.innerHTML = `<span class="bl-kinds">${KINDS.map(([v, i, n]) => `<button class="btn small ${kindSel === v ? 'primary' : ''}" data-kind="${v}">${ic(i)} ${n}</button>`).join('')}</span><span class="hint">puis trace un rectangle dans une case</span><button class="bl-ico" data-act="reset" title="Effacer">${ic('refresh')}</button>`;
      return;
    }
  }

  const apply = (k, v) => {
    if (k === 'text') b.text = v; else if (k === 'pt') b.pt = +v; else if (k === 'caps') b.caps = !!v;
    else if (k === 'shape') b.shape = v;
    else if (k === 'tailstyle') { if (v === 'none') { lastTail = b.tail; b.tail = null; } else { ensureTail(); b.tailStyle = v; } }
    else b[k] = +v;
    redraw();
  };
  root.addEventListener('input', e => { const k = e.target.dataset.k; if (!k) return; apply(k, e.target.type === 'checkbox' ? e.target.checked : e.target.value); if (e.target.tagName === 'SELECT') ui(); else if (e.target.type === 'range') { const sp = e.target.parentElement.firstElementChild; if (sp) sp.textContent = sp.textContent.replace(/[\d.,-]+( pt)?$/, k === 'pt' ? e.target.value + ' pt' : e.target.value); } });
  root.addEventListener('click', e => {
    const t = e.target.closest('button, summary'); if (!t) return;
    if (t.dataset.pop) { pop = pop === t.dataset.pop ? null : t.dataset.pop; ui(); return; }
    if (t.dataset.kind) { kindSel = t.dataset.kind; ui(); return; }
    if (t.dataset.shape) { b.shape = t.dataset.shape; redraw(); ui(); return; }
    if (t.dataset.tail) { apply('tailstyle', t.dataset.tail); ui(); return; }
    const a = t.dataset.act; if (!a) return;
    if (a === 'text') edit(true);
    else if (a === 'shape') cycleShape();
    else if (a === 'tail') toggleTail();
    else if (a === 'more') { pop = pop ? null : 'more'; ui(); }
    else if (a === 'dup') { b.x += 40; b.y += 40; if (b.tail) b.tail = { x: b.tail.x + 40, y: b.tail.y + 40 }; redraw(); }
    else if (a === 'del') { b.hidden = true; sel = false; redraw(); ui(); setTimeout(() => { delete b.hidden; sel = true; redraw(); ui(); }, 1200); }
    else if (a === 'smaller') { b.pt = Math.max(5, b.pt - 1); redraw(); ui(); }
    else if (a === 'bigger') { b.pt = Math.min(40, b.pt + 1); redraw(); ui(); }
    else if (a === 'reset') { const nb = mode === 'E' ? Object.assign(newDemoBubble(), { hidden: true }) : newDemoBubble(); Object.keys(b).forEach(k => delete b[k]); Object.assign(b, nb); sel = mode !== 'E'; redraw(); ui(); }
  });
  insp.addEventListener('toggle', e => { root._adv = e.target.open; }, true);
  if (mode === 'E') { b.hidden = true; sel = false; }
  ui(); redraw();
  if (document.fonts) document.fonts.ready.then(redraw);
}

// ───────────────────────── Dessin, couleur, planche : nouveautés de la v1.29 à la v1.39 ─────────────────────────
// Démonstrations avec le vrai moteur (previewBrush) ; rien n'est lu ni écrit ailleurs que dans la page.

const BR = id => brushSpec(id);
const TR = id => BUILTIN_TRAMAS.find(t => t.id === id) || null;
const PALETTE_DEMO = [['Stylo rond', 'stylo', null], ['Plume G', 'plumeg', null], ['Brush pen', 'brushpen', null], ['Crayon HB', 'hb', null], ['Fusain', 'fusain', null], ['Trame 25 %', 'stylo', 'g25'], ['Trame 50 %', 'stylo', 'g50'], ['Fusain tramé', 'fusain', 'g25']];
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
function stroke(spec, size, { w = 112, hgt = 52, alpha = 1, trame = null, color = null } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  previewBrush(c, spec, size, alpha, trame, 1, color); return c;
}

// Palette de pinceaux : A = emplacements du projet dans la barre ; B = un bouton et sa liste (ancienne).
function paletteDemo(el, mode) {
  if (mode === 'A') {
    const bar = h('div', 'lab-bar-mock');
    PALETTE_DEMO.forEach(([name, id, tid], i) => { const b = h('button', 'lab-slot' + (i === 0 ? ' on' : '')); b.title = name; b.append(stroke(BR(id), 7, { w: 56, hgt: 28, trame: TR(tid) })); b.onclick = () => { bar.querySelectorAll('.lab-slot').forEach(x => x.classList.toggle('on', x === b)); cap.textContent = name + ' : un toucher le choisit, un second ouvre ses réglages, un appui long le retire.'; }; bar.append(b); });
    bar.append(h('button', 'lab-slot add', '<i class="ti ti-plus"></i>'));
    const cap = h('p', 'lab-cap', 'Stylo rond : un toucher le choisit, un second ouvre ses réglages, un appui long le retire.');
    el.append(bar, cap);
  } else {
    const wrap = h('div', 'lab-col');
    const btn = h('button', 'lab-slot on'); btn.append(stroke(BR('stylo'), 7, { w: 64, hgt: 30 }));
    const list = h('div', 'lab-list');
    ['Encrage', 'Esquisse', 'Pinceaux', 'Calligraphie', 'Texture', 'Mes pinceaux'].forEach(g => list.append(h('div', 'lab-group', g)));
    PALETTE_DEMO.slice(0, 5).forEach(([name, id]) => { const r = h('div', 'lab-row'); r.append(stroke(BR(id), 6, { w: 120, hgt: 28 }), h('span', '', name)); list.append(r); });
    wrap.append(btn, list, h('p', 'lab-cap', 'Un seul bouton : il faut ouvrir la liste et la parcourir à chaque changement ; « Mes pinceaux » tout en bas, sur l\'appareil seulement.'));
    el.append(wrap);
  }
}

// Curseur de taille : même course, trois répartitions des tailles.
const CURVES = {
  log: v => 0.05 * Math.pow(1000, v),
  p2: v => 0.05 + 49.95 * Math.pow(v, 2),
  p25: v => 0.05 + 49.95 * Math.pow(v, 2.5),
};
function sizeDemo(el, curve) {
  const f = CURVES[curve], fmt = mm => (mm < 1 ? mm.toFixed(2) : mm < 10 ? mm.toFixed(1) : Math.round(mm)).toString().replace('.', ',') + ' mm';
  const scale = h('div', 'lab-scale');
  for (let i = 0; i <= 10; i++) { const s = h('span', '', fmt(f(i / 10))); s.style.left = i * 10 + '%'; scale.append(s); }
  const range = h('input'); range.type = 'range'; range.min = 0; range.max = 1000; range.value = 300; range.className = 'lab-range';
  const out = h('div', 'lab-out'), prev = h('div', 'lab-prev');
  const upd = () => { const mm = f(range.value / 1000); out.textContent = fmt(mm); prev.replaceChildren(stroke(BR('stylo'), Math.max(1, Math.min(90, mm * 3)), { w: 320, hgt: 110 })); };
  range.oninput = upd; upd();
  el.append(range, scale, out, prev, h('p', 'lab-cap', 'Aperçu au zoom « page entière » (environ 3 px par mm). Les repères du dessous montrent la taille tous les 10 % de la course.'));
}

// Opacité : 25, 50, 75, 100 %.
function opacityDemo(el, color) {
  const row = h('div', 'lab-row-strokes');
  [0.25, 0.5, 0.75, 1].forEach(a => { const f = h('figure'); f.append(stroke(BR('feutre'), 22, { w: 150, hgt: 80, alpha: a, color }), h('figcaption', '', Math.round(a * 100) + ' %')); row.append(f); });
  el.append(row);
}

// Réglages du pinceau : A = une fenêtre en groupes ; B = onglets Pinceau / Trame (ancienne).
function settingsDemo(el, mode) {
  const pop = h('div', 'lab-pop');
  const head = h('div', 'lab-pop-head', '<b>Trame 25 %</b>');
  pop.append(head);
  const prev = stroke(BR('stylo'), 14, { w: 300, hgt: 60, trame: TR('g25') }); prev.className = 'lab-wide';
  if (mode === 'A') {
    pop.append(prev);
    [['Trait', 'Taille · Opacité · Pression du stylet'], ['Trame', 'Vignette de la trame · Échelle · Fond blanc'], ['Forme et texture', 'Forme · Grain · Dispersion · Espacement'], ['Dynamique', 'Pression → taille · Vitesse · Départ effilé · Stabilisation'], ['Ce pinceau', 'Renommer · Déplacer · Retirer · Enregistrer']]
      .forEach(([t, d]) => pop.append(h('div', 'lab-pgroup', `<div class="lab-clabel">${t}</div><div>${d}</div>`)));
  } else {
    const tabs = h('div', 'lab-tabs', '<button class="on">Pinceau</button><button>Trame</button>');
    const body = h('div', 'lab-pgroup', '<div>Renommer · Taille exacte · Opacité · Pression · Rétablir · Enregistrer · Forme · Pression → taille · Taille à pression nulle · Vitesse · Départ effilé · Stabilisation · Dispersion · Espacement · Grain</div>');
    tabs.querySelectorAll('button').forEach((b, i) => b.onclick = () => { tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); body.innerHTML = i ? '<div>Échelle · Fond blanc · Enregistrer le réglage (la trame se choisit ailleurs)</div>' : '<div>Renommer · Taille exacte · Opacité · Pression · Rétablir · Enregistrer · Forme · Pression → taille · Taille à pression nulle · Vitesse · Départ effilé · Stabilisation · Dispersion · Espacement · Grain</div>'; });
    pop.append(tabs, body);
  }
  el.append(pop);
}

// Couleurs : A = deux couleurs entre les curseurs ; B = pastilles noir / blanc / couleur dans la barre (ancienne).
function colorChoiceDemo(el, mode) {
  const stageEl = h('div', 'lab-canvas-mock');
  if (mode === 'A') {
    let c1 = '#C0392B', c2 = '#F4D03F';
    const col = h('div', 'lab-quick');
    const w = h('div', 'lab-cw');
    const draw = () => { w.innerHTML = `<button class="p" style="background:${c1}" title="Couleur principale"></button><button class="s" style="background:${c2}" title="Toucher : échanger"></button><button class="x" title="Échanger"><i class="ti ti-arrows-exchange"></i></button><button class="r" title="Noir et blanc"><i></i><i></i></button>`;
      w.querySelector('.s').onclick = w.querySelector('.x').onclick = () => { [c1, c2] = [c2, c1]; draw(); };
      w.querySelector('.r').onclick = () => { c1 = '#000000'; c2 = '#FFFFFF'; draw(); }; };
    draw();
    col.append(h('div', 'lab-track'), w, h('div', 'lab-track'));
    stageEl.append(col, h('p', 'lab-cap', 'Taille en haut, opacité en bas, les deux couleurs entre les deux. Essaie la flèche et le mini noir et blanc.'));
  } else {
    stageEl.append(h('div', 'lab-bottom', '<span class="lab-ink" style="background:#000"></span><span class="lab-ink" style="background:#fff"></span><span class="lab-ink on" style="background:#2E86DE"></span>'),
      h('p', 'lab-cap', 'Noir, blanc et une couleur dans la barre du bas : le noir et le blanc avaient un statut à part, et la barre était plus chargée.'));
  }
  el.append(stageEl);
}

// Palette de couleurs : A = sélecteur, nuances, harmonies, palettes nommées ; B = grille du projet seule (ancienne).
const hsv2hex = (H, S, V) => { const f = n => { const k = (n + H / 60) % 6; return V - V * S * Math.max(0, Math.min(k, 4 - k, 1)); }; return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); };
const SAMPLE = ['#000000', '#FFFFFF', '#F2D3B3', '#D9A57A', '#8D5524', '#C0392B', '#E67E22', '#F4D03F', '#27AE60', '#1ABC9C', '#2E86DE', '#1F3A93', '#8E44AD', '#E84393', '#7F8C8D', '#2C3E50'];
function paletteColorsDemo(el, mode) {
  const box = h('div', 'lab-pop');
  if (mode === 'A') {
    let H = 8, S = 0.7, V = 0.76;
    const hue = h('input'); hue.type = 'range'; hue.min = 0; hue.max = 359; hue.value = H; hue.className = 'lab-hue';
    const now = h('div', 'lab-now'), shades = h('div', 'lab-sw'), harm = h('div', 'lab-sw');
    const tabs = h('div', 'lab-pals', '<button class="on">Projet</button><button>Peaux</button><button>Nuit</button><button class="add"><i class="ti ti-plus"></i></button>');
    const grid = h('div', 'lab-sw');
    const sets = [SAMPLE, ['#F2D3B3', '#E8B894', '#D9A57A', '#B07A4F', '#8D5524', '#5C3A1A'], ['#0B1026', '#1F3A93', '#2C3E50', '#5D6D7E', '#AEB6BF', '#F4D03F']];
    const sw = (c, on) => `<span style="background:${c}" class="${on ? 'on' : ''}" title="${c}"></span>`;
    const upd = () => {
      const c = hsv2hex(H, S, V); now.style.background = c; now.textContent = c;
      shades.innerHTML = [-0.6, -0.4, -0.2, 0, 0.25, 0.5, 0.75].map(t => sw(t < 0 ? hsv2hex(H, S, V * (1 + t)) : hsv2hex(H, S * (1 - t), V + (1 - V) * t), t === 0)).join('');
      harm.innerHTML = [-30, 30, 120, 240, 150, 180, 210].map(d => sw(hsv2hex((H + d + 360) % 360, S, V))).join('');
    };
    hue.oninput = () => { H = +hue.value; upd(); };
    tabs.querySelectorAll('button:not(.add)').forEach((b, i) => b.onclick = () => { tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); grid.innerHTML = sets[i].map(c => sw(c)).join(''); });
    grid.innerHTML = SAMPLE.map(c => sw(c)).join('');
    upd();
    box.append(h('div', 'lab-clabel', 'Teinte'), hue, now, h('div', 'lab-clabel', 'Nuances'), shades, h('div', 'lab-clabel', 'Harmonies · voisines · triade · complémentaires'), harm, tabs, grid,
      h('p', 'lab-cap', 'Dans l\'app : carré saturation × luminosité, code hex, récentes, pipette (bouton ou appui long d\'un doigt sur le dessin).'));
  } else {
    box.append(h('div', 'lab-sw', SAMPLE.slice(2).map(c => `<span style="background:${c}"></span>`).join('')), h('p', 'lab-cap', 'Une grille de 15 couleurs, des récentes et « Autre couleur… » (sélecteur du système) : pas de nuances sur le moment, une seule palette par projet.'));
  }
  el.append(box);
}

// Planche et case : A = deux niveaux ; B = tout sur la page (ancienne).
function levelsDemo(el, mode) {
  const row = h('div', 'lab-levels');
  const page = (title, tools, dock, caseOpen) => {
    const card = h('div', 'lab-level');
    card.append(h('div', 'lab-clabel', title));
    const body = h('div', 'lab-level-body');
    const tb = h('div', 'lab-tools', tools.map(i => `<i class="ti ti-${i}"></i>`).join(''));
    const pg = h('div', 'lab-page' + (caseOpen ? ' open' : ''), caseOpen ? '<div class="c big"></div>' : '<div class="c on"></div><div class="c"></div><div class="c"></div><div class="c"></div>');
    body.append(tb, pg, h('div', 'lab-dock', dock));
    card.append(body);
    return card;
  };
  if (mode === 'A') {
    row.append(page('Planche : cases et pages', ['layout-board-split', 'hand-stop', 'pencil'], 'Page<br><small>pages, notes, cadre, copie</small>', false),
      page('Case ouverte : dessin', ['brush', 'eraser', 'bucket-droplet', 'square', 'mask', 'marquee-2', 'message-circle', 'hand-stop'], 'Calques<br><small>bulles, calques, masque</small>', true));
    el.append(row, h('p', 'lab-cap', 'Double toucher sur une case pour l\'ouvrir ; « Page », Échap ou Entrée pour revenir.'));
  } else {
    row.append(page('Tout sur la page', ['pencil', 'texture', 'eraser', 'bucket-droplet', 'square', 'mask', 'marquee-2', 'message-circle', 'layout-board-split', 'hand-stop'], 'Calques · Page<br><small>deux onglets</small>', false));
    el.append(row, h('p', 'lab-cap', 'On dessinait directement sur la planche ; la taille des cases et le dessin se mêlaient.'));
  }
}

export const GROUPS = [
  { id: 'dessin', label: 'Dessin', icon: 'brush', subjects: [
    { id: 'palette', label: 'Palette de pinceaux', icon: 'brush', variants: [
      { title: 'Palette du projet', actuelle: true, retenue: true, say: 'Les pinceaux du projet sont dans la barre du bas, en un toucher ; ils suivent le projet sur tous les appareils (jusqu\'à 10, pinceaux et pinceaux tramés réunis).', render: el => paletteDemo(el, 'A') },
      { title: 'Un bouton et sa liste', ancienne: true, say: 'Un seul bouton de pinceau ouvrait toute la bibliothèque ; les pinceaux enregistrés restaient sur l\'appareil.', render: el => paletteDemo(el, 'B') },
    ] },
    { id: 'taille', label: 'Curseur de taille', icon: 'adjustments-vertical', variants: [
      { title: 'Courbe 2,5', actuelle: true, retenue: true, say: 'Courbe en puissance (exposant 2,5) : 0,05–1 mm sur un cinquième de la course, les grandes tailles se règlent au millimètre.', render: el => sizeDemo(el, 'p25') },
      { title: 'Logarithmique', ancienne: true, say: 'Chaque tiers de la course multipliait la taille par dix : trop de place pour les petites tailles, des sauts de 2 mm en haut.', render: el => sizeDemo(el, 'log') },
      { title: 'Courbe 2', say: 'Plus de place pour les grandes tailles, un peu moins de finesse sous 1 mm.', render: el => sizeDemo(el, 'p2') },
    ] },
    { id: 'opacite', label: 'Opacité du trait', icon: 'contrast', variants: [
      { title: 'Noir et blanc : gris tramé', actuelle: true, say: 'En noir ou blanc, l\'opacité est un gris tramé (grille de Bayer accrochée à la page), comme à l\'impression 1 bit.', render: el => opacityDemo(el, '#000000') },
      { title: 'Couleur : vraie transparence', actuelle: true, say: 'Avec une couleur, le calque passe en couleur et l\'opacité est une vraie transparence ; un trait ne fonce pas là où il repasse.', render: el => opacityDemo(el, '#2E86DE') },
    ] },
    { id: 'reglages', label: 'Réglages du pinceau', icon: 'adjustments-horizontal', variants: [
      { title: 'Une fenêtre en groupes', actuelle: true, retenue: true, say: 'Aperçu en direct puis Trait, Trame, Forme et texture, Dynamique, Ce pinceau, sans onglets.', render: el => settingsDemo(el, 'A') },
      { title: 'Onglets Pinceau / Trame', ancienne: true, say: 'Deux onglets, et deux icônes « Réglages » identiques dans la barre pour le pinceau trame.', render: el => settingsDemo(el, 'B') },
    ] },
  ] },
  { id: 'couleur', label: 'Couleur', icon: 'palette', subjects: [
    { id: 'choix', label: 'Choix des couleurs', icon: 'color-swatch', variants: [
      { title: 'Deux couleurs à gauche', actuelle: true, retenue: true, say: 'Entre les curseurs de taille et d\'opacité : principale et secondaire, flèche pour échanger (X), mini noir et blanc (D).', render: el => colorChoiceDemo(el, 'A') },
      { title: 'Pastilles dans la barre', ancienne: true, say: 'Noir, blanc et une couleur dans la barre du bas.', render: el => colorChoiceDemo(el, 'B') },
    ] },
    { id: 'nuancier', label: 'Palette de couleurs', icon: 'palette', variants: [
      { title: 'Sélecteur, nuances et palettes', actuelle: true, retenue: true, say: 'Nuances sur le moment, harmonies, plusieurs palettes nommées par projet (Projet, Peaux, Nuit…). Fais glisser la teinte.', render: el => paletteColorsDemo(el, 'A') },
      { title: 'Grille seule', ancienne: true, say: 'Une grille de couleurs et le sélecteur du système.', render: el => paletteColorsDemo(el, 'B') },
    ] },
  ] },
  { id: 'planche', label: 'Planche', icon: 'layout-board', subjects: [
    { id: 'niveaux', label: 'Planche et case', icon: 'layout-board-split', variants: [
      { title: 'Deux niveaux', actuelle: true, retenue: true, say: 'La planche gère les cases et les pages sans rien dessiner ; la case ouverte est le seul canevas, avec ses calques et ses bulles.', render: el => levelsDemo(el, 'A') },
      { title: 'Tout sur la page', ancienne: true, say: 'Dessin et mise en page sur le même écran, deux onglets Calques et Page.', render: el => levelsDemo(el, 'B') },
    ] },
  ] },
  { id: 'trames', label: 'Trames', icon: 'texture', subjects: [
    { id: 'biblio', label: 'Bibliothèque', icon: 'texture', variants: [
      { title: 'Grille de tuiles', actuelle: true, say: 'Les trames en grille de quatre colonnes dans le volet, sans nom : on choisit à l\'œil.',
        render(el) { const g = document.createElement('div'); g.className = 'tgal'; BUILTIN_TRAMAS.slice(0, 16).forEach(t => g.append(fig(t, 2, 64, 64, ''))); el.append(g); } },
      { title: 'Liste avec noms', say: 'Un échantillon large par ligne, avec son nom : plus lisible, mais moins de trames à l\'écran.',
        render(el) { const g = document.createElement('div'); g.className = 'tlist'; BUILTIN_TRAMAS.slice(0, 8).forEach(t => g.append(fig(t, 2, 160, 56, t.name))); el.append(g); } },
      { title: 'Bande de gris', say: 'Une bande horizontale de gris du plus clair au plus foncé, à porter de pouce sous l\'outil.',
        render(el) { const g = document.createElement('div'); g.className = 'tstrip'; grises().forEach(t => g.append(fig(t, 3, 72, 72, t.name))); el.append(g); } },
    ] },
  ] },
  { id: 'bulles', label: 'Bulles', icon: 'message-circle', subjects: [
    { id: 'types', label: 'Types de bulles', icon: 'message-circle', variants: [
      { title: 'Trait fin', actuelle: true, say: 'Contour de 0,35 mm, texte de 9 pt : le trait classique de la BD franco-belge.', render: el => bubbleDemo(el, { lw: 1, pt: 9, tail: true }) },
      { title: 'Trait épais', say: 'Contour plus marqué, texte un peu plus gros : plus lisible à l\'écran, plus lourd sur la page.', render: el => bubbleDemo(el, { lw: 1.7, pt: 10, tail: true }) },
      { title: 'Sans queue', say: 'Bulles sans queue pour une lecture plus aérée quand le locuteur est évident.', render: el => bubbleDemo(el, { lw: 1, pt: 9, tail: false }) },
    ] },
    { id: 'ergonomie', label: 'Outil Bulle', icon: 'hand-click', variants: [
      { title: 'Barre et fenêtres', ancienne: true, say: 'Le fonctionnement actuel : une barre, puis une fenêtre par famille de réglages (Texte, Forme, Queue). Retirer la queue = Queue → Style → Aucune.', render: el => bubbleLab(el, 'A') },
      { title: 'Barre flottante sur la bulle', actuelle: true, retenue: true, say: 'Les gestes courants sont sur la bulle elle-même : écrire, changer de forme (une touche), queue marche / arrêt, copie, corbeille. Le reste est derrière « Réglages ».', render: el => bubbleLab(el, 'B') },
      { title: 'Queue tirée du bord', say: 'Plus de réglage pour la queue : on la sort du bord de la bulle en tirant, on la retire en ramenant sa pointe dedans. Double toucher pour écrire.', render: el => bubbleLab(el, 'C') },
      { title: 'Panneau à vignettes', say: 'Un seul panneau : on choisit forme et queue sur des vignettes plutôt que dans des listes ; les curseurs sont repliés.', render: el => bubbleLab(el, 'D') },
      { title: 'Tracer pour créer', say: 'On trace dans la case la taille de la bulle : elle est créée du type choisi, avec une queue, et la saisie du texte s\'ouvre aussitôt.', render: el => bubbleLab(el, 'E') },
    ] },
    { id: 'polices', label: 'Polices', icon: 'typography', variants: [
      { title: 'Comic Neue', actuelle: true, say: 'La police par défaut : lisible, proche du lettrage de BD, avec des capitales rondes.', render: el => bubbleDemo(el, { lw: 1, pt: 9, tail: true, extra: { font: 'comicneue' } }) },
      { title: 'Patrick Hand SC', say: 'Capitales à la main, plus naturelles et moins régulières : l\'esprit du lettrage des albums classiques.', render: el => bubbleDemo(el, { lw: 1, pt: 10, tail: true, extra: { font: 'patrickhandsc' } }) },
      { title: 'Bangers', say: 'Une police d\'action pour les cris et les onomatopées ; trop dense pour de longs dialogues.', render: el => bubbleDemo(el, { lw: 1, pt: 10, tail: true, extra: { font: 'bangers' } }) },
      { title: 'Caveat', say: 'Une écriture manuscrite penchée, pour les pensées et les carnets.', render: el => bubbleDemo(el, { lw: 1, pt: 11, tail: true, extra: { font: 'caveat' } }) },
    ] },
  ] },
];

// ───────────────────────── Écran ─────────────────────────

const $ = s => document.querySelector(s);
const LET = 'ABCDEFGH';
let gi = 0, si = 0, vi = 0;

function parseHash() {
  const m = location.hash.slice(1).match(/^([\w-]+?)-([A-H])$/);
  if (!m) return;
  GROUPS.forEach((g, a) => g.subjects.forEach((s, b) => { if (s.id === m[1]) { gi = a; si = b; vi = Math.min(LET.indexOf(m[2]), s.variants.length - 1); } }));
}
const hashOf = () => `#${GROUPS[gi].subjects[si].id}-${LET[vi]}`;

function go(g, s, v, push = true) {
  gi = g; si = s; vi = v;
  if (push) history.replaceState(null, '', hashOf());
  draw();
}

function draw() {
  const g = GROUPS[gi], s = g.subjects[si], v = s.variants[vi];
  $('#tabs').innerHTML = GROUPS.map((x, i) => `<a href="#${x.subjects[0].id}-A" data-g="${i}" class="${i === gi ? 'on' : ''}"><i class="ti ti-${x.icon}" aria-hidden="true"></i> ${esc(x.label)}</a>`).join('');
  $('#side').innerHTML = g.subjects.map((x, i) => `<div class="subj ${i === si ? 'open' : ''}"><a href="#${x.id}-A" data-s="${i}"><i class="ti ti-${x.icon}" aria-hidden="true"></i>${esc(x.label)}<span class="n">${x.variants.length}</span></a>
    ${i === si ? `<div class="vars">${x.variants.map((y, j) => `<a href="#${x.id}-${LET[j]}" data-v="${j}" class="${j === vi ? 'on' : ''}"><span class="l ${y.retenue ? 'keep' : ''}">${LET[j]}</span>${esc(y.title)}</a>`).join('')}</div>` : ''}</div>`).join('');
  $('#chips').innerHTML = g.subjects.map((x, i) => `<a href="#${x.id}-A" data-s="${i}" class="${i === si ? 'on' : ''}"><i class="ti ti-${x.icon}" aria-hidden="true"></i>${esc(x.label)} · ${x.variants.length}</a>`).join('');
  $('#bar').innerHTML = `<button class="icon-btn icon-only" data-step="-1" aria-label="Variante précédente"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
    <div class="letters">${s.variants.map((y, j) => `<a href="#${s.id}-${LET[j]}" data-v="${j}" class="${j === vi ? 'on' : ''}">${LET[j]}</a>`).join('')}</div>
    <button class="icon-btn icon-only" data-step="1" aria-label="Variante suivante"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
    <span class="ttl">${esc(v.title)}</span>`;
  const stage = $('#stage');
  stage.innerHTML = `<article class="variant"><h2><span>${LET[vi]} · ${esc(v.title)}</span>${v.actuelle ? '<span class="tag cur">actuelle</span>' : ''}${v.retenue ? '<span class="tag cur">retenue</span>' : ''}${v.ancienne ? '<span class="tag">ancienne</span>' : ''}</h2><p class="say">${esc(v.say)}</p><div class="demo" id="demo"></div></article>`;
  v.render($('#demo'));
  document.title = `Labo — Fusain`;
}

function step(d) { const n = GROUPS[gi].subjects[si].variants.length; go(gi, si, (vi + d + n) % n); }

document.addEventListener('click', e => {
  const a = e.target.closest('a[data-g], a[data-s], a[data-v], button[data-step]');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.step) step(+a.dataset.step);
  else if (a.dataset.g !== undefined) go(+a.dataset.g, 0, 0);
  else if (a.dataset.s !== undefined) go(gi, +a.dataset.s, 0);
  else go(gi, si, +a.dataset.v);
});
window.addEventListener('keydown', e => { if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1); });
let x0 = null;
$('#stage').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
$('#stage').addEventListener('touchend', e => { if (x0 !== null && Math.abs(e.changedTouches[0].clientX - x0) > 70) step(e.changedTouches[0].clientX < x0 ? 1 : -1); x0 = null; }, { passive: true });
window.addEventListener('hashchange', () => { parseHash(); draw(); });

parseHash();
draw();

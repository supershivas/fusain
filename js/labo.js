// Labo : on compare des variantes avant d'en adopter une. Données d'exemple en dur : rien n'est lu ni écrit
// dans Supabase, IndexedDB ou localStorage. Ajouter un sujet ou une variante = ajouter une entrée à GROUPS.
import { BUILTIN_TRAMAS, drawTramaSwatch } from './tramas.js';
import { drawBubble, lineWidth } from './bubbles.js';

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

export const GROUPS = [
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
      { title: 'Barre et fenêtres', actuelle: true, say: 'Le fonctionnement actuel : une barre, puis une fenêtre par famille de réglages (Texte, Forme, Queue). Retirer la queue = Queue → Style → Aucune.', render: el => bubbleLab(el, 'A') },
      { title: 'Barre flottante sur la bulle', say: 'Les gestes courants sont sur la bulle elle-même : écrire, changer de forme (une touche), queue marche / arrêt, copie, corbeille. Le reste est derrière « Réglages ».', render: el => bubbleLab(el, 'B') },
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
  stage.innerHTML = `<article class="variant"><h2><span>${LET[vi]} · ${esc(v.title)}</span>${v.actuelle ? '<span class="tag cur">actuelle</span>' : ''}${v.retenue ? '<span class="tag cur">retenue</span>' : ''}</h2><p class="say">${esc(v.say)}</p><div class="demo" id="demo"></div></article>`;
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

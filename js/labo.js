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

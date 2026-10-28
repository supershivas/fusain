// Briques d'interface communes : échappement, icônes, fenêtres modales (rattachées au body).
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = name => `<i class="ti ti-${name}" aria-hidden="true"></i>`;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const stack = [];

// opts : { title, body (HTML), actions: [{ label, kind, onClick(close, el), keepOpen }], narrow, onClose }
export function openModal(opts) {
  const host = document.getElementById('modals');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box${opts.narrow ? ' narrow' : ''}${opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
    <div class="modal-head"><h2>${esc(opts.title)}</h2><button type="button" class="icon-btn icon-only" data-close aria-label="Fermer">${icon('x')}</button></div>
    <div class="modal-body">${opts.body || ''}</div>
    ${opts.actions && opts.actions.length ? '<div class="modal-actions"></div>' : ''}
  </div>`;
  const box = $('.modal-box', overlay);
  const api = { el: box, close };
  function close() {
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    overlay.remove();
    if (opts.onClose) opts.onClose();
  }
  const actions = $('.modal-actions', overlay);
  (opts.actions || []).forEach(a => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ' + (a.kind || 'secondary'); b.textContent = a.label;
    b.addEventListener('click', async () => {
      const keep = a.onClick ? await a.onClick(close, box) : false;
      if (!a.keepOpen && keep !== false) close();
    });
    actions.appendChild(b);
  });
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) overlay._down = true; });
  overlay.addEventListener('click', e => { if (e.target === overlay && overlay._down) close(); overlay._down = false; });
  $('[data-close]', overlay).addEventListener('click', close);
  host.appendChild(overlay);
  stack.push(api);
  const first = $('input:not([type=hidden]), textarea, select', box);
  if (first && !opts.noFocus) setTimeout(() => first.focus(), 30);
  return api;
}

export const closeAllModals = () => { [...stack].forEach(m => m.close()); };
export const modalOpen = () => stack.length > 0;

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close();
});

export function confirmModal({ title, message, confirm = 'Confirmer', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    openModal({
      title, narrow: true, body: `<p>${esc(message)}</p>`,
      actions: [
        { label: 'Annuler', onClick: () => { done = true; resolve(false); } },
        { label: confirm, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function promptModal({ title, label, value = '', confirm = 'Enregistrer' }) {
  return new Promise(resolve => {
    let done = false;
    const m = openModal({
      title, narrow: true,
      body: `<label class="field"><span>${esc(label)}</span><input type="text" value="${esc(value)}" maxlength="120"></label>`,
      actions: [
        { label: 'Annuler', onClick: () => { done = true; resolve(null); } },
        { label: confirm, kind: 'primary', onClick: (c, box) => { done = true; resolve($('input', box).value.trim()); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    $('input', m.el).addEventListener('keydown', e => { if (e.key === 'Enter') { done = true; resolve($('input', m.el).value.trim()); m.close(); } });
    setTimeout(() => $('input', m.el).select(), 40);
  });
}

export const formatDate = ms => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

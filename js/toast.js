// Notifications non bloquantes (même aspect dans toutes les apps : voir les tokens).
// opts : { actionLabel, onAction, duration, type: 'info' | 'error' }
export function toast(msg, opts = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (opts.type === 'error' ? ' toast-error' : '');
  el.setAttribute('role', 'status');
  const txt = document.createElement('span'); txt.textContent = msg; el.appendChild(txt);
  let timer = null;
  const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  if (opts.actionLabel && opts.onAction) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-action'; b.textContent = opts.actionLabel;
    b.addEventListener('click', () => { close(); opts.onAction(); });
    el.appendChild(b);
  }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'toast-x'; x.setAttribute('aria-label', 'Fermer');
  x.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>'; x.addEventListener('click', close);
  el.appendChild(x);
  host.appendChild(el);
  timer = setTimeout(close, opts.duration || 4000);
  return close;
}

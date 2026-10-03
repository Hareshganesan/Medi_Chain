// UI helpers. Every piece of server data goes through esc() before reaching innerHTML (XSS defence).
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function initials(name = '') {
  return name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return `in ${Math.ceil(-s / 60)} min`;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function toast(html, kind = 'info', ms = 5000) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${html}</div>`; // callers pass pre-escaped HTML
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Promise-based modal. `actions` = [{ label, kind, value }]; resolves with the clicked value or null. */
export function modal({ title, body, actions = [{ label: 'Close', value: null }], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="x-btn" aria-label="Close">×</button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind ?? ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>
      </div>`;
    const close = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && close(null);
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', async (e) => {
      if (e.target === back || e.target.closest('.x-btn')) return close(null);
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      const a = actions[Number(btn.dataset.i)];
      if (a.handler) {
        btn.disabled = true;
        const result = await a.handler(back).catch(() => false);
        btn.disabled = false;
        if (result === false) return; // keep open (e.g. validation failed)
        return close(result);
      }
      close(a.value);
    });
    document.body.append(back);
    onOpen?.(back);
    back.querySelector('input, select, textarea, .btn.primary')?.focus();
  });
}

/** Show server-side validation errors next to the matching fields (name="path"). */
export function showFieldErrors(root, details = []) {
  $$('.error', root).forEach((e) => (e.textContent = ''));
  $$('.invalid', root).forEach((e) => e.classList.remove('invalid'));
  let unmatched = [];
  for (const d of details) {
    const input = root.querySelector(`[name="${CSS.escape(d.path)}"]`);
    if (input) {
      input.classList.add('invalid');
      const err = input.closest('.field')?.querySelector('.error');
      if (err) err.textContent = d.message;
    } else unmatched.push(d.message);
  }
  return unmatched;
}

export function sparkline(values, { width = 160, height = 34, color = 'currentColor', fill = true } = {}) {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`);
  const area = fill ? `<path d="M0,${height} L${pts.join(' L')} L${width},${height} Z" fill="${color}" opacity="0.12"/>` : '';
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${area}<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

export function userCard(user) {
  return `<div class="avatar">${esc(initials(user.name))}</div>
    <div style="min-width:0"><div class="name">${esc(user.name)}</div><div class="role">${esc(user.title ?? user.role)}</div></div>`;
}

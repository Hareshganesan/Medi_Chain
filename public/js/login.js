import { api, session, HOME } from './api.js';
import { $, $$, esc } from './ui.js';
import { hydrateIcons } from './icons.js';

hydrateIcons();

const existing = session.get();
if (existing?.token && HOME[existing.user.role]) location.replace(HOME[existing.user.role]);

const form = $('#login-form');
const errorBox = $('#login-error');

const showError = (msg) => {
  errorBox.innerHTML = msg;
  errorBox.classList.remove('hidden');
};

$$('.demo').forEach((b) =>
  b.addEventListener('click', () => {
    $('#username').value = b.dataset.u;
    $('#password').value = b.dataset.p;
    $('#login-btn').focus();
  }),
);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.add('hidden');
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!username || !password) return showError('Enter your username and password.');
  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (r.ok) {
      session.set({ token: r.data.token, user: r.data.user });
      location.replace(HOME[r.data.user.role] ?? '/');
      return;
    }
    const d = r.data?.details?.[0] ?? {};
    if (r.status === 423) showError(`<b>Account locked.</b> Too many failed attempts — try again in ${esc(d.retryAfterSec)} s.`);
    else if (r.status === 429) showError('<b>Too many requests.</b> Please slow down and try again shortly.');
    else if (r.status === 401) showError(`Invalid username or password.${d.attemptsLeft !== undefined ? ` ${esc(d.attemptsLeft)} attempt(s) left before lockout.` : ''}`);
    else showError('Sign-in service is temporarily unavailable.');
  } catch {
    showError('Cannot reach the server.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in securely';
  }
});

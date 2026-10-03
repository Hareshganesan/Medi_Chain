import { api, requireSession, logout, stream } from './api.js';
import { $, esc, toast, initials, timeAgo, fmtDate, userCard, modal } from './ui.js';
import { timelineHtml, tabsHtml, inspectorHtml } from './records.js';
import { icon, hydrateIcons } from './icons.js';

hydrateIcons();

const { user } = requireSession('patient');
const me = await api('/api/auth/me');
const patientId = me.data.user.patientId;
$('#user-card').innerHTML = userCard({ ...user, title: `Patient · ${patientId}` });
$('#logout').onclick = logout;
$('#greeting').textContent = `Hello, ${user.name.split(' ')[0]}`;

let records = [];
let filter = 'all';
let doctors = [];

const EVENT_TEXT = {
  RECORD_READ: (e) => `viewed your record${e.reason === 'BREAK_GLASS_ACTIVE' ? ' under <b>emergency access</b>' : ''}`,
  RECORD_CREATED: (e) => `added a ${esc(e.details?.recordType ?? 'record')}: “${esc(e.details?.title ?? '')}”`,
  BREAK_GLASS: (e) => `used <b>EMERGENCY break-glass</b> access — “${esc(e.reason)}”`,
  ACCESS_DENIED: () => 'tried to open your record and was <b>denied</b>',
  CONSENT_GRANTED: (e) => `granted access to ${esc(e.details?.doctorName ?? e.details?.doctorId)}`,
  CONSENT_REVOKED: (e) => `revoked access for ${esc(e.details?.doctorId)}`,
  PATIENT_REGISTERED: () => 'registered you on MediChain',
  AUTH_LOGIN_SUCCESS: () => 'signed in to the patient portal',
};
const ICON = { RECORD_READ: 'eye', RECORD_CREATED: 'file', BREAK_GLASS: 'siren', ACCESS_DENIED: 'ban', CONSENT_GRANTED: 'check', CONSENT_REVOKED: 'x', PATIENT_REGISTERED: 'user-plus', AUTH_LOGIN_SUCCESS: 'key' };

async function loadRecord() {
  const r = await api(`/api/patients/${encodeURIComponent(patientId)}`);
  if (!r.ok) return ($('#summary').innerHTML = `<div class="muted">Could not load your record (${esc(r.status)})</div>`);
  const { patient: p, meta } = r.data;
  records = r.data.records;
  const lastVitals = records.find((x) => x.type === 'vitals');
  $('#summary').innerHTML = `
    <div class="avatar">${esc(initials(p.name))}</div>
    <div style="flex:1">
      <div class="row wrap"><h2>${esc(p.name)}</h2><span class="badge mono">${esc(p.id)}</span><span class="badge ok">${icon('lock', 11)} Encrypted at rest</span></div>
      <div class="facts"><span><b>${esc(p.age)}</b> years</span><span><b>${esc(p.gender)}</b></span><span>Blood <b>${esc(p.bloodGroup)}</b></span>
        <span>${icon('phone', 13)} <b>${esc(p.phone)}</b></span><span>ABHA <b class="mono">${esc(p.abhaId ?? '—')}</b></span></div>
      <div class="chips">${p.allergies?.length ? p.allergies.map((a) => `<span class="badge danger">${icon('alert', 11)} ${esc(a)}</span>`).join('') : '<span class="badge ok">No known allergies</span>'}
        ${lastVitals ? `<span class="badge">Last BP ${esc(lastVitals.systolic)}/${esc(lastVitals.diastolic)}</span><span class="badge">HR ${esc(lastVitals.heartRate)}</span>` : ''}</div>
    </div>`;
  $('#inspector').innerHTML = inspectorHtml(meta);
  renderTimeline();
}

function renderTimeline() {
  $('#tabs').innerHTML = tabsHtml(records, filter);
  $('#timeline').innerHTML = timelineHtml(records, filter);
}
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-filter]');
  if (t) {
    filter = t.dataset.filter;
    renderTimeline();
  }
});

async function loadConsents() {
  const [c, d] = await Promise.all([api(`/api/patients/${encodeURIComponent(patientId)}/consents`), api('/api/doctors')]);
  doctors = d.data?.doctors ?? [];
  const list = c.data?.consents ?? [];
  const label = { treating: ['primary', 'Treating physician'], consent: ['info', 'Granted by you'], breakglass: ['danger', 'Emergency access'] };
  $('#consent-list').innerHTML = list.length
    ? `<table class="table"><tbody>${list
        .map((g) => {
          const doc = doctors.find((x) => x.id === g.doctorId);
          const [kind, text] = label[g.type] ?? ['', g.type];
          return `<tr><td><b>${esc(doc?.name ?? g.doctorName ?? g.doctorId)}</b><div class="muted" style="font-size:12px">${esc(doc?.title ?? '')}</div>
            ${g.type === 'breakglass' ? `<div style="font-size:12px;color:var(--danger)">Reason: ${esc(g.reason)} · ${g.active ? 'expires ' + esc(timeAgo(g.expiresAt)) : 'expired'}</div>` : ''}</td>
            <td><span class="badge ${kind}">${text}</span>${g.active ? '' : ' <span class="badge">expired</span>'}</td>
            <td style="text-align:right"><button class="btn sm" data-revoke="${esc(g.doctorId)}">Revoke</button></td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<div class="empty">No clinician currently has access.</div>';
  const granted = new Set(list.filter((g) => g.active).map((g) => g.doctorId));
  const options = doctors.filter((x) => !granted.has(x.id));
  $('#grant-doctor').innerHTML = options.length ? options.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} — ${esc(x.title)}</option>`).join('') : '<option value="">All doctors already have access</option>';
  $('#grant-btn').disabled = !options.length;
}

$('#consent-list').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-revoke]')?.dataset.revoke;
  if (!id) return;
  const doc = doctors.find((x) => x.id === id);
  const yes = await modal({
    title: 'Revoke access?',
    body: `<p>${esc(doc?.name ?? id)} will immediately lose access to your records. The change is replicated across the cluster before this dialog closes.</p>`,
    actions: [{ label: 'Cancel', value: false }, { label: 'Revoke access', kind: 'danger', value: true }],
  });
  if (!yes) return;
  const r = await api(`/api/patients/${encodeURIComponent(patientId)}/consents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r.ok) toast(`<b>Access revoked</b> for ${esc(doc?.name ?? id)}`, 'ok');
  refresh();
});

$('#grant-btn').onclick = async () => {
  const doctorId = $('#grant-doctor').value;
  if (!doctorId) return;
  const r = await api(`/api/patients/${encodeURIComponent(patientId)}/consents`, { method: 'POST', body: { doctorId } });
  if (r.ok) toast(`<b>Access granted</b> to ${esc(doctors.find((x) => x.id === doctorId)?.name)}`, 'ok');
  refresh();
};

async function loadHistory() {
  const r = await api(`/api/patients/${encodeURIComponent(patientId)}/access-log`);
  if (!r.ok) return ($('#history-list').innerHTML = '<div class="empty">Audit service unavailable — events are buffered and will appear shortly.</div>');
  const { entries, ledger } = r.data;
  $('#ledger-badge').innerHTML = ledger?.valid
    ? `<span class="badge ok" title="SHA-256 hash chain verified">${icon('link', 11)} Ledger verified · ${esc(ledger.length)} blocks</span>`
    : `<span class="badge danger">${icon('alert', 11)} Ledger integrity broken at #${esc(ledger?.brokenAt)}</span>`;
  $('#history-list').innerHTML = entries.length
    ? entries
        .map(
          (e) => `<div class="feed-item" style="grid-template-columns:28px 1fr;align-items:start">
          <div class="fi">${icon(ICON[e.type] ?? 'activity', 14)}</div>
          <div><div><b>${e.actor?.id === user.sub ? 'You' : esc(e.actor?.name)}</b> ${(EVENT_TEXT[e.type] ?? (() => esc(e.type)))(e)}</div>
          <div class="muted" style="font-size:11.5px">${fmtDate(e.ts)} · block #${esc(e.index)} · <span class="mono">${esc(e.hash.slice(0, 12))}…</span></div></div></div>`,
        )
        .join('')
    : '<div class="empty">No access recorded yet.</div>';
}

function alertBanner(e) {
  const box = document.createElement('div');
  box.className = 'banner danger';
  box.style.margin = '0 0 16px';
  box.innerHTML = `${icon('siren', 16)} <div><b>${esc(e.actor?.name)}</b> used emergency break-glass access to your record — “${esc(e.reason)}”. <span class="muted">${esc(timeAgo(e.ts))}</span></div>`;
  $('#alerts').prepend(box);
}

function refresh() {
  return Promise.all([loadRecord(), loadConsents(), loadHistory()]);
}

stream(
  (e) => {
    if (e.type === 'BREAK_GLASS') {
      alertBanner(e);
      if (!e.replay) toast(`<b>${esc(e.actor?.name)}</b> accessed your record in an emergency`, 'danger', 9000);
    } else if (!e.replay && e.type === 'RECORD_READ') toast(`<b>${esc(e.actor?.name)}</b> just viewed your record`, 'info');
    else if (!e.replay && e.type === 'ACCESS_DENIED') toast(`<b>${esc(e.actor?.name)}</b> was denied access to your record`, 'warn');
    else if (!e.replay && e.type === 'RECORD_CREATED') toast(`<b>${esc(e.actor?.name)}</b> added “${esc(e.details?.title)}”`, 'ok');
    if (!e.replay) setTimeout(refresh, 300);
  },
  (on) => $('#live').classList.toggle('off', !on),
);

refresh();

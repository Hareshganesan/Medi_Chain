import { api, requireSession, logout, stream } from './api.js';
import { $, $$, esc, toast, modal, showFieldErrors, initials, timeAgo, userCard } from './ui.js';
import { timelineHtml, tabsHtml, inspectorHtml } from './records.js';
import { icon, hydrateIcons } from './icons.js';

hydrateIcons();

const { user } = requireSession('doctor');
$('#user-card').innerHTML = userCard(user);
$('#logout').onclick = logout;

let directory = [];
let current = null; // { id, data }
let filter = 'all';

const ACCESS_BADGE = {
  treating: '<span class="badge primary">Treating</span>',
  consent: '<span class="badge info">Consent</span>',
  breakglass: '<span class="badge danger">Emergency</span>',
};

// ─────────────────────────── directory (scatter-gather across shards) ───────────────────────────
async function loadDirectory() {
  const q = $('#search').value.trim();
  const r = await api(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (!r.ok) return toast('Could not load the patient directory', 'danger');
  directory = r.data.patients;
  $('#dir-meta').textContent = `${directory.length} patients · ${r.data.shardsQueried} shards queried in parallel · ${r.data.tookMs} ms`;
  const deg = $('#degraded');
  deg.classList.toggle('hidden', !r.data.degraded.length);
  deg.innerHTML = r.data.degraded.length ? `Partial results — ${r.data.degraded.map(esc).join(', ')} unreachable. Showing data from healthy shards.` : '';
  renderList();
}

function renderList() {
  const box = $('#plist');
  if (!directory.length) return (box.innerHTML = '<div class="empty">No patients match.</div>');
  box.innerHTML = directory
    .map(
      (p) => `<div class="pitem ${current?.id === p.id ? 'active' : ''} ${p.access ? '' : 'lock'}" data-id="${esc(p.id)}" tabindex="0" role="button">
        <div class="avatar" style="width:38px;height:38px">${esc(initials(p.name))}</div>
        <div style="min-width:0;flex:1">
          <div class="pname">${esc(p.name)}</div>
          <div class="meta">${esc(p.age)} y · ${esc(p.gender)} · ${esc(p.bloodGroup)} · <span title="Home shard (consistent hashing)">${esc(p.shardId)}</span></div>
        </div>
        ${p.access ? ACCESS_BADGE[p.access] : `<span class="badge">${icon('lock', 11)} No access</span>`}
      </div>`,
    )
    .join('');
}

$('#plist').addEventListener('click', (e) => {
  const item = e.target.closest('.pitem');
  if (item) openPatient(item.dataset.id);
});
$('#plist').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('pitem')) openPatient(e.target.dataset.id);
});
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadDirectory, 250);
});

// ─────────────────────────── patient detail ───────────────────────────
async function openPatient(id) {
  current = { id, data: null };
  filter = 'all';
  renderList();
  $('#detail').innerHTML = '<div class="empty" style="padding:80px">Fetching from shard…</div>';
  const r = await api(`/api/patients/${encodeURIComponent(id)}`);
  if (current?.id !== id) return;
  if (r.status === 403) return renderLocked(id, r.data?.details?.[0]?.reason);
  if (!r.ok) return ($('#detail').innerHTML = `<div class="empty">Could not load record (${esc(r.data?.message ?? r.status)})</div>`);
  current.data = r.data;
  renderPatient();
}

function renderLocked(id, reason) {
  const p = directory.find((x) => x.id === id) ?? { name: id };
  $('#detail').innerHTML = `<div class="locked">
    <div class="big">${icon('lock', 26)}</div>
    <h3>No consent to view ${esc(p.name)}'s record</h3>
    <p class="muted" style="max-width:460px;margin:0 auto 18px">Access is granted by the patient (or by being the treating physician).
      This attempt was denied and written to the audit ledger <span class="mono">(${esc(reason ?? 'NO_ACTIVE_CONSENT')})</span>.</p>
    <button class="btn danger" id="break-glass">${icon('siren', 15)} Emergency break-glass access</button>
    <p class="muted" style="font-size:12px;margin-top:10px">Grants 30 minutes of access. The patient is notified immediately and the reason is permanently audited.</p>
  </div>`;
  $('#break-glass').onclick = () => breakGlass(id, p.name);
}

function renderPatient() {
  const { patient: p, records, access, meta } = current.data;
  const bg = access.type === 'breakglass';
  $('#detail').innerHTML = `
    <div class="phead">
      <div class="avatar">${esc(initials(p.name))}</div>
      <div style="flex:1;min-width:0">
        <div class="row wrap"><h2>${esc(p.name)}</h2>${ACCESS_BADGE[access.type] ?? ''}<span class="badge mono">${esc(p.id)}</span></div>
        <div class="facts">
          <span><b>${esc(p.age)}</b> years</span><span><b>${esc(p.gender)}</b></span><span>Blood <b>${esc(p.bloodGroup)}</b></span>
          <span>${icon('phone', 13)} <b>${esc(p.phone ?? '—')}</b></span><span>ABHA <b class="mono">${esc(p.abhaId ?? '—')}</b></span>
          <span>Registered by <b>${esc(p.createdBy?.name)}</b></span>
        </div>
        <div class="chips">${
          p.allergies?.length ? p.allergies.map((a) => `<span class="badge danger">${icon('alert', 11)} ${esc(a)}</span>`).join('') : '<span class="badge ok">No known allergies</span>'
        }</div>
      </div>
      <button class="btn primary" id="add-record">${icon('plus', 15)} Add record</button>
    </div>
    <div class="inspector" title="How this read travelled through the distributed system">${inspectorHtml(meta)}</div>
    ${bg ? `<div class="banner danger">${icon('siren', 16)} <div><b>Emergency access active</b> — expires ${esc(timeAgo(access.expiresAt))}. Every action is audited and the patient has been notified.</div></div>` : ''}
    <div class="tabs" id="tabs">${tabsHtml(records, filter)}</div>
    <div class="timeline" id="timeline">${timelineHtml(records, filter)}</div>`;
  $('#tabs').onclick = (e) => {
    const t = e.target.closest('[data-filter]');
    if (!t) return;
    filter = t.dataset.filter;
    $('#tabs').innerHTML = tabsHtml(records, filter);
    $('#timeline').innerHTML = timelineHtml(records, filter);
  };
  $('#add-record').onclick = () => addRecord(p);
}

async function breakGlass(id, name) {
  const ok = await modal({
    title: `Emergency access — ${name}`,
    body: `<div class="banner danger" style="margin:0 0 14px">${icon('siren', 16)} <div>Break-glass overrides patient consent for <b>30 minutes</b>. Misuse is a disciplinary offence. The patient is alerted in real time.</div></div>
      <div class="field"><label for="bg-reason">Clinical justification</label>
      <textarea class="input" id="bg-reason" name="reason" placeholder="e.g. Patient unconscious in ER, need allergy & medication history"></textarea><div class="error"></div></div>`,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Grant emergency access',
        kind: 'danger',
        handler: async (root) => {
          const r = await api(`/api/patients/${encodeURIComponent(id)}/break-glass`, { method: 'POST', body: { reason: $('#bg-reason', root).value } });
          if (!r.ok) {
            showFieldErrors(root, r.data?.details?.map((d) => ({ path: d.path || 'reason', message: d.message ?? d.reason })) ?? []);
            return false;
          }
          return true;
        },
      },
    ],
  });
  if (ok) {
    toast('<b>Emergency access granted</b> — logged to the audit ledger.', 'warn');
    await loadDirectory();
    openPatient(id);
  }
}

// ─────────────────────────── add record ───────────────────────────
const RECORD_FORMS = {
  note: `<div class="field"><label>Note</label><textarea class="input" name="content" placeholder="Assessment, plan…"></textarea><div class="error"></div></div>`,
  vitals: `<div class="grid-3">
      ${[['heartRate', 'Heart rate (bpm)', 78], ['systolic', 'Systolic (mmHg)', 120], ['diastolic', 'Diastolic (mmHg)', 80], ['temperature', 'Temp (°C)', 36.8], ['spo2', 'SpO₂ (%)', 98]]
        .map(([n, l, v]) => `<div class="field"><label>${l}</label><input class="input" type="number" step="any" name="${n}" value="${v}"/><div class="error"></div></div>`)
        .join('')}</div>
    <div class="field" style="margin-top:12px"><label>Comment (optional)</label><input class="input" name="content"/><div class="error"></div></div>`,
  prescription: `<div class="grid-2">
      <div class="field"><label>Medication</label><input class="input" name="medication" placeholder="Metoprolol"/><div class="error"></div></div>
      <div class="field"><label>Dosage</label><input class="input" name="dosage" placeholder="25 mg"/><div class="error"></div></div>
      <div class="field"><label>Frequency</label><input class="input" name="frequency" placeholder="Twice daily"/><div class="error"></div></div>
      <div class="field"><label>Duration (days)</label><input class="input" type="number" name="durationDays" value="30"/><div class="error"></div></div></div>`,
  lab: `<div class="grid-3" id="lab-rows">
      <div class="field"><label>Test</label><input class="input" name="results.0.test" placeholder="HbA1c"/><div class="error"></div></div>
      <div class="field"><label>Value</label><input class="input" type="number" step="any" name="results.0.value"/><div class="error"></div></div>
      <div class="field"><label>Unit</label><input class="input" name="results.0.unit" placeholder="%"/><div class="error"></div></div>
      <div class="field"><label>Reference</label><input class="input" name="results.0.refRange" placeholder="&lt; 7"/><div class="error"></div></div>
      <div class="field"><label>Flag</label><select class="input" name="results.0.flag"><option>normal</option><option>low</option><option>high</option><option>critical</option></select><div class="error"></div></div></div>`,
};

function collectRecord(root, type) {
  const v = (n) => root.querySelector(`[name="${n}"]`)?.value;
  const num = (n) => (v(n) === '' || v(n) === undefined ? undefined : Number(v(n)));
  const base = { type, title: v('title') };
  if (type === 'note') return { ...base, content: v('content') };
  if (type === 'vitals') return { ...base, heartRate: num('heartRate'), systolic: num('systolic'), diastolic: num('diastolic'), temperature: num('temperature'), spo2: num('spo2'), content: v('content') || undefined };
  if (type === 'prescription') return { ...base, medication: v('medication'), dosage: v('dosage'), frequency: v('frequency'), durationDays: num('durationDays') };
  return {
    ...base,
    results: [{ test: v('results.0.test'), value: num('results.0.value'), unit: v('results.0.unit'), refRange: v('results.0.refRange') || undefined, flag: v('results.0.flag') }],
  };
}

async function addRecord(p) {
  const idempotencyKey = crypto.randomUUID(); // same key on every retry of THIS submission → exactly-once
  const saved = await modal({
    title: `New record — ${p.name}`,
    wide: true,
    body: `<div class="grid-2">
        <div class="field"><label>Type</label><select class="input" name="type" id="rec-type">
          <option value="note">Clinical note</option><option value="vitals">Vitals</option>
          <option value="prescription">Prescription</option><option value="lab">Lab result</option></select></div>
        <div class="field"><label>Title</label><input class="input" name="title" placeholder="e.g. Follow-up consultation"/><div class="error"></div></div>
      </div>
      <div id="rec-form" style="margin-top:14px">${RECORD_FORMS.note}</div>
      <div class="muted" style="font-size:12px;margin-top:12px">${icon('lock', 12)} Free-text content is encrypted with AES-256-GCM before it is replicated. Idempotency key <span class="mono">${idempotencyKey.slice(0, 8)}…</span></div>
      <div class="alert danger hidden" id="rec-err" style="margin-top:10px"></div>`,
    onOpen: (root) => {
      $('#rec-type', root).onchange = (e) => ($('#rec-form', root).innerHTML = RECORD_FORMS[e.target.value]);
    },
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save record',
        kind: 'primary',
        handler: async (root) => {
          const type = $('#rec-type', root).value;
          const r = await api(`/api/patients/${encodeURIComponent(p.id)}/records`, {
            method: 'POST',
            body: collectRecord(root, type),
            headers: { 'idempotency-key': idempotencyKey },
          });
          if (!r.ok) {
            const rest = showFieldErrors(root, r.data?.details ?? []);
            const err = $('#rec-err', root);
            err.textContent = rest.length ? rest.join(' · ') : (r.data?.message ?? 'Could not save');
            err.classList.toggle('hidden', !rest.length && r.status === 400);
            return false;
          }
          return r.data;
        },
      },
    ],
  });
  if (saved) {
    toast(`<b>Record saved</b> — committed by Raft on ${esc(saved.shardId)} (leader ${esc(saved.servedBy)}, log index ${esc(saved.logIndex)})`, 'ok');
    openPatient(p.id);
  }
}

// ─────────────────────────── register patient ───────────────────────────
$('#nav-register').onclick = async () => {
  const created = await modal({
    title: 'Register a new patient',
    wide: true,
    body: `<div class="grid-2">
        <div class="field"><label>Full name</label><input class="input" name="name"/><div class="error"></div></div>
        <div class="field"><label>Date of birth</label><input class="input" type="date" name="dob"/><div class="error"></div></div>
        <div class="field"><label>Gender</label><select class="input" name="gender"><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select><div class="error"></div></div>
        <div class="field"><label>Blood group</label><select class="input" name="bloodGroup">${['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => `<option>${b}</option>`).join('')}</select><div class="error"></div></div>
        <div class="field"><label>Mobile</label><input class="input" name="phone" placeholder="10-digit mobile"/><div class="error"></div></div>
        <div class="field"><label>ABHA number (optional)</label><input class="input" name="abhaId" placeholder="14 digits"/><div class="error"></div></div>
        <div class="field" style="grid-column:span 2"><label>Allergies (comma-separated)</label><input class="input" name="allergies" placeholder="Penicillin, Peanuts"/><div class="error"></div></div>
      </div>
      <h4 style="margin:20px 0 10px;font-size:14px">Patient portal account <span class="muted" style="font-weight:500">· optional</span></h4>
      <div class="grid-2">
        <div class="field"><label>Username</label><input class="input" name="account.username" placeholder="lowercase"/><div class="error"></div></div>
        <div class="field"><label>Temporary password</label><input class="input" name="account.password" placeholder="8+ chars, Aa1!"/><div class="error"></div></div>
      </div>
      <div class="alert danger hidden" id="reg-err" style="margin-top:12px"></div>`,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Register patient',
        kind: 'primary',
        handler: async (root) => {
          const v = (n) => root.querySelector(`[name="${n}"]`).value.trim();
          const body = {
            name: v('name'),
            dob: v('dob'),
            gender: v('gender'),
            bloodGroup: v('bloodGroup'),
            phone: v('phone'),
            abhaId: v('abhaId') || undefined,
            allergies: v('allergies') ? v('allergies').split(',').map((s) => s.trim()).filter(Boolean) : [],
            account: v('account.username') ? { username: v('account.username'), password: v('account.password') } : undefined,
          };
          const r = await api('/api/patients', { method: 'POST', body });
          if (!r.ok) {
            const rest = showFieldErrors(root, r.data?.details ?? []);
            const err = $('#reg-err', root);
            const msg = rest.length ? rest.join(' · ') : r.status === 400 ? '' : (r.data?.message ?? 'Registration failed');
            err.textContent = msg;
            err.classList.toggle('hidden', !msg);
            return false;
          }
          return r.data;
        },
      },
    ],
  });
  if (created) {
    toast(`<b>Patient ${esc(created.id)} registered</b> — placed on <b>${esc(created.shardId)}</b> by consistent hashing`, 'ok');
    await loadDirectory();
    openPatient(created.id);
  }
};

// ─────────────────────────── live notifications ───────────────────────────
stream(
  (e) => {
    if (e.replay) return;
    if (e.type === 'CONSENT_GRANTED') toast(`<b>Access granted</b> by patient — ${esc(e.actor?.name)}`, 'ok');
    if (e.type === 'CONSENT_REVOKED') toast(`<b>Consent revoked</b> by ${esc(e.actor?.name)}`, 'warn');
    loadDirectory();
  },
  (on) => $('#live').classList.toggle('off', !on),
);

loadDirectory();

import { esc, fmtDate } from './ui.js';
import { icon } from './icons.js';

export const TYPE_META = {
  note: { icon: 'file', label: 'Clinical note', plural: 'Notes' },
  lab: { icon: 'flask', label: 'Lab result', plural: 'Labs' },
  prescription: { icon: 'pill', label: 'Prescription', plural: 'Prescriptions' },
  vitals: { icon: 'heart', label: 'Vitals', plural: 'Vitals' },
};

function vitalsHtml(r) {
  const tiles = [
    ['Heart rate', `${r.heartRate}`, 'bpm', r.heartRate > 100 || r.heartRate < 50],
    ['Blood pressure', `${r.systolic}/${r.diastolic}`, 'mmHg', r.systolic >= 140 || r.diastolic >= 90 || r.systolic < 90],
    ['Temperature', `${r.temperature}`, '°C', r.temperature >= 38 || r.temperature < 35],
    ['SpO₂', `${r.spo2}`, '%', r.spo2 < 95],
  ];
  return `<div class="vgrid">${tiles
    .map(([l, v, u, bad]) => `<div class="vital ${bad ? 'bad' : ''}"><div class="l">${l}</div><div class="v">${esc(v)}<small class="muted" style="font-size:11px;font-weight:600"> ${u}</small></div></div>`)
    .join('')}</div>`;
}

function labsHtml(r) {
  return `<div class="labs"><table class="table">
    <thead><tr><th>Test</th><th>Result</th><th>Reference</th><th>Flag</th></tr></thead>
    <tbody>${r.results
      .map(
        (x) => `<tr><td>${esc(x.test)}</td><td class="flag-${esc(x.flag)}">${esc(x.value)} ${esc(x.unit)}</td><td class="muted">${esc(x.refRange ?? '—')}</td>
        <td>${x.flag === 'normal' ? '<span class="badge ok">normal</span>' : `<span class="badge ${x.flag === 'low' ? 'warn' : 'danger'}">${esc(x.flag)}</span>`}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function rxHtml(r) {
  return `<div class="rx"><span><b>${esc(r.medication)}</b></span><span>Dose <b>${esc(r.dosage)}</b></span>
    <span>Frequency <b>${esc(r.frequency)}</b></span><span>Duration <b>${esc(r.durationDays)} days</b></span></div>`;
}

export function recordHtml(r) {
  const m = TYPE_META[r.type] ?? { icon: 'file', label: r.type };
  const body = r.type === 'vitals' ? vitalsHtml(r) : r.type === 'lab' ? labsHtml(r) : r.type === 'prescription' ? rxHtml(r) : '';
  return `<article class="rec ${esc(r.type)}" data-type="${esc(r.type)}">
    <div class="ico" aria-hidden="true">${icon(m.icon, 18)}</div>
    <div style="min-width:0">
      <div class="row"><h4>${esc(r.title)}</h4><span class="badge">${m.label}</span><span class="spacer"></span><span class="when">${fmtDate(r.createdAt)}</span></div>
      <div class="when">by ${esc(r.author?.name ?? 'unknown')} · <span class="mono">${esc(r.id)}</span></div>
      ${body}
      ${r.content ? `<p>${esc(r.content)}</p>` : ''}
    </div></article>`;
}

export function timelineHtml(records, filter = 'all') {
  const list = filter === 'all' ? records : records.filter((r) => r.type === filter);
  if (!list.length) return `<div class="empty">No ${filter === 'all' ? '' : TYPE_META[filter].label.toLowerCase() + ' '}records yet.</div>`;
  return list.map(recordHtml).join('');
}

export function tabsHtml(records, active) {
  const count = (t) => (t === 'all' ? records.length : records.filter((r) => r.type === t).length);
  return ['all', 'note', 'lab', 'prescription', 'vitals']
    .map((t) => `<button class="tab ${t === active ? 'active' : ''}" data-filter="${t}">${t === 'all' ? 'All' : TYPE_META[t].plural} <span class="muted">${count(t)}</span></button>`)
    .join('');
}

/** "Request inspector" — makes the distributed path of each read visible in the UI. */
export function inspectorHtml(meta) {
  if (!meta) return '';
  return `<span>shard <b>${esc(meta.shardId)}</b></span>
    <span>replica <b>${esc(meta.servedBy)}</b> (leader)</span>
    <span>cache <b style="color:${meta.cache === 'HIT' ? 'var(--ok)' : 'var(--warn)'}">${esc(meta.cache)}</b></span>
    <span>consistency <b>${esc(meta.consistency)}</b></span>
    <span>storage <b>${esc(meta.storageMs)} ms</b></span>
    <span>gateway total <b>${esc(meta.totalMs)} ms</b></span>`;
}

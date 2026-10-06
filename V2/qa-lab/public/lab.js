// QA Lab front end. All server text goes through esc() before reaching innerHTML.
import { icon, hydrateIcons } from '/js/icons.js';
import { applyEvent, failedTests } from '/model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const $ = (sel) => document.querySelector(sel);
const fmtMs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const short = (file) => file.replace(/^tests\//, '');

const S = { run: null, history: [], campaign: null, faults: [], faultStatus: {}, quality: null, suites: [], open: new Set() };

function toast(text, kind = 'info') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${esc(text)}</div>`;
  box.append(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

const start = (path, body = {}) =>
  api(path, body).catch((err) => toast(err.message, 'warn'));

// ─── rendering, throttled to one frame ───
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderRun();
    renderTopbar();
  });
}

function renderTopbar() {
  const running = S.run?.status === 'running' || S.campaign?.running;
  const pill = $('#run-pill');
  if (running) {
    pill.className = 'badge info';
    pill.innerHTML = `<span class="dot pulse"></span> ${esc(S.campaign?.running ? `Fault campaign ${S.campaign.results.length + 1}/${S.campaign.total}` : S.run.label)}`;
  } else {
    pill.className = 'badge';
    pill.textContent = 'Idle';
  }
  $('#stop').classList.toggle('hidden', !running);
  for (const b of document.querySelectorAll('[data-start]')) b.disabled = Boolean(running);
}

function stateIcon(state) {
  const map = { passed: 'check', failed: 'x', running: 'clock', queued: 'clock', stopped: 'stop', skipped: 'ban' };
  return `<span class="state-ico ${esc(state)}">${icon(map[state] ?? 'clock', 12)}</span>`;
}

function renderRun() {
  const run = S.run;
  const view = $('#run-view');
  if (!run) return;
  const c = run.counts;
  const done = c.passed + c.failed + c.skipped;
  const elapsed = (run.endedAt ?? Date.now()) - run.startedAt;
  const pct = (n) => (c.total ? (n / c.total) * 100 : 0);
  const statusBadge = {
    running: '<span class="badge info"><span class="dot pulse"></span> Running</span>',
    passed: '<span class="badge ok">All passed</span>',
    failed: '<span class="badge danger">Failures</span>',
    stopped: '<span class="badge warn">Stopped</span>',
    done: '<span class="badge">Finished</span>',
  }[run.status] ?? '';

  let verdict = '';
  if (run.kind === 'fault' && run.verdict) {
    const caught = failedTests(run);
    if (run.verdict === 'killed') {
      verdict = `<div class="verdict killed">${icon('check', 22)}<div><div class="big">Bug caught by ${caught.length} test${caught.length === 1 ? '' : 's'}</div>
        <div class="muted">The seeded fault was detected, so the build would fail before this bug reached patients.</div>
        <ul>${caught.slice(0, 6).map((t) => `<li><b>${esc(t.name)}</b>${t.error?.message ? `<br><span class="muted">${esc(t.error.message.split('\n')[0].slice(0, 160))}</span>` : ''}</li>`).join('')}</ul></div></div>`;
    } else {
      verdict = `<div class="verdict ${esc(run.verdict)}">${icon('alert', 22)}<div><div class="big">${run.verdict === 'survived' ? 'Bug survived: no test failed' : 'The run could not complete'}</div>
        <div class="muted">${run.verdict === 'survived' ? 'This is a gap in the test suite. A new test is needed for this behaviour.' : 'See the console output below.'}</div></div></div>`;
    }
  }

  const files = run.fileOrder
    .map((file) => {
      const f = run.files[file];
      const tests = f.order.map((id) => f.tests[id]);
      const fp = tests.filter((t) => t.state === 'passed').length;
      const ff = tests.filter((t) => t.state === 'failed').length;
      const wall = tests.map((t) => `<span class="cell ${esc(t.state)}" title="${esc(t.name)}"></span>`).join('');
      const lines = tests
        .map((t) => {
          const mark = t.state === 'passed' ? `<span class="ok">${icon('check', 12)}</span>` : t.state === 'failed' ? `<span class="bad">${icon('x', 12)}</span>` : `<span class="muted">·</span>`;
          const err = t.error?.message ? `<div class="err">${esc(t.error.message)}</div>` : '';
          return `<div class="tline">${mark}<span>${esc(t.name)}</span><span class="d">${t.duration ? fmtMs(t.duration) : ''}</span>${err}</div>`;
        })
        .join('');
      const loadErr = f.error && !ff ? `<div class="err">${esc(f.error.message)}</div>` : '';
      return `<div class="file ${esc(f.state)} ${S.open.has(file) ? 'open' : ''}" data-file="${esc(file)}">
        <div class="fh">${stateIcon(f.state)}<span class="name">${esc(short(file))}</span><span class="meta">${fp}/${tests.length}${ff ? ` · <span style="color:var(--danger)">${ff} failed</span>` : ''}${f.duration ? ` · ${fmtMs(f.duration)}` : ''}</span></div>
        <div class="wall">${wall}</div>
        <div class="tests">${lines}${loadErr}</div>
      </div>`;
    })
    .join('');

  view.innerHTML = `
    <div class="run-head">
      <span class="run-title">${esc(run.label)}</span>${statusBadge}
      <span class="spacer"></span>
      <div class="counts">
        <span class="badge ok">${c.passed} passed</span>
        <span class="badge ${c.failed ? 'danger' : ''}">${c.failed} failed</span>
        ${c.skipped ? `<span class="badge">${c.skipped} skipped</span>` : ''}
        <span class="badge">${done} / ${c.total || '…'} · ${fmtMs(elapsed)}</span>
      </div>
    </div>
    <div class="progress ${run.status === 'running' ? 'running' : ''}"><span class="p-ok" style="width:${pct(c.passed)}%"></span><span class="p-bad" style="width:${pct(c.failed)}%"></span><span class="p-skip" style="width:${pct(c.skipped)}%"></span></div>
    ${verdict}
    <div class="files">${files || '<div class="muted" style="padding:6px 8px">Starting test runner…</div>'}</div>
    <div class="console">${esc(run.logs.slice(-40).join('\n'))}</div>
    ${renderHistory()}`;
  const con = view.querySelector('.console');
  if (con) con.scrollTop = con.scrollHeight;
}

function renderHistory() {
  if (!S.history.length) return '';
  return `<div class="history">${S.history
    .slice(0, 8)
    .map((h) => {
      const kind = h.verdict === 'killed' || h.status === 'passed' ? 'ok' : h.status === 'stopped' ? 'warn' : 'danger';
      const what = h.kind === 'fault' ? (h.verdict === 'killed' ? 'caught' : h.verdict) : `${h.counts.passed}/${h.counts.total}`;
      return `<span class="badge ${kind}" title="${esc(fmtDate(new Date(h.endedAt).toISOString()))}">${esc(h.label.split(' · ')[0])} · ${esc(what)} · ${fmtMs(h.endedAt - h.startedAt)}</span>`;
    })
    .join('')}</div>`;
}

$('#run-view').addEventListener('click', (e) => {
  const card = e.target.closest('.file');
  if (!card) return;
  const file = card.dataset.file;
  if (S.open.has(file)) S.open.delete(file);
  else S.open.add(file);
  card.classList.toggle('open');
});

// ─── suites ───
function renderSuites() {
  $('#suite-buttons').innerHTML = S.suites
    .map((s, i) => `<button class="btn sm ${i === 0 ? 'primary' : ''} suite-btn" data-start="suite" data-suite="${esc(s.id)}">${icon(s.id === 'all' ? 'layers' : 'play', 13)} ${esc(s.short)}${s.tests ? ` <span class="n">${s.tests}</span>` : ''}</button>`)
    .join('');
}
$('#suite-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('[data-suite]');
  if (b) start('/api/runs', { suite: b.dataset.suite }).then(() => $('#runner').scrollIntoView({ behavior: 'smooth' }));
});

// ─── seeded faults ───
function renderFaults() {
  $('#fault-grid').innerHTML = S.faults
    .map((f) => {
      const st = S.faultStatus[f.id] ?? {};
      const cls = st.running ? 'running' : st.verdict ?? '';
      const badge = st.running
        ? '<span class="badge info"><span class="dot pulse"></span> Running</span>'
        : st.verdict === 'killed'
          ? `<span class="badge ok">${icon('check', 12)} Caught by ${st.caughtBy.length}</span>`
          : st.verdict === 'survived'
            ? '<span class="badge danger">Survived</span>'
            : st.verdict
              ? `<span class="badge danger">${esc(st.verdict)}</span>`
              : '<span class="badge">Not run</span>';
      const caught = st.verdict === 'killed' && st.caughtBy.length ? `<div class="caught"><ul>${st.caughtBy.slice(0, 3).map((n) => `<li>${esc(n.length > 90 ? n.slice(0, 90) + '…' : n)}</li>`).join('')}${st.caughtBy.length > 3 ? `<li class="muted">and ${st.caughtBy.length - 3} more</li>` : ''}</ul></div>` : '';
      const d = f.diff;
      const diff = d
        ? `<div class="diff"><div class="loc">${esc(f.file)}:${d.line}</div>${d.before.map((l) => `<div class="ln minus"><span class="tag">CODE</span><span>${esc(l.trim())}</span></div>`).join('')}${d.after.map((l) => `<div class="ln plus"><span class="tag">BUG</span><span>${esc(l.trim())}</span></div>`).join('')}</div>`
        : '<div class="diff"><div class="loc">source changed: fault no longer applies</div></div>';
      return `<div class="fault ${esc(cls)}">
        <div class="top"><span class="id">${esc(f.id)}</span><span class="badge info">${esc(f.category)}</span><span class="spacer"></span>${badge}</div>
        <h4>${esc(f.title)}</h4>
        <div class="why">${esc(f.explain)}</div>
        ${diff}
        <div class="foot"><span class="badge">${esc(f.technique)}</span><span class="spacer"></span><button class="btn sm" data-start="fault" data-fault="${esc(f.id)}">${icon('bug', 13)} Inject &amp; test</button></div>
        ${caught}
      </div>`;
    })
    .join('');
  renderTopbar();
}
$('#fault-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fault]');
  if (b) start(`/api/faults/${encodeURIComponent(b.dataset.fault)}/run`).then(() => $('#runner').scrollIntoView({ behavior: 'smooth' }));
});
$('#run-all-faults').addEventListener('click', () => start('/api/faults/run-all'));

function renderCampaign() {
  const c = S.campaign;
  const box = $('#campaign');
  if (!c) {
    box.innerHTML = `<p class="fault-intro">Fault seeding (defect seeding) measures how good the tests are. Each card below is a realistic bug written into a sandbox copy of the code. Only the tests for that module run. If any test fails, the bug is caught. The real source code is never touched.</p>`;
    return;
  }
  const killed = c.results.filter((r) => r.verdict === 'killed').length;
  const doneN = c.results.length;
  const steps = S.faults
    .map((f, i) => {
      const r = c.results.find((x) => x.id === f.id);
      const cls = r ? r.verdict : c.running && i === doneN ? 'running' : '';
      return `<span class="step ${esc(cls)}" title="${esc(f.id + ' · ' + f.title)}">${esc(f.id.slice(3))}</span>`;
    })
    .join('');
  const rate = doneN ? Math.round((killed / doneN) * 100) : 0;
  box.innerHTML = `<div class="campaign">
    <div><div class="big">${killed} / ${c.total}</div><div class="muted" style="font-size:12px">seeded faults caught</div></div>
    <div><div class="big">${rate}%</div><div class="muted" style="font-size:12px">detection rate${c.running ? ' so far' : ''}</div></div>
    <div class="steps">${steps}</div>
    <span class="spacer"></span>
    <span class="badge ${c.running ? 'info' : killed === c.total ? 'ok' : 'warn'}">${c.running ? `<span class="dot pulse"></span> running ${doneN + 1} of ${c.total}` : `finished in ${fmtMs((c.endedAt ?? Date.now()) - c.startedAt)}`}</span>
  </div>`;
  renderKpis();
}

// ─── browser tests ───
$('#e2e-headed').addEventListener('click', () => start('/api/e2e', { headed: true }).then(() => toast('Starting a MediChain cluster for the browser tests. Chromium opens in about 20 seconds.')));
$('#e2e-headless').addEventListener('click', () => start('/api/e2e', { headed: false }));
$('#stop').addEventListener('click', () => api('/api/stop', {}).catch(() => {}));

// ─── quality dashboard ───
function bar(label, value, { second, before, target, cls = '', text } = {}) {
  const w = (v) => `${Math.max(0, Math.min(100, v))}%`;
  return `<div class="bar-row"><span class="lbl" title="${esc(label)}">${esc(label)}</span>
    <div class="track"><span class="fill ${cls}" style="width:${w(value)}"></span>${second != null ? `<span class="fill second" style="width:${w(second)}"></span>` : ''}${before != null ? `<span class="before" style="left:${w(before)}" title="before: ${before}%"></span>` : ''}${target != null ? `<span class="target" style="left:${w(target)}"></span>` : ''}</div>
    <span class="val">${text}</span></div>`;
}

function renderQuality() {
  const q = S.quality;
  if (!q) return;
  if (q.coverage) {
    $('#cov-stamp').textContent = fmtDate(q.coverage.generatedAt);
    $('#coverage').innerHTML =
      q.coverage.modules.map((m) => bar(m.name, m.lines, { second: m.branches, target: 80, text: `<b>${m.lines.toFixed(1)}</b> · ${m.branches.toFixed(1)}` })).join('') +
      bar('Total', q.coverage.total.lines, { second: q.coverage.total.branches, target: 80, text: `<b>${q.coverage.total.lines.toFixed(1)}</b> · ${q.coverage.total.branches.toFixed(1)}` });
  } else $('#coverage').innerHTML = '<div class="empty">Run <span class="mono">npm run test:coverage</span> to generate coverage.</div>';
  if (!$('#cov-legend')) $('#coverage').insertAdjacentHTML('afterend', '<div class="legend" id="cov-legend"><span><i style="background:#2dd4bf"></i>lines %</span><span><i style="background:#a78bfa"></i>branches %</span><span><i style="background:rgba(255,255,255,.55);width:2px"></i>80% target</span></div>');

  if (q.mutation) {
    $('#mut-stamp').textContent = `${q.mutation.mutants} mutants · ${fmtDate(q.mutation.generatedAt)}`;
    $('#mutation').innerHTML =
      q.mutation.files.map((f) => bar(f.file.split('/').pop(), f.score ?? 0, { before: f.before, cls: 'violet', text: `${f.before ?? '—'} → <b>${f.score ?? '—'}</b>` })).join('') +
      bar('Overall', q.mutation.score, { before: q.mutation.before, cls: 'violet', text: `${q.mutation.before} → <b>${q.mutation.score}</b>` });
    if (!$('#mut-legend')) $('#mutation').insertAdjacentHTML('afterend', '<div class="legend" id="mut-legend"><span><i style="background:#a78bfa"></i>score after mutation-driven tests</span><span><i style="background:#fbbf24;width:3px"></i>first Stryker run</span></div>');
  } else $('#mutation').innerHTML = '<div class="empty">Run <span class="mono">npm run test:mutation</span> to generate the mutation report.</div>';

  if (q.catalogue) {
    $('#cat-stamp').textContent = `${q.catalogue.total} named cases · ${q.catalogue.levels.map((l) => `${l.name.split(' ')[0]} ${l.cases}`).join(' · ')}`;
    const max = Math.max(...q.catalogue.techniques.map((t) => t.count));
    $('#techniques').innerHTML = q.catalogue.techniques.map((t) => bar(t.name, (t.count / max) * 100, { text: `<b>${t.count}</b>` })).join('');
  }

  if (q.load) {
    $('#load-stamp').textContent = fmtDate(q.load.generatedAt);
    $('#load').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Scenario</th><th>req/s</th><th>p50 ms</th><th>p99 ms</th><th>Errors</th></tr></thead><tbody>${q.load.rows
      .map((r) => `<tr><td>${esc(r.scenario)}</td><td>${r.rps}</td><td>${r.p50}</td><td>${r.p99}</td><td><span class="badge ${r.errors ? 'danger' : 'ok'}">${r.errors}</span></td></tr>`)
      .join('')}</tbody></table></div>`;
  } else $('#load').innerHTML = '<div class="empty">Run <span class="mono">npm run test:load</span> to measure performance.</div>';

  $('#reports').innerHTML = q.reports.map((r) => `<a href="${esc(r.href)}" target="_blank" rel="noopener" class="${r.exists ? '' : 'missing'}">${icon('file', 14)} ${esc(r.label)}</a>`).join('');

  const t = q.traceability;
  const levels = t.length ? Object.keys(t[0].levels) : [];
  $('#trace-table').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Req.</th><th>Requirement</th><th>Priority</th>${levels.map((l) => `<th>${esc(l)}</th>`).join('')}<th>Latest result</th></tr></thead><tbody>${t
    .map((r) => {
      const badge = r.status === 'verified' ? `<span class="badge ok">${icon('check', 12)} ${r.passed}/${r.linked} passing</span>` : r.status === 'failing' ? `<span class="badge danger">${r.failed} failing</span>` : '<span class="badge">Not run</span>';
      return `<tr class="${r.status}"><td class="mono rid">${esc(r.id)}</td><td>${esc(r.text)}</td><td>${esc(r.priority)}</td>${levels
        .map((l) => {
          const ids = r.levels[l];
          return `<td class="ids" title="${esc(ids.join(', '))}">${ids.length ? esc(ids.slice(0, 2).join(', ')) + (ids.length > 2 ? ` +${ids.length - 2}` : '') : '—'}</td>`;
        })
        .join('')}<td>${badge}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;

  const sev = { High: 'danger', Medium: 'warn', Low: 'info' };
  $('#defect-table').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Found by</th><th>Severity</th><th>Defect</th><th>Fix</th></tr></thead><tbody>${q.defects
    .map((d) => `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.foundBy)}</td><td><span class="badge ${sev[d.severity] ?? ''}">${esc(d.severity)}</span></td><td>${esc(d.description)}</td><td>${esc(d.fix)}</td></tr>`)
    .join('')}</tbody></table></div>`;
  renderKpis();
}

function renderKpis() {
  const q = S.quality;
  if (q?.junit?.tests) {
    $('#k-tests').innerHTML = `${q.junit.tests - q.junit.failures}<small> / ${q.junit.tests}</small>`;
    $('#k-tests-s').textContent = `Vitest, last full run ${fmtDate(q.junit.timestamp)}`;
  }
  if (q?.coverage) $('#k-cov').innerHTML = `${q.coverage.total.lines.toFixed(1)}<small>% · ${q.coverage.total.branches.toFixed(1)}%</small>`;
  if (q?.mutation) {
    $('#k-mut').innerHTML = `${q.mutation.score}<small>%</small>`;
    $('#k-mut-s').textContent = `up from ${q.mutation.before}% · ${q.mutation.mutants} mutants`;
  }
  if (q?.traceability?.length) {
    const v = q.traceability.filter((r) => r.status === 'verified').length;
    $('#k-req').innerHTML = `${v}<small> / ${q.traceability.length}</small>`;
  }
  const statuses = Object.values(S.faultStatus).filter((s) => s.verdict);
  if (statuses.length) {
    const k = statuses.filter((s) => s.verdict === 'killed').length;
    $('#k-faults').innerHTML = `${k}<small> / ${statuses.length}</small>`;
    $('#k-faults-s').textContent = statuses.length === S.faults.length ? `detection rate ${Math.round((k / statuses.length) * 100)}%` : `of ${S.faults.length} seeded faults run so far`;
  }
}

async function loadQuality() {
  S.quality = await api('/api/quality');
  renderQuality();
}

// ─── live stream ───
function noteFault(summary) {
  if (summary.kind !== 'fault') return;
  S.faultStatus[summary.meta.fault] = { verdict: summary.verdict ?? summary.status, caughtBy: summary.caughtBy ?? [], running: summary.status === 'running' };
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#live').classList.remove('off');
  es.onerror = () => $('#live').classList.add('off');
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'hello') {
      S.history = ev.state.history;
      for (const h of [...S.history].reverse()) noteFault(h);
      S.run = ev.state.current ?? ev.state.last ?? null;
      if (ev.state.current) noteFault(S.run);
      S.campaign = ev.state.campaign;
      for (const r of S.campaign?.results ?? []) S.faultStatus[r.id] = { verdict: r.verdict, caughtBy: r.caughtBy };
      renderCampaign();
      renderFaults();
      schedule();
    } else if (ev.type === 'run' && !ev.finished) {
      S.run = ev.run;
      if (ev.run.kind === 'fault') S.faultStatus[ev.run.meta.fault] = { running: true, caughtBy: [] };
      S.open.clear();
      renderFaults();
      schedule();
    } else if (ev.type === 'run' && ev.finished) {
      S.history.unshift(ev.run);
      noteFault(ev.run);
      renderFaults();
      schedule();
      if (ev.run.kind !== 'fault') loadQuality();
      const r = ev.run;
      if (r.kind === 'fault') toast(r.verdict === 'killed' ? `${r.meta.fault}: bug caught by ${r.caughtBy.length} test(s)` : `${r.meta.fault}: ${r.verdict}`, r.verdict === 'killed' ? 'ok' : 'danger');
      else toast(`${r.label}: ${r.counts.passed}/${r.counts.total} passed`, r.status === 'passed' ? 'ok' : 'danger');
    } else if (ev.type === 'event') {
      if (S.run && S.run.id === ev.runId) {
        applyEvent(S.run, ev.event);
        schedule();
      }
    } else if (ev.type === 'campaign') {
      S.campaign = ev.campaign;
      for (const r of ev.campaign.results) S.faultStatus[r.id] = { verdict: r.verdict, caughtBy: r.caughtBy };
      renderCampaign();
      renderFaults();
    }
  };
}

setInterval(() => {
  if (S.run?.status === 'running') schedule();
}, 500);

// Highlight the nav item for the section in view.
const navObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of document.querySelectorAll('.sidebar .nav-item')) a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`);
    }
  },
  { rootMargin: '-30% 0px -60% 0px' },
);
for (const id of ['runner', 'faults', 'e2e', 'quality', 'trace', 'defects']) navObserver.observe(document.getElementById(id));

(async () => {
  hydrateIcons();
  const [suites, faults] = await Promise.all([api('/api/suites'), api('/api/faults')]);
  S.suites = suites.suites;
  S.faults = faults.faults;
  renderSuites();
  renderCampaign();
  renderFaults();
  connect();
  loadQuality();
})();

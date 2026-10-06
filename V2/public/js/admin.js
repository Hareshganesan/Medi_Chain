import { api, requireSession, logout, stream } from './api.js';
import { $, esc, toast, modal, fmtTime, sparkline, userCard } from './ui.js';
import { icon, hydrateIcons } from './icons.js';

hydrateIcons();

const { user } = requireSession('admin');
$('#user-card').innerHTML = userCard(user);
$('#logout').onclick = logout;

const SHARD_COLORS = { 'shard-a': '#2dd4bf', 'shard-b': '#818cf8', 'shard-c': '#f472b6', 'shard-d': '#fbbf24' };
const colorOf = (id) => SHARD_COLORS[id] ?? '#94a3b8';
let cluster = null;

// ─────────────────────────── cluster topology ───────────────────────────
const POS = [
  [150, 48],
  [62, 146],
  [238, 146],
];

function shardSvg(shard) {
  const nodes = shard.nodes;
  const leaderIdx = nodes.findIndex((n) => n.up && n.role === 'leader' && !n.isolated);
  const lines = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) lines.push(`<line x1="${POS[i][0]}" y1="${POS[i][1]}" x2="${POS[j][0]}" y2="${POS[j][1]}" stroke="rgba(255,255,255,.1)" stroke-width="1"/>`);
  if (leaderIdx >= 0) {
    nodes.forEach((n, j) => {
      if (j === leaderIdx || !n.up || n.isolated) return;
      lines.push(`<line class="heartbeat" x1="${POS[leaderIdx][0]}" y1="${POS[leaderIdx][1]}" x2="${POS[j][0]}" y2="${POS[j][1]}" stroke="#f59e0b" stroke-width="2"/>`);
    });
  }
  const circles = nodes
    .map((n, i) => {
      const [x, y] = POS[i];
      const leader = n.up && n.role === 'leader';
      const stroke = !n.up ? '#475569' : n.isolated ? '#f43f5e' : leader ? '#f59e0b' : n.role === 'candidate' ? '#c084fc' : colorOf(shard.id);
      const label = !n.up ? 'DOWN' : n.isolated ? 'ISOLATED' : n.role.toUpperCase();
      return `<g>
        ${leader ? `<circle cx="${x}" cy="${y}" r="30" fill="none" stroke="#f59e0b" stroke-opacity="0.25" stroke-width="6"/>` : ''}
        <circle cx="${x}" cy="${y}" r="24" fill="rgba(255,255,255,.06)" stroke="${stroke}" stroke-width="2.5" ${n.isolated ? 'stroke-dasharray="5 4"' : ''}/>
        <text x="${x}" y="${y + 1}" text-anchor="middle" font-weight="600" font-size="14" fill="${n.up ? 'var(--text)' : '#64748b'}">${esc(n.id)}${leader ? '★' : ''}</text>
        <text x="${x}" y="${y + 13}" text-anchor="middle" font-size="8" fill="var(--muted)">${n.up ? 'T' + esc(n.term) : '✕'}</text>
        <text x="${x}" y="${y + (i === 0 ? -32 : 42)}" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="1" fill="${stroke}">${label}</text>
      </g>`;
    })
    .join('');
  return `<svg viewBox="0 0 300 200" width="100%" height="200" font-family="Segoe UI, system-ui, sans-serif">${lines.join('')}${circles}</svg>`;
}

function nodeTile(n) {
  const cls = [!n.up && 'down', n.up && n.role === 'leader' && 'leader', n.isolated && 'isolated'].filter(Boolean).join(' ');
  return `<div class="node ${cls}">
    <div class="row"><span class="nid">${esc(n.id)}</span><span class="spacer"></span>
      ${!n.up ? '<span class="badge danger">down</span>' : n.isolated ? '<span class="badge danger">partitioned</span>' : n.role === 'leader' ? '<span class="badge warn">leader</span>' : `<span class="badge">${esc(n.role)}</span>`}</div>
    <div class="kv">
      <span>term</span><b>${esc(n.term ?? '—')}</b>
      <span>commit</span><b>${esc(n.commitIndex ?? '—')}</b>
      <span>log</span><b>${esc(n.logLength ?? '—')}</b>
      <span>keys</span><b>${esc(n.keys ?? '—')}</b>
      <span>votedFor</span><b>${esc(n.votedFor ?? '—')}</b>
    </div>
    <div class="actions">
      ${n.up ? `<button class="btn danger" data-act="kill" data-node="${esc(n.id)}">Kill</button>` : `<button class="btn primary" data-act="restart" data-node="${esc(n.id)}">Restart</button>`}
      ${n.up ? (n.isolated ? `<button class="btn" data-act="heal" data-node="${esc(n.id)}">Heal</button>` : `<button class="btn" data-act="isolate" data-node="${esc(n.id)}">Partition</button>`) : ''}
      ${n.up ? `<button class="btn ghost" data-log="${esc(n.id)}">Log</button>` : ''}
    </div></div>`;
}

function renderShards() {
  $('#shards').innerHTML = cluster.shards
    .map((s) => {
      const up = s.nodes.filter((n) => n.up && !n.isolated).length;
      const quorum = Math.floor(s.nodes.length / 2) + 1;
      return `<div class="card shard-card">
        <div class="card-head">
          <span class="dot" style="color:${colorOf(s.id)}"></span><h3>${esc(s.id)}</h3>
          <span class="sub">Raft group · ${s.nodes.length} replicas · quorum ${quorum}</span><span class="spacer"></span>
          ${s.leaderId ? `<span class="badge warn">leader ${esc(s.leaderId)} · term ${esc(s.term)}</span>` : '<span class="badge danger">electing…</span>'}
          <span class="badge ${up >= quorum ? 'ok' : 'danger'}">${up}/${s.nodes.length} healthy${up >= quorum ? '' : ' — NO QUORUM'}</span>
        </div>
        <div class="viz">${shardSvg(s)}</div>
        <div class="node-tiles">${s.nodes.map(nodeTile).join('')}</div>
      </div>`;
    })
    .join('');
}

$('#shards').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    act.disabled = true;
    const r = await api(`/api/admin/nodes/${act.dataset.node}/${act.dataset.act}`, { method: 'POST' });
    const verb = { kill: 'killed (SIGKILL)', restart: 'restarted — recovering from its write-ahead log', isolate: 'partitioned from its peers', heal: 'reconnected' }[act.dataset.act];
    toast(r.ok ? `<b>${esc(act.dataset.node)}</b> ${verb}` : `Failed: ${esc(r.data?.message)}`, r.ok ? (act.dataset.act === 'kill' ? 'danger' : 'ok') : 'danger');
    setTimeout(loadCluster, 300);
    return;
  }
  const log = e.target.closest('[data-log]');
  if (log) showLog(log.dataset.log);
});

async function showLog(nodeId) {
  const r = await api(`/api/admin/nodes/${nodeId}/log?limit=12`);
  if (!r.ok) return toast('Node unreachable', 'danger');
  const pretty = JSON.stringify(r.data.entries, null, 2)
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/(enc:v1:[^"]+)/g, '<span style="color:#f472b6">$1</span>');
  modal({
    title: `Replicated log — ${nodeId} (commitIndex ${r.data.commitIndex})`,
    wide: true,
    body: `<p class="muted" style="margin-top:0">Latest entries of the Raft write-ahead log on this replica. <span style="color:#f472b6">Pink</span> values are AES-256-GCM ciphertext — the storage tier never sees plaintext identifiers or clinical notes.</p><div class="code">${pretty}</div>`,
  });
}

// ─────────────────────────── KPIs ───────────────────────────
async function loadMetrics() {
  const r = await api('/api/admin/metrics');
  if (!r.ok) return;
  const m = r.data;
  const series = m.throughput.map((t) => t.requests);
  const last10 = series.slice(-10);
  $('#k-rps').textContent = (last10.reduce((a, b) => a + b, 0) / last10.length).toFixed(1);
  $('#k-rps-spark').innerHTML = sparkline(series, { color: 'var(--primary)' });
  $('#k-lat').textContent = `${Math.round(m.latency.p50)} / ${Math.round(m.latency.p95)} / ${Math.round(m.latency.p99)}`;
  $('#k-lat-s').textContent = `ms · ${m.requests} requests total`;
  $('#k-cache').textContent = `${Math.round(m.cache.hitRatio * 100)}%`;
  $('#k-cache-s').textContent = `${m.cache.hits} hits · ${m.cache.misses} misses · ${m.cache.size} keys`;
  $('#k-events').textContent = m.publisher.published;
  $('#k-events-s').textContent = m.publisher.queued ? `${m.publisher.queued} buffered (bus down?)` : 'outbox empty · all delivered';
}

// ─────────────────────────── consistent hashing ring ───────────────────────────
function renderRing() {
  const pts = [...cluster.ringPoints].sort((a, b) => a[0] - b[0]);
  const R = 92;
  const C = 110;
  const ang = (pos) => (pos / 2 ** 32) * Math.PI * 2 - Math.PI / 2;
  const xy = (a, r = R) => [C + r * Math.cos(a), C + r * Math.sin(a)];
  let arcs = '';
  for (let i = 0; i < pts.length; i++) {
    const prev = i === 0 ? pts[pts.length - 1][0] - 2 ** 32 : pts[i - 1][0];
    const [a0, a1] = [ang(prev), ang(pts[i][0])];
    const [x0, y0] = xy(a0);
    const [x1, y1] = xy(a1);
    arcs += `<path d="M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}" stroke="${colorOf(pts[i][1])}" stroke-width="16" fill="none"/>`;
  }
  const marker = ringMarker ? (() => {
    const [x, y] = xy(ang(ringMarker.position), R + 16);
    const [x2, y2] = xy(ang(ringMarker.position), R - 12);
    return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="5" fill="#fff"/>`;
  })() : '';
  $('#ring-svg').innerHTML = `<svg viewBox="0 0 220 220" width="220" height="220">${arcs}${marker}
    <text x="110" y="106" text-anchor="middle" font-size="12" fill="var(--muted)">2³² key space</text>
    <text x="110" y="124" text-anchor="middle" font-size="11" fill="var(--muted)">${pts.length} vnodes</text></svg>`;
  $('#ring-legend').innerHTML = Object.entries(cluster.ring)
    .map(([id, share]) => `<div class="row"><span class="dot" style="color:${colorOf(id)};width:12px;height:12px"></span><b>${esc(id)}</b><span class="spacer"></span><span class="mono">${(share * 100).toFixed(1)}% of keys</span></div>`)
    .join('');
}

let ringMarker = null;
$('#ring-go').onclick = async () => {
  const key = $('#ring-key').value.trim();
  if (!key) return;
  const r = await api(`/api/admin/ring/lookup?key=${encodeURIComponent(key)}`);
  if (!r.ok) return;
  ringMarker = r.data;
  $('#ring-result').innerHTML = `<b>${esc(key)}</b> → hash <span class="mono">${esc(r.data.position)}</span> → first vnode clockwise belongs to <b style="color:${colorOf(r.data.shardId)}">${esc(r.data.shardId)}</b>`;
  renderRing();
};
$('#ring-key').addEventListener('keydown', (e) => e.key === 'Enter' && $('#ring-go').click());

// ─────────────────────────── breakers & bus ───────────────────────────
function renderBreakers() {
  const rows = cluster.clients.flatMap((c) =>
    c.breakers.map((b) => {
      const kind = b.state === 'CLOSED' ? 'ok' : b.state === 'OPEN' ? 'danger' : 'warn';
      return `<tr><td class="mono">${esc(b.name)}</td><td><span class="badge ${kind}">${esc(b.state)}</span></td><td class="mono">${b.success}</td><td class="mono">${b.failure}</td><td class="mono">${b.rejected}</td></tr>`;
    }),
  );
  const stats = cluster.clients
    .map((c) => `<span class="badge">${esc(c.shardId)}: ${c.stats.redirects} redirects · ${c.stats.retries} retries · ${c.stats.failovers} failovers</span>`)
    .join(' ');
  $('#breakers').innerHTML = `<table class="table"><thead><tr><th>Replica</th><th>State</th><th>OK</th><th>Fail</th><th>Rejected</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <div class="row wrap" style="padding:10px 14px">${stats}</div>`;
}

async function loadBus() {
  const r = await api('/api/admin/eventbus');
  if (!r.ok) return ($('#bus').innerHTML = '<div class="empty">Event bus unreachable — producers are buffering in their outbox.</div>');
  $('#bus').innerHTML = `<table class="table"><thead><tr><th>Topic</th><th>End offset</th><th>Consumer group</th><th>Lag</th></tr></thead><tbody>${r.data.topics
    .flatMap((t) =>
      (t.groups.length ? t.groups : [{ group: '—', lag: '—' }]).map(
        (g, i) => `<tr><td class="mono">${i ? '' : esc(t.name)}</td><td class="mono">${i ? '' : t.endOffset}</td><td class="mono">${esc(g.group)}</td>
          <td><span class="badge ${g.lag === 0 ? 'ok' : 'warn'}">${esc(g.lag)}</span></td></tr>`,
      ),
    )
    .join('')}</tbody></table>`;
}

// ─────────────────────────── live events ───────────────────────────
const EVENT_KIND = {
  ACCESS_DENIED: 'danger', BREAK_GLASS: 'danger', NODE_DOWN: 'danger', NODE_KILLED: 'danger', NO_LEADER: 'danger', AUTH_LOGIN_FAILURE: 'warn',
  AUTH_ACCOUNT_LOCKED: 'danger', RATE_LIMITED: 'warn', NODE_ISOLATED: 'warn', LEADER_ELECTED: 'warn', NODE_UP: 'ok', NODE_RESTARTED: 'ok',
  NODE_HEALED: 'ok', RECORD_CREATED: 'ok', CONSENT_GRANTED: 'ok', AUTH_LOGIN_SUCCESS: 'info', RECORD_READ: 'info',
};
function describe(e) {
  if (e.topic === 'cluster.events') {
    return `${esc(e.shardId ?? '')} ${e.nodeId ? '· node <b>' + esc(e.nodeId) + '</b>' : ''} ${e.term ? '· term ' + esc(e.term) : ''} ${e.by ? '· by ' + esc(e.by) : ''}`;
  }
  return `<b>${esc(e.actor?.name)}</b> ${e.patientId ? '→ <span class="mono">' + esc(e.patientId) + '</span>' : ''} ${e.reason ? '· ' + esc(e.reason) : ''}`;
}
stream(
  (e) => {
    const feed = $('#feed');
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = `<div class="t">${fmtTime(e.ts)}</div><div><span class="badge ${EVENT_KIND[e.type] ?? ''}">${esc(e.type)}</span> ${describe(e)}</div>`;
    feed.prepend(item);
    while (feed.children.length > 120) feed.lastChild.remove();
    if (!e.replay && e.type === 'LEADER_ELECTED') toast(`<b>${esc(e.nodeId)}</b> elected leader of ${esc(e.shardId)} (term ${esc(e.term)})`, 'warn');
  },
  (on) => $('#live').classList.toggle('off', !on),
);

// ─────────────────────────── audit ledger ───────────────────────────
async function loadLedger() {
  const [a, v] = await Promise.all([api('/api/admin/audit?limit=40'), api('/api/admin/audit/verify')]);
  if (!a.ok) return;
  const broken = v.data?.valid ? -1 : v.data?.brokenAt;
  $('#k-ledger').innerHTML = v.data?.valid ? '<span style="color:var(--ok)">Valid</span>' : '<span style="color:var(--danger)">broken</span>';
  $('#k-ledger-s').textContent = v.data?.valid ? `${v.data.length} blocks · head ${v.data.head.slice(0, 10)}…` : `integrity broken at block #${broken}`;
  const entries = a.data.entries;
  $('#chain').innerHTML = [...entries.slice(0, 8)]
    .reverse()
    .map(
      (e) => `<div class="lblock ${e.index >= broken && broken >= 0 ? 'bad' : ''}"><div class="bt">#${e.index} ${esc(e.data.type)}</div>
        <div>prev ${esc(e.prevHash.slice(0, 8))}</div><div style="color:var(--primary)">hash ${esc(e.hash.slice(0, 8))}</div></div>`,
    )
    .join('');
  $('#ledger-table').innerHTML = entries
    .map(
      (e) => `<div class="feed-item" style="${e.data.tampered ? 'background:var(--danger-soft)' : ''}"><div class="t">#${e.index}</div>
      <div><span class="badge ${EVENT_KIND[e.data.type] ?? ''}">${esc(e.data.type)}</span> <b>${esc(e.data.actor?.name)}</b>
      ${e.data.patientId ? '→ <span class="mono">' + esc(e.data.patientId) + '</span>' : ''} <span class="badge ${e.data.outcome === 'DENY' ? 'danger' : 'ok'}">${esc(e.data.outcome)}</span>
      ${e.data.tampered ? '<span class="badge danger">EDITED</span>' : ''}
      <div class="muted mono" style="font-size:10.5px">${esc(e.timestamp)} · ${esc(e.hash.slice(0, 24))}…</div></div></div>`,
    )
    .join('');
  return v.data;
}

$('#verify').onclick = async () => {
  const v = await loadLedger();
  $('#verify-result').innerHTML = v?.valid
    ? `<div class="banner info" style="margin:0">${icon('check', 16)} <div>Chain verified: all <b>${esc(v.length)}</b> blocks re-hashed and linked correctly. Head <span class="mono">${esc(v.head.slice(0, 16))}…</span></div></div>`
    : `<div class="banner danger" style="margin:0">${icon('alert', 16)} <div><b>Tampering detected</b> at block #${esc(v?.brokenAt)} (${esc(v?.reason)}). Every later block is untrusted.</div></div>`;
};
$('#tamper').onclick = async () => {
  const r = await api('/api/admin/audit/tamper', { method: 'POST', body: {} });
  if (r.ok) toast(`Simulated insider edit of block <b>#${esc(r.data.tamperedIndex)}</b> — now press <b>Verify chain</b>`, 'danger');
  loadLedger();
};
$('#restore').onclick = async () => {
  await api('/api/admin/audit/restore', { method: 'POST', body: {} });
  $('#verify-result').innerHTML = '';
  toast('Original block contents restored', 'ok');
  loadLedger();
};

// ─────────────────────────── chaos lab ───────────────────────────
const chaos = { running: false, probes: {}, timers: [] };
/**
 * Build each shard's row once, then update only its stats and bars. Rebuilding the
 * buttons 5×/s (every probe) would detach them mid-click and swallow user clicks.
 */
function renderChaos() {
  if (!cluster) return;
  const box = $('#chaos-shards');
  const key = cluster.shards.map((s) => s.id).join(',');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = cluster.shards
      .map(
        (s) => `<div class="stack" style="gap:8px" data-shard="${esc(s.id)}">
        <div class="row" style="padding:0 22px"><span class="dot" style="color:${colorOf(s.id)}"></span><b>${esc(s.id)}</b>
          <span class="chaos-stats row" style="gap:6px"></span><span class="spacer"></span>
          <button class="btn sm danger" data-kill-leader="${esc(s.id)}">Kill leader</button></div>
        <div class="probe-bars"></div>
      </div>`,
      )
      .join('');
  }
  for (const s of cluster.shards) {
    const row = box.querySelector(`[data-shard="${CSS.escape(s.id)}"]`);
    const p = chaos.probes[s.id] ?? [];
    const ok = p.filter((x) => x.ok).length;
    const fail = p.length - ok;
    const max = Math.max(0, ...p.filter((x) => x.ok).map((x) => x.ms));
    row.querySelector('.chaos-stats').innerHTML = `<span class="badge ok">${ok} committed</span><span class="badge ${fail ? 'danger' : ''}">${fail} failed</span>
      <span class="badge ${max > 400 ? 'warn' : ''}">worst ${max} ms</span>`;
    const btn = row.querySelector('[data-kill-leader]');
    const label = s.leaderId ? `Kill leader (${s.leaderId})` : 'Kill leader';
    if (btn.textContent !== label) btn.textContent = label;
    btn.disabled = !s.leaderId;
    row.querySelector('.probe-bars').innerHTML =
      p
        .slice(-90)
        .map((x) => `<i class="${x.ok ? (x.ms > 400 ? 'slow' : '') : 'fail'}" style="height:${x.ok ? Math.min(100, 6 + Math.log2(1 + x.ms) * 9) : 100}%" title="${x.ok ? x.ms + ' ms via ' + esc(x.servedBy) : 'FAILED'}"></i>`)
        .join('') || '<span class="muted" style="font-size:12px">Start write traffic, then kill a leader. Writes stall briefly during the election, but none are lost.</span>';
  }
}

$('#chaos-shards').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-kill-leader]');
  if (!b) return;
  const shard = cluster.shards.find((s) => s.id === b.dataset.killLeader);
  if (!shard?.leaderId) return;
  b.disabled = true;
  await api(`/api/admin/nodes/${shard.leaderId}/kill`, { method: 'POST' });
  toast(`Killed leader <b>${esc(shard.leaderId)}</b> of ${esc(shard.id)} — watch the election`, 'danger');
  loadCluster();
});

async function probeLoop(shardId) {
  while (chaos.running) {
    const t0 = performance.now();
    const r = await api('/api/admin/probe', { method: 'POST', body: { shardId } }).catch(() => ({ ok: false }));
    const ms = Math.round(performance.now() - t0);
    (chaos.probes[shardId] ??= []).push({ ok: r.ok && r.data?.ok, ms, servedBy: r.data?.servedBy });
    if (chaos.probes[shardId].length > 300) chaos.probes[shardId].shift();
    renderChaos();
    await new Promise((res) => setTimeout(res, 200));
  }
}

$('#chaos-toggle').onclick = () => {
  chaos.running = !chaos.running;
  $('#chaos-toggle').textContent = chaos.running ? 'Stop traffic' : 'Start write traffic';
  $('#chaos-toggle').classList.toggle('primary', !chaos.running);
  $('#chaos-toggle').classList.toggle('danger', chaos.running);
  if (chaos.running) cluster.shards.forEach((s) => probeLoop(s.id));
};

// ─────────────────────────── polling ───────────────────────────
async function loadCluster() {
  const r = await api('/api/admin/cluster');
  if (!r.ok) return;
  cluster = r.data;
  renderShards();
  renderBreakers();
  renderChaos();
  if (!$('#ring-svg').innerHTML) renderRing();
}

await loadCluster();
renderRing();
loadMetrics();
loadBus();
loadLedger();
setInterval(loadCluster, 1000);
setInterval(loadMetrics, 2000);
setInterval(loadBus, 3000);
setInterval(loadLedger, 5000);

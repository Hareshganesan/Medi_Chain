/**
 * Run model shared by the QA Lab server and the browser.
 * Both apply the same reporter events with applyEvent(), so the page can rebuild
 * the exact server state from a snapshot plus the live event stream.
 */
export function newRun({ id, kind, label, meta = {} }) {
  return {
    id,
    kind, // 'suite' | 'fault' | 'e2e'
    label,
    meta, // suite name, fault id, headed flag …
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    files: {}, // file → { tests: { id → test }, order: [id], state, duration, error }
    fileOrder: [],
    counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
    logs: [],
    verdict: null, // fault runs: 'killed' | 'survived' | 'error'
  };
}

const ensureFile = (run, file) => {
  if (!run.files[file]) {
    run.files[file] = { tests: {}, order: [], state: 'queued', duration: 0, error: null };
    run.fileOrder.push(file);
  }
  return run.files[file];
};

export function applyEvent(run, ev) {
  switch (ev.type) {
    case 'run-start':
      for (const f of ev.files ?? []) ensureFile(run, f);
      break;
    case 'module': {
      const f = ensureFile(run, ev.file);
      f.state = 'running';
      for (const t of ev.tests) {
        if (f.tests[t.id]) continue;
        f.tests[t.id] = { id: t.id, name: t.name, fullName: t.fullName, state: 'pending', duration: 0, error: null };
        f.order.push(t.id);
        run.counts.total++;
      }
      break;
    }
    case 'test-begin': {
      const t = ensureFile(run, ev.file).tests[ev.id];
      if (t) t.state = 'running';
      break;
    }
    case 'test': {
      const f = ensureFile(run, ev.file);
      let t = f.tests[ev.id];
      if (!t) {
        t = f.tests[ev.id] = { id: ev.id, name: ev.name, fullName: ev.fullName, state: 'pending', duration: 0, error: null };
        f.order.push(ev.id);
        run.counts.total++;
      }
      if (t.state === 'passed' || t.state === 'failed' || t.state === 'skipped') run.counts[t.state]--; // retried test
      t.state = ev.state === 'passed' || ev.state === 'failed' ? ev.state : 'skipped';
      t.duration = ev.duration ?? 0;
      t.error = ev.error ?? null;
      run.counts[t.state]++;
      if (f.state === 'queued') f.state = 'running';
      break;
    }
    case 'module-end': {
      const f = ensureFile(run, ev.file);
      f.duration = ev.duration ?? 0;
      f.error = ev.error ?? null;
      const failed = ev.state === 'failed' || Object.values(f.tests).some((t) => t.state === 'failed');
      f.state = failed ? 'failed' : 'passed';
      break;
    }
    case 'log':
      run.logs.push(ev.text);
      if (run.logs.length > 200) run.logs.shift();
      break;
    case 'end':
      run.status = ev.status;
      run.endedAt = ev.endedAt ?? Date.now();
      run.verdict = ev.verdict ?? null;
      run.exitCode = ev.exitCode ?? null;
      for (const f of Object.values(run.files)) if (f.state === 'running' || f.state === 'queued') f.state = ev.status === 'stopped' ? 'stopped' : f.state === 'queued' ? 'skipped' : 'failed';
      break;
    default:
      break;
  }
  return run;
}

/** Test cases that failed in a run, as "file › name" — what "caught" a seeded fault. */
export function failedTests(run) {
  const out = [];
  for (const file of run.fileOrder) {
    const f = run.files[file];
    for (const id of f.order) if (f.tests[id].state === 'failed') out.push({ file, ...f.tests[id] });
    if (f.error && !f.order.some((id) => f.tests[id].state === 'failed')) out.push({ file, name: 'Test file failed to load', error: f.error });
  }
  return out;
}

/** Stable test-case ID (TC-…, E2E-…, DT-…) at the start of a test name, if any. */
export const caseId = (name = '') => (name.match(/^((?:TC|E2E)-[A-Z0-9]+(?:-[A-Z0-9]+)*)/) || [])[1] ?? null;

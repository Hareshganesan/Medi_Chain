/**
 * QA Lab engine: runs test suites, seeded-fault experiments and browser tests as child
 * processes, parses their live reporter output and broadcasts every event to subscribers.
 *
 * Only one run executes at a time, because integration and E2E suites bind real ports.
 * Commands are fixed: callers choose a suite or fault by ID, never pass raw arguments.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAULTS, faultById, forSource, occurrences } from './faults.js';
import { newRun, applyEvent, failedTests } from './public/model.js';
import { headedChannel } from '../scripts/browser-channel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK = '@@QA@@';

export const SUITES = {
  unit: { label: 'Unit tests', paths: ['tests/unit'] },
  integration: { label: 'Integration tests', paths: ['tests/integration/services.test.js', 'tests/integration/raft-http.test.js', 'tests/integration/gateway-api.test.js'] },
  security: { label: 'Security tests (OWASP API Top 10)', paths: ['tests/integration/security.test.js'] },
  chaos: { label: 'Chaos test (Jepsen-style)', paths: ['tests/chaos'] },
  all: { label: 'Full automated suite', paths: [] },
};

export class BusyError extends Error {
  constructor() {
    super('Another run is in progress');
    this.code = 'BUSY';
  }
}

/**
 * Copy the code under test into a throw-away folder and apply exactly one fault to the copy.
 * The folder must sit inside the project, so the copied tests still resolve node_modules.
 */
export function prepareSandbox(root, dir, fault) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const item of ['src', 'tests', 'cluster.config.js', 'vitest.config.js']) {
    fs.cpSync(path.join(root, item), path.join(dir, item), { recursive: true });
  }
  const target = path.join(dir, fault.file);
  const source = fs.readFileSync(target, 'utf8');
  const hits = occurrences(fault, source);
  if (hits !== 1) throw new Error(`${fault.id}: expected the faulty line once in ${fault.file}, found it ${hits} times`);
  const { find, replace } = forSource(fault, source);
  fs.writeFileSync(target, source.replace(find, () => replace));
  return target;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

export function createLab({ root, sandboxDir = path.join(root, '.qa-sandbox'), node = process.execPath, historySize = 25 } = {}) {
  const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  const reporter = path.join(HERE, 'live-reporter.js');
  const pwReporter = path.join(HERE, 'pw-reporter.js');

  const listeners = new Set();
  const history = [];
  const latest = new Map(); // test full name → 'passed' | 'failed' | 'skipped' (from real suite runs only)
  let current = null;
  let last = null; // the most recent finished run, so a reloaded page can still show it
  let child = null;
  let campaign = null; // "run every seeded fault" progress
  let seq = 0;

  const broadcast = (ev) => {
    for (const fn of listeners) fn(ev);
  };

  function summary(run) {
    return {
      id: run.id, kind: run.kind, label: run.label, meta: run.meta, status: run.status, verdict: run.verdict,
      counts: run.counts, startedAt: run.startedAt, endedAt: run.endedAt,
      caughtBy: run.kind === 'fault' ? failedTests(run).map((t) => t.name).slice(0, 20) : undefined,
    };
  }

  /** Spawn one test process and stream its @@QA@@ events. Resolves with the finished run. */
  function execute(run, args, { cwd, env = {}, onFinish } = {}) {
    current = run;
    broadcast({ type: 'run', run: structuredClone(run) });
    return new Promise((resolve) => {
      const proc = spawn(node, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env }, windowsHide: true });
      child = proc;
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          let ev;
          if (line.startsWith(MARK)) {
            try {
              ev = JSON.parse(line.slice(MARK.length));
            } catch {
              continue;
            }
          } else if (line.trim()) {
            ev = { type: 'log', text: line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500) };
          } else continue;
          applyEvent(run, ev);
          broadcast({ type: 'event', runId: run.id, event: ev });
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close', (code) => {
        child = null;
        const stopped = run.stopRequested;
        const failed = run.counts.failed > 0 || failedTests(run).length > 0;
        let status = stopped ? 'stopped' : code === 0 && !failed ? 'passed' : 'failed';
        let verdict = null;
        if (run.kind === 'fault' && !stopped) verdict = failed ? 'killed' : code === 0 ? 'survived' : 'error';
        if (run.kind === 'fault' && !stopped) status = 'done';
        const end = { type: 'end', status, verdict, exitCode: code, endedAt: Date.now() };
        applyEvent(run, end);
        broadcast({ type: 'event', runId: run.id, event: end });
        onFinish?.(run);
        history.unshift(summary(run));
        history.length = Math.min(history.length, historySize);
        current = null;
        last = run;
        broadcast({ type: 'run', run: summary(run), finished: true });
        resolve(run);
      });
    });
  }

  function guard() {
    if (current || campaign?.running) throw new BusyError();
  }

  function recordResults(run) {
    for (const file of run.fileOrder) for (const t of Object.values(run.files[file].tests)) if (t.state !== 'pending') latest.set(t.fullName, t.state);
  }

  function runSuite(name) {
    const suite = SUITES[name];
    if (!suite) throw Object.assign(new Error(`Unknown suite "${name}"`), { code: 'BAD_REQUEST' });
    guard();
    const run = newRun({ id: `R${++seq}`, kind: 'suite', label: suite.label, meta: { suite: name } });
    const done = execute(run, [vitestBin, 'run', ...suite.paths, '--reporter', reporter], { cwd: root, onFinish: recordResults });
    return { run, done };
  }

  function runFault(id) {
    const fault = faultById(id);
    if (!fault) throw Object.assign(new Error(`Unknown fault "${id}"`), { code: 'NOT_FOUND' });
    guard();
    return startFault(fault);
  }

  function startFault(fault) {
    const run = newRun({ id: `R${++seq}`, kind: 'fault', label: `${fault.id} · ${fault.title}`, meta: { fault: fault.id } });
    const dir = path.join(sandboxDir, run.id);
    try {
      prepareSandbox(root, dir, fault);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw Object.assign(err, { code: 'FAULT_DRIFT' });
    }
    const done = execute(run, [vitestBin, 'run', ...fault.tests, '--reporter', reporter], {
      cwd: dir,
      onFinish: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    });
    return { run, done };
  }

  function runAllFaults() {
    guard();
    campaign = { running: true, total: FAULTS.length, results: [], startedAt: Date.now() };
    broadcast({ type: 'campaign', campaign: structuredClone(campaign) });
    const done = (async () => {
      for (const fault of FAULTS) {
        if (campaign.stopRequested) break;
        let result;
        try {
          const { run, done: finished } = startFault(fault);
          await finished;
          result = { id: fault.id, verdict: run.verdict ?? run.status, caughtBy: failedTests(run).map((t) => t.name), ms: run.endedAt - run.startedAt };
        } catch (err) {
          result = { id: fault.id, verdict: 'error', caughtBy: [], error: err.message };
        }
        campaign.results.push(result);
        broadcast({ type: 'campaign', campaign: structuredClone(campaign) });
      }
      campaign.running = false;
      campaign.endedAt = Date.now();
      broadcast({ type: 'campaign', campaign: structuredClone(campaign) });
      return campaign;
    })();
    return { campaign, done };
  }

  function runE2E({ headed = true, slowMo = 200 } = {}) {
    guard();
    const run = newRun({ id: `R${++seq}`, kind: 'e2e', label: headed ? 'Browser tests (visible browser)' : 'Browser tests (headless)', meta: { headed } });
    const args = [playwrightCli, 'test', '--reporter', pwReporter, ...(headed ? ['--headed'] : [])];
    const done = execute(run, args, { cwd: root, env: { PW_SLOWMO: headed ? String(slowMo) : '0', PW_CHANNEL: headed ? headedChannel() : '' }, onFinish: recordResults });
    return { run, done };
  }

  function stop() {
    if (campaign?.running) campaign.stopRequested = true;
    if (!current) return false;
    current.stopRequested = true;
    killTree(child);
    return true;
  }

  return {
    root,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    state: () => ({ current: current ? structuredClone(current) : null, last: last ? structuredClone(last) : null, campaign: campaign ? structuredClone(campaign) : null, history: [...history] }),
    latestResults: () => latest,
    seedResults(entries) {
      for (const [name, state] of entries) if (!latest.has(name)) latest.set(name, state);
    },
    runSuite,
    runFault,
    runAllFaults,
    runE2E,
    stop,
    busy: () => Boolean(current || campaign?.running),
  };
}

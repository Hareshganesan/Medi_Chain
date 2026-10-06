/**
 * MediChain QA Lab — a live test-demonstration console, separate from the system under test.
 *
 *   npm run lab        → http://127.0.0.1:9000
 *
 * Runs the real test suites and streams every test case to the browser, injects seeded
 * faults into a sandbox copy of the code to show the tests catching them, launches the
 * Playwright browser tests in a visible window, and shows coverage, mutation score,
 * requirement traceability and defects from the reports the tools write.
 * It listens on 127.0.0.1 only: it starts processes, so it must not be reachable from the network.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab, SUITES } from './lab.js';
import { FAULTS, faultDiff } from './faults.js';
import * as quality from './quality.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createLabServer({ root = path.resolve(HERE, '..'), lab = createLab({ root }) } = {}) {
  const j = quality.junit(root);
  if (j) lab.seedResults(j.results);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    next();
  });

  // Page, shared design system and the reports the tools generate.
  app.use(express.static(path.join(HERE, 'public')));
  app.use('/css', express.static(path.join(root, 'public', 'css')));
  app.get('/js/icons.js', (req, res) => res.sendFile(path.join(root, 'public', 'js', 'icons.js')));
  app.use('/reports', express.static(path.join(root, 'reports'), { extensions: ['html'] }));

  const fail = (res, err) => {
    const status = { BUSY: 409, NOT_FOUND: 404, BAD_REQUEST: 400, FAULT_DRIFT: 409 }[err.code] ?? 500;
    res.status(status).json({ error: err.code ?? 'ERROR', message: err.message });
  };

  app.get('/api/state', (req, res) => res.json(lab.state()));

  const SHORT = { unit: 'Unit', integration: 'Integration', security: 'Security', chaos: 'Chaos', all: 'Full suite' };
  app.get('/api/suites', (req, res) => {
    const files = quality.junit(root)?.files ?? {};
    const count = (paths) =>
      Object.entries(files)
        .filter(([f]) => !paths.length || paths.some((p) => f === p || f.startsWith(p + '/')))
        .reduce((s, [, n]) => s + n, 0) || null;
    res.json({ suites: Object.entries(SUITES).map(([id, s]) => ({ id, label: s.label, short: SHORT[id] ?? id, paths: s.paths, tests: count(s.paths) })) });
  });

  app.get('/api/faults', (req, res) => {
    res.json({
      faults: FAULTS.map((f) => {
        const source = fs.readFileSync(path.join(root, f.file), 'utf8');
        const { find, replace, ...rest } = f;
        return { ...rest, diff: faultDiff(f, source) };
      }),
    });
  });

  app.get('/api/quality', (req, res) => {
    const results = lab.latestResults();
    res.json({
      coverage: quality.coverage(root),
      mutation: quality.mutation(root),
      junit: (({ results: _r, ...rest }) => rest)(quality.junit(root) ?? { results: [] }),
      load: quality.loadTest(root),
      catalogue: quality.catalogue(root),
      defects: quality.defects(root),
      traceability: quality.traceability(root, results),
      reports: quality.reportLinks(root),
    });
  });

  app.post('/api/runs', (req, res) => {
    try {
      const { run } = lab.runSuite(String(req.body?.suite ?? ''));
      res.status(202).json({ id: run.id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/faults/:id/run', (req, res) => {
    try {
      const { run } = lab.runFault(req.params.id);
      res.status(202).json({ id: run.id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/faults/run-all', (req, res) => {
    try {
      lab.runAllFaults();
      res.status(202).json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/e2e', (req, res) => {
    try {
      const { run } = lab.runE2E({ headed: req.body?.headed !== false });
      res.status(202).json({ id: run.id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/stop', (req, res) => res.json({ stopped: lab.stop() }));

  // Server-Sent Events: every reporter event, run start/finish and fault-campaign progress.
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    send({ type: 'hello', state: lab.state() });
    const off = lab.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return { app, lab };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.QA_LAB_PORT || 9000);
  const { app, lab } = createLabServer();
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`\n\x1b[1m\x1b[35m  MediChain QA Lab\x1b[0m  →  http://127.0.0.1:${port}\n`);
    console.log('  Run the test suites live, inject seeded faults, launch browser tests,');
    console.log('  and review coverage, mutation score and traceability.  Ctrl+C to stop.\n');
  });
  const shutdown = () => {
    lab.stop();
    server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

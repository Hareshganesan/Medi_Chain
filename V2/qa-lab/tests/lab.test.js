import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { FAULTS, faultById, faultDiff, forSource, occurrences } from '../faults.js';
import { prepareSandbox, createLab } from '../lab.js';
import { newRun, applyEvent, failedTests, caseId } from '../public/model.js';
import { expandIds, traceability, mutationScore, junit, mdTables } from '../quality.js';
import { createLabServer } from '../server.js';
import { headedChannel } from '../../scripts/browser-channel.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('QA Lab: seeded-fault catalogue', () => {
  it('TC-LAB-01: every seeded fault matches exactly one place in its source file', () => {
    for (const f of FAULTS) {
      const source = fs.readFileSync(path.join(ROOT, f.file), 'utf8');
      expect(occurrences(f, source), `${f.id} in ${f.file}`).toBe(1);
      expect(f.replace).not.toBe(f.find);
    }
  });

  it('TC-LAB-02: IDs are unique and sequential, and every listed test file exists', () => {
    expect(FAULTS.map((f) => f.id)).toEqual(FAULTS.map((_, i) => `SF-${String(i + 1).padStart(2, '0')}`));
    for (const f of FAULTS) {
      expect(f.tests.length).toBeGreaterThan(0);
      for (const t of f.tests) expect(fs.existsSync(path.join(ROOT, t)), `${f.id} → ${t}`).toBe(true);
    }
    expect(faultById('SF-05').file).toBe('src/common/circuit-breaker.js');
    expect(faultById('SF-99')).toBeUndefined();
  });

  it('TC-LAB-03: faultDiff shows the line number, the correct line and the faulty line', () => {
    const f = faultById('SF-13');
    const d = faultDiff(f, 'const A = 1;\nconst MAX_AGE_YEARS = 130;\nconst B = 2;\n');
    expect(d).toEqual({ line: 2, before: ['const MAX_AGE_YEARS = 130;'], after: ['const MAX_AGE_YEARS = 150;'] });
    expect(faultDiff(f, 'nothing here')).toBeNull();
  });

  it('TC-LAB-04: multi-line faults also match files with Windows (CRLF) line endings', () => {
    const f = faultById('SF-11');
    const lf = 'if (x) {\n      this.applied.set(cmd.requestId, result);\n}\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(occurrences(f, lf)).toBe(1);
    expect(occurrences(f, crlf)).toBe(1);
    expect(forSource(f, crlf).replace.endsWith('\r\n')).toBe(true);
    expect(faultDiff(f, crlf).line).toBe(2);
  });
});

describe('QA Lab: sandbox', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qalab-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('TC-LAB-05: the fault is applied to the sandbox copy only; the real source is untouched', () => {
    const f = faultById('SF-01');
    const original = fs.readFileSync(path.join(ROOT, f.file), 'utf8');
    const target = prepareSandbox(ROOT, path.join(tmp, 'box'), f);
    expect(fs.readFileSync(target, 'utf8')).toContain(f.replace);
    expect(fs.readFileSync(target, 'utf8')).not.toContain(f.find);
    expect(fs.readFileSync(path.join(ROOT, f.file), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(tmp, 'box', 'tests', 'unit', 'rbac.test.js'))).toBe(true);
  });

  it('TC-LAB-06: a fault whose code has changed is refused instead of silently testing nothing', () => {
    const drifted = { ...faultById('SF-01'), find: 'this text is not in the file' };
    expect(() => prepareSandbox(ROOT, path.join(tmp, 'drift'), drifted)).toThrow(/found it 0 times/);
  });
});

describe('QA Lab: run model', () => {
  const stream = [
    { type: 'run-start', files: ['tests/unit/a.test.js', 'tests/unit/b.test.js'] },
    { type: 'module', file: 'tests/unit/a.test.js', tests: [{ id: '1', name: 'TC-A-01: ok', fullName: 'A > TC-A-01: ok' }, { id: '2', name: 'TC-A-02: bad', fullName: 'A > TC-A-02: bad' }] },
    { type: 'test', file: 'tests/unit/a.test.js', id: '1', name: 'TC-A-01: ok', state: 'passed', duration: 3 },
    { type: 'test', file: 'tests/unit/a.test.js', id: '2', name: 'TC-A-02: bad', state: 'failed', duration: 4, error: { message: 'expected 1 to be 2' } },
    { type: 'module-end', file: 'tests/unit/a.test.js', state: 'failed', duration: 9 },
    { type: 'module-end', file: 'tests/unit/b.test.js', state: 'failed', duration: 1, error: { message: 'SyntaxError: Unexpected token' } },
    { type: 'log', text: '[chaos] acked=75 lost=0' },
  ];

  it('TC-LAB-07: reporter events build counts, per-file states and the console log', () => {
    const run = newRun({ id: 'R1', kind: 'suite', label: 'x' });
    for (const ev of stream) applyEvent(run, ev);
    expect(run.counts).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(run.files['tests/unit/a.test.js'].state).toBe('failed');
    expect(run.fileOrder).toEqual(['tests/unit/a.test.js', 'tests/unit/b.test.js']);
    expect(run.logs).toEqual(['[chaos] acked=75 lost=0']);
    applyEvent(run, { type: 'end', status: 'failed', exitCode: 1 });
    expect(run.status).toBe('failed');
  });

  it('TC-LAB-08: a retried test is counted once, with its final result', () => {
    const run = newRun({ id: 'R2', kind: 'e2e', label: 'x' });
    applyEvent(run, stream[1]);
    applyEvent(run, { ...stream[3] });
    applyEvent(run, { ...stream[3], state: 'passed', error: undefined });
    expect(run.counts).toMatchObject({ total: 2, passed: 1, failed: 0 });
  });

  it('TC-LAB-09: failedTests lists failing cases and test files that failed to load', () => {
    const run = newRun({ id: 'R3', kind: 'fault', label: 'x' });
    for (const ev of stream) applyEvent(run, ev);
    expect(failedTests(run).map((t) => t.name)).toEqual(['TC-A-02: bad', 'Test file failed to load']);
    expect(caseId('TC-RBAC-29 (BVA): grant expiring now')).toBe('TC-RBAC-29');
    expect(caseId('E2E-06: break-glass')).toBe('E2E-06');
    expect(caseId('no id here')).toBeNull();
  });
});

describe('QA Lab: quality evidence', () => {
  it.each([
    ['TC-API-01..03', ['TC-API-01', 'TC-API-02', 'TC-API-03']],
    ['TC-AUTH-03, 04, TC-SEC-06', ['TC-AUTH-03', 'TC-AUTH-04', 'TC-SEC-06']],
    ['TC-VAL-NAME/DOB/PII', ['TC-VAL-NAME', 'TC-VAL-DOB', 'TC-VAL-PII']],
    ['TC-RBAC DT-01..02', ['TC-RBAC DT-01', 'TC-RBAC DT-02']],
    ['TC-NOTIFY (8 rules)', ['TC-NOTIFY']],
    ['TC-API-22, load test', ['TC-API-22']],
    ['—', []],
  ])('TC-LAB-10: traceability cell "%s" expands to its test IDs', (cell, ids) => {
    expect(expandIds(cell)).toEqual(ids);
  });

  it('TC-LAB-11: a requirement is "failing" if any traced test failed, "not-run" if none ran', () => {
    const results = new Map([
      ['Auth > TC-AUTH-01: login works', 'passed'],
      ['API > TC-API-01: token issued', 'failed'],
      ['API > TC-API-010: a different test', 'passed'],
    ]);
    const rows = traceability(ROOT, results);
    const fr01 = rows.find((r) => r.id === 'FR-01');
    expect(fr01).toMatchObject({ status: 'failing', failed: 1, passed: 1 });
    expect(rows.find((r) => r.id === 'NFR-12').status).toBe('not-run');
    expect(rows).toHaveLength(22);
  });

  it('TC-LAB-12: mutation score = detected / (detected + survived + no coverage)', () => {
    expect(mutationScore({ Killed: 90, Timeout: 5, Survived: 4, NoCoverage: 1, CompileError: 7, Ignored: 3 })).toBe(95);
    expect(mutationScore({})).toBeNull();
  });

  it('TC-LAB-13: the JUnit parser reads totals and each test result, and markdown tables parse', () => {
    const report = junit(ROOT);
    expect(report.tests).toBe(report.results.length);
    expect(report.results.every(([, s]) => ['passed', 'failed', 'skipped'].includes(s))).toBe(true);
    expect(Object.values(report.files).reduce((a, b) => a + b, 0)).toBe(report.tests);
    expect(mdTables('| a | b |\n| --- | --- |\n| 1 | x \\| y |\n\ntext')).toEqual([{ header: ['a', 'b'], rows: [['1', 'x | y']] }]);
  });
});

describe('QA Lab: visible browser choice', () => {
  it('TC-LAB-16: visible demos use installed Edge on Windows; PW_CHANNEL always wins', () => {
    expect(headedChannel({}, 'win32', () => true)).toBe('msedge');
    expect(headedChannel({}, 'win32', () => false)).toBe('');
    expect(headedChannel({}, 'linux', () => true)).toBe('');
    expect(headedChannel({ PW_CHANNEL: 'chrome' }, 'win32', () => true)).toBe('chrome');
  });
});

describe('QA Lab: HTTP API', () => {
  let app;
  let lab;
  beforeAll(() => {
    ({ app, lab } = createLabServer({ root: ROOT, lab: createLab({ root: ROOT, sandboxDir: path.join(ROOT, '.qa-sandbox', 'self-test') }) }));
  });

  it('TC-LAB-14: rejects unknown suites and faults; the fault list hides the raw patch but shows the diff', async () => {
    await request(app).post('/api/runs').send({ suite: 'everything; rm -rf /' }).expect(400);
    await request(app).post('/api/faults/SF-99/run').expect(404);
    const { body } = await request(app).get('/api/faults').expect(200);
    expect(body.faults).toHaveLength(FAULTS.length);
    expect(body.faults[0]).not.toHaveProperty('find');
    expect(body.faults[0].diff.line).toBeGreaterThan(0);
    const page = await request(app).get('/').expect(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('TC-LAB-15: a seeded fault run through the API is caught, and a second run is refused while busy', async () => {
    const finished = new Promise((resolve) => lab.subscribe((ev) => ev.type === 'run' && ev.finished && resolve(ev.run)));
    await request(app).post('/api/faults/SF-13/run').expect(202);
    await request(app).post('/api/runs').send({ suite: 'unit' }).expect(409);
    const run = await finished;
    expect(run.verdict).toBe('killed');
    expect(run.caughtBy.some((n) => n.startsWith('TC-VAL-DOB'))).toBe(true);
    const { body } = await request(app).get('/api/state').expect(200);
    expect(body.current).toBeNull();
    expect(body.history[0].verdict).toBe('killed');
  });
});

/**
 * Reads the evidence the test tools already produce (coverage JSON, Stryker JSON, JUnit XML,
 * the load-test report and the generated docs) and turns it into data for the QA Lab dashboard.
 * Every function tolerates a missing file, because a fresh checkout has no reports yet.
 */
import fs from 'node:fs';
import path from 'node:path';

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const mtime = (file) => {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
};
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const plain = (s) => s.replace(/\*\*|`/g, '').trim();

/** Rows of every markdown pipe table in `md`, as arrays of trimmed cells (header and separator rows dropped). */
export function mdTables(md) {
  const tables = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('|')) {
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      if (!cur) cur = { header: cells, rows: [] };
      else if (!cells.every((c) => /^:?-+:?$/.test(c))) cur.rows.push(cells);
    } else if (cur) {
      tables.push(cur);
      cur = null;
    }
  }
  if (cur) tables.push(cur);
  return tables;
}

export function coverage(root) {
  const file = path.join(root, 'reports', 'coverage', 'coverage-summary.json');
  const raw = read(file);
  if (!raw) return null;
  const json = JSON.parse(raw);
  const pick = (m) => ({ lines: m.lines.pct, branches: m.branches.pct, functions: m.functions.pct, statements: m.statements.pct });
  const files = Object.entries(json)
    .filter(([k]) => k !== 'total')
    .map(([k, m]) => ({ file: path.relative(path.join(root, 'src'), k).split(path.sep).join('/'), ...pick(m) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const modules = {};
  for (const [k, m] of Object.entries(json)) {
    if (k === 'total') continue;
    const mod = path.relative(path.join(root, 'src'), k).split(path.sep)[0];
    const acc = (modules[mod] ??= { name: mod, lines: [0, 0], branches: [0, 0], functions: [0, 0] });
    for (const key of ['lines', 'branches', 'functions']) {
      acc[key][0] += m[key].covered;
      acc[key][1] += m[key].total;
    }
  }
  const pct = ([c, t]) => (t ? Math.round((c / t) * 1000) / 10 : 100);
  return {
    generatedAt: mtime(file),
    total: pick(json.total),
    modules: Object.values(modules).map((m) => ({ name: m.name, lines: pct(m.lines), branches: pct(m.branches), functions: pct(m.functions) })),
    files,
  };
}

// First Stryker run, before the mutation-driven tests were written (docs/TEST_REPORT.md §4).
const MUTATION_BASELINE = {
  'src/common/rbac.js': 92.0,
  'src/common/rate-limiter.js': 81.4,
  'src/common/hash-chain.js': 83.0,
  'src/raft/kv-state-machine.js': 80.7,
  'src/common/lru-cache.js': 87.5,
  'src/common/circuit-breaker.js': 81.8,
  'src/common/consistent-hash.js': 80.8,
};

export const mutationScore = (c) => {
  const detected = (c.Killed ?? 0) + (c.Timeout ?? 0);
  const valid = detected + (c.Survived ?? 0) + (c.NoCoverage ?? 0);
  return valid ? Math.round((detected / valid) * 1000) / 10 : null;
};

export function mutation(root) {
  const file = path.join(root, 'reports', 'mutation', 'mutation.json');
  const raw = read(file);
  if (!raw) return null;
  const json = JSON.parse(raw);
  const total = {};
  const files = Object.entries(json.files).map(([name, f]) => {
    const counts = {};
    for (const m of f.mutants) {
      counts[m.status] = (counts[m.status] ?? 0) + 1;
      total[m.status] = (total[m.status] ?? 0) + 1;
    }
    const survivors = f.mutants
      .filter((m) => m.status === 'Survived')
      .slice(0, 5)
      .map((m) => ({ line: m.location.start.line, mutator: m.mutatorName, replacement: m.replacement }));
    return { file: name, mutants: f.mutants.length, counts, score: mutationScore(counts), before: MUTATION_BASELINE[name] ?? null, survivors };
  });
  const before = 84.4;
  return { generatedAt: mtime(file), mutants: files.reduce((s, f) => s + f.mutants, 0), counts: total, score: mutationScore(total), before, files };
}

/** Last full Vitest run, from the JUnit XML that every `npm test` writes. */
export function junit(root) {
  const file = path.join(root, 'reports', 'junit.xml');
  const xml = read(file);
  if (!xml) return null;
  const head = xml.match(/<testsuites[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"[^>]*time="([\d.]+)"/);
  const stamp = xml.match(/timestamp="([^"]+)"/);
  const results = [];
  const re = /<testcase\b[^>]*\bname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const body = m[3] ?? '';
    const state = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    results.push([unescapeXml(m[1]), state]);
  }
  const files = {};
  for (const m of xml.matchAll(/<testsuite\b[^>]*\bname="([^"]*)"[^>]*\btests="(\d+)"/g)) files[unescapeXml(m[1])] = Number(m[2]);
  return {
    files,
    tests: head ? Number(head[1]) : results.length,
    failures: head ? Number(head[2]) + Number(head[3]) : results.filter(([, s]) => s === 'failed').length,
    seconds: head ? Number(head[4]) : null,
    timestamp: stamp?.[1] ?? mtime(file),
    results,
  };
}

export function loadTest(root) {
  const file = path.join(root, 'reports', 'load-test.md');
  const md = read(file);
  if (!md) return null;
  const t = mdTables(md)[0];
  if (!t) return null;
  const col = (name) => t.header.findIndex((h) => h.toLowerCase().startsWith(name));
  const [s, rps, p50, p99, errors, non2xx] = ['scenario', 'req/s', 'p50', 'p99', 'errors', 'non-2xx'].map(col);
  return {
    generatedAt: mtime(file),
    rows: t.rows.map((r) => ({ scenario: r[s], rps: Number(r[rps]), p50: Number(r[p50]), p99: Number(r[p99]), errors: Number(r[errors]) + Number(r[non2xx] || 0) })),
  };
}

/** docs/TEST_CASES.md (generated from the test sources): counts per level and per design technique. */
export function catalogue(root) {
  const md = read(path.join(root, 'docs', 'TEST_CASES.md'));
  if (!md) return null;
  const levels = [];
  const techniques = {};
  const sections = md.split(/^## /m).slice(1);
  for (const sec of sections) {
    const name = sec.split('\n')[0].trim();
    const t = mdTables(sec)[0];
    if (!t) continue;
    levels.push({ name, cases: t.rows.length });
    for (const r of t.rows) for (const tech of r[2].split(',').map((x) => x.trim()).filter(Boolean)) techniques[tech] = (techniques[tech] ?? 0) + 1;
  }
  return {
    total: levels.reduce((s, l) => s + l.cases, 0),
    levels,
    techniques: Object.entries(techniques)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function defects(root) {
  const md = read(path.join(root, 'docs', 'TEST_REPORT.md'));
  if (!md) return [];
  const t = mdTables(md).find((x) => x.header[0] === 'ID' && x.rows[0]?.[0]?.startsWith('DEF-'));
  if (!t) return [];
  return t.rows.map(([id, foundBy, severity, description, fix]) => ({ id, foundBy: plain(foundBy), severity: plain(severity), description: plain(description), fix: plain(fix) }));
}

/**
 * Expand a traceability-matrix cell into test-case IDs:
 * "TC-API-01..03" → TC-API-01, -02, -03 · "TC-AUTH-03, 04" → TC-AUTH-03, TC-AUTH-04 ·
 * "TC-VAL-NAME/DOB" → TC-VAL-NAME, TC-VAL-DOB · "TC-NOTIFY (8 rules)" → TC-NOTIFY.
 */
export function expandIds(cell) {
  const ids = [];
  let prefix = '';
  for (let tok of cell.split(',')) {
    tok = tok.replace(/\(.*?\)/g, '').trim();
    if (!tok || tok === '—') continue;
    let m;
    if ((m = tok.match(/^(.*?)(\d+)\.\.(\d+)$/))) {
      if (m[1]) prefix = m[1];
      const width = m[2].length;
      for (let n = Number(m[2]); n <= Number(m[3]); n++) ids.push(prefix + String(n).padStart(width, '0'));
    } else if ((m = tok.match(/^(.*?)(\d+)$/)) && (m[1] === '' || /-$/.test(m[1]))) {
      if (m[1]) prefix = m[1];
      ids.push(prefix + m[2]);
    } else if (/^(TC|E2E|DT)-/.test(tok) && tok.includes('/')) {
      const [first, ...rest] = tok.split('/');
      const base = first.slice(0, first.lastIndexOf('-') + 1);
      ids.push(first, ...rest.map((r) => base + r));
    } else if (/^(TC|E2E|DT)-/.test(tok)) {
      ids.push(tok);
      prefix = tok.slice(0, tok.lastIndexOf('-') + 1);
    }
  }
  return [...new Set(ids)];
}

const idMatcher = (id) => new RegExp(`(^|[\\s>])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Z])`);

/** Requirements (docs/TEST_PLAN.md) joined with the latest result of every test that traces to them. */
export function traceability(root, results) {
  const md = read(path.join(root, 'docs', 'TEST_PLAN.md'));
  if (!md) return [];
  const tables = mdTables(md);
  const reqTable = tables.find((t) => t.header[0].startsWith('Req. ID'));
  const matrix = tables.find((t) => t.header[0].startsWith('Req.') && t.header.includes('Unit'));
  if (!reqTable || !matrix) return [];
  const names = [...results.entries()];
  return reqTable.rows.map(([id, text, priority]) => {
    const row = matrix.rows.find((r) => r[0] === id) ?? [];
    const levels = {};
    let passed = 0;
    let failed = 0;
    let linked = 0;
    matrix.header.slice(1).forEach((level, i) => {
      const ids = expandIds(row[i + 1] ?? '');
      levels[level] = ids;
      const matchers = ids.map(idMatcher);
      for (const [name, state] of names) {
        if (!matchers.some((re) => re.test(name))) continue;
        linked++;
        if (state === 'passed') passed++;
        else if (state === 'failed') failed++;
      }
    });
    const status = failed ? 'failing' : passed ? 'verified' : 'not-run';
    return { id, text: plain(text), priority: plain(priority), levels, linked, passed, failed, status };
  });
}

export function reportLinks(root) {
  const links = [
    ['Coverage report (V8)', 'reports/coverage/index.html'],
    ['Mutation report (Stryker)', 'reports/mutation/index.html'],
    ['Unit and integration report (Vitest)', 'reports/test-report/index.html'],
    ['Browser test report (Playwright)', 'reports/e2e/index.html'],
    ['Load test report', 'reports/load-test.md'],
    ['JUnit XML (for CI)', 'reports/junit.xml'],
  ];
  return links.map(([label, rel]) => ({ label, href: '/' + rel, exists: fs.existsSync(path.join(root, rel)), updatedAt: mtime(path.join(root, rel)) }));
}

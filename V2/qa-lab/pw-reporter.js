/**
 * Playwright reporter that emits the same @@QA@@ events as live-reporter.js,
 * so the QA Lab shows browser tests with the same live view as Vitest tests.
 */
import path from 'node:path';

const MARK = '@@QA@@';
const emit = (event) => process.stdout.write(MARK + JSON.stringify(event) + '\n');
const rel = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');
const STATE = { passed: 'passed', failed: 'failed', timedOut: 'failed', interrupted: 'failed', skipped: 'skipped' };
const strip = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

export default class PlaywrightLiveReporter {
  onBegin(config, suite) {
    const byFile = new Map();
    for (const t of suite.allTests()) {
      const file = rel(t.location.file);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id: t.id, name: t.title, fullName: t.titlePath().slice(3).join(' > ') || t.title });
    }
    emit({ type: 'run-start', files: [...byFile.keys()] });
    for (const [file, tests] of byFile) emit({ type: 'module', file, tests });
  }

  onTestBegin(test) {
    emit({ type: 'test-begin', file: rel(test.location.file), id: test.id, name: test.title });
  }

  onTestEnd(test, result) {
    emit({
      type: 'test',
      file: rel(test.location.file),
      id: test.id,
      name: test.title,
      fullName: test.title,
      state: STATE[result.status] ?? 'failed',
      duration: result.duration,
      error: result.error ? { message: strip(result.error.message).slice(0, 2000) } : undefined,
    });
  }

  onStdOut(chunk) {
    const text = strip(chunk).trim();
    if (text) emit({ type: 'log', text: text.slice(0, 500) });
  }

  onEnd(result) {
    emit({ type: 'run-end', reason: result.status === 'passed' ? 'passed' : 'failed', errors: [] });
  }

  printsToStdio() {
    return true;
  }
}

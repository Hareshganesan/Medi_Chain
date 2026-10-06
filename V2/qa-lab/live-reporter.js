/**
 * Vitest reporter that streams one JSON event per line to stdout, prefixed with @@QA@@.
 * The QA Lab server parses these lines and forwards them to the browser as they happen,
 * so the audience watches every test case pass or fail live.
 */
import path from 'node:path';

const MARK = '@@QA@@';
const emit = (event) => process.stdout.write(MARK + JSON.stringify(event) + '\n');
const rel = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');
const firstError = (errors) => {
  const e = errors?.[0];
  if (!e) return undefined;
  return { message: String(e.message ?? e).slice(0, 2000), expected: e.expected, actual: e.actual };
};

export default class LiveReporter {
  onTestRunStart(specifications) {
    emit({ type: 'run-start', files: specifications.map((s) => rel(s.moduleId)) });
  }

  onTestModuleCollected(testModule) {
    const tests = [...testModule.children.allTests()].map((t) => ({ id: t.id, name: t.name, fullName: t.fullName }));
    emit({ type: 'module', file: rel(testModule.moduleId), tests });
  }

  onTestCaseResult(testCase) {
    const r = testCase.result();
    emit({
      type: 'test',
      file: rel(testCase.module.moduleId),
      id: testCase.id,
      name: testCase.name,
      fullName: testCase.fullName,
      state: r.state,
      duration: Math.round(testCase.diagnostic()?.duration ?? 0),
      error: r.state === 'failed' ? firstError(r.errors) : undefined,
    });
  }

  onTestModuleEnd(testModule) {
    emit({
      type: 'module-end',
      file: rel(testModule.moduleId),
      state: testModule.state(),
      duration: Math.round(testModule.diagnostic()?.duration ?? 0),
      error: firstError(testModule.errors?.()),
    });
  }

  onUserConsoleLog(log) {
    const text = String(log.content ?? '').trim();
    if (text) emit({ type: 'log', text: text.slice(0, 500) });
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    emit({ type: 'run-end', reason, errors: unhandledErrors.map((e) => String(e.message ?? e).slice(0, 500)) });
  }
}

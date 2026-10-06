/**
 * Seeded-fault catalogue for the QA Lab ("fault seeding" / "defect seeding").
 *
 * Each entry is a realistic bug, written as an exact text substitution in one source file.
 * The lab copies the project into a sandbox, applies ONE fault, and runs only the tests
 * that should notice it. If at least one test fails, the fault is detected ("killed");
 * if every test still passes, the suite has a blind spot ("survived").
 *
 * The real source tree is never modified. tests in qa-lab/tests check that every `find`
 * string still occurs exactly once, so the catalogue cannot silently drift from the code.
 */
export const FAULTS = [
  {
    id: 'SF-01',
    title: 'Break-glass accepts a 9-character reason',
    category: 'Boundary',
    technique: 'Boundary value analysis',
    file: 'src/common/rbac.js',
    find: 'ctx.reason.trim().length < 10',
    replace: 'ctx.reason.trim().length < 9',
    tests: ['tests/unit/rbac.test.js'],
    explain: 'An off-by-one error: the rule says at least 10 characters. Only a test placed exactly on the boundary (9 vs 10 characters) can see it.',
  },
  {
    id: 'SF-02',
    title: 'Administrators can read patient records',
    category: 'Security',
    technique: 'Decision table',
    file: 'src/common/rbac.js',
    find: "return deny('ADMIN_NO_PHI_ACCESS');",
    replace: "return allow('ADMIN_NO_PHI_ACCESS');",
    tests: ['tests/unit/rbac.test.js'],
    explain: 'Least privilege is broken: operators could see clinical data. Every role × action combination is a row of the 28-rule decision table.',
  },
  {
    id: 'SF-03',
    title: "A patient can open another patient's data",
    category: 'Security',
    technique: 'Decision table + defense in depth',
    file: 'src/common/rbac.js',
    find: "return own ? allow('DATA_OWNER') : deny('NOT_OWNER');",
    replace: "return allow('DATA_OWNER');",
    tests: ['tests/unit/rbac.test.js', 'tests/integration/gateway-api.test.js'],
    explain: 'Insecure direct object reference (OWASP API1): the policy forgets the ownership check. The decision-table tests catch it. The API test TC-API-13 still passes, because the gateway checks ownership a second time, so no data would leak.',
  },
  {
    id: 'SF-04',
    title: 'Expired consent and break-glass never end',
    category: 'Logic',
    technique: 'Boundary value analysis (time)',
    file: 'src/common/rbac.js',
    find: 'new Date(g.expiresAt).getTime() <= now) return null;',
    replace: 'new Date(g.expiresAt).getTime() <= 0) return null;',
    tests: ['tests/unit/rbac.test.js'],
    explain: 'Emergency access is meant to last 30 minutes. With the expiry check broken it lasts forever. The tests inject a fake clock, so they can check the exact expiry moment.',
  },
  {
    id: 'SF-05',
    title: 'Circuit breaker opens one failure too late',
    category: 'State machine',
    technique: 'State transition testing',
    file: 'src/common/circuit-breaker.js',
    find: 'this.failures >= this.failureThreshold',
    replace: 'this.failures > this.failureThreshold',
    tests: ['tests/unit/circuit-breaker.test.js'],
    explain: 'The CLOSED → OPEN transition fires on the wrong failure count, so a dead replica keeps receiving traffic. The state-transition tests walk every edge of the breaker.',
  },
  {
    id: 'SF-06',
    title: 'Cache ignores expiry and serves stale data',
    category: 'Logic',
    technique: 'Functional test with an injected clock',
    file: 'src/common/lru-cache.js',
    find: 'if (!e || e.expires <= this.now()) {',
    replace: 'if (!e) {',
    tests: ['tests/unit/rate-limiter-cache.test.js', 'tests/unit/mutation-hardening.test.js'],
    explain: 'Time-to-live is ignored, so a doctor could see an outdated record. The cache takes a fake clock, so the test can move time forward without waiting.',
  },
  {
    id: 'SF-07',
    title: 'Encryption reuses the same nonce',
    category: 'Crypto',
    technique: 'Property-based + security test',
    file: 'src/common/crypto.js',
    find: 'const iv = randomBytes(12);',
    replace: 'const iv = Buffer.alloc(12); // fixed nonce',
    tests: ['tests/unit/crypto-hashchain.test.js'],
    explain: 'AES-GCM with a repeated nonce leaks data. Everything still decrypts correctly, so a happy-path test would pass. The test that equal plaintexts give different ciphertexts catches it.',
  },
  {
    id: 'SF-08',
    title: 'Audit ledger stops checking content hashes',
    category: 'Integrity',
    technique: 'Negative testing (tamper simulation)',
    file: 'src/common/hash-chain.js',
    find: "    if (computeHash(e) !== e.hash) return { valid: false, brokenAt: i, reason: 'CONTENT_HASH_MISMATCH' };\n",
    replace: '    // content hash no longer checked\n',
    tests: ['tests/unit/crypto-hashchain.test.js', 'tests/unit/mutation-hardening.test.js'],
    explain: 'An insider could edit history without being noticed. The tests tamper with a block on purpose and expect verification to name it.',
  },
  {
    id: 'SF-09',
    title: 'Raft commits a write without a majority',
    category: 'Distributed',
    technique: 'Fault injection (partition)',
    file: 'src/raft/raft-node.js',
    find: 'if (replicas >= this.majority())',
    replace: 'if (replicas >= 1)',
    tests: ['tests/unit/raft-node.test.js'],
    explain: 'The leader acknowledges a write that only it has stored. One crash later the write is gone. The tests partition the leader away from its followers and check that it cannot commit.',
  },
  {
    id: 'SF-10',
    title: 'Raft votes for a candidate with an old log',
    category: 'Distributed',
    technique: 'Fault injection (crash + election)',
    file: 'src/raft/raft-node.js',
    find: '      this.isLogUpToDate(lastLogIndex, lastLogTerm)\n    ) {',
    replace: '      true /* log freshness not checked */\n    ) {',
    tests: ['tests/unit/raft-node.test.js'],
    explain: "Raft's election restriction is removed, so a replica that missed writes can become leader and overwrite committed data.",
  },
  {
    id: 'SF-11',
    title: 'Retried writes are applied twice',
    category: 'Distributed',
    technique: 'Idempotency test',
    file: 'src/raft/kv-state-machine.js',
    find: '      this.applied.set(cmd.requestId, result);\n',
    replace: '      // request id not recorded\n',
    tests: ['tests/unit/infrastructure.test.js', 'tests/unit/raft-node.test.js', 'tests/unit/mutation-hardening.test.js'],
    explain: 'After a leader crash the client retries. Without request-ID deduplication the same prescription is stored twice.',
  },
  {
    id: 'SF-12',
    title: 'Hash ring wraps around to the wrong shard',
    category: 'Sharding',
    technique: 'Boundary + property-based test',
    file: 'src/common/consistent-hash.js',
    find: 'if (h > this.ring[hi].pos) return this.ring[0].node; // wrap around',
    replace: 'if (h > this.ring[hi].pos) return this.ring[hi].node; // wrap around',
    tests: ['tests/unit/consistent-hash.test.js'],
    explain: 'Keys past the last point on the ring should wrap to the first. Only a few keys are affected, which is why the test targets the exact wrap-around position.',
  },
  {
    id: 'SF-13',
    title: 'Registration accepts a 140-year-old patient',
    category: 'Validation',
    technique: 'Boundary value analysis',
    file: 'src/common/validation.js',
    find: 'const MAX_AGE_YEARS = 130;',
    replace: 'const MAX_AGE_YEARS = 150;',
    tests: ['tests/unit/validation.test.js'],
    explain: 'The maximum age moved from 130 to 150 years. The boundary tests check 130 (valid) and 131 (invalid).',
  },
  {
    id: 'SF-14',
    title: 'Phone numbers stored in plaintext',
    category: 'Security',
    technique: 'Integration test on every replica',
    file: 'src/gateway/ehr-repository.js',
    find: 'if (input[f]) patient[f] = encryptField(input[f], this.key);',
    replace: 'if (input[f]) patient[f] = input[f];',
    tests: ['tests/integration/gateway-api.test.js'],
    explain: 'The app still works and shows the right phone number, so no functional test notices. Only the test that reads the raw storage of every replica sees plaintext.',
  },
];

export const faultById = (id) => FAULTS.find((f) => f.id === id);

/** The fault's find/replace text with line endings matching the source file (some files are CRLF). */
export function forSource(fault, source) {
  if (!source.includes('\r\n')) return { find: fault.find, replace: fault.replace };
  const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
  return { find: crlf(fault.find), replace: crlf(fault.replace) };
}

/** How many times the fault's target text occurs in the source (must be exactly 1). */
export const occurrences = (fault, source) => source.split(forSource(fault, source).find).length - 1;

/** Line-level preview of a fault for the UI: 1-based line number plus before/after text. */
export function faultDiff(fault, source) {
  source = source.replace(/\r\n/g, '\n');
  const at = source.indexOf(fault.find);
  if (at < 0) return null;
  const line = source.slice(0, at).split('\n').length;
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  const endOfFind = at + fault.find.length;
  const lineEnd = source.indexOf('\n', fault.find.endsWith('\n') ? endOfFind - 1 : endOfFind);
  const before = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const after = before.replace(fault.find.replace(/\n$/, ''), fault.replace.replace(/\n$/, ''));
  return { line, before: before.split('\n'), after: after.split('\n') };
}

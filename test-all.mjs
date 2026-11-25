/**
 * The suite runner: run every section, then report ALL of them.
 *
 * `npm test` used to be `a && b && c …`, so the first failure hid every later
 * section. That is not a style problem: in 1.6.4 the host-range section went red
 * on a machine with a second DSH install, which meant the seven sections after
 * it — including the 25 mobile-shape assertions added in the same release —
 * never ran, and a shipped P0 (entry delete doing nothing on desktop/browser)
 * sat behind a green-looking log.
 *
 * Contract:
 *  - every section runs, always, in a fixed order;
 *  - each section's exit code is reported;
 *  - the process exits 1 if ANY section failed (a red suite is still red);
 *  - the last line is machine-readable enough for CI to grep.
 *
 * stdio is inherited on purpose: these scripts print their own PASS/FAIL lines
 * and some confined environments cannot start a child with piped stdio.
 */
import { spawnSync } from 'node:child_process'

const SECTIONS = [
  ['lint', 'lint.mjs'],
  ['host-range', 'host-range-test.mjs'],
  ['section-order', 'section-order-test.mjs'],
  ['smoke', 'smoke-test.mjs'],
  ['contract', 'contract-test.mjs'],
  ['verify', 'verify.mjs'],
  ['feedback', 'feedback-test.mjs'],
  ['ui', 'ui-test.mjs'],
  ['mobile-shape', 'mobile-shape-test.mjs'],
]

const results = []
for (const [name, file] of SECTIONS) {
  console.log('\n=== ' + name + ' (' + file + ') ===')
  const started = Date.now()
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  const code = res.status === null ? 1 : res.status
  results.push({ name, file, code, ms: Date.now() - started, error: res.error === undefined ? null : String(res.error) })
}

const failed = results.filter((entry) => entry.code !== 0)
console.log('\n=== summary ===')
for (const entry of results) {
  console.log((entry.code === 0 ? 'PASS  ' : 'FAIL  ') + entry.name.padEnd(14) + ' exit=' + entry.code + '  ' + entry.ms + 'ms'
    + (entry.error === null ? '' : '  (' + entry.error + ')'))
}
if (failed.length === 0) {
  console.log('\nALL SECTIONS PASS (' + results.length + '/' + results.length + ')')
  process.exit(0)
}
console.log('\n' + failed.length + ' SECTION(S) FAILED: ' + failed.map((entry) => entry.name).join(', ')
  + ' (' + (results.length - failed.length) + ' passed)')
process.exit(1)

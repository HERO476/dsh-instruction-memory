/**
 * Syntax gate: every file the package ships and every script the repo's own
 * commands run must PARSE.   node lint.mjs
 *
 * There is no ESLint here by design — the test suite stays zero-dependency —
 * so this is the floor instead: a file that does not even parse can pass no
 * test. A sweep beats "just import everything" because several maintained
 * files are executed by nothing in the suite: install.mjs and
 * .demo-server.mjs only run on a user's machine, and lib/client.js is loaded
 * by the DSH webview in production, never imported by node.
 *
 * Scope: lib/ recursively (what the tarball ships) plus every JS file in the
 * repo root (what npm scripts, CI and install run). Tool-state and evidence
 * directories (.graphflow, dsh-memory-verification, …) are deliberately out
 * of scope — they are agent output, not maintained code.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const files = readdirSync('lib')
  .filter((name) => /\.(js|mjs|cjs)$/.test(name))
  .map((name) => join('lib', name))
for (const name of readdirSync('.')) {
  if (/\.(js|mjs|cjs)$/.test(name)) files.push(name)
}
files.sort()

let failed = 0

/**
 * Parse one file with `node --check`. The piped run is preferred because it
 * lets this script print the parser's message itself; but some confined
 * environments (sandboxes that forbid piped child stdio) cannot start a child
 * that way at all — spawnSync then returns status=null with an EPERM error and
 * the file would be reported as unparseable even though it is fine. In that
 * case fall back to inherited stdio: the exit status is still authoritative
 * and node prints its own diagnostics straight to the terminal.
 */
function parseCheck(file) {
  const piped = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (piped.error === undefined && piped.status !== null) return piped
  return spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

for (const file of files) {
  // --check parses without executing: nothing is imported, no DSH_HOME is
  // touched, and a module that touches window at top level still parses.
  const res = parseCheck(file)
  if (res.status !== 0) {
    failed += 1
    console.log('FAIL  ' + file)
    const detail = String(res.stderr ?? '').trim()
    if (detail !== '') console.log(detail)
  } else {
    console.log('PASS  ' + file)
  }
}

console.log(failed === 0 ? '\nALL PARSE (' + files.length + ' files)' : '\n' + failed + ' FAILED TO PARSE')
process.exit(failed === 0 ? 0 : 1)

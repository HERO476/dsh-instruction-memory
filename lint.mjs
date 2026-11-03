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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// lib/ is what the tarball ships and what a profile junction points at: the
// browser half is bundled by DSH's webview and the host half is mounted from
// inside the profile. Neither may reach for the host by PACKAGE NAME — that
// resolves against whatever tree the file happens to sit in, so it either
// pins the plugin to one installed copy or fails outright (headless, CI, a
// checkout). The host is reached through the context object it passes in.
const LIB_DIR = 'lib'
const libFiles = readdirSync(LIB_DIR)
  .filter((name) => /\.(js|mjs|cjs)$/.test(name))
  .map((name) => join(LIB_DIR, name))
const files = [...libFiles]
for (const name of readdirSync('.')) {
  if (/\.(js|mjs|cjs)$/.test(name)) files.push(name)
}
files.sort()

let failed = 0
let policyFailed = 0

// `import x from '@deepseek-ai/…'`, `import '@deepseek-ai/…'`,
// `require('@deepseek-ai/…')`, `import('@deepseek-ai/…')` — the forms that
// would make lib/ depend on where the host is installed.
const HOST_IMPORT = /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"]@deepseek-ai\//

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

// The policy half of the gate: parsing is necessary, not sufficient.
for (const file of libFiles) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!HOST_IMPORT.test(line)) return
    policyFailed += 1
    console.log('FAIL  ' + file + ':' + (i + 1) + ' imports the host by package name')
    console.log('      ' + line.trim())
  })
}

console.log(failed === 0 && policyFailed === 0
  ? '\nALL PARSE (' + files.length + ' files)' + (policyFailed === 0 ? ', lib/ host-import free' : '')
  : '\n' + failed + ' FAILED TO PARSE' + (policyFailed === 0 ? '' : ', ' + policyFailed + ' host import(s) in lib/'))
process.exit(failed === 0 && policyFailed === 0 ? 0 : 1)

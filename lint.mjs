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

/**
 * R1 (1.6.5): the replay closure must not carry the action's side effect.
 *
 * `confirmThen(message, run)` returns FALSE when a real dialog said yes — and it
 * does NOT call `run`; the caller is expected to continue with its own copy of
 * the action. So this shape
 *
 *     if (confirmThen(msg, () => { send('delete-entry', …) })) return
 *     }                       // nothing else in the block
 *
 * makes the button a silent no-op on every surface with a working dialog
 * (desktop + browser) while still working on the dialog-less one. That is
 * exactly what shipped in 1.6.4 for entry delete, and no test caught it because
 * nothing clicked that button.
 *
 * The mechanical rule: `run` may only be a REPLAY entry point (a bare handler
 * reference or `() => handler(...)`); it may not hold the side effect itself.
 * A `send(` inside the second argument is therefore a policy failure. Every
 * call site in this repo passes a replay (`() => handler(...)` or a named local
 * that the caller also invokes after the guard).
 */
function confirmGuardViolations(source) {
  const out = []
  const marker = 'confirmThen('
  let at = source.indexOf(marker)
  while (at !== -1) {
    const line = source.slice(0, at).split('\n').length
    let depth = 0
    let end = -1
    for (let i = at + marker.length - 1; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      out.push({ line, reason: 'unbalanced confirmThen( call' })
    } else if (/send\s*\(/.test(source.slice(at, end))) {
      out.push({ line, reason: 'the action (send) lives inside the replay closure — put it after the guard' })
    }
    at = source.indexOf(marker, at + 1)
  }
  return out
}

const clientSource = readFileSync(join(LIB_DIR, 'client.js'), 'utf8')
const guardViolations = confirmGuardViolations(clientSource)
for (const violation of guardViolations) {
  policyFailed += 1
  console.log('FAIL  lib/client.js:' + violation.line + ' ' + violation.reason)
}

console.log(failed === 0 && policyFailed === 0
  ? '\nALL PARSE (' + files.length + ' files)' + (policyFailed === 0 ? ', lib/ host-import free, confirm guards sound' : '')
  : '\n' + failed + ' FAILED TO PARSE' + (policyFailed === 0 ? '' : ', ' + policyFailed + ' policy problem(s)'))
process.exit(failed === 0 && policyFailed === 0 ? 0 : 1)

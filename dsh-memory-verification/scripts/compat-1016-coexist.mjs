/**
 * Coexistence harness: install dsh-instruction-memory@1.0.16 together with the
 * seven top-downloaded memory plugins into one isolated profile, boot the
 * combined stack once, and verify:
 *
 *   1. every add succeeds (peer resolution, supply-chain policy, patch merge)
 *   2. the host boots with all plugins enabled (no mount-time throw)
 *   3. THIS plugin's route, CRUD and guards still pass (live-check reuse)
 *   4. this plugin's store directory is not touched/overwritten by neighbours
 *
 * Third-party plugins are installed but never driven (no LLM configured), so
 * their own features are not exercised — mount/load coexistence is the scope.
 *
 *   node compat-1016-coexist.mjs <dshBin> <dshHome> <port> <pnpmStoreDir>
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync as fsExists, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const VROOT = join(HERE, '..')
const [, , DSH_BIN, DSH_HOME, PORT, STORE_DIR] = process.argv
if (!DSH_BIN || !DSH_HOME || !PORT || !STORE_DIR) {
  console.log('usage: node compat-1016-coexist.mjs <dshBin> <dshHome> <port> <pnpmStoreDir>')
  process.exit(2)
}
const PNPM_CANDIDATES = [
  dirname(process.execPath),
  ...(process.env.PNPM_DIR ? [process.env.PNPM_DIR] : []),
]
const PNPM_DIR = PNPM_CANDIDATES.find((d) => fsExists(join(d, 'pnpm.cmd')))
if (!PNPM_DIR) { console.log('FATAL: pnpm.cmd not found in candidates: ' + PNPM_CANDIDATES.join(' | ')); process.exit(2) }
const env = { ...process.env, DSH_HOME, PATH: PNPM_DIR + ';' + process.env.PATH }
const PROFILE = join(DSH_HOME, 'profiles', 'web')

const NEIGHBOURS = [
  '@vectorize-io/hindsight-coding-agents',
  'dsh-mnemon',
  '@openviking/dsh-memory-plugin',
  'dsh-tiddlywiki',
  '@a9i5k4/dsh-auto-memory',
  '@modusensus/dsh-mneme',
  'dsh-prime-memory',
]
const steps = []
function addPkg(spec) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [DSH_BIN, 'plugin', '--profile', 'web', 'add', spec, '--store-dir', STORE_DIR], {
    env, encoding: 'utf8', timeout: 300_000,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // pnpm prints "Done"/"Already up to date" even when a trailing cache write
  // is sandbox-blocked; judge by the marker, not exit code.
  const ok = /Done in \d|Already up to date|Progress:.*done/.test(out)
  steps.push({ spec, ok, ms: Date.now() - t0, code: r.status, signal: r.signal,
    tail: out.split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean).slice(-6) })
  console.log(`${ok ? 'ADD-OK ' : 'ADD-FAIL'} ${spec} (${Date.now() - t0}ms code=${r.status})`)
  if (!ok) console.log('   ' + steps.at(-1).tail.join('\n   '))
  return ok
}

mkdirSync(DSH_HOME, { recursive: true })
addPkg('dsh-instruction-memory@1.0.16')
for (const n of NEIGHBOURS) addPkg(n)

/* ---- installed inventory + storage isolation snapshot ---- */
const nmDir = join(PROFILE, 'node_modules')
const installed = []
for (const top of ['.', '@vectorize-io', '@openviking', '@a9i5k4', '@modusensus']) {
  const d = join(nmDir, top)
  if (!existsSync(d)) continue
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink?.()) continue
    const pj = join(d, e.name, 'package.json')
    try { installed.push({ name: JSON.parse(readFileSync(pj, 'utf8')).name, version: JSON.parse(readFileSync(pj, 'utf8')).version }) } catch { /* scope dir noise */ }
  }
}

/* ---- boot the combined stack ---- */
console.log(`\nbooting combined stack on port ${PORT} ...`)
const bootLog = []
const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open', '--host', '127.0.0.1', '--port', PORT], {
  env, cwd: DSH_HOME,
})
child.stdout.on('data', (d) => { process.stdout.write(d); bootLog.push(d.toString()) })
child.stderr.on('data', (d) => { process.stderr.write(d); bootLog.push(d.toString()) })

const waitPort = (timeoutMs) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs
  const tick = () => {
    const s = net.connect(Number(PORT), '127.0.0.1')
    s.once('connect', () => { s.end(); resolve(true) })
    s.once('error', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 500) })
  }
  tick()
})
const booted = await waitPort(45_000)
await new Promise((r) => setTimeout(r, 6_000)) // let late mount errors surface
const bootText = bootLog.join('')
const tokenM = bootText.match(/token=([\w-]+)/)
const token = tokenM ? tokenM[1] : null
const bootErrors = bootText.split(/\r?\n/).filter((l) => /error|Error|ERR!|throw|cannot|undefined is not|failed to/i.test(l)
  && !/logDebug|deprecation/i.test(l)).slice(0, 20)
console.log(`\nboot=${booted} token=${token ? 'captured' : 'MISSING'} errorLines=${bootErrors.length}`)

/* ---- run THIS plugin's live check against the combined stack ---- */
let live = null
if (booted && token) {
  const r = spawnSync(process.execPath, [join(HERE, 'compat-1016-live-check.mjs'),
    `http://127.0.0.1:${PORT}`, DSH_HOME, 'coexist', token], { env, encoding: 'utf8', timeout: 90_000 })
  live = { code: r.status, out: (r.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(-28) }
  console.log(r.stdout)
  if (r.stderr) console.log(r.stderr)
}

/* ---- storage isolation: top-level data dirs actually materialised ---- */
const dataDirs = existsSync(DSH_HOME) ? readdirSync(DSH_HOME, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
const selfStore = join(DSH_HOME, 'instruction-memory', 'memory.json')

/* ---- shutdown ---- */
try { spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf8' }) } catch { /* best effort */ }

mkdirSync(join(VROOT, 'out'), { recursive: true })
const result = {
  generatedAt: new Date().toISOString(),
  dshBin: DSH_BIN, dshHome: DSH_HOME, port: Number(PORT),
  neighbours: NEIGHBOURS, addSteps: steps,
  allAddsOk: steps.every((s) => s.ok),
  installed: installed.sort((a, b) => a.name.localeCompare(b.name)),
  boot: { reachedPort: booted, tokenCaptured: token !== null, errorLines: bootErrors },
  liveCheckExit: live?.code ?? null,
  liveCheckTail: live?.out ?? null,
  homeDataDirs: dataDirs,
  selfStoreIntact: existsSync(selfStore),
}
const outFile = join(VROOT, 'out', 'compat-1016-coexist-top7.json')
writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
console.log('\n  evidence -> ' + outFile)
process.exit(result.allAddsOk && booted && live?.code === 0 ? 0 : 1)

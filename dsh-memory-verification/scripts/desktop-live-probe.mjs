/**
 * Read-only live probe of the DSH desktop app for dsh-instruction-memory.
 *
 * Run while the desktop app is up (its web host listens on 19387). Every
 * request here is read-only: a state envelope, guard checks, and GETs that
 * are expected to be refused. Nothing is written to the shared store.
 *
 *   node scripts/desktop-live-probe.mjs
 *
 * Evidence: dsh-memory-verification/out/desktop-live-probe-2026-10-16.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 19387
const BASE = 'http://127.0.0.1:' + PORT
const API = '/instruction-memory/api'
const HERE = dirname(fileURLToPath(import.meta.url))
const VROOT = join(HERE, '..')

const results = []
function check(id, label, ok, detail) {
  results.push({ id, label, pass: !!ok, detail: detail === undefined ? null : String(detail) })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id.padEnd(26) + label
    + (ok || detail === undefined ? '' : '\n        -> ' + detail))
}

function call(method, args, { headers = {}, path = API, httpMethod = 'POST', body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body !== null ? body : JSON.stringify({ method, args: args ?? null })
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method: httpMethod,
      headers: {
        ...(httpMethod === 'POST' ? { 'content-type': 'application/json' } : {}),
        host: '127.0.0.1:' + PORT,
        origin: BASE,
        ...(httpMethod === 'POST' ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text, ctype: res.headers['content-type'] })
      })
    })
    req.on('error', (err) => resolve({ status: 0, json: null, text: String(err?.message ?? err) }))
    if (httpMethod === 'POST') req.write(payload)
    req.end()
  })
}

/* ---- 1. route alive + state envelope (read-only) ---- */
let s = await call('state', null)
for (let i = 0; i < 20 && (s.status !== 200 || s.json?.ok !== true); i += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  s = await call('state', null)
}
check('state-200', 'POST state answers 200 ok', s.status === 200 && s.json?.ok === true,
  'status=' + s.status + ' body=' + s.text.slice(0, 120))
const snap = s.json?.snapshot ?? {}
check('store-shared', 'store path is the shared DSH_HOME store',
  typeof snap.storage?.path === 'string' && /\.dsh[\\/]instruction-memory[\\/]memory\.json$/.test(snap.storage.path),
  String(snap.storage?.path))
check('entries-visible', 'entries are visible through the desktop host',
  Array.isArray(snap.data?.entries), 'entries=' + (snap.data?.entries?.length ?? 'n/a'))
check('injection-state', 'injection block state is reported',
  snap.injection !== undefined && typeof snap.injection.registered === 'boolean',
  JSON.stringify(snap.injection && {
    registered: snap.injection.registered, available: snap.injection.available,
    muted: snap.injection.muted, chars: snap.injection.chars, activeCount: snap.injection.activeCount,
  }))
check('security-reported', 'security diagnostics present', snap.security !== undefined,
  JSON.stringify(snap.security ?? null).slice(0, 160))

/* ---- 2. request guards (unchanged from web-host behaviour?) ---- */
const evilOrigin = await call('state', null, { headers: { origin: 'http://evil.example.com:19387' } })
check('guard-evil-origin', 'cross-origin POST rejected with 403', evilOrigin.status === 403,
  'status=' + evilOrigin.status)
const evilHost = await call('state', null, { headers: { host: 'evil.example.com:19387' } })
check('guard-evil-host', 'foreign Host rejected', evilHost.status !== 200,
  'status=' + evilHost.status)
const nonJson = await call('state', null, { headers: { 'content-type': 'text/plain' } })
check('guard-ctype-415', 'non-JSON content-type rejected with 415', nonJson.status === 415,
  'status=' + nonJson.status)
const getPlain = await call(null, null, { httpMethod: 'GET' })
check('guard-get-405', 'plain GET rejected with 405', getPlain.status === 405,
  'status=' + getPlain.status)
const bogus = await call('definitely-not-a-method', null)
check('bogus-method', 'unknown method returns ok:false envelope', bogus.status === 200 && bogus.json?.ok === false,
  'status=' + bogus.status)

/* ---- 3. can the client bundle be fetched the same way the renderer does? ---- */
const clientJs = await call(null, null, { httpMethod: 'GET', path: '/plugins/dsh-instruction-memory/client.js' })
check('clientjs-reachable', 'GET /plugins/dsh-instruction-memory/client.js (informational)',
  true, 'status=' + clientJs.status + ' ctype=' + String(clientJs.ctype) + ' bytes=' + clientJs.text.length)
const pluginsIndex = await call(null, null, { httpMethod: 'GET', path: '/plugins/' })
check('plugins-index-info', 'GET /plugins/ (informational)', true,
  'status=' + pluginsIndex.status + ' bytes=' + pluginsIndex.text.length)

/* ---- output ---- */
const failed = results.filter((r) => !r.pass)
mkdirSync(join(VROOT, 'out'), { recursive: true })
const outFile = join(VROOT, 'out', 'desktop-live-probe-2026-10-16.json')
writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  target: 'DSH desktop app web host', baseUrl: BASE, readOnly: true,
  storePath: snap.storage?.path ?? null,
  injection: snap.injection ?? null,
  checks: results, passCount: results.length - failed.length, failCount: failed.length,
}, null, 2), 'utf8')
console.log('\n  checks ' + results.length + ', fail ' + failed.length)
console.log('  evidence -> ' + outFile)
process.exit(failed.length === 0 ? 0 : 1)

/**
 * L3 live-host verification for dsh-instruction-memory 1.0.16.
 *
 * Drives a REALLY running DSH web host over HTTP (no fakes): CRUD through the
 * route, SSE connect frame, request guards, on-disk persistence, and a
 * stability burst. A uniquely-marked entry is created and deleted again, and
 * options are restored, so the run leaves no functional data behind.
 *
 *   node compat-1016-live-check.mjs <baseUrl> <dshHome> <label>
 *
 * @example
 *   node compat-1016-live-check.mjs http://127.0.0.1:8091 <DSH_HOME> live-alpha2
 *
 * Evidence: dsh-memory-verification/out/compat-1016-live-<label>.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
// Single source of truth for the snapshot's platform token (%USERPROFILE% on
// Windows, ~ elsewhere). Copied logic here would drift exactly like the
// storage-path assertion this replaces.
import { expandDisplayPath } from '../../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VROOT = join(HERE, '..')
const [, , BASE_URL, DSH_HOME, LABEL, ACCESS_TOKEN] = process.argv
if (!BASE_URL || !DSH_HOME || !LABEL) {
  console.log('usage: node compat-1016-live-check.mjs <baseUrl> <dshHome> <label>')
  process.exit(2)
}
const u = new URL(BASE_URL)
const ORIGIN = BASE_URL
const HOST_HEADER = u.host
/** The plugin owns this fixed prefix regardless of any path in BASE_URL. */
const API_PATH = '/instruction-memory/api'

const results = []
function check(id, label, ok, detail) {
  results.push({ id, label, pass: !!ok, detail: detail === undefined ? null : String(detail) })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id.padEnd(22) + ' ' + label
    + (ok || detail === undefined ? '' : '\n        -> ' + detail))
}

/** POST a {method,args} envelope; returns {status, json, text}. */
function call(method, args, { headers = {}, bodyOverride = null, rawPath = null } = {}) {
  return new Promise((resolve) => {
    const payload = bodyOverride !== null ? bodyOverride : JSON.stringify({ method, args: args ?? null })
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: rawPath ?? API_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: HOST_HEADER,
        origin: ORIGIN,
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', (err) => resolve({ status: 0, json: null, text: String(err?.message ?? err) }))
    req.write(payload)
    req.end()
  })
}

/** Plain GET, optionally with SSE Accept; returns status/headers/first chunk. */
function getOnce({ sse = false, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: API_PATH + (sse && ACCESS_TOKEN ? `?token=${ACCESS_TOKEN}` : ''), method: 'GET',
      headers: { host: HOST_HEADER, origin: ORIGIN, ...(sse ? { accept: 'text/event-stream' } : {}), ...headers },
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      const timer = setTimeout(() => { req.destroy(); finish() }, 4000)
      const finish = () => {
        clearTimeout(timer)
        try { req.destroy() } catch { /* already gone */ }
        resolve({ status: res.statusCode, headers: res.headers, chunk: buf })
      }
      res.on('data', (c) => {
        buf += c
        // First SSE data frame arrived.
        if (sse && buf.includes('data: ')) finish()
      })
      res.on('end', finish)
      setTimeout(finish, 4000)
    })
    req.on('error', (err) => resolve({ status: 0, headers: {}, chunk: String(err?.message ?? err) }))
    req.end()
  })
}

const startedAt = new Date().toISOString()
const mark = 'LIVE-' + Date.now().toString(36)
let createdId = null
let restoredOptions = null

/* ---- 1. boot state + storage path ---- */
const s0 = await call('state', null)
check('state-200', 'state envelope answers 200 ok', s0.status === 200 && s0.json?.ok === true, `status=${s0.status}`)
const publishedStorePath = s0.json?.snapshot?.storage?.path
  ?? s0.json?.snapshot?.state?.storagePath ?? s0.json?.snapshot?.storagePath ?? null
// 1.4.4 folded the home prefix for display. A raw string comparison then
// failed on every host even though the store was exactly where promised;
// expand the platform token back to the real path before judging it.
const storePath = publishedStorePath === null ? null : expandDisplayPath(publishedStorePath)
check('store-inside-home', 'materialised store is inside the isolated DSH_HOME',
  storePath !== null && storePath.replace(/\\/g, '/').startsWith(DSH_HOME.replace(/\\/g, '/')),
  `storePath=${storePath} published=${publishedStorePath} dshHome=${DSH_HOME}`)
check('store-on-disk', 'memory.json exists on disk after state',
  storePath !== null && existsSync(storePath), storePath)

/* ---- 2. CRUD: create ---- */
const beforeCount = s0.json?.snapshot?.data?.entries?.length ?? -1
const entry = {
  id: '', title: mark, content: 'compat live probe — safe to delete',
  mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0,
}
const save = await call('save-entry', { entry })
check('save-entry', 'save-entry creates the probe instruction',
  save.status === 200 && save.json?.ok === true && save.json?.snapshot?.data?.entries?.some((e) => e.title === mark),
  save.text.slice(0, 200))
check('section-armed', 'non-empty memory arms the prompt section (registered=true)',
  save.json?.snapshot?.injection?.registered === true && save.json?.snapshot?.injection?.chars > 0,
  JSON.stringify(save.json?.snapshot?.injection))
createdId = save.json?.snapshot?.data?.entries?.find((e) => e.title === mark)?.id ?? null

/* ---- 3. persistence on disk ---- */
let onDisk = null
try { onDisk = JSON.parse(readFileSync(join(DSH_HOME, 'instruction-memory', 'memory.json'), 'utf8')) } catch { /* below */ }
check('persisted-disk', 'HTTP write is really persisted to memory.json',
  Array.isArray(onDisk?.entries) && onDisk.entries.some((e) => e.title === mark),
  onDisk === null ? 'memory.json unreadable' : `entries=${onDisk?.entries?.length}`)

/* ---- 4. SSE connect frame ---- */
const sse = await getOnce({ sse: true })
let sseFrame = null
try {
  const m = sse.chunk.match(/data: (\{.*?\})\n\n/s)
  if (m) sseFrame = JSON.parse(m[1])
} catch { /* below */ }
check('sse-frame', 'SSE delivers a snapshot frame on connect',
  sse.status === 200 && sse.headers['content-type']?.includes('text/event-stream') && sseFrame?.data?.entries !== undefined,
  `status=${sse.status} ctype=${sse.headers['content-type']} frameKeys=${sseFrame === null ? 'none' : Object.keys(sseFrame).join(',')}`)

/* ---- 5. options round trip ---- */
const orig = onDisk ?? { enabled: true, budgetChars: 4000 }
restoredOptions = { enabled: orig.enabled !== false, budgetChars: orig.budgetChars ?? 4000 }
const opts = await call('set-options', { enabled: false, budgetChars: 1500 })
check('set-options', 'set-options accepted and reflected',
  opts.status === 200 && opts.json?.ok === true
  && opts.json?.snapshot?.data?.enabled === false
  && opts.json?.snapshot?.data?.budgetChars === 1500,
  opts.text.slice(0, 200))
const optsRead = await call('state', null)
check('options-persist', 'changed options survive a fresh state read',
  optsRead.json?.snapshot?.data?.enabled === false
  && optsRead.json?.snapshot?.data?.budgetChars === 1500)

/* ---- 6. guards ---- */
const evil = await call('state', null, { headers: { origin: 'http://evil.example.com:8091' } })
check('guard-origin', 'cross-origin POST rejected with 403', evil.status === 403, `status=${evil.status}`)
const nonJson = await call('state', null, { headers: { 'content-type': 'text/plain' } })
check('guard-ctype', 'non-JSON content-type rejected with 415', nonJson.status === 415, `status=${nonJson.status}`)
const getPlain = await getOnce({ sse: false })
check('guard-get405', 'plain GET rejected with 405', getPlain.status === 405, `status=${getPlain.status}`)
const bogus = await call('bogus-method', null)
check('bogus-method', 'unknown method returns ok:false envelope without crash',
  bogus.status === 200 && bogus.json?.ok === false, `status=${bogus.status}`)
// Host header as a bare IPv6 loopback with a MATCHING v6 Origin: the 1.0.16
// fix must accept the bracketed text instead of slicing it at the last colon.
// The TCP connection still arrives over 127.0.0.1 here — this checks the
// guard's address logic; the true ::1-bound end-to-end case is run separately.
const v6 = await call('state', null, {
  headers: { host: '[::1]:' + u.port, origin: 'http://[::1]:' + u.port },
})
check('ipv6-loopback-equivalent', 'Host+Origin [::1] accepted as loopback pair (1.0.16 fix)',
  v6.status === 200 && v6.json?.ok === true, `status=${v6.status} body=${v6.text.slice(0, 100)}`)
// A v6 Host paired with a v4 Origin are different origins even though both
// are loopback: accepting them would be a DNS-rebinding-class hole.
const v6mix = await call('state', null, {
  headers: { host: '[::1]:' + u.port, origin: 'http://127.0.0.1:' + u.port },
})
check('ipv6-mixed-origin-denied', 'v6 Host with v4 Origin still rejected as cross-origin',
  v6mix.status === 403, `status=${v6mix.status}`)

/* ---- 7. delete + no-op delete ---- */
const del = await call('delete-entry', { id: createdId })
check('delete-entry', 'delete-entry removes the probe instruction',
  del.status === 200 && del.json?.ok === true
  && !del.json?.snapshot?.data?.entries?.some((e) => e.id === createdId),
  del.text.slice(0, 150))
const delAgain = await call('delete-entry', { id: createdId })
check('delete-missing-noop', 'deleting an absent id is ok without a phantom rewrite',
  delAgain.status === 200 && delAgain.json?.ok === true && delAgain.json?.saved === false,
  `saved=${delAgain.json?.saved}`)
// restore options
await call('set-options', restoredOptions)

/* ---- 8. stability burst ---- */
const N = 30
const t0 = Date.now()
let burstOk = 0
for (let i = 0; i < N; i += 1) {
  const r = await call('state', null)
  if (r.status === 200 && r.json?.ok === true) burstOk += 1
}
const ms = Date.now() - t0
check('stability-burst', `${N} consecutive state calls all succeed`, burstOk === N, `${burstOk}/${N} in ${ms}ms`)

/* ---- 9. final state clean (probe gone, options restored) ---- */
const sEnd = await call('state', null)
const entries = sEnd.json?.snapshot?.data?.entries ?? []
check('cleanup', 'probe entry gone and entry count back to baseline',
  !entries.some((e) => e.title === mark) && entries.length === beforeCount,
  `now=${entries.length} baseline=${beforeCount}`)
if (beforeCount === 0) {
  check('section-disarmed', 'back to empty memory: prompt section disposed (registered=false)',
    sEnd.json?.snapshot?.injection?.registered === false,
    JSON.stringify(sEnd.json?.snapshot?.injection))
}
check('options-restored', 'options restored to pre-run values',
  sEnd.json?.snapshot?.data?.enabled === restoredOptions.enabled
  && sEnd.json?.snapshot?.data?.budgetChars === restoredOptions.budgetChars)

/* ---- output ---- */
const failed = results.filter((r) => !r.pass)
mkdirSync(join(VROOT, 'out'), { recursive: true })
const outFile = join(VROOT, 'out', `compat-1016-live-${LABEL}.json`)
writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(), startedAt, label: LABEL,
  baseUrl: BASE_URL, dshHome: DSH_HOME, storePath,
  checks: results, passCount: results.length - failed.length, failCount: failed.length,
}, null, 2), 'utf8')
console.log(`\n  checks ${results.length}, fail ${failed.length}`)
console.log('  evidence -> ' + outFile)
process.exit(failed.length === 0 ? 0 : 1)

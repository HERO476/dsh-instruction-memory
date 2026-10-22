/**
 * live-host-smoke.mjs — dual-host smoke test against RUNNING DSH hosts.
 *
 * Deliberately NOT part of `npm test`: it needs a live web host and/or a live
 * desktop host, and CI has neither. Run it by hand after a DSH upgrade, before
 * a release, or whenever a "does it still work on both shells?" question comes
 * up. It measures the four numbers that actually moved in the 2026-10-22 audit
 * and refuses to guess about anything else:
 *
 *   1. `state` latency      p50 / p95 over N round trips (node http, direct —
 *                           NOT through http_proxy, which `curl` would use and
 *                           which silently adds ~5 ms to every reading)
 *   2. SSE first event      time to the first `data:` frame on the live channel
 *   3. injection            registered / chars / activeCount / pulls
 *   4. cross-host identity  both snapshots must be byte-identical except for
 *                           the runtime counter `injection.pulls`
 *
 * Usage:
 *   node live-host-smoke.mjs                    # both, ports 8080 / 19387
 *   node live-host-smoke.mjs --web 8080         # only the web host
 *   node live-host-smoke.mjs --desktop 19387    # only the desktop host
 *   node live-host-smoke.mjs --rounds 30        # latency sample count
 *   node live-host-smoke.mjs --json             # machine-readable output
 *   node live-host-smoke.mjs --require-pulls    # exit 1 if pulls === 0
 *
 * Exit code: 0 all green, 1 a check failed, 2 no host reachable.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const API = '/instruction-memory/api'
const args = process.argv.slice(2)
const flag = (name) => args.includes('--' + name)
const opt = (name, fallback) => {
  const at = args.indexOf('--' + name)
  return at === -1 ? fallback : Number(args[at + 1])
}

const ROUNDS = opt('rounds', 20)
const AS_JSON = flag('json')
const REQUIRE_PULLS = flag('require-pulls')
const PORTS = []
if (!args.includes('--desktop')) PORTS.push({ name: 'web', port: opt('web', 8080) })
if (!args.includes('--web')) PORTS.push({ name: 'desktop', port: opt('desktop', 19387) })

// Threshold for "the route is unusably slow". The audit measured sub-millisecond
// p50 on both shells; 50 ms leaves two orders of magnitude of headroom so this
// does not fire on a loaded machine, but still catches a real regression.
const SLOW_P50_MS = 50

const CLIENT_BYTES = (() => {
  try {
    return readFileSync(fileURLToPath(new URL('./lib/client.js', import.meta.url)))
  } catch {
    return null
  }
})()?.length ?? null

function post (port, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const t0 = process.hrtime.bigint()
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: API,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        origin: 'http://127.0.0.1:' + port,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6
        const raw = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(raw.toString('utf8')) } catch { /* non-JSON is a finding, not a crash */ }
        resolve({ status: res.statusCode, ms, bytes: raw.length, json })
      })
    })
    req.on('error', (err) => resolve({ status: 0, ms: 0, error: err.message }))
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout after ' + timeoutMs + 'ms')) })
    req.end(body)
  })
}

function sseFirstEvent (port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: API,
      method: 'GET',
      headers: { accept: 'text/event-stream', origin: 'http://127.0.0.1:' + port },
    }, (res) => {
      let buf = ''
      let first = null
      res.on('data', (c) => {
        buf += c.toString('utf8')
        if (first === null && buf.includes('\n\n')) {
          first = Number(process.hrtime.bigint() - t0) / 1e6
          req.destroy()
          resolve({ status: res.statusCode, firstEventMs: first, head: buf.slice(0, 60).replace(/\n/g, '\\n') })
        }
      })
      res.on('end', () => resolve({ status: res.statusCode, firstEventMs: null, head: buf.slice(0, 60) }))
    })
    req.on('error', (err) => resolve({ status: 0, error: err.message }))
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]

async function probe (host) {
  const first = await post(host.port, { method: 'state' })
  if (first.status !== 200) {
    return { ...host, reachable: false, error: first.error || ('HTTP ' + first.status) }
  }
  const samples = []
  let last = first
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = await post(host.port, { method: 'state' })
    if (r.status !== 200) return { ...host, reachable: false, error: 'HTTP ' + r.status + ' on round ' + (i + 1) }
    samples.push(r.ms)
    last = r
  }
  samples.sort((a, b) => a - b)
  const sse = await sseFirstEvent(host.port)
  const snap = last.json?.snapshot ?? {}
  return {
    ...host,
    reachable: true,
    bytes: last.bytes,
    latency: {
      n: samples.length,
      p50: Number(quantile(samples, 0.5).toFixed(2)),
      p95: Number(quantile(samples, 0.95).toFixed(2)),
      max: Number(samples[samples.length - 1].toFixed(2)),
    },
    sse,
    injection: {
      registered: snap.injection?.registered === true,
      chars: snap.injection?.chars ?? null,
      activeCount: snap.injection?.activeCount ?? null,
      pulls: snap.injection?.pulls ?? null,
      error: snap.injection?.error ?? null,
    },
    snapshot: snap,
  }
}

// Everything except the runtime counter must match byte-for-byte. `pulls` is a
// per-process counter of real agent turns, so it legitimately differs between
// two processes reading the same store.
function diffSnapshots (a, b) {
  const out = []
  const walk = (x, y, path) => {
    if (x === y) return
    const tx = x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x
    const ty = y === null ? 'null' : Array.isArray(y) ? 'array' : typeof y
    if (tx !== ty) { out.push(path + ' (' + tx + ' vs ' + ty + ')'); return }
    if (tx === 'object' || tx === 'array') {
      for (const k of new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])) {
        walk(x?.[k], y?.[k], path === '' ? k : path + '.' + k)
      }
      return
    }
    out.push(path + ' (' + JSON.stringify(x) + ' vs ' + JSON.stringify(y) + ')')
  }
  walk(a, b, '')
  return out
}

const results = []
for (const host of PORTS) results.push(await probe(host))
const live = results.filter((r) => r.reachable)

const problems = []
for (const r of results) {
  if (!r.reachable) {
    problems.push(r.name + ': 无法连接 127.0.0.1:' + r.port + '（' + r.error + '）')
    continue
  }
  if (!r.injection.registered) problems.push(r.name + ': injection.registered=false（section 未注册）')
  if (r.injection.chars === 0 && r.injection.activeCount > 0) problems.push(r.name + ': 有启用的指令但注入字符为 0')
  if (r.latency.p50 > SLOW_P50_MS) problems.push(r.name + ': state p50 ' + r.latency.p50 + 'ms 超过阈值 ' + SLOW_P50_MS + 'ms')
  if (r.sse.firstEventMs === null) problems.push(r.name + ': SSE 通道没有发出首个事件')
  if (REQUIRE_PULLS && r.injection.pulls === 0) {
    problems.push(r.name + ': injection.pulls=0（该宿主尚未经历过真实的 Agent 回合，注入链路未被证实）')
  }
}

let diff = []
if (live.length === 2) {
  diff = diffSnapshots(live[0].snapshot, live[1].snapshot)
  const unexpected = diff.filter((line) => !line.startsWith('injection.pulls'))
  if (unexpected.length > 0) {
    problems.push('两端快照不一致（除 injection.pulls 外）：' + unexpected.join('; '))
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({
    rounds: ROUNDS,
    clientBytes: CLIENT_BYTES,
    hosts: results.map((r) => ({
      name: r.name, port: r.port, reachable: r.reachable, error: r.error,
      latency: r.latency, sse: r.sse, injection: r.injection, bytes: r.bytes,
    })),
    snapshotDiff: diff,
    problems,
  }, null, 1))
} else {
  console.log('live dual-host smoke — ' + ROUNDS + ' rounds per host, direct HTTP (no proxy fallback)')
  if (CLIENT_BYTES !== null) console.log('client bundle: ' + CLIENT_BYTES + ' bytes on disk (both shells serve the same file)')
  console.log('')
  for (const r of results) {
    if (!r.reachable) {
      console.log('✗ ' + r.name + ' :' + r.port + '  unreachable — ' + r.error)
      continue
    }
    console.log('✓ ' + r.name + ' :' + r.port)
    console.log('    state      p50 ' + r.latency.p50 + 'ms   p95 ' + r.latency.p95 + 'ms   max ' + r.latency.max + 'ms   (' + r.bytes + ' B)')
    console.log('    SSE        first event ' + (r.sse.firstEventMs === null ? 'none' : r.sse.firstEventMs.toFixed(2) + 'ms'))
    console.log('    injection  registered=' + r.injection.registered + '  chars=' + r.injection.chars
      + '  active=' + r.injection.activeCount + '  pulls=' + r.injection.pulls)
    console.log('')
  }
  if (live.length === 2) {
    const extra = diff.filter((line) => !line.startsWith('injection.pulls'))
    console.log(extra.length === 0
      ? 'snapshot parity: identical except injection.pulls (' + live[0].injection.pulls + ' vs ' + live[1].injection.pulls + ')'
      : 'snapshot parity: ' + extra.length + ' unexpected difference(s)')
    console.log('')
  }
  if (problems.length === 0) {
    console.log('ALL CHECKS PASSED')
  } else {
    for (const p of problems) console.log('PROBLEM  ' + p)
  }
}

process.exitCode = live.length === 0 ? 2 : (problems.length === 0 ? 0 : 1)

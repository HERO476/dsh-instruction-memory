/**
 * E-4 regression test — real HTTP server, real requests.
 *
 * The settings-page route writes the user's long-lived instructions, which are
 * injected into every later prompt, so it is worth more than a stubbed req/res.
 * This mounts the plugin on an actual node:http server and sends actual HTTP
 * requests with hostile Host/Origin headers, then checks that a rejected write
 * really left the store alone.
 *
 *   node route-guard-test.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const HOME = join(ROOT, 'tmp', 'guard-home')
const HOST_URL = 'file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()

/* ---------- a store with one entry, re-seeded per mount ---------- */

function seedHome() {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(join(HOME, 'instruction-memory'), { recursive: true })
  const store = join(HOME, 'instruction-memory', 'memory.json')
  writeFileSync(store, JSON.stringify({
    version: 1,
    enabled: true,
    budgetChars: 4000,
    entries: [{ id: 'g', title: 'GUARD', content: 'IM-GUARD-OK', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
  }, null, 2))
  return store
}

/* ---------- mount the plugin on a real server ---------- */

async function mount(boundHost) {
  process.env.DSH_HOME = HOME
  const mod = await import(HOST_URL + '?v=' + Math.random())
  const sections = []
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: {
            host: boundHost,
            register: (route) => {
              server.on('request', (req, res) => {
                if (req.url === route.path) route.handler(req, res)
                else { res.writeHead(404); res.end('nope') }
              })
              return () => {}
            },
          },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
  }
  const server = createServer()
  mod.apply(ctx)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { server, port, sections, mod }
}

/** One real HTTP request with full control over Host and Origin. */
function request(port, { method = 'POST', path = '/instruction-memory/api', host, origin, contentType = 'application/json', body = '{"method":"state"}' } = {}) {
  return new Promise((resolve) => {
    const headers = {}
    if (host !== undefined) headers.Host = host
    if (origin !== undefined) headers.Origin = origin
    if (contentType !== null) headers['content-type'] = contentType
    if (body !== null) headers['content-length'] = Buffer.byteLength(body)
    const req = require_http.request({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', (err) => resolve({ status: 0, json: null, text: String(err.message) }))
    if (body !== null) req.write(body)
    req.end()
  })
}
const require_http = await import('node:http')

/* ================================================================== */

console.log('########## A. bound to loopback (the default) ##########\n')
const store = seedHome()
const a = await mount('127.0.0.1')
const before = sha(store)

const cases = [
  { label: 'Host 127.0.0.1 + no Origin is accepted (the settings page)', opt: { host: `127.0.0.1:${a.port}` }, expect: 200 },
  { label: 'Host localhost is accepted', opt: { host: `localhost:${a.port}` }, expect: 200 },
  { label: 'Host 127.0.0.1 + same-origin Origin is accepted', opt: { host: `127.0.0.1:${a.port}`, origin: `http://127.0.0.1:${a.port}` }, expect: 200 },
  { label: 'DNS REBINDING: foreign Host is refused', opt: { host: `evil.com:${a.port}` }, expect: 403 },
  { label: 'DNS REBINDING: foreign Host with matching Origin is still refused', opt: { host: `evil.com:${a.port}`, origin: `http://evil.com:${a.port}` }, expect: 403 },
  { label: 'cross-origin Origin is refused', opt: { host: `127.0.0.1:${a.port}`, origin: `http://evil.com` }, expect: 403 },
  { label: 'Origin: null is refused', opt: { host: `127.0.0.1:${a.port}`, origin: 'null' }, expect: 403 },
  { label: 'GET is still refused with 405', opt: { method: 'GET', host: `127.0.0.1:${a.port}` }, expect: 405 },
  { label: 'non-JSON content-type is still refused with 415', opt: { host: `127.0.0.1:${a.port}`, contentType: 'text/plain' }, expect: 415 },
  // Node's own HTTP/1.1 parser rejects a request carrying no Host before the
  // route is ever reached, so 400 is the correct expectation for the wire case.
  // The guard's own missing-Host branch is covered by section D.
  { label: 'a request with no Host is rejected by the HTTP layer itself', opt: { host: undefined, origin: undefined }, expect: 400 },
]

for (const c of cases) {
  const res = await request(a.port, c.opt)
  check(c.label + ' (HTTP ' + c.expect + ')', res.status === c.expect, 'got ' + res.status + ' ' + JSON.stringify(res.json))
}

// A refused write must not have touched the store.
const hostileWrite = await request(a.port, {
  host: `evil.com:${a.port}`,
  body: JSON.stringify({ method: 'save-entry', args: { entry: { id: '', title: 'PWNED', content: 'injected via rebinding', mode: 'always', when: '', priority: 2, enabled: true, updatedAt: 0 } } }),
})
check('a rebinding write is refused', hostileWrite.status === 403, 'got ' + hostileWrite.status)
check('REFUSED WRITE LEFT THE STORE ALONE', sha(store) === before, 'store hash changed!')
check('the hostile entry is not in the store', !readFileSync(store, 'utf8').includes('PWNED'))
check('the hostile entry is not injected', !a.sections.map((s) => s.text({})).join('').includes('PWNED'))

a.server.close()

console.log('\n########## B. bound to 0.0.0.0 (deliberately published) ##########\n')
{
  seedHome()
  const b = await mount('0.0.0.0')
  const ok = await request(b.port, { host: `192.168.1.50:${b.port}` })
  check('the Host allowlist is disabled when bound to every interface',
    ok.status === 200, 'got ' + ok.status + ' ' + JSON.stringify(ok.json))
  const stillGuarded = await request(b.port, { host: `192.168.1.50:${b.port}`, origin: 'http://evil.com' })
  check('the Origin check still applies on an all-interfaces bind',
    stillGuarded.status === 403, 'got ' + stillGuarded.status)
  b.server.close()
}

console.log('\n########## C. hostnameOf parsing ##########\n')
{
  const { hostnameOf } = await import(HOST_URL + '?v=' + Math.random())
  const table = [
    ['127.0.0.1:8080', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]:8080', '::1'],
    ['[::1]', '::1'],
    ['LOCALHOST:8080', 'localhost'],
    ['  localhost  ', 'localhost'],
    ['', ''],
    [undefined, ''],
    [null, ''],
    ['evil.com:443', 'evil.com'],
  ]
  for (const [input, expected] of table) {
    check('hostnameOf(' + JSON.stringify(input) + ') = ' + JSON.stringify(expected),
      hostnameOf(input) === expected, 'got ' + JSON.stringify(hostnameOf(input)))
  }
}

console.log('\n########## D. requestOriginVerdict directly ##########\n')
{
  const { requestOriginVerdict } = await import(HOST_URL + '?v=' + Math.random())
  const verdicts = [
    ['loopback Host, no Origin', { host: '127.0.0.1:8080' }, true, true],
    ['loopback Host, same-origin Origin', { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, true, true],
    ['MISSING Host, guarded', {}, true, false],
    ['MISSING Host, unguarded (0.0.0.0 bind)', {}, false, true],
    ['foreign Host, guarded', { host: 'evil.com:8080' }, true, false],
    ['foreign Host, unguarded', { host: 'evil.com:8080' }, false, true],
    ['foreign Host + matching Origin, guarded', { host: 'evil.com:8080', origin: 'http://evil.com:8080' }, true, false],
    ['Origin null', { host: '127.0.0.1:8080', origin: 'null' }, true, false],
    ['Origin with a different port on the same host', { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:9999' }, true, true],
    ['null headers', null, true, false],
  ]
  for (const [label, headers, guarded, expected] of verdicts) {
    const got = requestOriginVerdict(headers, guarded)
    check('verdict: ' + label + ' -> ' + (expected ? 'allow' : 'deny'), got.ok === expected, JSON.stringify(got))
  }
}

console.log('\nchecks failed: ' + failures)
process.exit(failures === 0 ? 0 : 1)

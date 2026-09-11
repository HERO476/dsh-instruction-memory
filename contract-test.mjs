/**
 * Contract test: the seam between the two halves.
 *   node contract-test.mjs
 *
 * verify.mjs checks each half in isolation; this checks that what the Host
 * actually returns is what the Client can actually consume. The shipped bug —
 * `state` answering with a bare snapshot while the Client required an
 * `{ ok, message, snapshot }` envelope — lived exactly here, so every method is
 * driven through the real route handler and its raw response is fed to the
 * Client's own normalizer.
 *
 * Nothing touches the user's real store: the Host runs against an in-memory
 * filesystem fake.
 */
const JUNCTION = 'file:///C:/Users/34332/.dsh/profiles/web/node_modules/dsh-instruction-memory'

import { rm } from 'node:fs/promises'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/* ---------------- isolate the store: point DSH_HOME at a scratch dir ---------------- */

// The Host resolves its own data file under the harness home. Redirecting
// DSH_HOME here is what guarantees this suite never reads or writes the user's
// real memory store.
const SCRATCH_HOME = new URL('./.test-dsh-home/', import.meta.url).pathname.replace(/^\//, '')
process.env.DSH_HOME = decodeURIComponent(SCRATCH_HOME)
await rm(process.env.DSH_HOME, { recursive: true, force: true })

/* ---------------- minimal req/res doubles ---------------- */

function makeRequest(body) {
  const listeners = {}
  return {
    method: 'POST',
    setEncoding() {},
    destroy() {},
    on(event, callback) {
      ;(listeners[event] = listeners[event] || []).push(callback)
      return this
    },
    fire() {
      for (const cb of listeners.data || []) cb(body)
      for (const cb of listeners.end || []) cb()
    },
  }
}

function makeResponse() {
  const out = { status: 0, body: '' }
  return {
    writeHead(status) { out.status = status },
    end(chunk) { out.body = chunk || '' },
    read() { return out },
  }
}

async function callRoute(handler, payload) {
  const req = makeRequest(JSON.stringify(payload))
  const res = makeResponse()
  handler(req, res)
  req.fire()
  for (let i = 0; i < 200; i += 1) {
    if (res.read().body !== '') return JSON.parse(res.read().body)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('route never responded for method ' + payload.method)
}

/* ---------------- load the Host half through the junction ---------------- */

const host = await import(JUNCTION + '/lib/index.js')

let handler = null
{
  const ctx = {
    systemPrompt: { section: () => () => {} },
    get: (name) => (name === 'webServer'
      ? { register: (route) => { handler = route.handler; return () => {} } }
      : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  host.apply(ctx)
  check('host: route handler captured', typeof handler === 'function')
}

/* ---------------- load the Client half's normalizer ---------------- */

globalThis.window = { __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } } }
await import(JUNCTION + '/lib/client.js')
const clientPlugin = globalThis.__spec.factory((id) => {
  if (id === 'react') return { createElement: () => ({}), useState: () => [null, () => {}], useEffect: () => {} }
  throw new Error('unexpected require: ' + id)
})
const normalize = clientPlugin.__normalizeResult
check('client: exposes __normalizeResult for this test', typeof normalize === 'function')

/* ---------------- drive every method and require a consumable response ---------------- */

const entry = {
  id: '', title: 'CONTRACT-TEST', content: 'temporary', mode: 'always',
  when: '', priority: 1, enabled: true, updatedAt: 0,
}

const scenarios = [
  { method: 'state', args: null, expectOk: true },
  { method: 'save-entry', args: { entry }, expectOk: true },
  { method: 'state', args: null, expectOk: true },
  { method: 'set-options', args: { enabled: true, budgetChars: 1200 }, expectOk: true },
  { method: 'delete-entry', args: { id: 'any' }, expectOk: true },
  { method: 'reload', args: null, expectOk: true },
  { method: 'bogus-method', args: null, expectOk: false },
]

for (const scenario of scenarios) {
  const response = await callRoute(handler, { method: scenario.method, args: scenario.args })
  const normalized = normalize(response)

  check(scenario.method + ': response is consumable by the Client',
    normalized !== null,
    'raw keys = ' + JSON.stringify(Object.keys(response || {})))

  if (normalized !== null) {
    check(scenario.method + ': normalized snapshot carries data.entries',
      Array.isArray(normalized.snapshot.data.entries),
      JSON.stringify(normalized.snapshot.data).slice(0, 120))
    check(scenario.method + ': ok flag is ' + scenario.expectOk,
      normalized.ok === scenario.expectOk, String(normalized.ok))
  }
}

// The normalizer must also accept the legacy bare-snapshot shape, so a Host
// that predates the envelope fix still cannot wedge the panel.
{
  const bare = { data: { version: 1, enabled: true, budgetChars: 4000, entries: [] }, storage: {}, injection: {}, preview: '', limits: {} }
  check('normalizer accepts a bare snapshot (backward compatible)', normalize(bare) !== null)
  check('normalizer rejects a payload with no snapshot', normalize({ ok: true }) === null)
  check('normalizer rejects a non-object', normalize(null) === null)
}

// The store must round-trip through the route. Note that a blank id is a
// CREATE (the Host mints one), so re-saving a known id is what exercises the
// update path the settings page uses after the first save.
{
  const before = normalize(await callRoute(handler, { method: 'state', args: null }))
  const existing = before.snapshot.data.entries[0]
  check('round-trip: the created entry came back with a Host-minted id',
    typeof existing.id === 'string' && existing.id !== '', JSON.stringify(existing.id))

  const updated = { ...existing, content: 'updated-content', updatedAt: existing.updatedAt }
  const saved = normalize(await callRoute(handler, { method: 'save-entry', args: { entry: updated } }))
  check('round-trip: saving a known id reports ok', saved.ok === true)

  const after = normalize(await callRoute(handler, { method: 'state', args: null }))
  check('round-trip: update by id replaces instead of appending',
    after.snapshot.data.entries.length === before.snapshot.data.entries.length,
    'before=' + before.snapshot.data.entries.length + ' after=' + after.snapshot.data.entries.length)
  check('round-trip: the update persisted the new content',
    after.snapshot.data.entries.some((e) => e.content === 'updated-content'))

  // And deletion removes exactly that entry.
  const deleted = normalize(await callRoute(handler, { method: 'delete-entry', args: { id: existing.id } }))
  check('round-trip: delete reports ok', deleted.ok === true)
  check('round-trip: the entry is gone',
    deleted.snapshot.data.entries.length === after.snapshot.data.entries.length - 1,
    String(deleted.snapshot.data.entries.length))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

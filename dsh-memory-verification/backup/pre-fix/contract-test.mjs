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
 * Nothing touches the user's real store: the Host runs against a scratch
 * directory under .test-dsh-home, seeded with an over-cap memory.json so the
 * dropped-entries warning path is exercised too.
 */
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/* ---------------- isolate the store: point DSH_HOME at a scratch dir ---------------- */

// The Host resolves its own data file under the harness home. Redirecting
// DSH_HOME here is what guarantees this suite never reads or writes the user's
// real memory store.
const SCRATCH_HOME = fileURLToPath(new URL('./.test-dsh-home/', import.meta.url))
const STORE_FILE = join(SCRATCH_HOME, 'instruction-memory', 'memory.json')
process.env.DSH_HOME = SCRATCH_HOME
await rm(SCRATCH_HOME, { recursive: true, force: true })

/* ---------------- minimal req/res doubles ---------------- */

function makeRequest(body, headers) {
  const listeners = {}
  return {
    method: 'POST',
    headers: headers || { 'content-type': 'application/json' },
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
    // The real handler attaches no-op error listeners to both streams; the
    // double must tolerate that.
    on() {},
    read() { return out },
  }
}

async function rawRoute(handler, rawBody) {
  const req = makeRequest(rawBody)
  const res = makeResponse()
  handler(req, res)
  req.fire()
  for (let i = 0; i < 200; i += 1) {
    if (res.read().body !== '') return res.read()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('route never responded')
}

async function callRoute(handler, payload) {
  const out = await rawRoute(handler, JSON.stringify(payload))
  return JSON.parse(out.body)
}

/* ---------------- load the Host half ---------------- */

// The repo files are what the profile junction points at (install.mjs links
// them), so importing locally keeps `npm test` working on a fresh clone.
const host = await import(new URL('./lib/index.js', import.meta.url).href)

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
await import(new URL('./lib/client.js', import.meta.url).href)
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

// Over-cap store, read back through the real reload path: 205 valid entries
// plus 2 blank ones must keep the first 200 and disclose the 7 it dropped
// instead of silently truncating — they would vanish for good on the next
// save.
{
  const seedEntries = Array.from({ length: 205 }, (_, i) => ({
    id: 'seed-' + i, title: 'S' + i, content: 'seed content ' + i,
    mode: 'always', when: '', priority: 1, enabled: true, updatedAt: i,
  }))
  seedEntries.push({ title: '', content: '' }, { title: '', content: '' })
  await writeFile(STORE_FILE, JSON.stringify({ version: 1, enabled: true, budgetChars: 2000, entries: seedEntries }), 'utf8')

  const reloaded = normalize(await callRoute(handler, { method: 'reload', args: null }))
  check('over-cap store: reload reports ok', reloaded.ok === true, JSON.stringify(reloaded.message))
  check('over-cap store: entries capped at MAX',
    reloaded.snapshot.data.entries.length === 200, String(reloaded.snapshot.data.entries.length))
  check('over-cap store: dropped entries are disclosed, not silent',
    typeof reloaded.snapshot.storage.warning === 'string' && reloaded.snapshot.storage.warning.includes('7'),
    JSON.stringify(reloaded.snapshot.storage.warning))
  check('over-cap store: warning names the next-save consequence',
    reloaded.snapshot.storage.warning.includes('下次保存'),
    JSON.stringify(reloaded.snapshot.storage.warning))

  // With the store at the cap, a new entry must be refused with a readable
  // message instead of silently dropped.
  const rejected = normalize(await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'OVER-CAP', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  }))
  check('over-cap store: creating past MAX is refused with a message',
    rejected.ok === false && rejected.message.includes('最多保存'),
    JSON.stringify(rejected.message))
}

// Rolling backup recovery: a corrupt memory.json must fall back to
// memory.json.bak (the previous good version) instead of presenting an empty
// memory — and the corrupt file itself stays on disk until the next save.
{
  // The last host write before this point renamed the previous state into
  // .bak, so a usable backup exists here.
  await writeFile(STORE_FILE, '{corrupted', 'utf8')

  const recovered = normalize(await callRoute(handler, { method: 'reload', args: null }))
  check('corrupt store: reload recovers from .bak', recovered.ok === true, JSON.stringify(recovered.message))
  check('corrupt store: recovery is disclosed',
    typeof recovered.snapshot.storage.warning === 'string' && recovered.snapshot.storage.warning.includes('回退'),
    JSON.stringify(recovered.snapshot.storage.warning))
  check('corrupt store: the backup data is usable',
    Array.isArray(recovered.snapshot.data.entries) && recovered.snapshot.data.entries.length >= 1,
    String(recovered.snapshot.data.entries.length))
  check('corrupt store: the broken file is preserved on disk',
    (await readFile(STORE_FILE, 'utf8')) === '{corrupted')

  // The next save must overwrite the corrupt file and clear the recovery note.
  const entry = recovered.snapshot.data.entries[0]
  const resaved = normalize(await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { ...entry, content: entry.content + ' (recovered)' } },
  }))
  check('corrupt store: saving after recovery reports ok', resaved.ok === true, JSON.stringify(resaved.message))
  const cleared = normalize(await callRoute(handler, { method: 'reload', args: null }))
  check('corrupt store: warning cleared once the file is good again',
    cleared.snapshot.storage.warning === null, JSON.stringify(cleared.snapshot.storage.warning))
}

// Export must produce a self-describing payload; importing it back adds
// nothing (duplicate detection); importing new entries merges them in —
// import can never wipe what is already there.
{
  // Note: the export envelope travels on the RAW response — normalize() only
  // carries { snapshot, ok, message }, exactly like the Client's doExport()
  // reads result.export off the un-normalized JSON.
  const raw = await callRoute(handler, { method: 'export-data', args: null })
  check('export-data: ok with a self-describing payload',
    raw.ok === true && raw.export !== undefined
    && raw.export.app === 'dsh-instruction-memory'
    && Array.isArray(raw.export.data.entries),
    JSON.stringify(Object.keys(raw)))
  const exported = normalize(raw)
  check('export-data: normalized snapshot still consumable', exported !== null)

  const again = normalize(await callRoute(handler, { method: 'import-data', args: { payload: raw.export } }))
  check('import-data: re-importing the export adds nothing',
    again.ok === true && again.message.includes('没有新增'), JSON.stringify(again.message))

  const fresh = { entries: [
    { title: 'IMPORTED-1', content: 'imported content one' },
    { title: 'IMPORTED-2', content: 'imported content two' },
    { title: 'IMPORTED-1', content: 'imported content one' },
  ] }
  const imported = normalize(await callRoute(handler, { method: 'import-data', args: { payload: fresh } }))
  check('import-data: new entries merge in with minted ids',
    imported.ok === true && imported.message.includes('新增 2 条'), JSON.stringify(imported.message))
  const st = normalize(await callRoute(handler, { method: 'state', args: null }))
  const importedEntries = st.snapshot.data.entries
    .filter((e) => e.title === 'IMPORTED-1' || e.title === 'IMPORTED-2')
  check('import-data: exactly two imported entries persisted with ids',
    importedEntries.length === 2 && importedEntries.every((e) => typeof e.id === 'string' && e.id !== ''),
    JSON.stringify(importedEntries.map((e) => e.title)))

  const empty = normalize(await callRoute(handler, { method: 'import-data', args: { payload: { entries: [] } } }))
  check('import-data: an empty file is refused with a message', empty.ok === false, JSON.stringify(empty.message))
}

// A body over the 1 MB ceiling must come back as a clean 413 the Client can
// render, not a destroyed socket it can only report as a network failure.
{
  const out = await rawRoute(handler, 'x'.repeat(1_000_001))
  check('oversized body answers 413 with a JSON error',
    out.status === 413 && JSON.parse(out.body).ok === false,
    'status=' + out.status)
}

// The route only speaks application/json: a cross-site form post (or any
// other content type) must get a readable 415, not a confusing parse
// failure. The 415 branch answers synchronously, before the body is read.
{
  const req = makeRequest('{}', { 'content-type': 'text/plain' })
  const res = makeResponse()
  handler(req, res)
  req.fire()
  check('non-JSON content-type answers 415',
    res.read().status === 415 && JSON.parse(res.read().body).ok === false,
    'status=' + res.read().status)
}

// Atomic writes: no temp leftovers, and the rolling backup is in place.
{
  const files = await readdir(join(SCRATCH_HOME, 'instruction-memory'))
  check('no .tmp leftovers after saves',
    !files.some((name) => name.endsWith('.tmp')), JSON.stringify(files))
  check('rolling backup memory.json.bak exists', files.includes('memory.json.bak'), JSON.stringify(files))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

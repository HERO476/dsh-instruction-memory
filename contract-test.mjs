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
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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

// A real HTTP/1.1 client always sends `Host`, and the route now requires a
// loopback one whenever the server is bound to loopback (see the DNS-rebinding
// note on requestOriginVerdict in lib/index.js). The doubles must therefore
// carry it, or every scenario below would be answered with 403.
const DEFAULT_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:8080' }

function makeRequest(body, headers) {
  const listeners = {}
  return {
    method: 'POST',
    headers: headers || { ...DEFAULT_HEADERS },
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

async function rawRoute(handler, rawBody, headers) {
  const req = makeRequest(rawBody, headers)
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
// Captured so the regression guards at the end can assert what would actually
// be injected, not just what the route reported.
const sections = []
const injectedText = () => sections
  .map((section) => (typeof section.text === 'function' ? section.text({}) : section.text))
  .filter((text) => text.length > 0)
  .join('\n\n')
{
  const ctx = {
    systemPrompt: {
      section: (spec) => {
        sections.push(spec)
        return () => {
          const i = sections.indexOf(spec)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    },
    // `ctx.inject(deps, cb)` is how the route is registered; model the real
    // child fiber by running the callback because webServer exists here.
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { handler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
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
  check('corrupt store: the corrupt primary keeps onDisk=true (the file IS on disk)',
    recovered.snapshot.storage.onDisk === true, JSON.stringify(recovered.snapshot.storage.onDisk))
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

// Optimistic concurrency: a mutating command may carry the rev its caller last
// saw (`baseRev`). Without it, two settings pages sharing one store could
// blind-overwrite each other — tab A holding a stale snapshot would push back
// entries tab B had just deleted, and neither tab would ever know.
{
  const raw1 = await callRoute(handler, { method: 'state', args: null })
  const rev1 = raw1.snapshot.data.rev
  check('rev: the snapshot carries a numeric rev', typeof rev1 === 'number', JSON.stringify(rev1))

  const saved = await callRoute(handler, {
    method: 'save-entry',
    args: {
      baseRev: rev1,
      entry: { id: '', title: 'REV-ENTRY', content: 'rev content', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 },
    },
  })
  check('rev: a save carrying the current rev succeeds', saved.ok === true, JSON.stringify(saved.message))
  check('rev: a committed write advanced the rev by exactly one',
    saved.snapshot.data.rev === rev1 + 1, rev1 + ' -> ' + saved.snapshot.data.rev)

  // A second window still holding rev1 must be refused with a conflict — and
  // the refusal must carry the FRESH snapshot so its panel can resync.
  const stale = await callRoute(handler, {
    method: 'save-entry',
    args: {
      baseRev: rev1,
      entry: { id: '', title: 'STALE-WINDOW', content: 'must not land', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 },
    },
  })
  check('rev: a stale baseRev is refused with conflict:true',
    stale.ok === false && stale.conflict === true, JSON.stringify({ ok: stale.ok, conflict: stale.conflict }))
  check('rev: the conflict response carries the fresh snapshot',
    stale.snapshot.data.rev === saved.snapshot.data.rev
    && !stale.snapshot.data.entries.some((e) => e.title === 'STALE-WINDOW'))
  const after = await callRoute(handler, { method: 'state', args: null })
  check('rev: the stale write never reached the store',
    !after.snapshot.data.entries.some((e) => e.title === 'STALE-WINDOW'))

  // delete-entry and set-options must be guarded by the same check.
  const staleDelete = await callRoute(handler, { method: 'delete-entry', args: { id: 'whatever', baseRev: rev1 } })
  check('rev: a stale delete is refused with conflict:true',
    staleDelete.ok === false && staleDelete.conflict === true, JSON.stringify(staleDelete.conflict))
  const staleOptions = await callRoute(handler, { method: 'set-options', args: { enabled: false, baseRev: rev1 } })
  check('rev: a stale set-options is refused with conflict:true',
    staleOptions.ok === false && staleOptions.conflict === true, JSON.stringify(staleOptions.conflict))
  check('rev: the stale set-options did not flip the master switch',
    staleOptions.snapshot.data.enabled === true, String(staleOptions.snapshot.data.enabled))

  // Legacy clients send no baseRev; they keep the old unconditional behaviour.
  const legacy = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'LEGACY-CLIENT', content: 'no baseRev', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('rev: a save without baseRev is still accepted (legacy clients)',
    legacy.ok === true, JSON.stringify(legacy.message))
}

// A store declaring a FUTURE format version must be refused, not best-effort
// parsed as v1: fields could mean something else, and the next save would
// rewrite the file in the wrong shape. Mutations must be paused while the
// file is in that state — the file itself stays untouched on disk.
{
  await writeFile(STORE_FILE, JSON.stringify({
    version: 2, rev: 9, enabled: true, budgetChars: 4000,
    entries: [{ id: 'v2-e', title: 'FROM-THE-FUTURE', content: 'v2 payload', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
  }), 'utf8')

  const refused = await callRoute(handler, { method: 'reload', args: null })
  check('future version: reload is refused with a readable error',
    refused.ok === false && typeof refused.message === 'string' && refused.message.includes('版本'),
    JSON.stringify(refused.message))
  check('future version: the future-format entry is NOT loaded',
    !refused.snapshot.data.entries.some((e) => e.title === 'FROM-THE-FUTURE'))
  check('future version: the panel is told the file is on disk (it is)',
    refused.snapshot.storage.onDisk === true, JSON.stringify(refused.snapshot.storage))

  const saveRefused = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'MUST-NOT-SAVE', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('future version: saving is paused while the format is unknown',
    saveRefused.ok === false && typeof saveRefused.message === 'string' && saveRefused.message.includes('版本'),
    JSON.stringify(saveRefused.message))
  const optionsRefused = await callRoute(handler, { method: 'set-options', args: { enabled: false } })
  check('future version: set-options is paused too',
    optionsRefused.ok === false, JSON.stringify(optionsRefused.message))
  check('future version: the file on disk is untouched (still version 2)',
    JSON.parse(await readFile(STORE_FILE, 'utf8')).version === 2)

  // Restoring a v1 file and reloading lifts the pause.
  await writeFile(STORE_FILE, JSON.stringify({
    version: 1, enabled: true, budgetChars: 4000,
    entries: [{ id: 'back-to-v1', title: 'RESTORED', content: 'v1 again', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
  }), 'utf8')
  const healed = await callRoute(handler, { method: 'reload', args: null })
  check('future version: a restored v1 file loads normally',
    healed.ok === true && healed.snapshot.data.entries.some((e) => e.title === 'RESTORED'),
    JSON.stringify(healed.message))
  const healedSave = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'AFTER-HEAL', content: 'works again', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('future version: saving works again after the restore',
    healedSave.ok === true, JSON.stringify(healedSave.message))
}

// The body ceiling must exceed the largest payload this plugin can produce.
// It used to be a hard-coded 1,000,000 while MAX_ENTRIES × MAX_CONTENT is
// already 1.2 M characters of content — so a maximal store could be exported by
// this plugin and then never imported back into it: the route answered the
// plugin's own export with 413. The ceiling is derived from the entry limits
// now, and this guard is what keeps the two from drifting apart again.
//
// A body over the ceiling must still come back as a clean 413 the Client can
// render, not a destroyed socket it can only report as a network failure.
{
  const worstCase = JSON.stringify({
    method: 'import-data',
    args: {
      payload: {
        entries: Array.from({ length: 200 }, (_, i) => ({
          id: 'worst-' + i,
          title: 'T'.repeat(120),
          content: 'C'.repeat(6000),
          mode: 'always',
          when: 'W'.repeat(200),
          priority: 2,
          enabled: true,
          updatedAt: Date.now(),
        })),
      },
    },
  })
  check('body ceiling exceeds the largest legal payload (own export must re-import)',
    worstCase.length < host.MAX_BODY_CHARS,
    worstCase.length + ' vs ' + host.MAX_BODY_CHARS)

  const out = await rawRoute(handler, 'x'.repeat(host.MAX_BODY_CHARS + 1))
  check('oversized body answers 413 with a JSON error',
    out.status === 413 && JSON.parse(out.body).ok === false,
    'status=' + out.status)

  // The ceiling is published in the snapshot so the Client can refuse an
  // oversized import file before reading it. Pin the wiring: same value the
  // route enforces, or the Client-side gate would drift from the real 413.
  const stateNow = await callRoute(handler, { method: 'state', args: null })
  check('body ceiling: limits.maxBodyChars is published and equals the enforced ceiling',
    stateNow.snapshot.limits.maxBodyChars === host.MAX_BODY_CHARS,
    JSON.stringify(stateNow.snapshot.limits))
}

// The route only speaks application/json: a cross-site form post (or any
// other content type) must get a readable 415, not a confusing parse
// failure. The 415 branch answers synchronously, before the body is read.
{
  const req = makeRequest('{}', { 'content-type': 'text/plain', host: '127.0.0.1:8080' })
  const res = makeResponse()
  handler(req, res)
  req.fire()
  check('non-JSON content-type answers 415',
    res.read().status === 415 && JSON.parse(res.read().body).ok === false,
    'status=' + res.read().status)
}

// Origin/Host guard. The 415 rule above assumes the browser sees the request as
// cross-origin; DNS rebinding removes that assumption, because a page on
// evil.com pointed at 127.0.0.1 is same-origin with the server it then calls —
// no preflight, JSON content-type allowed, and this route would rewrite the
// instructions injected into every later prompt. Only the Host header still
// gives the attacker away.
async function statusFor(headers, body) {
  const out = await rawRoute(handler, body, headers)
  return out.status
}
{
  const hostile = JSON.stringify({ method: 'save-entry', args: { entry: { id: '', title: 'PWNED', content: 'via rebinding', mode: 'always', when: '', priority: 2, enabled: true, updatedAt: 0 } } })
  const before = await callRoute(handler, { method: 'state', args: null })

  check('a foreign Host is refused with 403',
    await statusFor({ 'content-type': 'application/json', host: 'evil.com:8080' }, hostile) === 403)
  check('a foreign Host is refused even when Origin matches it',
    await statusFor({ 'content-type': 'application/json', host: 'evil.com:8080', origin: 'http://evil.com:8080' }, hostile) === 403)
  check('a cross-origin Origin is refused with 403',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', origin: 'http://evil.com' }, hostile) === 403)
  check('Origin: null is refused with 403',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', origin: 'null' }, hostile) === 403)
  check('a loopback Host with a same-origin Origin is accepted',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, JSON.stringify({ method: 'state' })) === 200)
  check('a localhost Host is accepted',
    await statusFor({ 'content-type': 'application/json', host: 'localhost:8080' }, JSON.stringify({ method: 'state' })) === 200)

  // Fetch Metadata: a modern browser stamps Sec-Fetch-Site on every request,
  // even ones that managed to drop Origin — a page on evil.com is still
  // labelled cross-site. Only cross-site is refused; same-site must pass
  // (schemeful same-site ignores ports), and absence passes because curl,
  // Node and pre-2020 browsers never send it.
  check('Sec-Fetch-Site: cross-site is refused with 403',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' }, hostile) === 403)
  check('Sec-Fetch-Site: the refusal carries a readable reason',
    (await rawRoute(handler, hostile,
      { 'content-type': 'application/json', host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' }))
      .body.includes('Sec-Fetch-Site'))
  check('Sec-Fetch-Site: same-origin is accepted',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', 'sec-fetch-site': 'same-origin' }, JSON.stringify({ method: 'state' })) === 200)
  check('Sec-Fetch-Site: same-site is accepted (same-site ignores ports)',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', 'sec-fetch-site': 'same-site' }, JSON.stringify({ method: 'state' })) === 200)
  check('Sec-Fetch-Site: none is accepted (user-driven navigation)',
    await statusFor({ 'content-type': 'application/json', host: '127.0.0.1:8080', 'sec-fetch-site': 'none' }, JSON.stringify({ method: 'state' })) === 200)

  const after = await callRoute(handler, { method: 'state', args: null })
  check('a refused rebinding write left the store untouched',
    after.snapshot.data.entries.length === before.snapshot.data.entries.length
    && after.snapshot.data.entries.every((e) => e.title !== 'PWNED'))
  check('the refused entry was never injected',
    !injectedText().includes('PWNED'))
}

// The Host allowlist must track the BIND, not the literal string `0.0.0.0`.
// Binding `::` (IPv6 all-interfaces) or a concrete address such as
// `192.168.1.5` publishes the server just as deliberately as `0.0.0.0` does,
// and the old `boundHost !== '0.0.0.0'` comparison left those deployments
// 403-ing every legitimate client that reached them by hostname.
{
  async function mountWithHost(boundHost) {
    let h = null
    const ctx = {
      systemPrompt: { section: () => () => {} },
      inject: (deps, callback) => {
        const names = Array.isArray(deps) ? deps : Object.keys(deps)
        if (names.includes('webServer')) {
          callback({
            // `host: undefined` exercises the "server did not say" default,
            // which must behave as loopback (the server default bind).
            webServer: {
              ...(boundHost === '' ? {} : { host: boundHost }),
              register: (route) => { h = route.handler; return () => {} },
            },
            effect: (fn) => { fn(); return () => {} },
          })
        }
        return null
      },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
      logger: () => ({ info: () => {}, debug: () => {} }),
    }
    const mod = await import(new URL('./lib/index.js', import.meta.url).href
      + '?bind=' + encodeURIComponent(boundHost === '' ? 'unset' : boundHost)
      + '-' + Date.now() + Math.random().toString(36).slice(2))
    mod.apply(ctx)
    if (h === null) throw new Error('route not registered for bind ' + boundHost)
    return h
  }

  async function statusOn(h, headers, body) {
    const out = await rawRoute(h, body, headers)
    return out.status
  }

  // A published deployment: the client legitimately arrives with the address
  // it dialed, which is not a loopback name.
  for (const bound of ['::', '0.0.0.0', '192.168.1.5']) {
    const h = await mountWithHost(bound)
    const status = await statusOn(h,
      { 'content-type': 'application/json', host: '192.168.1.5:8080' },
      JSON.stringify({ method: 'state' }))
    check('host guard: bind ' + bound + ' accepts a non-loopback Host (published deployment)',
      status === 200, 'status=' + status)
  }
  // A loopback (or unset — the server default) bind must keep the allowlist.
  for (const bound of ['127.0.0.1', 'localhost', '::1', '']) {
    const h = await mountWithHost(bound)
    const status = await statusOn(h,
      { 'content-type': 'application/json', host: '192.168.1.5:8080' },
      JSON.stringify({ method: 'state' }))
    check('host guard: bind ' + (bound === '' ? '(unset)' : bound) + ' still refuses a non-loopback Host',
      status === 403, 'status=' + status)
  }

  // IPv6 loopback END TO END through the real route. The shipped defect
  // rejected the GUI when it was opened at http://[::1]:port: the Host parsed
  // to ::1 but the bracketed Origin parsed to '[::1]', and the two never
  // compared equal. Also covers the two WHATWG-URL spellings of a mapped
  // address (dotted-quad Host vs canonical hex Origin).
  {
    const h6 = await mountWithHost('::1')
    const sameOrigin = await statusOn(h6,
      { 'content-type': 'application/json', host: '[::1]:8080', origin: 'http://[::1]:8080' },
      JSON.stringify({ method: 'state' }))
    check('ipv6: [::1] loopback Host with a bracketed same Origin is 200',
      sameOrigin === 200, 'status=' + sameOrigin)
    const diffPort = await statusOn(h6,
      { 'content-type': 'application/json', host: '[::1]:8080', origin: 'http://[::1]:9999' },
      JSON.stringify({ method: 'state' }))
    check('ipv6: a different-port same-host Origin is still same-origin',
      diffPort === 200, 'status=' + diffPort)
    const mapped = await statusOn(h6,
      { 'content-type': 'application/json', host: '[::ffff:127.0.0.1]:8080', origin: 'http://[::ffff:7f00:1]:8080' },
      JSON.stringify({ method: 'state' }))
    check('ipv6: the mapped-address spelling difference (dotted vs hex) is accepted',
      mapped === 200, 'status=' + mapped)
    const rebind = await statusOn(h6,
      { 'content-type': 'application/json', host: '[::1]:8080', origin: 'http://evil.com' },
      JSON.stringify({ method: 'state' }))
    check('ipv6: rebinding through a foreign Origin is still 403',
      rebind === 403, 'status=' + rebind)
    // The SSE stream runs the same verdict before upgrading.
    const sseDenied = await new Promise((resolve) => {
      const req = {
        method: 'GET',
        headers: { accept: 'text/event-stream', host: '[::1]:8080', origin: 'http://evil.com' },
        on: () => req,
      }
      let settled = false
      const settle = (status) => { if (!settled) { settled = true; resolve(status) } }
      const res = { writeHead: settle, end: () => settle(0), on() {}, write() {} }
      h6(req, res)
    })
    check('ipv6: a cross-origin EventSource is refused 403 too', sseDenied === 403, 'status=' + sseDenied)
  }
}

// Atomic writes: no temp leftovers, and the rolling backup is in place.
{
  const files = await readdir(join(SCRATCH_HOME, 'instruction-memory'))
  check('no .tmp leftovers after saves',
    !files.some((name) => name.endsWith('.tmp')), JSON.stringify(files))
  check('rolling backup memory.json.bak exists', files.includes('memory.json.bak'), JSON.stringify(files))
}

// Cross-process write lock ownership. The marker carries a per-attempt token:
// a finished slow holder must never delete the lock a newer owner took over.
{
  const lockPath = STORE_FILE + '.lock'
  await rm(lockPath, { force: true })

  // A FRESH foreign lock (another process mid-save): the host waits its short
  // grace period, then writes unlocked BY DESIGN — but the foreign marker must
  // survive our finally untouched.
  writeFileSync(lockPath, 'foreign-holder-token')
  const t0 = Date.now()
  const unlocked = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'LOCK-FRESH', content: 'written past a live lock', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  const waitedMs = Date.now() - t0
  check('lock: a save blocked by a fresh foreign lock still succeeds (unlocked by design)',
    unlocked.ok === true && unlocked.saved === true, JSON.stringify(unlocked.message))
  check('lock: the blocked save waited roughly the 2s grace period, not 0 and not 10s',
    waitedMs >= 1800 && waitedMs < 8000, waitedMs + 'ms')
  check('lock: the foreign marker is left owned by the OTHER process (no unlink in finally)',
    existsSync(lockPath) && readFileSync(lockPath, 'utf8') === 'foreign-holder-token',
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '(marker missing)')
  check('lock: the unlocked write landed anyway',
    unlocked.snapshot.data.entries.some((e) => e.title === 'LOCK-FRESH'))

  // A STALE foreign lock (crashed holder; mtime older than the 10s threshold)
  // is stolen; the new owner's token is what gets released afterwards, so the
  // marker ends up gone rather than replaced by our content and abandoned.
  utimesSync(lockPath, (Date.now() - 30000) / 1000, (Date.now() - 30000) / 1000)
  const stolen = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'LOCK-STALE', content: 'written after stealing a dead lock', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('lock: a stale foreign lock is stolen and the save succeeds quickly',
    stolen.ok === true && stolen.saved === true, JSON.stringify(stolen.message))
  check('lock: after release no marker remains (we released our own token)',
    !existsSync(lockPath), 'marker still present')
  await rm(lockPath, { force: true })
}

// Deleting an id that is not there changes nothing: no disk write, no rev
// bump, no push. Previously a missing id still ran the full commit path.
{
  const before = await callRoute(handler, { method: 'state', args: null })
  const revBefore = before.snapshot.data.rev
  const countBefore = before.snapshot.data.entries.length
  const missing = await callRoute(handler, { method: 'delete-entry', args: { id: 'no-such-entry-exists' } })
  check('delete: a missing id reports ok', missing.ok === true, JSON.stringify(missing.message))
  check('delete: a missing id performs NO save (saved:false)',
    missing.saved === false, String(missing.saved))
  check('delete: a missing id does not bump rev',
    missing.snapshot.data.rev === revBefore, revBefore + ' -> ' + missing.snapshot.data.rev)
  check('delete: a missing id leaves the entry count alone',
    missing.snapshot.data.entries.length === countBefore,
    countBefore + ' -> ' + missing.snapshot.data.entries.length)
  const after = await callRoute(handler, { method: 'state', args: null })
  check('delete: a follow-up state read sees the same rev (nothing was written)',
    after.snapshot.data.rev === revBefore, revBefore + ' -> ' + after.snapshot.data.rev)
}

/* ==================================================================== *
 * Regression guards for the defects fixed in 1.0.10.
 * These mutate the scratch store destructively, so they run last.
 * ==================================================================== */

// --- A no-op import must not claim it saved anything. ---------------------
{
  const before = await callRoute(handler, { method: 'state', args: null })
  const raw = await callRoute(handler, { method: 'export-data', args: null })
  const again = await callRoute(handler, { method: 'import-data', args: { payload: raw.export } })
  check('no-op import reports saved:false (it wrote nothing)',
    again.ok === true && again.saved === false && again.message.includes('没有新增'),
    JSON.stringify({ ok: again.ok, saved: again.saved, message: again.message }))
  const after = await callRoute(handler, { method: 'state', args: null })
  check('no-op import left the store untouched',
    after.snapshot.data.entries.length === before.snapshot.data.entries.length)
}

// --- An over-long entry must be reported as truncated, not silently cut. ---
{
  const long = await callRoute(handler, {
    method: 'import-data',
    args: { payload: { entries: [{ title: 'TOO-LONG', content: 'L'.repeat(7000) }] } },
  })
  check('an over-long import discloses the truncation',
    long.ok === true && typeof long.message === 'string' && long.message.includes('截断'),
    JSON.stringify(long.message))
  check('the stored content really is the capped length',
    long.snapshot.data.entries.some((e) => e.title === 'TOO-LONG' && e.content.length === 6000))
  check('the truncated entry is still injected (it was saved, not dropped)',
    injectedText().includes('TOO-LONG'))
}

// --- A failed disk write must roll the in-memory state back. --------------
//
// The write is the commit point. Before this guard, a failed save correctly
// left memory.json alone and told the user so — while the injected prompt kept
// carrying the unsaved edit for the rest of the process lifetime, so the model
// obeyed an instruction the user had been told was not saved.
{
  const tmpDir = join(SCRATCH_HOME, 'instruction-memory', 'memory.json.tmp')
  await mkdir(tmpDir, { recursive: true })

  const failed = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'NEVER-SAVED', content: 'IM-NEVER-SAVED', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('a failed save reports ok:false', failed.ok === false, JSON.stringify(failed.message))
  check('a failed save is not injected',
    !injectedText().includes('IM-NEVER-SAVED'),
    injectedText().includes('IM-NEVER-SAVED') ? 'injection still carries the unsaved edit' : 'clean')
  check('a failed save leaves the stored entries unchanged',
    failed.snapshot.data.entries.every((e) => e.title !== 'NEVER-SAVED'))
  check('a failed set-options also rolls back',
    (await callRoute(handler, { method: 'set-options', args: { enabled: false } })).snapshot.data.enabled === true)

  await rm(tmpDir, { recursive: true, force: true })
}

// --- A missing primary with a good backup must recover, not go empty. -----
//
// The backup step used to rename the live file away before the replace, so a
// failure in between left no memory.json at all; the next boot then found no
// file, materialised an EMPTY store, and silently presented the user with no
// memory while their real data sat in .bak. The backup is a copy now, and this
// path recovers rather than starting over.
{
  const before = await callRoute(handler, { method: 'state', args: null })
  check('precondition: the store has entries to lose',
    before.snapshot.data.entries.length > 0, String(before.snapshot.data.entries.length))

  await rm(STORE_FILE, { force: true })                      // memory.json gone
  check('precondition: the rolling backup survives', existsSync(STORE_FILE + '.bak'))

  const recoveredRaw = await callRoute(handler, { method: 'reload', args: null })
  const recovered = normalize(recoveredRaw)
  check('missing primary: recovers from the backup instead of an empty store',
    recovered.snapshot.data.entries.length > 0,
    'entries=' + recovered.snapshot.data.entries.length)
  check('missing primary: the promoting reload reports saved:true (it wrote memory.json back)',
    recoveredRaw.saved === true, JSON.stringify(recoveredRaw.saved))
  check('missing primary: the recovery is disclosed',
    typeof recovered.snapshot.storage.warning === 'string' && recovered.snapshot.storage.warning.includes('memory.json.bak'),
    JSON.stringify(recovered.snapshot.storage.warning))
  check('missing primary: the recovered data is injected',
    injectedText().length > 0)
  check('missing primary: memory.json was written back',
    existsSync(STORE_FILE))
}

// --- Hand-edited options must be corrected loudly, not silently. ------------
//
// The loader has always clamped budgetChars and defaulted a non-boolean
// enabled, but the fix used to be invisible: the next save rewrote the file
// with the corrected values and the user never learned their edit had been
// ignored. Now every correction is named in the load warning.
{
  await writeFile(STORE_FILE, JSON.stringify({
    version: 1, enabled: 'yes', budgetChars: 100,
    entries: [{ id: 'hand-1', title: 'HAND', content: 'hand edited', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
  }), 'utf8')

  const reloaded = normalize(await callRoute(handler, { method: 'reload', args: null }))
  check('hand-edited options: reload reports ok', reloaded.ok === true, JSON.stringify(reloaded.message))
  check('hand-edited options: values are corrected',
    reloaded.snapshot.data.budgetChars === 800 && reloaded.snapshot.data.enabled === true,
    'budgetChars=' + reloaded.snapshot.data.budgetChars + ' enabled=' + reloaded.snapshot.data.enabled)
  check('hand-edited options: both corrections are disclosed',
    typeof reloaded.snapshot.storage.warning === 'string'
      && reloaded.snapshot.storage.warning.includes('budgetChars')
      && reloaded.snapshot.storage.warning.includes('enabled'),
    JSON.stringify(reloaded.snapshot.storage.warning))
  check('hand-edited options: warning names the next-save consequence',
    reloaded.snapshot.storage.warning.includes('下次保存'),
    JSON.stringify(reloaded.snapshot.storage.warning))

  // The next save persists the corrected values, and the disclosure ends.
  const saved = normalize(await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'AFTER-FIX', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  }))
  check('hand-edited options: saving after corrections reports ok', saved.ok === true, JSON.stringify(saved.message))
  const onDisk = JSON.parse(await readFile(STORE_FILE, 'utf8'))
  check('hand-edited options: the corrected values are what got persisted',
    onDisk.budgetChars === 800 && onDisk.enabled === true,
    'budgetChars=' + onDisk.budgetChars + ' enabled=' + onDisk.enabled)
  const cleared = normalize(await callRoute(handler, { method: 'reload', args: null }))
  check('hand-edited options: warning cleared once the file is clean again',
    cleared.snapshot.storage.warning === null, JSON.stringify(cleared.snapshot.storage.warning))
}

// --- Read-only responses must not claim they saved anything. ---------------
//
// `saved` in the response envelope means "this operation persisted the store".
// Before the fix, `state`, `reload` and even `export-data` — which never
// writes a byte — answered saved:true, so the field carried no information a
// caller could rely on. Raw responses are asserted because the Client's
// normalizer deliberately drops the field.
{
  const stateRes = await callRoute(handler, { method: 'state', args: null })
  check('read-only: state on an existing store reports saved:false',
    stateRes.ok === true && stateRes.saved === false,
    JSON.stringify({ ok: stateRes.ok, saved: stateRes.saved }))

  const reloadRes = await callRoute(handler, { method: 'reload', args: null })
  check('read-only: reload of an unchanged store reports saved:false',
    reloadRes.ok === true && reloadRes.saved === false,
    JSON.stringify({ ok: reloadRes.ok, saved: reloadRes.saved }))

  const exportRes = await callRoute(handler, { method: 'export-data', args: null })
  check('read-only: export-data never claims a save',
    exportRes.ok === true && exportRes.saved === false,
    JSON.stringify({ ok: exportRes.ok, saved: exportRes.saved }))

  const savedRes = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'REAL-SAVE', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('read-only: a real save still reports saved:true',
    savedRes.ok === true && savedRes.saved === true,
    JSON.stringify({ ok: savedRes.ok, saved: savedRes.saved }))
}

/* ==================================================================== *
 * SSE live updates: an open settings page must see store changes that
 * happened without it — another window saving through the same host, or
 * memory.json changing on disk underneath the process.
 * ==================================================================== */
{
  // Minimal EventSource stand-in: a GET carrying `Accept: text/event-stream`
  // (exactly what a browser EventSource sends) against a response double that
  // records every chunk written.
  const openStream = (headers, routeHandler = handler) => {
    const listeners = {}
    const out = { status: 0, chunks: [], ended: false }
    const req = {
      method: 'GET',
      headers: headers || { accept: 'text/event-stream', host: '127.0.0.1:8080' },
      on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); return this },
      fire(name) { for (const cb of listeners[name] || []) cb() },
    }
    const res = {
      writeHead(status) { out.status = status },
      write(chunk) { out.chunks.push(String(chunk)) },
      end() { out.ended = true },
      on() {},
    }
    routeHandler(req, res)
    return { req, out }
  }
  const framesOf = (out) => out.chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)))

  const hostile = openStream({ accept: 'text/event-stream', host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' })
  check('sse: a cross-site stream request is refused (403)',
    hostile.out.status === 403, 'status=' + hostile.out.status)

  const stream = openStream()
  check('sse: a stream request is answered 200 with a retry hint',
    stream.out.status === 200
      && typeof stream.out.chunks[0] === 'string' && stream.out.chunks[0].startsWith('retry: '),
    'status=' + stream.out.status + ' first=' + JSON.stringify(stream.out.chunks[0]))
  check('sse: connecting immediately delivers the current snapshot',
    framesOf(stream.out).length === 1, 'frames=' + framesOf(stream.out).length)
  const firstFrame = normalize(framesOf(stream.out)[0])
  check('sse: the frame is the bare snapshot the Client normalizer accepts',
    firstFrame !== null && Array.isArray(firstFrame.snapshot.data.entries),
    'raw keys = ' + JSON.stringify(Object.keys(framesOf(stream.out)[0] || {})))

  // Same host, second window: a mutation by one panel must reach the other.
  const savedRes = await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'SSE-PUSH', content: 'pushed to other windows', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  let pushed = null
  for (let i = 0; i < 200 && pushed === null; i += 1) {
    const frames = framesOf(stream.out)
    pushed = frames.length > 1 ? frames[frames.length - 1] : null
    if (pushed === null) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  check('sse: a mutation through the route is pushed to the open stream',
    pushed !== null && pushed.data.entries.some((e) => e.title === 'SSE-PUSH'),
    'pushed=' + (pushed === null ? 'null' : 'no SSE-PUSH entry'))
  check('sse: the pushed frame matches the response snapshot (so the initiating window drops it as an echo)',
    pushed !== null && JSON.stringify(pushed) === JSON.stringify(savedRes.snapshot))

  // A writer whose socket has died: res.write throws on the next broadcast.
  // pushSnapshot must run that stream's full cleanup (end the response and
  // unsubscribe) and keep serving the healthy streams — previously it only
  // deleted the send from a Set, leaving the response open and registered.
  {
    const deadListeners = {}
    const deadOut = { status: 0, chunks: [], ended: false }
    let writes = 0
    const deadReq = {
      method: 'GET',
      headers: { accept: 'text/event-stream', host: '127.0.0.1:8080' },
      on(event, cb) { (deadListeners[event] = deadListeners[event] || []).push(cb); return deadReq },
      fire() {},
    }
    const deadRes = {
      writeHead(status) { deadOut.status = status },
      // write #1 is the retry hint, #2 the connect frame; the first PUSH (#3)
      // is the dead socket, so it throws exactly when a broadcast happens.
      write(chunk) {
        writes += 1
        if (writes >= 3) throw new Error('EPIPE')
        deadOut.chunks.push(String(chunk))
      },
      end() { deadOut.ended = true },
      on() {},
    }
    handler(deadReq, deadRes)
    check('sse: the dead writer\'s connect frame did not throw yet',
      deadOut.status === 200 && deadOut.ended === false, 'status=' + deadOut.status)

    await callRoute(handler, {
      method: 'save-entry',
      args: { entry: { id: '', title: 'SSE-DEAD', content: 'the other end vanished', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
    })
    check('sse: a writer that throws on broadcast is fully disposed (response ended)',
      deadOut.ended === true, 'stream left open')
    // The healthy stream opened above must still receive broadcasts: the
    // cleanup of one dead stream never tears down the others.
    let healthyGotIt = null
    for (let i = 0; i < 100 && healthyGotIt === null; i += 1) {
      const frames = framesOf(stream.out)
      healthyGotIt = frames.some((f) => f.data.entries.some((e) => e.title === 'SSE-DEAD'))
      if (healthyGotIt !== true) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check('sse: disposing the dead writer does not interrupt a healthy stream',
      healthyGotIt === true, 'the open stream never saw SSE-DEAD')
  }

  // External change: memory.json rewritten on disk by something else (another
  // process sharing the file). Watcher + debounce must reload and push.
  const beforeExternal = framesOf(stream.out).length
  await writeFile(STORE_FILE, JSON.stringify({
    version: 1, enabled: true, budgetChars: 2000,
    entries: [{ id: 'ext-1', title: 'EXTERNAL', content: 'written outside the host', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 2 }],
  }), 'utf8')
  let external = null
  for (let i = 0; i < 400 && external === null; i += 1) {
    const frames = framesOf(stream.out)
    for (let j = beforeExternal; j < frames.length; j += 1) {
      if (frames[j].data.entries.some((e) => e.title === 'EXTERNAL')) external = frames[j]
    }
    if (external === null) await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check('sse: an external disk change is reloaded and pushed (watcher + debounce)',
    external !== null, 'waited 10s for an EXTERNAL frame')
  if (external !== null) {
    check('sse: the external frame reflects the file, not the stale memory',
      external.data.entries.every((e) => e.title !== 'SSE-PUSH'))
  }

  // Closing the stream unsubscribes: later pushes reach nobody.
  stream.req.fire('close')
  check('sse: closing the request ends the response', stream.out.ended === true)
  const beforeClose = framesOf(stream.out).length
  await callRoute(handler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'AFTER-CLOSE', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  check('sse: a closed stream receives no further frames',
    framesOf(stream.out).length === beforeClose,
    'frames=' + framesOf(stream.out).length + ' before=' + beforeClose)

  // Connect-frame race: a stream opened in the gap between apply() and the
  // initial disk read settling must NOT be handed the empty boot state. The
  // first frame has to wait for boot and describe the SEEDED store. The
  // discriminator is timing-deterministic: readFile cannot resolve in the same
  // synchronous tick as apply(), so a pre-fix host always delivered one
  // (empty) frame immediately.
  {
    const BOOT_HOME = fileURLToPath(new URL('./.test-dsh-home-boot/', import.meta.url))
    await rm(BOOT_HOME, { recursive: true, force: true })
    await mkdir(join(BOOT_HOME, 'instruction-memory'), { recursive: true })
    await writeFile(join(BOOT_HOME, 'instruction-memory', 'memory.json'), JSON.stringify({
      version: 1, enabled: true, budgetChars: 4000,
      entries: [{ id: 'boot-race', title: 'BOOT-RACE', content: 'loaded before the first frame', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 3 }],
    }), 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = BOOT_HOME

    let bootHandler = null
    const bootCtx = {
      systemPrompt: { section: () => () => {} },
      inject: (deps, callback) => {
        const names = Array.isArray(deps) ? deps : Object.keys(deps)
        if (names.includes('webServer')) {
          callback({
            webServer: { register: (route) => { bootHandler = route.handler; return () => {} } },
            effect: (fn) => { fn(); return () => {} },
          })
        }
        return null
      },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    const bootMod = await import(new URL('./lib/index.js', import.meta.url).href + '?boot=' + Date.now())
    bootMod.apply(bootCtx)

    // Same tick: boot's read is necessarily still pending.
    const early = openStream(undefined, bootHandler)
    check('sse: no frame precedes the initial disk read (no empty-store flash)',
      framesOf(early.out).length === 0, 'frames=' + framesOf(early.out).length)

    let seededFrame = null
    let observedFrames = []
    for (let i = 0; i < 200 && seededFrame === null; i += 1) {
      observedFrames = framesOf(early.out)
      seededFrame = observedFrames.find((f) => f.data.entries.some((e) => e.title === 'BOOT-RACE')) || null
      if (seededFrame === null) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check('sse: the first frame waits for boot and carries the seeded entry',
      seededFrame !== null, 'no BOOT-RACE frame within 2s')
    check('sse: no empty frame was ever sent ahead of the seeded one',
      seededFrame !== null && observedFrames.indexOf(seededFrame) === 0,
      'the seeded frame was not the first frame; frames=' + observedFrames.length)

    early.req.fire('close')
    process.env.DSH_HOME = previousHome
    await rm(BOOT_HOME, { recursive: true, force: true })
  }
}

/* ==================================================================== *
 * Lazy first run: starting up with no store must not create one.
 *
 * The plugin used to materialise an empty memory.json the moment the host
 * booted — no session, no turn, no user action. That is the one side effect a
 * behaviour audit can fairly call "running with nothing to do", so the file is
 * now created by the first action that genuinely needs it: a save, or the
 * settings page reading `state`.
 * ==================================================================== */
{
  const LAZY_HOME = fileURLToPath(new URL('./.test-dsh-home-lazy/', import.meta.url))
  await rm(LAZY_HOME, { recursive: true, force: true })

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = LAZY_HOME

  let lazyHandler = null
  const logLines = []
  const lazySections = []
  const lazyCtx = {
    systemPrompt: {
      section: (spec) => {
        lazySections.push(spec)
        return () => {
          const i = lazySections.indexOf(spec)
          if (i >= 0) lazySections.splice(i, 1)
        }
      },
    },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { lazyHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
    logger: () => ({ info: (m) => logLines.push(String(m)), debug: (m) => logLines.push(String(m)) }),
  }

  // A separate module instance, so this mount cannot share state with the one
  // at the top of this file.
  const lazyHost = await import(new URL('./lib/index.js', import.meta.url).href + '?lazy=' + Date.now())
  lazyHost.apply(lazyCtx)

  // boot is asynchronous; the mount line is the signal that it has settled.
  for (let i = 0; i < 300 && !logLines.some((l) => l.startsWith('mounted:')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const storeDir = join(LAZY_HOME, 'instruction-memory')
  const storeFile = join(storeDir, 'memory.json')

  check('lazy first run: booting writes no store file', !existsSync(storeFile))
  check('lazy first run: booting does not even create the store directory',
    !existsSync(storeDir),
    'workspace contents = ' + JSON.stringify(await readdir(LAZY_HOME).catch(() => [])))
  // With an empty store there is nothing to prepare, so the wording is
  // "nothing to inject" — the "pending assembly" wording (content present but
  // not yet pulled) is guarded in verify.mjs, which seeds a store first.
  check('lazy first run: the mount line reports onDisk=no, first run, and nothing to inject',
    logLines.some((l) => l.includes('onDisk=no') && l.includes('from=first run')
      && l.includes('section=nothing to inject') && !l.includes('injected=')),
    JSON.stringify(logLines))
  check('lazy first run: nothing has been pulled into a prompt yet (pulls=0)',
    logLines.some((l) => l.includes('pulls=0')), JSON.stringify(logLines))

  // Reading `state` is a deliberate user action — the settings page mounting —
  // and that is what materialises the file.
  const firstState = await callRoute(lazyHandler, { method: 'state' })
  check('lazy first run: an empty memory registers NO prompt section',
    firstState.snapshot.injection.registered === false, JSON.stringify(firstState.snapshot.injection))
  check('lazy first run: reading state materialises the store',
    existsSync(storeFile))
  check('lazy first run: the materialising state reports saved:true (it wrote the file)',
    firstState.saved === true, JSON.stringify(firstState.saved))
  check('lazy first run: the snapshot reports onDisk=true afterwards',
    firstState.snapshot.storage.onDisk === true, JSON.stringify(firstState.snapshot.storage))
  check('lazy first run: pulls is still 0 (prepared nowhere, assembled nowhere)',
    firstState.snapshot.injection.pulls === 0, String(firstState.snapshot.injection.pulls))

  // `pulls` is the honest "did this reach a prompt" signal: it moves only when
  // the harness would have evaluated the registered thunk.
  const saved = await callRoute(lazyHandler, {
    method: 'save-entry',
    args: { entry: { id: '', title: 'PULLS', content: 'IM-PULLS-OK', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 } },
  })
  check('lazy first run: saving registers the section', saved.snapshot.injection.registered === true)
  check('lazy first run: registering alone does not move pulls',
    saved.snapshot.injection.pulls === 0, String(saved.snapshot.injection.pulls))

  const rendered = lazySections[0]?.text({})
  check('lazy first run: the registered thunk renders the memory',
    typeof rendered === 'string' && rendered.includes('IM-PULLS-OK'), String(rendered))
  const afterPull = await callRoute(lazyHandler, { method: 'state' })
  check('lazy first run: a host assembly moves pulls to 1',
    afterPull.snapshot.injection.pulls === 1, String(afterPull.snapshot.injection.pulls))
  check('lazy first run: a later state read reports saved:false (nothing to write)',
    afterPull.saved === false, JSON.stringify(afterPull.saved))

  process.env.DSH_HOME = previousHome
  await rm(LAZY_HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

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
  // GitHub Actions annotation: surfaces the failing assertion on the public
  // check-run without needing log access.
  if (!ok) console.log('::error::' + label + (detail === undefined ? '' : ' | ' + String(detail).slice(0, 200)))
}

// A crash (route timeout, a throwing predicate) must still surface: print the
// annotation and keep exit code 1 without cutting off the buffered output.
process.on('uncaughtException', (err) => {
  process.exitCode = 1
  console.log('::error::uncaught: ' + String(err && err.stack ? err.stack : err).slice(0, 400))
})
process.on('unhandledRejection', (err) => {
  process.exitCode = 1
  console.log('::error::unhandledRejection: ' + String(err && err.stack ? err.stack : err).slice(0, 400))
})

/* ---------------- isolate the store: point DSH_HOME at a scratch dir ---------------- */

// The Host resolves its own data file under the harness home. Redirecting
// DSH_HOME here is what guarantees this suite never reads or writes the user's
// real memory store.
/**
 * Scratch homes carry a per-PROCESS suffix ("-p<pid>"). Every block deletes
 * and re-creates its home around itself, so two concurrent runs of this suite
 * (an IDE test task plus "npm test", say) would otherwise delete each other's
 * store mid-write — which surfaced as a baffling ENOTEMPTY crash inside a
 * cleanup rather than as a test failure. The gitignore pattern
 * ".test-dsh-home-star" covers every variant. (No literal "star-slash" here:
 * inside a block comment it would terminate the comment early.)
 */
const scratchHome = (name) =>
  fileURLToPath(new URL('./.test-dsh-home' + name + '-p' + process.pid + '/', import.meta.url))

const SCRATCH_HOME = scratchHome('')
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
  // Poll for up to 15s of WALL TIME: a loaded runner can stall a route that
  // does a real disk write (lock, two backup copies, rename, history
  // snapshot) past any iteration count, which is what the isolated ubuntu
  // cell failures were.
  const deadline = Date.now() + 15000
  for (;;) {
    if (res.read().body !== '') return res.read()
    if (Date.now() > deadline) throw new Error('route never responded')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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
    imported.ok === true && imported.message.includes('新增指令 2 条'), JSON.stringify(imported.message))
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
// parsed: fields could mean something else, and the next save would rewrite the
// file in the wrong shape. Mutations must be paused while the file is in that
// state — the file itself stays untouched on disk.
//
// This also IS the downgrade guard: an older build of this plugin (which knows
// version 1 only) refuses a version 2 file the same way, so data written by a
// newer build is never silently half-read and then rewritten by an older one.
{
  await writeFile(STORE_FILE, JSON.stringify({
    version: 3, rev: 9, enabled: true, budgetChars: 4000,
    entries: [{ id: 'v3-e', title: 'FROM-THE-FUTURE', content: 'v3 payload', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
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
  // Reading the "source" in this state would hand out the placeholder in-memory
  // store — i.e. an EMPTY document that looks saveable. It must refuse and point
  // at the file instead.
  const sourceRefused = await callRoute(handler, { method: 'read-source', args: null })
  check('future version: source mode is paused (it would show an empty store)',
    sourceRefused.ok === false && sourceRefused.source === undefined
    && String(sourceRefused.message).includes('重新载入'),
    JSON.stringify(sourceRefused.message))
  check('future version: the file on disk is untouched (still version 3)',
    JSON.parse(await readFile(STORE_FILE, 'utf8')).version === 3)

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
    const BOOT_HOME = scratchHome('-boot')
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
  const LAZY_HOME = scratchHome('-lazy')
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

/* ====================================================================
 * F1: the injection budget plan is published through the real route
 *
 * A tight budget must make the state snapshot carry the effective ceiling,
 * per-entry included/omitted decisions, and a preview whose length matches
 * injection.chars — the exact data the Client's budget meter and the entry
 * badges render. The Client's own reducer is fed the raw snapshot too, so
 * this also pins the seam between the two halves.
 * ==================================================================== */
{
  const PLAN_HOME = scratchHome('-plan')
  await rm(PLAN_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = PLAN_HOME

  let planHandler = null
  const planCtx = {
    systemPrompt: { section: () => () => {} },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { planHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }

  const planHost = await import(new URL('./lib/index.js', import.meta.url).href + '?plan=' + Date.now())
  planHost.apply(planCtx)

  // Eight active entries plus one disabled entry; equal 220-char bodies so
  // only priority/recency decides who makes an 800-character budget.
  const planEntries = Array.from({ length: 8 }, (_, i) => ({
    id: 'p' + i, title: 'P' + i, content: 'z'.repeat(220),
    mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 100 - i,
  }))
  planEntries.push({
    id: 'p-off', title: 'POFF', content: 'q'.repeat(220),
    mode: 'always', when: '', priority: 1, enabled: false, updatedAt: 200,
  })

  await callRoute(planHandler, { method: 'state' })
  for (const e of planEntries) {
    await callRoute(planHandler, { method: 'save-entry', args: { entry: e } })
  }
  await callRoute(planHandler, { method: 'set-options', args: { budgetChars: 800 } })

  const state = await callRoute(planHandler, { method: 'state' })
  const normalized = normalize(state)
  check('F1 plan: the state response is consumable by the Client', normalized !== null)
  const inj = state.snapshot.injection
  check('F1 plan: snapshot carries the effective 800-char budget',
    inj.budget === 800, String(inj.budget))
  check('F1 plan: injection.chars equals preview.length and stays within the budget',
    typeof inj.chars === 'number' && inj.chars === state.snapshot.preview.length
    && inj.chars > 0 && inj.chars <= 800,
    'chars=' + String(inj.chars) + ' preview=' + state.snapshot.preview.length)
  check('F1 plan: activeCount counts enabled non-blank entries only',
    inj.activeCount === 8, String(inj.activeCount))
  check('F1 plan: included and omitted partition every active entry exactly once',
    Array.isArray(inj.included) && Array.isArray(inj.omitted)
    && inj.included.length + inj.omitted.length === 8
    && new Set([...inj.included, ...inj.omitted].map((x) => x.id)).size === 8,
    JSON.stringify({ included: inj.included.map((x) => x.id), omitted: inj.omitted.map((x) => x.id) }))
  check('F1 plan: the disabled entry is in neither list',
    ![...inj.included, ...inj.omitted].some((x) => x.id === 'p-off'))
  // The Host re-stamps updatedAt on every save, so the entry saved LAST is the
  // most recent (all priorities are equal); derive the expected first id from
  // the stored data instead of assuming the request order survived.
  const expectedFirst = state.snapshot.data.entries.slice()
    .filter((e) => e.enabled && e.content !== '')
    .sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))[0].id
  check('F1 plan: the most recent active entry is included first',
    inj.included[0] && inj.included[0].id === expectedFirst,
    'got ' + String(inj.included[0] && inj.included[0].id) + ' expected ' + expectedFirst)
  check('F1 plan: an 800-char budget omits at least one 220-char entry',
    inj.omitted.length >= 1, String(inj.omitted.length))
  check('F1 plan: every included item carries id/chars/truncated',
    inj.included.every((x) => typeof x.id === 'string' && typeof x.chars === 'number' && x.chars > 0
      && typeof x.truncated === 'boolean'), JSON.stringify(inj.included))
  check('F1 plan: every omitted item carries id/chars and is not marked truncated',
    inj.omitted.every((x) => typeof x.id === 'string' && typeof x.chars === 'number' && x.chars > 0
      && x.truncated === undefined), JSON.stringify(inj.omitted))
  check('F1 plan: the preview discloses the exact omitted count',
    state.snapshot.preview.includes('另有 ' + inj.omitted.length + ' 条指令因注入字数上限未包含'),
    state.snapshot.preview.slice(-120))

  // The Client-side reducer against the REAL snapshot (the two-half seam).
  if (typeof clientPlugin.__budgetMeter === 'function') {
    const meter = clientPlugin.__budgetMeter(normalized.snapshot)
    check('F1 seam: meter.used mirrors injection.chars', meter.used === inj.chars, String(meter.used))
    check('F1 seam: meter.budget mirrors the plan budget', meter.budget === 800, String(meter.budget))
    check('F1 seam: meter.omitted counts the omitted entries',
      meter.omitted === inj.omitted.length, meter.omitted + ' vs ' + inj.omitted.length)
    check('F1 seam: meter.percent is within 1..100',
      meter.percent >= 1 && meter.percent <= 100, String(meter.percent))
    check('F1 seam: meter.tokens is the documented 0.6 estimate',
      meter.tokens === Math.round(inj.chars * 0.6), String(meter.tokens))
  } else {
    check('F1 seam: client exposes __budgetMeter', false, 'missing export')
  }

  // Raising the budget must fit every entry and clear the omitted set.
  await callRoute(planHandler, { method: 'set-options', args: { budgetChars: 40000 } })
  const roomy = (await callRoute(planHandler, { method: 'state' })).snapshot.injection
  check('F1 plan: a large budget includes every active entry',
    roomy.included.length === 8 && roomy.omitted.length === 0,
    JSON.stringify({ included: roomy.included.length, omitted: roomy.omitted.length }))

  // Backward-compatible seam: an older Host publishes no budget/included/
  // omitted fields; the reducer falls back to data.budgetChars and never throws.
  if (typeof clientPlugin.__budgetMeter === 'function') {
    const oldMeter = clientPlugin.__budgetMeter({
      data: { budgetChars: 2000 },
      injection: { registered: true, chars: 123 },
    })
    check('F1 seam: older-host snapshot falls back to data.budgetChars',
      oldMeter.budget === 2000 && oldMeter.used === 123 && oldMeter.omitted === 0
      && oldMeter.truncated === 0, JSON.stringify(oldMeter))
    const garbage = clientPlugin.__budgetMeter(null)
    check('F1 seam: garbage snapshot degrades to zeros',
      garbage.budget === 0 && garbage.used === 0 && garbage.omitted === 0
      && garbage.percent === 0 && garbage.tokens === 0, JSON.stringify(garbage))
  }

  process.env.DSH_HOME = previousHome
  await rm(PLAN_HOME, { recursive: true, force: true })
}

/* ====================================================================
 * F3: the batch route applies one op to many entries in ONE transaction
 *
 * Every successful batch must commit exactly once (rev moves by exactly
 * 1, regardless of how many ids it touches); all-no-op batches write nothing
 * and keep rev still, mirroring the single delete-entry rule. Tags round-trip
 * and never reach the injected preview. Invalid op/value shapes and stale revs
 * are refused.
 * ==================================================================== */
{
  const BATCH_HOME = scratchHome('-batch')
  await rm(BATCH_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = BATCH_HOME

  let batchHandler = null
  const batchCtx = {
    systemPrompt: { section: () => () => {} },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { batchHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  const batchHost = await import(new URL('./lib/index.js', import.meta.url).href + '?batch=' + Date.now())
  batchHost.apply(batchCtx)

  await callRoute(batchHandler, { method: 'state' })
  const ids = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']
  for (const id of ids) {
    await callRoute(batchHandler, {
      method: 'save-entry',
      args: { entry: { id, title: 'BATCH-' + id, content: 'content ' + id, mode: 'always', when: '', priority: 1, enabled: true, tags: ['grp'] } },
    })
  }

  const revOf = async () => (await callRoute(batchHandler, { method: 'state' })).snapshot.data.rev
  const entriesOf = (snap) => snap.snapshot.data.entries
  const byId = (snap, id) => entriesOf(snap).find((e) => e.id === id)

  let rev = await revOf()

  // set-priority on three ids in one request -> exactly one write (rev +1).
  const prio = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'set-priority', ids: ['b0', 'b1', 'b2'], value: 2 },
  })
  check('batch: set-priority reports ok/saved', prio.ok === true && prio.saved === true, JSON.stringify(prio.message))
  check('batch: set-priority is one transaction (rev +1)',
    prio.snapshot.data.rev === rev + 1, 'rev=' + prio.snapshot.data.rev + ' expected ' + (rev + 1))
  check('batch: priority changed on exactly the three targets',
    [0, 1, 2].every((i) => byId(prio, 'b' + i).priority === 2)
    && byId(prio, 'b3').priority === 1)
  rev = prio.snapshot.data.rev

  // Repeating it is a no-op: no write, rev unchanged.
  const prioAgain = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'set-priority', ids: ['b0', 'b1', 'b2'], value: 2 },
  })
  check('batch: an all-no-op batch saves nothing',
    prioAgain.ok === true && prioAgain.saved === false, JSON.stringify(prioAgain.saved))
  check('batch: an all-no-op batch keeps rev still',
    prioAgain.snapshot.data.rev === rev, String(prioAgain.snapshot.data.rev))

  // set-enabled false on two ids, message names the count.
  const disable = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'set-enabled', ids: ['b3', 'b4'], value: false },
  })
  check('batch: disable ok/saved and message counts 2',
    disable.ok && disable.saved && disable.message.includes('停用') && disable.message.includes('2'),
    JSON.stringify(disable.message))
  check('batch: exactly the two targets are disabled',
    !byId(disable, 'b3').enabled && !byId(disable, 'b4').enabled && byId(disable, 'b0').enabled)
  check('batch: bulk enable does not re-stamp updatedAt',
    byId(disable, 'b3').updatedAt > 0 && byId(disable, 'b3').updatedAt === (await callRoute(batchHandler, {
      method: 'batch', args: { op: 'set-enabled', ids: ['b3'], value: true },
    })).snapshot.data.entries.find((e) => e.id === 'b3').updatedAt)
  rev = disable.snapshot.data.rev

  // add-tags merges de-duplicated; tags stay out of the injected preview.
  const addTags = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'add-tags', ids: ['b0', 'b1'], value: ['grp', 'x', 'y'] },
  })
  check('batch: add-tags merges and de-duplicates',
    addTags.ok && addTags.saved
    && JSON.stringify(byId(addTags, 'b0').tags) === JSON.stringify(['grp', 'x', 'y'])
    && JSON.stringify(byId(addTags, 'b1').tags) === JSON.stringify(['grp', 'x', 'y']),
    JSON.stringify([byId(addTags, 'b0') && byId(addTags, 'b0').tags]))
  check('batch: tag text never enters the injected preview',
    !addTags.snapshot.preview.includes('grp') && !addTags.snapshot.preview.includes('x'))

  // Adding only tags already present is a no-op.
  const addSame = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'add-tags', ids: ['b0', 'b1'], value: ['x'] },
  })
  check('batch: adding already-present tags saves nothing', addSame.saved === false)

  // remove-tags.
  const removeTags = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'remove-tags', ids: ['b0'], value: ['x'] },
  })
  check('batch: remove-tags drops the tag from the target only',
    JSON.stringify(byId(removeTags, 'b0').tags) === JSON.stringify(['grp', 'y'])
    && JSON.stringify(byId(removeTags, 'b1').tags) === JSON.stringify(['grp', 'x', 'y']))
  rev = removeTags.snapshot.data.rev

  // delete two in one transaction.
  const del = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'delete', ids: ['b4', 'b5'] },
  })
  check('batch: delete ok/saved and message counts 2',
    del.ok && del.saved && del.message.includes('删除') && del.message.includes('2'), JSON.stringify(del.message))
  check('batch: delete removed exactly two entries',
    entriesOf(del).length === 4 && !entriesOf(del).some((e) => e.id === 'b4' || e.id === 'b5'))
  check('batch: delete is one transaction (rev +1)',
    del.snapshot.data.rev === rev + 1, 'rev=' + del.snapshot.data.rev)
  rev = del.snapshot.data.rev

  // Deleting absent ids writes nothing.
  const delMissing = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'delete', ids: ['ghost1', 'ghost2'] },
  })
  check('batch: deleting only absent ids saves nothing',
    delMissing.ok === true && delMissing.saved === false && delMissing.snapshot.data.entries.length === 4,
    JSON.stringify({ saved: delMissing.saved, n: delMissing.snapshot.data.entries.length }))
  check('batch: deleting absent ids keeps rev still', delMissing.snapshot.data.rev === rev)

  // Partial hit: the missing id is counted but the present one still changes.
  const partial = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'set-enabled', ids: ['b0', 'ghost'], value: false },
  })
  check('batch: a partial hit still applies and discloses the missing id',
    partial.ok && partial.saved && !byId(partial, 'b0').enabled && partial.message.includes('1 条未找到'),
    JSON.stringify(partial.message))

  // Invalid shapes refused without writing.
  const badOp = await callRoute(batchHandler, { method: 'batch', args: { op: 'explode', ids: ['b0'] } })
  check('batch: unknown op refused', badOp.ok === false)
  const noIds = await callRoute(batchHandler, { method: 'batch', args: { op: 'delete', ids: [] } })
  check('batch: empty ids refused', noIds.ok === false)
  const badPrio = await callRoute(batchHandler, { method: 'batch', args: { op: 'set-priority', ids: ['b0'], value: 9 } })
  check('batch: invalid priority value refused', badPrio.ok === false)
  const badBool = await callRoute(batchHandler, { method: 'batch', args: { op: 'set-enabled', ids: ['b0'], value: 'yes' } })
  check('batch: non-boolean enabled value refused', badBool.ok === false)
  const badTags = await callRoute(batchHandler, { method: 'batch', args: { op: 'add-tags', ids: ['b0'], value: 'not-an-array' } })
  check('batch: non-array tags value refused', badTags.ok === false)

  // Stale rev -> conflict, no write.
  const conflict = await callRoute(batchHandler, {
    method: 'batch', args: { op: 'set-priority', ids: ['b0'], value: 0, baseRev: rev - 5 },
  })
  check('batch: a stale baseRev is a conflict carrying a fresh snapshot',
    conflict.ok === false && conflict.conflict === true && conflict.snapshot.data.rev !== rev - 5,
    JSON.stringify({ ok: conflict.ok, conflict: conflict.conflict }))

  process.env.DSH_HOME = previousHome
  await rm(BATCH_HOME, { recursive: true, force: true })
}

/* ====================================================================
 * 用户形象 (persona profiles): save/delete over the real route, snapshot
 * shape, injection placement/toggle, conflict guard, and import merge.
 * ==================================================================== */
{
  const PROFILE_HOME = scratchHome('-profiles')
  await rm(PROFILE_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = PROFILE_HOME

  let profileHandler = null
  const profileCtx = {
    systemPrompt: { section: () => () => {} },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { profileHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  const profileHost = await import(new URL('./lib/index.js', import.meta.url).href + '?profiles=' + Date.now())
  profileHost.apply(profileCtx)

  const snap = async () => (await callRoute(profileHandler, { method: 'state' })).snapshot
  const rev = async () => (await snap()).data.rev
  const saveProfile = async (profile) =>
    callRoute(profileHandler, { method: 'save-profile', args: { profile, baseRev: await rev() } })
  const deleteProfile = async (id) =>
    callRoute(profileHandler, { method: 'delete-profile', args: { id, baseRev: await rev() } })

  let baseRev = await rev()

  // Create with no entries present: the persona alone makes the section non-empty.
  const created = await saveProfile({ id: 'pf1', name: '职业背景', content: '有 8 年后端经验，可跳过入门概念' })
  check('profile: save ok/saved and rev +1',
    created.ok === true && created.saved === true && created.snapshot.data.rev === baseRev + 1,
    JSON.stringify({ ok: created.ok, saved: created.saved }))
  baseRev = created.snapshot.data.rev
  const createdSnap = created.snapshot
  check('profile: snapshot carries the stored profile and injection metadata',
    createdSnap.data.profiles.length === 1
    && createdSnap.data.profiles[0].name === '职业背景'
    && Array.isArray(createdSnap.injection.profiles)
    && createdSnap.injection.profiles.length === 1
    && createdSnap.injection.profiles[0].name === '职业背景'
    && typeof createdSnap.injection.profileChars === 'number' && createdSnap.injection.profileChars > 0
    && createdSnap.injection.entryChars === 0,
    JSON.stringify({ n: createdSnap.data.profiles.length, inj: createdSnap.injection }))
  check('profile: persona header lands in the preview',
    createdSnap.preview.includes('## 关于用户（用户形象）') && createdSnap.preview.includes('### 职业背景'))

  // Update in place.
  const updated = await saveProfile({ id: 'pf1', name: '职业背景', content: '十年经验，熟悉分布式' })
  check('profile: update keeps one profile and bumps rev',
    updated.ok && updated.snapshot.data.profiles.length === 1
    && updated.snapshot.data.profiles[0].content === '十年经验，熟悉分布式'
    && updated.snapshot.data.rev === baseRev + 1,
    JSON.stringify(updated.snapshot.data.profiles))
  baseRev = updated.snapshot.data.rev

  // Blank name+content refused without a write.
  const blank = await callRoute(profileHandler, {
    method: 'save-profile', args: { profile: { id: 'pfX', name: '  ', content: '' }, baseRev: baseRev },
  })
  check('profile: a fully blank profile is refused', blank.ok === false && blank.saved === false)
  check('profile: refusing a blank profile keeps rev still', blank.snapshot.data.rev === baseRev)

  // Add an instruction entry too, then untick the persona: persona disappears,
  // instructions remain.
  await callRoute(profileHandler, {
    method: 'save-entry',
    args: { entry: { id: 'e1', title: '规则', content: '回答使用中文' }, baseRev: await rev() },
  })
  const both = await snap()
  check('profile: persona sits before the instruction block',
    both.preview.indexOf('## 关于用户（用户形象）') < both.preview.indexOf('## 用户长期指令记忆'))
  const unticked = await saveProfile({ id: 'pf1', name: '职业背景', content: '十年经验，熟悉分布式', enabled: false })
  check('profile: unticking removes the persona while leaving instructions',
    !unticked.snapshot.preview.includes('## 关于用户（用户形象）')
    && unticked.snapshot.preview.includes('回答使用中文')
    && unticked.snapshot.injection.profiles.length === 0
    && unticked.snapshot.injection.profileChars === 0
    && unticked.snapshot.injection.entryChars > 0,
    JSON.stringify({ entryChars: unticked.snapshot.injection.entryChars }))
  await saveProfile({ id: 'pf1', name: '职业背景', content: '十年经验，熟悉分布式', enabled: true })

  // Delete: present id writes and rev+1; absent id is a no-op.
  const beforeDelete = await rev()
  const deleted = await deleteProfile('pf1')
  check('profile: delete ok/saved, rev +1, profile gone',
    deleted.ok === true && deleted.saved === true
    && deleted.snapshot.data.rev === beforeDelete + 1
    && deleted.snapshot.data.profiles.length === 0,
    JSON.stringify({ saved: deleted.saved, n: deleted.snapshot.data.profiles.length }))
  const deleteGhost = await callRoute(profileHandler, {
    method: 'delete-profile', args: { id: 'ghost', baseRev: await rev() },
  })
  check('profile: deleting an absent id saves nothing',
    deleteGhost.ok === true && deleteGhost.saved === false)

  // Stale baseRev -> conflict carrying a fresh snapshot.
  const conflict = await callRoute(profileHandler, {
    method: 'save-profile',
    args: { profile: { id: 'pf2', name: '性格', content: '严谨' }, baseRev: (await rev()) - 7 },
  })
  check('profile: stale baseRev is a conflict',
    conflict.ok === false && conflict.conflict === true && conflict.snapshot !== undefined,
    JSON.stringify({ ok: conflict.ok, conflict: conflict.conflict }))

  // A profiles-only import file is valid (not "nothing to import") — done
  // while the profile list is empty, before the 50-cap bulk import below.
  const onlyProfiles = await callRoute(profileHandler, {
    method: 'import-data',
    args: {
      payload: { profiles: [{ id: 'solo', name: '独有形象', content: '只带形象的导入文件' }] },
      baseRev: await rev(),
    },
  })
  check('profile: a profiles-only import is accepted',
    onlyProfiles.ok && onlyProfiles.saved
    && onlyProfiles.snapshot.data.profiles.some((p) => p.id === 'solo'),
    JSON.stringify({ ok: onlyProfiles.ok, saved: onlyProfiles.saved }))

  // Import merges profiles (and entries together) in ONE transaction;
  // duplicates by id/name+content are skipped; the 50-profile cap is enforced.
  const many = []
  for (let i = 0; i < 52; i += 1) many.push({ id: 'imp' + i, name: '形象' + i, content: '内容' + i })
  const bulk = await callRoute(profileHandler, {
    method: 'import-data',
    args: {
      payload: {
        app: 'dsh-instruction-memory', version: 1,
        data: {
          entries: [{ id: 'ie1', title: '导入规则', content: '导入的指令' }],
          profiles: many,
        },
      },
      baseRev: await rev(),
    },
  })
  check('profile: bulk import accepts at most 50 profiles',
    bulk.ok && bulk.saved && bulk.snapshot.data.profiles.length === 50
    && bulk.message.includes('新增用户形象 49 个') && bulk.message.includes('跳过 3 个'),
    JSON.stringify({ n: bulk.snapshot.data.profiles.length, msg: bulk.message }))
  check('profile: mixed import lands entries and personas in one rev bump',
    bulk.snapshot.data.entries.some((e) => e.id === 'ie1')
    && bulk.snapshot.preview.includes('### 形象0')
    && bulk.snapshot.preview.includes('导入的指令'))
  // Re-importing the same two profiles adds nothing (same name+content).
  const reimport = await callRoute(profileHandler, {
    method: 'import-data',
    args: {
      payload: { profiles: [{ name: '形象0', content: '内容0' }, { name: '形象1', content: '内容1' }] },
      baseRev: await rev(),
    },
  })
  check('profile: duplicate personas merge as no-op',
    reimport.ok && reimport.saved === false && reimport.snapshot.data.profiles.length === 50,
    JSON.stringify({ saved: reimport.saved, n: reimport.snapshot.data.profiles.length }))

  process.env.DSH_HOME = previousHome
  await rm(PROFILE_HOME, { recursive: true, force: true })
}

/* ---------------- F13–F18: sets, history, source mode, backup location -------- */

// One isolated home for the whole block: a seeded v1 store, then the real
// route driving every new command. Isolated because these tests MOVE the
// active set and rewrite the store; the suites above assume a single set.
{
  const FEATURE_HOME = scratchHome('-features')
  await rm(FEATURE_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = FEATURE_HOME
  const featureStore = join(FEATURE_HOME, 'instruction-memory', 'memory.json')
  const featureDir = join(FEATURE_HOME, 'instruction-memory')
  await mkdir(featureDir, { recursive: true })

  // A v1 file: the migration path is what the whole block runs on top of.
  await writeFile(featureStore, JSON.stringify({
    version: 1,
    rev: 4,
    enabled: true,
    budgetChars: 4000,
    entries: [
      { id: 'old-1', title: 'V1-RULE', content: '来自版本 1 的指令', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 5 },
    ],
    profiles: [{ id: 'old-p', name: '旧形象', content: '版本 1 的形象', enabled: true, updatedAt: 5 }],
  }), 'utf8')

  let featureHandler = null
  const featureSections = []
  const featureCtx = {
    systemPrompt: {
      section: (spec) => {
        featureSections.push(spec)
        return () => {
          const i = featureSections.indexOf(spec)
          if (i >= 0) featureSections.splice(i, 1)
        }
      },
    },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { featureHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  const featureHost = await import(new URL('./lib/index.js', import.meta.url).href + '?features=' + Date.now())
  featureHost.apply(featureCtx)

  const call = (method, args) => callRoute(featureHandler, { method, args })
  const snap = async () => (await call('state', null)).snapshot
  const rev = async () => (await snap()).data.rev
  const injected = () => featureSections
    .map((section) => (typeof section.text === 'function' ? section.text({}) : section.text))
    .filter((text) => text.length > 0)
    .join('\n\n')

  // ---- migration ----
  const migrated = await snap()
  check('sets: a v1 store loads as version 2 with one 默认 set',
    migrated.data.version === 2 && migrated.data.sets.length === 1
    && migrated.data.sets[0].name === '默认' && migrated.data.activeSetId === 'st-default'
    && migrated.data.entries.every((entry) => entry.setId === 'st-default')
    && migrated.data.profiles.every((profile) => profile.setId === 'st-default'),
    JSON.stringify(migrated.data.sets))
  check('sets: the migration is disclosed, naming the default set and the version',
    typeof migrated.storage.warning === 'string' && migrated.storage.warning.includes('默认')
    && migrated.storage.warning.includes('版本 2'),
    JSON.stringify(migrated.storage.warning))
  check('sets: migration does not change what is injected',
    injected().includes('V1-RULE') && injected().includes('版本 1 的形象'), injected().slice(0, 120))
  check('sets: the v1 file is NOT rewritten until a save happens',
    JSON.parse(readFileSync(featureStore, 'utf8')).version === 1)

  // ---- create / switch / isolation ----
  const created = await call('save-set', { set: { id: '', name: '工作' }, baseRev: await rev() })
  check('sets: create adds a set, writes once, and does NOT activate it',
    created.ok === true && created.saved === true
    && created.snapshot.data.sets.length === 2
    && created.snapshot.data.activeSetId === 'st-default'
    && created.snapshot.storage.warning === null,
    JSON.stringify({ n: created.snapshot.data.sets.length, active: created.snapshot.data.activeSetId }))
  const workId = created.snapshot.data.sets.find((set) => set.name === '工作').id
  check('sets: the v2 shape is on disk now (version + sets + setId)',
    (() => {
      const onDisk = JSON.parse(readFileSync(featureStore, 'utf8'))
      return onDisk.version === 2 && onDisk.sets.length === 2 && onDisk.entries[0].setId === 'st-default'
        && onDisk.$schema === './memory.schema.json'
    })(), readFileSync(featureStore, 'utf8').slice(0, 120))

  const duplicateName = await call('save-set', { set: { id: '', name: '工作' }, baseRev: await rev() })
  check('sets: a duplicate name is refused',
    duplicateName.ok === false && duplicateName.saved === false, JSON.stringify(duplicateName.message))

  const switched = await call('set-active-set', { id: workId, baseRev: await rev() })
  check('sets: switching activates the target and empties the visible list',
    switched.ok === true && switched.saved === true
    && switched.snapshot.data.activeSetId === workId
    && switched.snapshot.data.entries.length === 0,
    JSON.stringify({ active: switched.snapshot.data.activeSetId, n: switched.snapshot.data.entries.length }))
  check('ISOLATION: the previous set is no longer injected',
    !injected().includes('V1-RULE'), injected().slice(0, 120))
  check('ISOLATION: the previous set profile is gone from the prompt too',
    !injected().includes('版本 1 的形象'), injected().slice(0, 120))
  check('sets: store-wide counts stay visible while a set is active',
    switched.snapshot.sets.total.entries === 1
    && switched.snapshot.sets.list.find((set) => set.name === '默认').entries === 1
    && switched.snapshot.sets.list.find((set) => set.name === '工作').entries === 0,
    JSON.stringify(switched.snapshot.sets))

  const sameSwitch = await call('set-active-set', { id: workId, baseRev: await rev() })
  check('sets: re-selecting the active set writes nothing', sameSwitch.ok === true && sameSwitch.saved === false)

  const inWork = await call('save-entry', {
    entry: { id: '', title: 'WORK-RULE', content: '只属于工作集', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 },
    baseRev: await rev(),
  })
  check('sets: a new entry is filed under the ACTIVE set (server-side)',
    inWork.ok === true && inWork.snapshot.data.entries.length === 1
    && inWork.snapshot.data.entries[0].setId === workId,
    JSON.stringify(inWork.snapshot.data.entries))
  check('sets: injection now carries the new set only',
    injected().includes('WORK-RULE') && !injected().includes('V1-RULE'), injected().slice(0, 200))

  const crossDelete = await call('delete-entry', { id: 'old-1', baseRev: await rev() })
  check('ISOLATION: deleting an id from another set is a no-op (no write)',
    crossDelete.ok === true && crossDelete.saved === false
    && crossDelete.snapshot.sets.list.find((set) => set.name === '默认').entries === 1,
    JSON.stringify(crossDelete.snapshot.sets.list))
  const crossBatch = await call('batch', { op: 'add-tags', ids: ['old-1'], value: ['x'], baseRev: await rev() })
  check('ISOLATION: a batch over another set\'s id is reported as missing, not applied',
    crossBatch.ok === true && crossBatch.saved === false && String(crossBatch.message).includes('未找到'),
    JSON.stringify(crossBatch.message))

  // A cross-set UUID collision must not let one set's save overwrite another's
  // entry: entries are addressed by id only, so this is the guard that matters.
  const cloned = await call('save-entry', {
    entry: { id: 'old-1', title: 'Hijack?', content: 'should not touch the other set', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 },
    baseRev: await rev(),
  })
  check('sets: saving an id that exists in ANOTHER set creates here instead of overwriting there',
    cloned.ok === true
    && cloned.snapshot.data.entries.some((entry) => entry.title === 'Hijack?')
    && cloned.snapshot.sets.list.find((set) => set.name === '默认').entries === 1
    && String(cloned.message).includes('新 id'),
    JSON.stringify({ msg: cloned.message, sets: cloned.snapshot.sets.list }))

  // ---- duplicate + delete rules ----
  const copied = await call('duplicate-set', { id: workId, name: '客户A', baseRev: await rev() })
  check('sets: duplicate copies the content into a new, inactive set',
    copied.ok === true && copied.saved === true
    && copied.snapshot.data.activeSetId === workId
    && copied.snapshot.sets.list.find((set) => set.name === '客户A').entries === 2
    && copied.snapshot.data.entries.every((entry) => entry.id !== 'old-1'),
    JSON.stringify(copied.snapshot.sets.list))
  const clientId = copied.snapshot.data.sets.find((set) => set.name === '客户A').id
  const deleteActive = await call('delete-set', { id: workId, baseRev: await rev() })
  check('sets: deleting the ACTIVE set is refused with a reason',
    deleteActive.ok === false && String(deleteActive.message).includes('激活'), JSON.stringify(deleteActive.message))
  const deletedOther = await call('delete-set', { id: clientId, baseRev: await rev() })
  check('sets: deleting another set removes its items and reports the counts',
    deletedOther.ok === true && deletedOther.saved === true
    && deletedOther.snapshot.data.sets.length === 2
    && deletedOther.snapshot.sets.total.entries === 3
    && String(deletedOther.message).includes('已删除配置集'),
    JSON.stringify({ msg: deletedOther.message, n: deletedOther.snapshot.sets.total.entries }))
  const lastSet = await call('save-set', { set: { id: 'st-default', name: '默认' }, baseRev: await rev() })
  check('sets: renaming a set to its own name is a no-op',
    lastSet.ok === true && lastSet.saved === false, JSON.stringify(lastSet.message))

  // ---- history ----
  const historyDir = join(featureDir, 'history')
  const historyNames = await readdir(historyDir)
  check('history: snapshots land in a history/ subdirectory (never watched)',
    historyNames.length >= 4 && historyNames.every((name) => /\.json$/.test(name)),
    JSON.stringify(historyNames))
  const mismatch = historyNames.filter((name) => !/^\d{8}T\d{9}Z-r\d+-[a-z0-9_]+\.json$/.test(name))
  check('history: every snapshot name carries stamp + rev + device', mismatch.length === 0, JSON.stringify(mismatch))

  const listed = await call('history-list', null)
  check('history: list is newest-first with metadata',
    listed.ok === true && listed.history.items.length === historyNames.length
    && listed.history.items[0].name > listed.history.items[1].name
    && typeof listed.history.items[0].epoch === 'number' && listed.history.items[0].epoch > 0
    && typeof listed.history.items[0].rev === 'number'
    && listed.history.items[0].foreign === false
    && listed.history.items[0].entries !== null,
    JSON.stringify(listed.history.items.slice(0, 2)))
  check('history: list also reports the directory on the snapshot block',
    listed.snapshot.storage.historyDir === historyDir
    && listed.snapshot.storage.historyCount === listed.history.items.length,
    JSON.stringify({ dir: listed.snapshot.storage.historyDir }))

  // Roll back to the OLDEST snapshot of this run: the v1 content must return
  // and the revision must move FORWARD (never backwards).
  const oldest = listed.history.items[listed.history.items.length - 1]
  const revBeforeRollback = listed.snapshot.data.rev
  const rolled = await call('history-restore', { name: oldest.name, baseRev: revBeforeRollback })
  check('history: rollback adopts the snapshot and moves rev forward',
    rolled.ok === true && rolled.saved === true && rolled.snapshot.data.rev === revBeforeRollback + 1,
    JSON.stringify({ ok: rolled.ok, saved: rolled.saved, rev: rolled.snapshot.data.rev }))
  const badName = await call('history-restore', { name: '../memory.json', baseRev: await rev() })
  check('history: a traversal-style name is refused before touching the disk',
    badName.ok === false && String(badName.message).includes('无效'), JSON.stringify(badName.message))

  const beforeSnapshotDelete = (await readdir(historyDir)).length
  const deletedSnapshot = await call('history-delete', { name: oldest.name })
  check('history: deleting one snapshot leaves the store untouched',
    deletedSnapshot.ok === true && deletedSnapshot.saved === false
    && (await readdir(historyDir)).length === beforeSnapshotDelete - 1,
    JSON.stringify(deletedSnapshot.message))

  // Retention: 20 per device. Drive enough saves to overflow it and check that
  // the count is exactly the cap (oldest evicted, newest kept).
  for (let i = 0; i < 22; i += 1) {
    await call('save-entry', {
      entry: { id: 'fill-' + i, title: 'FILL ' + i, content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 },
      baseRev: await rev(),
    })
  }
  const afterFill = await call('history-list', null)
  check('history: retention keeps exactly the newest 20 snapshots',
    afterFill.history.items.length === 20, String(afterFill.history.items.length))
  const keptRevs = afterFill.history.items.map((item) => item.rev)
  check('history: the newest snapshot is the current revision',
    keptRevs[0] === afterFill.snapshot.data.rev
    && Math.min(...keptRevs) > 4,
    JSON.stringify(keptRevs.slice(0, 3) + ' ... ' + keptRevs.slice(-2)))

  // ---- source mode (F16) ----
  const source = await call('read-source', null)
  check('source: read-source returns the exact serialisation',
    source.ok === true && typeof source.source === 'string'
    && source.source.includes('"$schema": "./memory.schema.json"')
    && source.source.includes('"version": 2'),
    source.source.slice(0, 100))
  check('source: the text is byte-identical to what a save would write',
    source.source === readFileSync(featureStore, 'utf8'))

  const parsedSource = JSON.parse(source.source)
  parsedSource.entries = parsedSource.entries.map((entry) => (entry.title === 'FILL 21' ? { ...entry, title: 'EDITED-IN-SOURCE' } : entry))
  const wroteSource = await call('write-source', { text: JSON.stringify(parsedSource, null, 2), baseRev: source.snapshot.data.rev })
  check('source: write-source adopts the edit and reports the shape',
    wroteSource.ok === true && wroteSource.saved === true
    && String(wroteSource.message).includes('已按源码保存')
    && wroteSource.snapshot.data.entries.some((entry) => entry.title === 'EDITED-IN-SOURCE'),
    JSON.stringify(wroteSource.message))

  const brokenSource = await call('write-source', { text: '{ "entries": [', baseRev: await rev() })
  check('source: broken JSON is refused with the parser message',
    brokenSource.ok === false && String(brokenSource.message).includes('JSON'), JSON.stringify(brokenSource.message))
  const emptyObject = await call('write-source', { text: '{}', baseRev: await rev() })
  check('source: an empty object cannot wipe the store', emptyObject.ok === false,
    JSON.stringify(emptyObject.message))
  const arraySource = await call('write-source', { text: '[1,2,3]', baseRev: await rev() })
  check('source: a non-object document is refused', arraySource.ok === false, JSON.stringify(arraySource.message))
  const futureSource = await call('write-source', { text: JSON.stringify({ version: 9, entries: [] }), baseRev: await rev() })
  check('source: a future format version is refused', futureSource.ok === false
    && String(futureSource.message).includes('版本'), JSON.stringify(futureSource.message))
  const staleSource = await call('write-source', { text: source.source, baseRev: 3 })
  check('source: a stale baseRev is a conflict, not an overwrite',
    staleSource.ok === false && staleSource.conflict === true)
  const droppedSource = await call('write-source', {
    text: JSON.stringify({
      version: 2,
      budgetChars: 999999,
      activeSetId: 'st-nowhere',
      entries: [{ title: 'A', content: 'B' }, { title: '', content: '' }],
      sets: [{ id: 'st-default', name: '默认' }, { id: 'st-ghost', name: '幽灵' }],
    }, null, 2),
    baseRev: await rev(),
  })
  check('source: corrections are disclosed (dropped item, option fix, orphan activeSetId)',
    droppedSource.ok === true && String(droppedSource.message).includes('1 条条目未能载入')
    && String(droppedSource.message).includes('budgetChars')
    && String(droppedSource.message).includes('activeSetId')
    && String(droppedSource.message).includes('没有该配置集'),
    JSON.stringify(droppedSource.message))
  check('source: the adopted store really has the corrected values',
    droppedSource.snapshot.data.budgetChars === 40000
    && droppedSource.snapshot.data.entries.length === 1
    && droppedSource.snapshot.data.activeSetId === 'st-default'
    && droppedSource.snapshot.data.entries[0].setId === 'st-default'
    && droppedSource.snapshot.data.sets.length === 2,
    JSON.stringify({
      budget: droppedSource.snapshot.data.budgetChars,
      active: droppedSource.snapshot.data.activeSetId,
      sets: droppedSource.snapshot.data.sets,
    }))
  // Truncation is the other silent-loss channel a source paste could open:
  // an over-long field must be cut AND reported, never cut quietly.
  const longSource = await call('write-source', {
    text: JSON.stringify({
      version: 2,
      sets: [{ id: 'st-default', name: '默认' }],
      activeSetId: 'st-default',
      entries: [{ title: 'x'.repeat(200), content: 'y'.repeat(7000) }],
      profiles: [{ name: 'n', content: 'z'.repeat(5000) }],
    }, null, 2),
    baseRev: await rev(),
  })
  check('source: over-long fields are truncated AND disclosed',
    longSource.ok === true && String(longSource.message).includes('已被截断')
    && longSource.snapshot.data.entries[0].title.length === 120
    && longSource.snapshot.data.entries[0].content.length === 6000
    && longSource.snapshot.data.profiles[0].content.length === 4000,
    JSON.stringify(longSource.message))

  // ---- restore-data: the whole-store replace door (F14) ----
  const backupEnvelope = {
    app: 'dsh-instruction-memory',
    version: 2,
    exportedAt: new Date().toISOString(),
    data: {
      version: 2,
      enabled: true,
      budgetChars: 2500,
      backupDir: 'D:\\should-not-be-adopted',
      activeSetId: 'st-restored',
      sets: [{ id: 'st-restored', name: '恢复到这套' }],
      entries: [{ id: 'r1', title: 'RESTORED', content: '整体替换进来的指令', mode: 'always', when: '', priority: 1, enabled: true, tags: [], setId: 'st-restored', updatedAt: 1 }],
      profiles: [],
    },
  }
  const beforeRestore = await rev()
  const restored = await call('restore-data', { payload: backupEnvelope, baseRev: beforeRestore })
  check('restore: the whole store is replaced by the payload',
    restored.ok === true && restored.saved === true
    && restored.snapshot.data.sets.length === 1
    && restored.snapshot.data.sets[0].name === '恢复到这套'
    && restored.snapshot.data.entries.length === 1
    && restored.snapshot.data.entries[0].title === 'RESTORED'
    && restored.snapshot.data.budgetChars === 2500
    && restored.snapshot.data.rev === beforeRestore + 1,
    JSON.stringify({ msg: restored.message }))
  check('restore: the machine-local backup location is preserved, not adopted',
    restored.snapshot.data.backupDir === '' && restored.snapshot.storage.backupDir === '',
    JSON.stringify(restored.snapshot.data.backupDir))
  const restoredJournal = await call('history-list', null)
  check('restore: the replaced content is still recoverable from history',
    restoredJournal.history.items.some((item) => item.rev === beforeRestore),
    JSON.stringify(restoredJournal.history.items.slice(0, 4).map((item) => item.rev)))
  const restoreJunk = await call('restore-data', { payload: { hello: 'world' }, baseRev: await rev() })
  check('restore: an unrelated JSON object is refused', restoreJunk.ok === false, JSON.stringify(restoreJunk.message))
  const restoreStale = await call('restore-data', { payload: backupEnvelope, baseRev: 1 })
  check('restore: a stale baseRev is a conflict', restoreStale.ok === false && restoreStale.conflict === true)

  // ---- export shape + import set mapping ----
  const exported = await call('export-data', null)
  check('export: the envelope carries every set and the file-format version',
    exported.ok === true && exported.saved === false && exported.export.version === 2
    && exported.export.data.version === 2
    && Array.isArray(exported.export.data.sets)
    && exported.export.data.activeSetId === 'st-restored'
    && exported.export.data.$schema === './memory.schema.json',
    JSON.stringify(Object.keys(exported.export)))

  const imported = await call('import-data', {
    payload: {
      app: 'dsh-instruction-memory',
      version: 2,
      data: {
        version: 2,
        activeSetId: 'st-imported',
        sets: [{ id: 'st-imported', name: '导入的集合' }],
        entries: [{ id: 'imp-1', title: 'IMPORTED', content: '带配置集导入', mode: 'always', when: '', priority: 1, enabled: true, tags: [], setId: 'st-imported', updatedAt: 1 }],
        profiles: [],
      },
    },
    baseRev: await rev(),
  })
  check('import: a declared set is created and the entry is filed into it',
    imported.ok === true && imported.saved === true
    && imported.snapshot.data.sets.length === 2
    && imported.snapshot.sets.list.find((set) => set.name === '导入的集合').entries === 1
    && String(imported.message).includes('新建配置集 1 个'),
    JSON.stringify({ msg: imported.message, sets: imported.snapshot.sets.list }))
  const reimported = await call('import-data', {
    payload: {
      data: {
        version: 2,
        sets: [{ id: 'st-imported', name: '导入的集合' }],
        entries: [{ id: 'imp-1', title: 'IMPORTED', content: '带配置集导入', mode: 'always', when: '', priority: 1, enabled: true, tags: [], setId: 'st-imported', updatedAt: 1 }],
      },
    },
    baseRev: await rev(),
  })
  check('import: re-importing the same file stays a no-op (per-set de-duplication)',
    reimported.ok === true && reimported.saved === false
    && reimported.snapshot.sets.list.find((set) => set.name === '导入的集合').entries === 1,
    JSON.stringify({ msg: reimported.message }))
  const orphanImport = await call('import-data', {
    payload: {
      data: {
        entries: [{ id: 'orphan-1', title: 'ORPHAN', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, tags: [], setId: 'st-does-not-exist', updatedAt: 1 }],
      },
    },
    baseRev: await rev(),
  })
  check('import: an item naming an unknown set falls back to the active set and says so',
    orphanImport.ok === true && orphanImport.saved === true
    && String(orphanImport.message).includes('已归入当前配置集')
    && orphanImport.snapshot.data.entries.some((entry) => entry.title === 'ORPHAN'),
    JSON.stringify(orphanImport.message))

  // ---- F18: backup location ----
  const backupRoot = join(FEATURE_HOME, 'cloud backups')
  await mkdir(backupRoot, { recursive: true })
  const relative = await call('set-options', { backupDir: 'relative/dir', baseRev: await rev() })
  check('backup: a relative path is refused with the reason',
    relative.ok === false && String(relative.message).includes('绝对路径'), JSON.stringify(relative.message))
  const missing = await call('set-options', { backupDir: join(FEATURE_HOME, 'nope'), baseRev: await rev() })
  check('backup: a non-existent directory is refused before it is stored',
    missing.ok === false && (await snap()).data.backupDir === '', JSON.stringify(missing.message))
  // A FILE where a directory is expected is the other easy mistake.
  const filePath = join(FEATURE_HOME, 'not-a-dir.txt')
  await writeFile(filePath, 'x', 'utf8')
  const notADir = await call('set-options', { backupDir: filePath, baseRev: await rev() })
  check('backup: a path that is a file is refused with "not a directory"',
    notADir.ok === false && String(notADir.message).includes('不是目录'), JSON.stringify(notADir.message))
  const applied = await call('set-options', { backupDir: backupRoot, baseRev: await rev() })
  check('backup: a usable directory is accepted, persisted and reported',
    applied.ok === true && applied.saved === true
    && applied.snapshot.storage.backupDir === backupRoot
    && applied.snapshot.storage.isDefaultBackupDir === false
    && String(applied.message).includes('备份位置已更新'),
    JSON.stringify(applied.message))

  const exportToDir = await call('export-to-dir', null)
  const backupFiles = await readdir(backupRoot)
  check('backup: export-to-dir writes a dated export into the custom folder',
    exportToDir.ok === true && String(exportToDir.message).includes(backupRoot)
    && backupFiles.some((name) => /^dsh-instruction-memory-\d{8}-\d{6}Z\.json$/.test(name)),
    JSON.stringify(backupFiles))
  check('backup: the export written there is a complete store (all sets)',
    (() => {
      const name = backupFiles.find((file) => file.startsWith('dsh-instruction-memory-'))
      const envelope = JSON.parse(readFileSync(join(backupRoot, name), 'utf8'))
      return envelope.app === 'dsh-instruction-memory' && Array.isArray(envelope.data.sets)
        && envelope.data.sets.length >= 2
    })(), JSON.stringify(backupFiles))

  // A save after setting the location must leave BOTH rolling copies: the one
  // next to the store (what crash recovery reads) and the custom one.
  await call('save-entry', {
    entry: { id: 'after-backup', title: 'AFTER-BACKUP', content: 'x', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 },
    baseRev: await rev(),
  })
  check('backup: both rolling copies exist after a save',
    existsSync(join(featureDir, 'memory.json.bak')) && existsSync(join(backupRoot, 'memory.json.bak')),
    JSON.stringify(await readdir(backupRoot)))
  check('backup: history follows the custom location',
    (await readdir(join(backupRoot, 'history'))).length > 0,
    JSON.stringify(await readdir(backupRoot)))
  const cleared = await call('set-options', { backupDir: '', baseRev: await rev() })
  check('backup: clearing it returns to the default and says so',
    cleared.ok === true && cleared.snapshot.storage.isDefaultBackupDir === true
    && String(cleared.message).includes('默认备份位置'),
    JSON.stringify(cleared.message))

  // ---- the schema file the plugin leaves next to the store ----
  check('schema: a copy of memory.schema.json sits next to the store and parses',
    (() => {
      try {
        const schema = JSON.parse(readFileSync(join(featureDir, 'memory.schema.json'), 'utf8'))
        return schema.title !== undefined && schema.properties.entries !== undefined
      } catch {
        return false
      }
    })(), JSON.stringify(await readdir(featureDir)))

  process.env.DSH_HOME = previousHome
  await rm(FEATURE_HOME, { recursive: true, force: true })
}

/* ---------------- import fallback de-duplication (review fix) ---------------- */

// The plan phase de-duplicates against the set an item DECLARES, but the commit
// can retarget it into the active set (unknown set id, or the 20-set cap
// blocking creation). That retarget used to skip the duplicate check entirely,
// so an import could file a second copy of text the active set already had.
// The shapes that must hold:
//   a fallback whose body already exists in the active set -> skipped, with a
//     disclosed count, and no write at all when nothing else is left;
//   a DECLARED set that really gets created -> may hold the same text as the
//     active set (per-set isolation is the design; this must not be broken);
//   the same rules under the 20-set cap;
//   two same-body fallbacks inside ONE batch -> exactly one insertion;
//   an id that is taken in the fallback target -> re-minted, never duplicated.
{
  const IMPORT_HOME = scratchHome('-import-dedup')
  await rm(IMPORT_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME

  const entryShape = (over) => ({
    title: '重复探针', content: '与激活集中已有条目完全相同的正文',
    mode: 'always', when: '', priority: 1, enabled: true, tags: [], updatedAt: 1, ...over,
  })

  /** One host on its own home, with the given sets pre-created in the store. */
  const mountDedup = async (name, sets) => {
    const home = join(IMPORT_HOME, name)
    await mkdir(join(home, 'instruction-memory'), { recursive: true })
    process.env.DSH_HOME = home
    await writeFile(join(home, 'instruction-memory', 'memory.json'), JSON.stringify({
      version: 2,
      activeSetId: 'st-default',
      sets,
      entries: [{ id: 'im-x', setId: 'st-default', ...entryShape() }],
      profiles: [],
    }), 'utf8')
    let dedupHandler = null
    const dedupHost = await import(new URL('./lib/index.js', import.meta.url).href + '?dedup=' + name + Date.now())
    dedupHost.apply({
      systemPrompt: { section: () => () => {} },
      inject: (deps, callback) => {
        callback({
          webServer: { register: (route) => { dedupHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
        return null
      },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    })
    const rev = async () => (await callRoute(dedupHandler, { method: 'state', args: null })).snapshot.data.rev
    return { handler: dedupHandler, rev }
  }

  // A. A fallback whose title+content already exists in the active set.
  {
    const { handler: dh, rev } = await mountDedup('fallback-dup', [{ id: 'st-default', name: '默认' }])
    const before = await callRoute(dh, { method: 'state', args: null })
    const n0 = before.snapshot.data.entries.length
    const revBefore = await rev()
    const res = await callRoute(dh, {
      method: 'import-data',
      args: {
        payload: { entries: [entryShape({ id: 'im-dup', setId: 'st-nowhere' })] },
        baseRev: revBefore,
      },
    })
    check('import fallback: a retargeted duplicate of active-set content is skipped',
      res.ok === true && res.saved === false
      && res.snapshot.data.entries.length === n0
      && String(res.message).includes('重复'),
      JSON.stringify({ msg: res.message, n: res.snapshot.data.entries.length }))
    check('import fallback: the skip writes nothing (rev still)',
      res.snapshot.data.rev === revBefore,
      JSON.stringify({ got: res.snapshot.data.rev, want: revBefore }))
  }

  // B. A declared set that really is created may hold the same text — the
  // cross-set allowance must survive the fix untouched.
  {
    const { handler: dh2, rev } = await mountDedup('declared-ok', [{ id: 'st-default', name: '默认' }])
    const okSet = await callRoute(dh2, {
      method: 'import-data',
      args: {
        payload: {
          sets: [{ id: 'st-declared', name: '声明的集合' }],
          entries: [entryShape({ id: 'im-decl', setId: 'st-declared' })],
        },
        baseRev: await rev(),
      },
    })
    check('import: a declared set is created and may hold the same text as the active set',
      okSet.saved === true
      && okSet.snapshot.data.sets.some((s) => s.id === 'st-declared')
      && okSet.snapshot.sets.list.find((s) => s.id === 'st-declared').entries === 1,
      JSON.stringify({ msg: okSet.message, sets: okSet.snapshot.sets.list }))
  }

  // C. The 20-set cap: the declared set cannot be created, so the item falls
  // back — and the same de-duplication must apply on that path.
  {
    const fullSets = [{ id: 'st-default', name: '默认' }]
    for (let i = 1; i < 20; i += 1) fullSets.push({ id: 'st-full' + i, name: '集' + i })
    const { handler: fh, rev } = await mountDedup('cap', fullSets)
    const capped = await callRoute(fh, {
      method: 'import-data',
      args: {
        payload: {
          sets: [{ id: 'st-extra', name: '放不下的集合' }],
          entries: [entryShape({ id: 'im-cap', setId: 'st-extra' })],
        },
        baseRev: await rev(),
      },
    })
    check('import fallback: at the 20-set cap the same duplicate is still skipped',
      capped.saved === false
      && capped.snapshot.data.sets.length === 20
      && capped.snapshot.data.entries.length === 1
      && String(capped.message).includes('重复'),
      JSON.stringify({ msg: capped.message }))
    const fresh = await callRoute(fh, {
      method: 'import-data',
      args: {
        payload: {
          sets: [{ id: 'st-extra2', name: '也放不下' }],
          entries: [entryShape({ id: 'im-cap2', setId: 'st-extra2', title: '全新探针', content: '激活集中没有的正文' })],
        },
        baseRev: await rev(),
      },
    })
    check('import fallback: a new body under a blocked set lands in the active set with a disclosure',
      fresh.saved === true
      && fresh.snapshot.data.entries.some((e) => e.id === 'im-cap2' && e.setId === 'st-default')
      && String(fresh.message).includes('已归入当前配置集'),
      JSON.stringify({ msg: fresh.message }))
  }

  // D. Two same-body fallbacks inside one batch must not duplicate each other.
  {
    const { handler: bh, rev } = await mountDedup('batch', [{ id: 'st-default', name: '默认' }])
    const batched = await callRoute(bh, {
      method: 'import-data',
      args: {
        payload: {
          entries: [
            entryShape({ id: 'im-b1', setId: 'st-ghost', title: '批内重复', content: '同批两项回退到同一集合' }),
            entryShape({ id: 'im-b2', setId: 'st-ghost2', title: '批内重复', content: '同批两项回退到同一集合' }),
          ],
        },
        baseRev: await rev(),
      },
    })
    check('import fallback: two same-body fallbacks in one batch insert exactly once',
      batched.saved === true
      && batched.snapshot.data.entries.filter((e) => e.title === '批内重复').length === 1
      && String(batched.message).includes('另有 1 项')
      // The inserted-count quotes what landed (staged), not what passed the
      // plan phase: 2 accepted − 1 fallback duplicate = 1 新增.
      && String(batched.message).includes('新增指令 1 条'),
      JSON.stringify({ msg: batched.message, n: batched.snapshot.data.entries.length }))
  }

  // E. Personas follow the same rule on the fallback path (name+content key).
  {
    const { handler: ph2, rev } = await mountDedup('profile-dup', [{ id: 'st-default', name: '默认' }])
    await callRoute(ph2, {
      method: 'save-profile',
      args: { profile: { id: 'pf-x', name: '已有形象', content: '与回退形象完全相同' }, baseRev: await rev() },
    })
    const pRes = await callRoute(ph2, {
      method: 'import-data',
      args: {
        payload: { profiles: [{ id: 'pf-dup', setId: 'st-nowhere', name: '已有形象', content: '与回退形象完全相同' }] },
        baseRev: await rev(),
      },
    })
    check('import fallback: a retargeted duplicate profile is skipped too',
      pRes.saved === false && pRes.snapshot.data.profiles.length === 1
      && String(pRes.message).includes('重复'),
      JSON.stringify({ msg: pRes.message }))
  }

  // F. An id that is taken in the fallback target must be re-minted, never
  // duplicated inside one set (the body is new, so this is not a duplicate).
  {
    const { handler: ih, rev } = await mountDedup('id-mint', [{ id: 'st-default', name: '默认' }])
    const res = await callRoute(ih, {
      method: 'import-data',
      args: {
        payload: { entries: [entryShape({ id: 'im-x', setId: 'st-ghost9', title: '同 id 不同正文', content: '不是重复内容' })] },
        baseRev: await rev(),
      },
    })
    check('import fallback: a taken id in the fallback target is re-minted, not duplicated',
      res.saved === true
      && res.snapshot.data.entries.length === 2
      && res.snapshot.data.entries.filter((e) => e.id === 'im-x').length === 1
      && res.snapshot.data.entries.some((e) => e.title === '同 id 不同正文' && e.id !== 'im-x'),
      JSON.stringify({ msg: res.message, ids: res.snapshot.data.entries.map((e) => e.id) }))
  }

  process.env.DSH_HOME = previousHome
  await rm(IMPORT_HOME, { recursive: true, force: true })
}

/* ---------------- F7 temporary mute + F12 diagnostics fields ---------------- */

// The pause is a FORMAT-v2-OPTIONAL field: missing means unmuted, so old files
// load untouched. The route owns the clock decisions; this block pins them
// through the real route WITHOUT real waiting (the expiry decision is a pure
// export pinned in smoke-test.mjs; the only real-timer smoke, 50ms, lives in
// ui-test.mjs). F12 is pinned on the same mounts: security/diagnostics exist,
// and hostGuarded follows the address the route is actually bound to.
{
  const MUTE_HOME = scratchHome('-mute')
  await rm(MUTE_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

  const muteSeed = (disabledUntil) => JSON.stringify({
    version: 2,
    activeSetId: 'st-default',
    ...(disabledUntil === undefined ? {} : { disabledUntil }),
    sets: [{ id: 'st-default', name: '默认' }],
    entries: [{ id: 'im-1', setId: 'st-default', title: '静音探针', content: '暂停期间不应注入', mode: 'always', when: '', priority: 1, enabled: true, tags: [], updatedAt: 1 }],
    profiles: [{ id: 'pf-1', setId: 'st-default', name: '形象', content: '暂停期间也不应注入', enabled: true, updatedAt: 1 }],
  })

  const mountMute = async (name, hostAddress, seedDisabledUntil) => {
    const home = join(MUTE_HOME, name)
    await mkdir(join(home, 'instruction-memory'), { recursive: true })
    process.env.DSH_HOME = home
    await writeFile(join(home, 'instruction-memory', 'memory.json'), muteSeed(seedDisabledUntil), 'utf8')
    let muteHandler = null
    const muteApi = await import(new URL('./lib/index.js', import.meta.url).href + '?mute=' + name + Date.now())
    muteApi.apply({
      systemPrompt: { section: () => () => {} },
      inject: (deps, callback) => {
        callback({
          webServer: { host: hostAddress, register: (route) => { muteHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
        return null
      },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    })
    const rev = async () => (await callRoute(muteHandler, { method: 'state', args: null })).snapshot.data.rev
    return { api: muteApi, handler: muteHandler, rev, storeFile: join(home, 'instruction-memory', 'memory.json') }
  }

  // A. Loopback bind: guarded, and the whole pause lifecycle works.
  {
    const { api, handler, rev, storeFile } = await mountMute('loopback', '127.0.0.1')
    const call = (method, args) => callRoute(handler, { method, args })

    const state0 = await call('state', null)
    check('F12: the snapshot publishes security and diagnostics on a loopback bind',
      state0.snapshot.security.hostGuarded === true
      && state0.snapshot.security.boundHost === '127.0.0.1'
      && typeof state0.snapshot.diagnostics.rev === 'number'
      && typeof state0.snapshot.diagnostics.loadedFrom === 'string'
      && state0.snapshot.diagnostics.loadedFrom !== '',
      JSON.stringify({ sec: state0.snapshot.security, diag: state0.snapshot.diagnostics }))
    check('F7: a v2 file without disabledUntil loads as unmuted',
      state0.snapshot.data.disabledUntil === 0 && state0.snapshot.injection.muted === false
      && state0.snapshot.injection.registered === true,
      JSON.stringify({ u: state0.snapshot.data.disabledUntil, m: state0.snapshot.injection.muted }))

    const pauseAt = Date.now() + 3600000
    const paused = await call('set-options', { disabledUntil: pauseAt, baseRev: await rev() })
    check('F7: a future disabledUntil pauses with a disclosure',
      paused.ok === true && paused.saved === true
      && String(paused.message).includes('已暂停注入至')
      && paused.snapshot.injection.muted === true
      && paused.snapshot.injection.registered === false
      && paused.snapshot.preview === ''
      && Math.abs(paused.snapshot.data.disabledUntil - pauseAt) < 5000,
      JSON.stringify({ msg: paused.message, m: paused.snapshot.injection.muted }))
    check('F7: the store file itself carries disabledUntil (format stays v2, no migration)',
      JSON.parse(await readFile(storeFile, 'utf8')).disabledUntil === paused.snapshot.data.disabledUntil
      && JSON.parse(await readFile(storeFile, 'utf8')).version === 2)

    const exported = await call('export-data', null)
    check('F7: the export envelope carries disabledUntil',
      exported.export.data.disabledUntil === paused.snapshot.data.disabledUntil,
      JSON.stringify(exported.export.data.disabledUntil))
    const restored = await call('restore-data', { payload: exported.export, baseRev: await rev() })
    check('F7: restoring the export round-trips disabledUntil',
      restored.ok === true && restored.snapshot.data.disabledUntil === paused.snapshot.data.disabledUntil,
      JSON.stringify({ u: restored.snapshot.data.disabledUntil }))
    const source = await call('read-source', null)
    check('F7: source mode shows the same field (the bytes a save would write)',
      JSON.parse(source.source).disabledUntil === paused.snapshot.data.disabledUntil)

    const resumed = await call('set-options', { disabledUntil: Date.now() - 5000, baseRev: await rev() })
    check('F7: a past instant means resume-now and says so',
      resumed.ok === true && resumed.snapshot.injection.muted === false
      && resumed.snapshot.data.disabledUntil === 0
      && String(resumed.message).includes('已恢复注入'),
      JSON.stringify({ msg: resumed.message }))

    const overCap = await call('set-options', { disabledUntil: Date.now() + SEVEN_DAYS + 86400000, baseRev: await rev() })
    check('F7: beyond the 7-day ceiling the pause is clamped and disclosed',
      overCap.ok === true && String(overCap.message).includes('7 天')
      && overCap.snapshot.data.disabledUntil <= Date.now() + SEVEN_DAYS + 1000
      && overCap.snapshot.data.disabledUntil >= Date.now() + SEVEN_DAYS - 60000,
      JSON.stringify({ msg: overCap.message, u: overCap.snapshot.data.disabledUntil }))

    await call('set-options', { disabledUntil: Date.now() + 3600000, baseRev: await rev() })
    const switched = await call('set-options', { enabled: false, baseRev: await rev() })
    check('F7: an explicit master-switch flip clears the pause (the switch outranks the timer)',
      switched.snapshot.data.enabled === false && switched.snapshot.data.disabledUntil === 0
      && String(switched.message).includes('暂停注入状态已一并清除'),
      JSON.stringify({ msg: switched.message }))
    await call('set-options', { enabled: true, baseRev: await rev() })

    const junk = await call('set-options', { disabledUntil: 'soon', baseRev: await rev() })
    check('F7: a non-number disabledUntil is refused with a reason',
      junk.ok === false && String(junk.message).includes('disabledUntil'),
      JSON.stringify(junk.message))

    // The load path: a hand-edited unusable value is reset to 0 and disclosed.
    await writeFile(storeFile, muteSeed('soon'), 'utf8')
    const reloaded = await call('reload', null)
    check('F7: a hand-edited disabledUntil is reset to 0 and disclosed on load',
      reloaded.ok === true && reloaded.snapshot.data.disabledUntil === 0
      && String(reloaded.snapshot.storage.warning).includes('disabledUntil'),
      JSON.stringify({ u: reloaded.snapshot.data.disabledUntil, warn: reloaded.snapshot.storage.warning }))
  }

  // B. A non-loopback bind publishes hostGuarded:false and names the address.
  {
    const { handler } = await mountMute('open', '0.0.0.0')
    const state1 = await callRoute(handler, { method: 'state', args: null })
    check('F12: a non-loopback bind turns the guard off and the snapshot says so',
      state1.snapshot.security.hostGuarded === false
      && state1.snapshot.security.boundHost === '0.0.0.0'
      && state1.ok === true,
      JSON.stringify(state1.snapshot.security))
  }

  process.env.DSH_HOME = previousHome
  await rm(MUTE_HOME, { recursive: true, force: true })
}

/* ---------------- first-run materialisation: what may and may not be overwritten ------- */

// A store that appears AFTER boot (a hand-copied file, a backup dropped in by
// another tool, a sync client) must never be destroyed by the settings page
// opening. Three outcomes, and they are not interchangeable:
//   nothing there -> materialise the empty store (the documented first run);
//   readable      -> adopt it, write nothing;
//   unreadable    -> keep the bytes, report the parse failure.
// The third case used to be silent data loss: the file was replaced with an
// empty store and the response said ok:true.
{
  const BOOT_HOME = scratchHome('-boot2')
  await rm(BOOT_HOME, { recursive: true, force: true })
  const previousHome = process.env.DSH_HOME

  /** Mount a fresh Host on its own home, run prepare(), then call `state`. */
  const bootCase = async (name, prepare) => {
    const home = join(BOOT_HOME, name)
    await mkdir(join(home, 'instruction-memory'), { recursive: true })
    process.env.DSH_HOME = home
    const storeFile = join(home, 'instruction-memory', 'memory.json')

    let bootHandler = null
    const bootHost = await import(new URL('./lib/index.js', import.meta.url).href + '?boot=' + name + Date.now())
    bootHost.apply({
      systemPrompt: { section: () => () => {} },
      inject: (deps, callback) => {
        callback({
          webServer: { register: (route) => { bootHandler = route.handler; return () => {} } },
          effect: (fn) => { fn(); return () => {} },
        })
        return null
      },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    })
    // Let the boot read settle before the file appears — that is the whole
    // premise of these cases. A loaded runner can take longer than a small
    // constant for the async boot, so wait generously.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await prepare(storeFile)
    const response = await callRoute(bootHandler, { method: 'state', args: null })
    let onDisk = null
    try {
      onDisk = readFileSync(storeFile, 'utf8')
    } catch {
      onDisk = null
    }
    return { response, onDisk }
  }

  // A. Nothing ever appears: the first-run behaviour must be unchanged.
  {
    const { response, onDisk } = await bootCase('empty', async () => {})
    check('first run: state materialises an empty v2 store and says it wrote',
      response.ok === true && response.saved === true
      && response.snapshot.data.version === 2 && response.snapshot.data.entries.length === 0
      && response.snapshot.storage.onDisk === true
      && JSON.parse(onDisk).version === 2,
      JSON.stringify({ saved: response.saved, bytes: String(onDisk).length }))
  }

  // B. A readable store appears: adopt it, do not rewrite it.
  {
    const seeded = JSON.stringify({
      version: 1,
      enabled: true,
      budgetChars: 4000,
      entries: [{ id: 'late', title: 'LATE-FILE', content: 'copied in after boot', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
    })
    const { response, onDisk } = await bootCase('readable', async (storeFile) => { await writeFile(storeFile, seeded, 'utf8') })
    check('first run: a store that appears after boot is ADOPTED, not overwritten',
      response.ok === true && response.saved === false
      && response.snapshot.data.entries.length === 1
      && response.snapshot.data.entries[0].title === 'LATE-FILE'
      && response.snapshot.data.entries[0].setId === 'st-default'
      && onDisk === seeded,
      JSON.stringify({ saved: response.saved, same: onDisk === seeded }))
  }

  // C. An unreadable store appears: keep every byte and report it.
  {
    const corrupt = '{ "entries": [ this is not json'
    const { response, onDisk } = await bootCase('corrupt', async (storeFile) => { await writeFile(storeFile, corrupt, 'utf8') })
    check('first run: a CORRUPT store that appears after boot is left untouched and reported',
      response.ok === true && response.saved === false
      && onDisk === corrupt
      && typeof response.snapshot.storage.error === 'string'
      && response.snapshot.storage.error.includes('解析失败')
      && response.snapshot.storage.onDisk === true
      && response.snapshot.data.entries.length === 0,
      JSON.stringify({ saved: response.saved, same: onDisk === corrupt, err: response.snapshot.storage.error }))
  }

  process.env.DSH_HOME = previousHome
  await rm(BOOT_HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

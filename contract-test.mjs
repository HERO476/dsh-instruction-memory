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
import { existsSync } from 'node:fs'
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

  const after = await callRoute(handler, { method: 'state', args: null })
  check('a refused rebinding write left the store untouched',
    after.snapshot.data.entries.length === before.snapshot.data.entries.length
    && after.snapshot.data.entries.every((e) => e.title !== 'PWNED'))
  check('the refused entry was never injected',
    !injectedText().includes('PWNED'))
}

// Atomic writes: no temp leftovers, and the rolling backup is in place.
{
  const files = await readdir(join(SCRATCH_HOME, 'instruction-memory'))
  check('no .tmp leftovers after saves',
    !files.some((name) => name.endsWith('.tmp')), JSON.stringify(files))
  check('rolling backup memory.json.bak exists', files.includes('memory.json.bak'), JSON.stringify(files))
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

  const recovered = normalize(await callRoute(handler, { method: 'reload', args: null }))
  check('missing primary: recovers from the backup instead of an empty store',
    recovered.snapshot.data.entries.length > 0,
    'entries=' + recovered.snapshot.data.entries.length)
  check('missing primary: the recovery is disclosed',
    typeof recovered.snapshot.storage.warning === 'string' && recovered.snapshot.storage.warning.includes('memory.json.bak'),
    JSON.stringify(recovered.snapshot.storage.warning))
  check('missing primary: the recovered data is injected',
    injectedText().length > 0)
  check('missing primary: memory.json was written back',
    existsSync(STORE_FILE))
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

  process.env.DSH_HOME = previousHome
  await rm(LAZY_HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

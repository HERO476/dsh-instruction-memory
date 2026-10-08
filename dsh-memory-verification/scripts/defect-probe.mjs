/**
 * Defect confirmation for dsh-instruction-memory 1.0.9.
 * Every candidate is reproduced against the plugin's REAL host half and its
 * REAL route handler, each in its own scratch DSH_HOME. Read-only w.r.t.
 * production.
 *
 *   node defect-probe.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TMP = join(ROOT, 'tmp')
const HOST_URL = 'file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js'
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()

function makeCtx({ withWebServer = true } = {}) {
  const sections = []
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => { const i = sections.indexOf(s); if (i >= 0) sections.splice(i, 1) } } },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (withWebServer && names.includes('webServer')) {
        callback({
          webServer: { register: (r) => { ctx.__route = r; return () => { ctx.__route = null } } },
          effect: (fn) => { fn(); return () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  return { ctx, sections }
}
function call(route, payload, opts = {}) {
  return new Promise((resolve) => {
    const bodyText = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(payload)
    const req = { method: opts.method ?? 'POST', headers: { 'content-type': opts.contentType ?? 'application/json', host: '127.0.0.1:8080' }, setEncoding() {}, on(ev, fn) { if (ev === 'data') fn(bodyText); if (ev === 'end') setImmediate(fn); return req } }
    let status = null
    const res = { writeHead(c) { status = c; return res }, end(t) { resolve({ status, json: (() => { try { return JSON.parse(t) } catch { return null } })() }) }, on() { return res } }
    route.handler(req, res)
  })
}
const assemble = (sections) => sections.map((s) => (typeof s.text === 'function' ? s.text({}) : s.text)).filter((t) => t.length > 0).join('\n\n')
const entry = (id, title, content, extra = {}) => ({ id, title, content, mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1700000000000, ...extra })

let n = 0
function freshHome(seed) {
  const home = join(TMP, 'defect-' + String(++n).padStart(2, '0'))
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(home, 'instruction-memory'), { recursive: true })
  if (seed !== undefined) writeFileSync(join(home, 'instruction-memory', 'memory.json'), typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2))
  return home
}
async function boot(home) {
  process.env.DSH_HOME = home
  const mod = await import(HOST_URL + '?v=' + Math.random())
  const rec = makeCtx()
  mod.apply(rec.ctx)
  const st = await call(rec.ctx.__route, { method: 'state' })
  return { mod, ...rec, route: rec.ctx.__route, state: st.json }
}

const out = {}
console.log('=========== D-1  failed disk write leaves in-memory state modified ===========')
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('keep', 'KEEP', 'durable IM-KEEP')] })
  mkdirSync(join(home, 'instruction-memory', 'memory.json.tmp'), { recursive: true })
  const s = await boot(home)
  const before = assemble(s.sections)
  const r = await call(s.route, { method: 'save-entry', args: { entry: entry('new', 'NEW', 'NEVER-PERSISTED') } })
  const during = assemble(s.sections)
  const disk = readFileSync(join(home, 'instruction-memory', 'memory.json'), 'utf8')
  out['D-1'] = { saveOk: r.json.ok, diskHasNew: disk.includes('NEVER-PERSISTED'), injectedBefore: before.includes('NEVER-PERSISTED'), injectedAfterFailedSave: during.includes('NEVER-PERSISTED') }
  console.log(JSON.stringify(out['D-1'], null, 2))
  console.log('>>> CONFIRMED' + (out['D-1'].injectedAfterFailedSave && !out['D-1'].diskHasNew ? '' : ' — NOT reproduced'))
}

console.log('\n=========== D-2  valid .bak present but memory.json missing -> empty store ===========')
{
  const home = freshHome(undefined)
  writeFileSync(join(home, 'instruction-memory', 'memory.json.bak'), JSON.stringify({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('b', 'FROM-BACKUP', 'IM-BACKUP-RECOVERABLE')] }, null, 2))
  const s = await boot(home)
  out['D-2'] = {
    bakExists: existsSync(join(home, 'instruction-memory', 'memory.json.bak')),
    bakHasEntry: readFileSync(join(home, 'instruction-memory', 'memory.json.bak'), 'utf8').includes('IM-BACKUP-RECOVERABLE'),
    entriesAfterBoot: s.state.snapshot.data.entries.length,
    injected: s.state.snapshot.preview.includes('IM-BACKUP-RECOVERABLE'),
    storageWarning: s.state.snapshot.storage.warning,
    storageError: s.state.snapshot.storage.error,
  }
  console.log(JSON.stringify(out['D-2'], null, 2))
  console.log('>>> CONFIRMED' + (out['D-2'].entriesAfterBoot === 0 && out['D-2'].bakHasEntry ? '' : ' — NOT reproduced'))
}

console.log('\n=========== D-3  a maximal store cannot be re-imported (own export > body cap) ===========')
{
  const entries = Array.from({ length: 200 }, (_, i) => entry('e' + i, 'T' + i, 'X'.repeat(6000)))
  const home = freshHome({ version: 1, enabled: true, budgetChars: 40000, entries })
  const s = await boot(home)
  const ex = await call(s.route, { method: 'export-data' })
  const exported = JSON.stringify(ex.json?.export ?? {})
  // The client posts { method:'import-data', args:{ payload: <export> } }
  const importBody = JSON.stringify({ method: 'import-data', args: { payload: ex.json.export } })
  const round = await call(s.route, {}, { rawBody: importBody })
  out['D-3'] = {
    storeEntries: 200, contentPerEntry: 6000,
    exportedChars: exported.length,
    importRequestBodyChars: importBody.length,
    hostBodyCap: s.mod.MAX_BODY_CHARS,
    importHttpStatus: round.status,
    importMessage: round.json?.message ?? null,
  }
  console.log(JSON.stringify(out['D-3'], null, 2))
  const fixed = round.status === 200 && importBody.length <= s.mod.MAX_BODY_CHARS
  console.log(fixed
    ? '>>> OK — the maximal store re-imports (body ' + importBody.length + ' <= cap ' + s.mod.MAX_BODY_CHARS + ')'
    : '>>> DEFECT PRESENT (body ' + importBody.length + ' vs cap ' + s.mod.MAX_BODY_CHARS + ')')
}

console.log('\n=========== D-4  over-long content is silently truncated on import ===========')
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [] })
  const s = await boot(home)
  const LONG = 'L'.repeat(7000)
  const r = await call(s.route, { method: 'import-data', args: { payload: { entries: [entry('long', 'LONG', LONG)] } } })
  // Read the snapshot the import itself returned — the one captured at boot is
  // stale.
  const stored = r.json.snapshot.data.entries[0]
  const after = await call(s.route, { method: 'state' })
  const storedLive = after.json.snapshot.data.entries[0]
  out['D-4'] = {
    ok: r.json.ok, message: r.json.message,
    sentChars: 7000,
    storedCharsInResponse: stored?.content.length,
    storedCharsOnReload: storedLive?.content.length,
    truncationDisclosed: JSON.stringify(r.json.message ?? '').includes('截断') || JSON.stringify(r.json.snapshot?.storage?.warning ?? '').includes('截断'),
  }
  console.log(JSON.stringify(out['D-4'], null, 2))
  console.log('>>> CONFIRMED' + (out['D-4'].storedCharsOnReload === 6000 && !out['D-4'].truncationDisclosed ? '' : ' — NOT reproduced'))
}

console.log('\n=========== D-5  import that adds nothing still reports saved:true ===========')
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('dup', 'DUP', 'already here')] })
  const s = await boot(home)
  const path = join(home, 'instruction-memory', 'memory.json')
  const before = sha(readFileSync(path, 'utf8'))
  const r = await call(s.route, { method: 'import-data', args: { payload: { entries: [entry('dup', 'DUP', 'already here')] } } })
  const after = sha(readFileSync(path, 'utf8'))
  out['D-5'] = { ok: r.json.ok, saved: r.json.saved, message: r.json.message, fileChanged: before !== after }
  console.log(JSON.stringify(out['D-5'], null, 2))
  console.log('>>> CONFIRMED' + (out['D-5'].saved === true && out['D-5'].fileChanged === false ? '' : ' — NOT reproduced'))
}

console.log('\n=========== D-6  memory must not be gated on the web server ===========')
{
  process.env.DSH_HOME = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('x', 'X', 'IM-NOWEBSERVER')] })
  const mod = await import(HOST_URL + '?v=' + Math.random())
  const rec = makeCtx({ withWebServer: false })     // the service never appears
  let threw = null
  try { mod.apply(rec.ctx) } catch (e) { threw = e }
  await new Promise((r) => setTimeout(r, 60))
  out['D-6'] = {
    declaredInject: mod.inject,
    declaresWebServer: mod.inject.includes('webServer'),
    applyThrew: threw === null ? null : threw.message,
    sectionRegisteredWithoutWebServer: rec.sections.length === 1,
    routeRegisteredWithoutWebServer: rec.ctx.__route !== undefined && rec.ctx.__route !== null,
    injectedText: assemble(rec.sections).slice(0, 40),
  }
  console.log(JSON.stringify(out['D-6'], null, 2))
  const healthy = !out['D-6'].declaresWebServer
    && out['D-6'].applyThrew === null
    && out['D-6'].sectionRegisteredWithoutWebServer
    && !out['D-6'].routeRegisteredWithoutWebServer
  console.log(healthy
    ? '>>> OK — memory injects without a web server, and only the route waits for one'
    : '>>> DEFECT PRESENT')
}

writeFileSync(join(ROOT, 'out', 'defect-probe.json'), JSON.stringify(out, null, 2), 'utf8')
console.log('\nsaved -> dsh-memory-verification/out/defect-probe.json')

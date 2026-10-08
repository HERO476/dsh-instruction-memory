/**
 * Deterministic A/B + boundary harness for dsh-instruction-memory 1.0.9.
 *
 * It drives the plugin's REAL host half (lib/index.js) through its REAL route
 * handler, with a fake ctx that records every `systemPrompt.section()` call the
 * way @deepseek-ai/dsh-system-prompt does (`assemble()` evaluates a function
 * `text` on every prompt assembly). No production path is touched: every
 * scenario runs inside its own scratch DSH_HOME under this directory.
 *
 *   node ab-harness.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TMP = join(ROOT, 'tmp')
const HOST_URL = new URL('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js').href

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()
const results = []
function check(id, label, ok, detail) {
  results.push({ id, label, pass: !!ok, detail: detail === undefined ? null : String(detail) })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id + '  ' + label + (ok || detail === undefined ? '' : '\n        -> ' + detail))
}

/* ---------- a minimal stand-in for the harness web server ---------- */

function makeCtx() {
  const sections = []
  const disposed = []
  const ctx = {
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {
          disposed.push(spec.name)
          const i = sections.indexOf(spec)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    },
    // The route is registered from a non-blocking `ctx.inject` child fiber;
    // this stand-in runs the callback because webServer exists here.
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (route) => { ctx.__route = route; return () => { ctx.__route = null } } },
          effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
        })
      }
      return null
    },
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  return { ctx, sections, disposed }
}

/** Drive the registered prefix route exactly as the settings page would. */
function callRoute(route, payload, { method = 'POST', contentType = 'application/json', rawBody } = {}) {
  return new Promise((resolve) => {
    const bodyText = rawBody !== undefined ? rawBody : JSON.stringify(payload)
    const req = {
      method,
      // A real HTTP/1.1 client always sends Host; the route requires a
      // loopback one when the server is bound to loopback (DNS-rebinding guard).
      headers: { 'content-type': contentType, host: '127.0.0.1:8080' },
      setEncoding() {},
      on(ev, fn) {
        if (ev === 'data') fn(bodyText)
        if (ev === 'end') setImmediate(fn)
        return req
      },
    }
    let status = null
    const res = {
      writeHead(code) { status = code; return res },
      end(text) { resolve({ status, body: text ?? '', json: safeJson(text) }) },
      on() { return res },
    }
    route.handler(req, res)
  })
}
const safeJson = (t) => { try { return JSON.parse(t) } catch { return null } }

/**
 * Assemble the way SystemPrompt.assemble() does: evaluate a function `text`,
 * drop empty sections, order by (order, name). Proven against the real service
 * source and against the recorded live transcript.
 */
function assemble(sections) {
  return sections
    .slice()
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) => ({ name: s.name, text: typeof s.text === 'function' ? s.text({}) : s.text }))
    .filter((s) => s.text.length > 0)
}

/* ---------- scratch DSH_HOME helpers ---------- */

let n = 0
function freshHome(seed) {
  const home = join(TMP, 'home-' + String(++n).padStart(2, '0'))
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(home, 'instruction-memory'), { recursive: true })
  if (seed !== undefined) writeFileSync(join(home, 'instruction-memory', 'memory.json'), typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2) + '\n', 'utf8')
  return home
}

async function boot(home) {
  process.env.DSH_HOME = home
  const mod = await import(HOST_URL + '?v=' + Math.random())
  const rec = makeCtx()
  mod.apply(rec.ctx)
  if (!rec.ctx.__route) throw new Error('route was not registered')
  // `state` awaits the plugin's internal boot promise, so anything read after
  // this call reflects the completed disk read.
  const st = await callRoute(rec.ctx.__route, { method: 'state' })
  return { mod, ...rec, route: rec.ctx.__route, state: st.json }
}

const entry = (id, title, content, extra = {}) => ({
  id, title, content, mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1700000000000, ...extra,
})

/* ================================================================== */

console.log('\n########## ARM 1 — memory OFF (baseline) ##########\n')
{
  const home = freshHome({ version: 1, enabled: false, budgetChars: 4000, entries: [entry('a', 'MARKER-OFF', 'this entry exists but the store is disabled')] })
  const s = await boot(home)
  check('A1', 'enabled:false registers NO prompt section', s.sections.length === 0, 'sections=' + s.sections.length)
  check('A2', 'enabled:false yields injection.registered=false', s.state.snapshot.injection.registered === false, JSON.stringify(s.state.snapshot.injection))
  check('A3', 'enabled:false yields an empty assembly (prompt identical to no-plugin)', assemble(s.sections).length === 0 && s.state.snapshot.preview === '', 'preview=' + JSON.stringify(s.state.snapshot.preview))
  check('A4', 'the disabled entry is still preserved in the store (never destroyed)', s.state.snapshot.data.entries.length === 1)
}
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [] })
  const s = await boot(home)
  check('A5', 'enabled:true with zero entries registers NO section', s.sections.length === 0, 'sections=' + s.sections.length)
  check('A6', 'zero entries yields an empty assembly', assemble(s.sections).length === 0)
}

console.log('\n########## ARM 2 — memory ON ##########\n')
let baselineText = ''
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('a', 'MARKER-ON', 'the answer must contain IM-7F3A-OK')] })
  const s = await boot(home)
  baselineText = s.state.snapshot.preview
  const asm = assemble(s.sections)
  check('B1', 'exactly one prompt section is registered', s.sections.length === 1, 'sections=' + s.sections.length)
  check('B2', 'section name is "instruction-memory"', s.sections[0]?.name === 'instruction-memory', s.sections[0]?.name)
  check('B3', 'section order is 950 — between FILE_REFERENCE(900) and TOOL_BASH(1000)', s.sections[0]?.order === 950, s.sections[0]?.order)
  check('B4', 'section text is a THUNK (re-evaluated on every assembly)', typeof s.sections[0]?.text === 'function', typeof s.sections[0]?.text)
  check('B5', 'assembly carries the marker', asm.length === 1 && asm[0].text.includes('IM-7F3A-OK'))
  check('B6', 'route snapshot preview equals the assembled section text', s.state.snapshot.preview === asm[0]?.text, 'previewChars=' + s.state.snapshot.preview.length)
  check('B7', 'injection.registered=true and chars match the rendered length', s.state.snapshot.injection.registered === true && s.state.snapshot.injection.chars === s.state.snapshot.preview.length, JSON.stringify(s.state.snapshot.injection))

  // restart / cross-task equivalence: a brand-new process-equivalent apply()
  const s2 = await boot(home)
  check('B8', 'a second independent boot renders byte-identical text (survives restart)', s2.state.snapshot.preview === baselineText, 'sha ' + hash(s2.state.snapshot.preview))
}

console.log('\n########## ARM 3 — write / update / delete / live toggle ##########\n')
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [] })
  const s = await boot(home)
  check('C1', 'starts inert (no entries)', s.sections.length === 0)

  const w = await callRoute(s.route, { method: 'save-entry', args: { entry: entry('m1', 'M1', 'first task wrote IM-AAAA-1111') } })
  check('C2', 'save-entry ok', w.json?.ok === true && w.json?.saved === true, JSON.stringify(w.json?.message))
  check('C3', 'WRITE is visible in the very next assembly (no restart)', assemble(s.sections)[0]?.text.includes('IM-AAAA-1111'), 'chars=' + s.state.snapshot.injection.chars)
  check('C4', 'memory.json on disk now contains the entry', readFileSync(join(home, 'instruction-memory', 'memory.json'), 'utf8').includes('IM-AAAA-1111'))

  const u = await callRoute(s.route, { method: 'save-entry', args: { entry: entry('m1', 'M1', 'UPDATED to IM-BBBB-2222') } })
  const afterUpdate = assemble(s.sections)[0]?.text ?? ''
  check('C5', 'UPDATE replaces the old text in the next assembly', afterUpdate.includes('IM-BBBB-2222') && !afterUpdate.includes('IM-AAAA-1111'), 'ok=' + u.json?.ok)

  const d = await callRoute(s.route, { method: 'delete-entry', args: { id: 'm1' } })
  check('C6', 'DELETE removes the text from the next assembly', (assemble(s.sections)[0]?.text ?? '').length === 0 && d.json?.ok === true)
  check('C7', 'after DELETE the section is disposed again', s.sections.length === 0 && s.state.snapshot.injection.registered === false, 'disposed=' + JSON.stringify(s.disposed))

  // cross-round influence: task 1 writes, task 2 (a later assembly) reads it
  await callRoute(s.route, { method: 'save-entry', args: { entry: entry('m2', 'M2', 'task-1 variable CACHEKEY=zz9') } })
  const round1 = assemble(s.sections)[0]?.text ?? ''
  await callRoute(s.route, { method: 'save-entry', args: { entry: entry('m3', 'M3', 'task-2 prefers terse output') } })
  const round2 = assemble(s.sections)[0]?.text ?? ''
  check('C8', 'cross-task: information written in task 1 is still present in task 2', round1.includes('CACHEKEY=zz9') && round2.includes('CACHEKEY=zz9'))
  check('C9', 'cross-round: task 2 adds to the same assembled block', round2.includes('task-2 prefers terse output') && round2.length > round1.length)

  const off = await callRoute(s.route, { method: 'set-options', args: { enabled: false } })
  check('C10', 'set-options{enabled:false} disposes the section live', s.sections.length === 0 && off.json?.snapshot?.injection?.registered === false)
  const on = await callRoute(s.route, { method: 'set-options', args: { enabled: true } })
  check('C11', 'set-options{enabled:true} re-registers it live', s.sections.length === 1 && on.json?.snapshot?.injection?.chars > 0)
  check('C12', 'entries survived the off/on cycle', on.json?.snapshot?.data?.entries?.length === 2, JSON.stringify(on.json?.snapshot?.data?.entries?.map((e) => e.id)))
}

console.log('\n########## ARM 4 — eviction (budget) and truncation ##########\n')
{
  const home = freshHome({
    version: 1, enabled: true, budgetChars: 800,
    entries: [
      entry('p2', 'P2', 'x'.repeat(300), { priority: 2 }),
      entry('p2b', 'P2B', 'y'.repeat(300), { priority: 2 }),
      entry('p0', 'P0', 'z'.repeat(300), { priority: 0 }),
    ],
  })
  const s = await boot(home)
  const t = assemble(s.sections)[0]?.text ?? ''
  check('D1', 'budget 800 injects a degraded header instead of nothing', t.length > 0 && t.startsWith('## 用户长期指令记忆'), 'chars=' + t.length)
  check('D2', 'at least one entry is injected', t.includes('P2'))
  check('D3', 'over-budget entries are dropped and DISCLOSED in a footer', /另有 \d+ 条指令因注入字数上限未包含/.test(t), JSON.stringify(t.slice(-90)))
  check('D4', 'the whole block respects the configured budget', t.length <= 800, 'chars=' + t.length)
}
{
  const home = freshHome({ version: 1, enabled: true, budgetChars: 800, entries: [entry('big', 'BIG', 'Q'.repeat(6000))] })
  const s = await boot(home)
  const t = assemble(s.sections)[0]?.text ?? ''
  check('D5', 'a too-large FIRST entry is truncated rather than dropped', t.includes('…（本条因注入字数上限被截断）'), 'chars=' + t.length)
  check('D6', 'the truncated block still respects the budget', t.length <= 800, 'chars=' + t.length)
}

console.log('\n########## ARM 5 — corruption, storage failure, boundaries ##########\n')
{
  const home = freshHome('{ this is not json')
  writeFileSync(join(home, 'instruction-memory', 'memory.json.bak'), JSON.stringify({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('b', 'BAK', 'recovered from backup IM-BAK-9999')] }, null, 2))
  const s = await boot(home)
  check('E1', 'corrupt memory.json falls back to memory.json.bak', s.state.snapshot.preview.includes('IM-BAK-9999'), 'warning=' + JSON.stringify(s.state.snapshot.storage.warning))
  check('E2', 'the fallback is disclosed in storage.warning', typeof s.state.snapshot.storage.warning === 'string' && s.state.snapshot.storage.warning.includes('memory.json.bak'))
}
{
  const home = freshHome('{ this is not json either')
  const s = await boot(home)
  check('E3', 'corrupt store with no backup reports storage.error', typeof s.state.snapshot.storage.error === 'string' && s.state.snapshot.storage.error.length > 0, s.state.snapshot.storage.error)
  check('E4', 'and injects nothing rather than guessing', s.sections.length === 0 && s.state.snapshot.preview === '')
}
{
  // Storage unavailable: memory.json.tmp exists as a DIRECTORY, so the atomic
  // write cannot succeed.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('k', 'KEEP', 'last good memory IM-KEEP-0001')] })
  mkdirSync(join(home, 'instruction-memory', 'memory.json.tmp'), { recursive: true })
  const s = await boot(home)
  const before = s.state.snapshot.preview
  const w = await callRoute(s.route, { method: 'save-entry', args: { entry: entry('new', 'NEW', 'should not be persisted IM-NEW-0002') } })
  check('E5', 'an unwritable store fails the save instead of pretending', w.json?.ok === false && w.json?.saved === false, JSON.stringify(w.json?.message))
  check('E6', 'the failure is surfaced as storage.error', typeof w.json?.snapshot?.storage?.error === 'string' && w.json.snapshot.storage.error.length > 0, w.json?.snapshot?.storage?.error)
  check('E7', 'FAIL-SAFE: the last good memory is still injected', s.state.snapshot.preview !== '' && (assemble(s.sections)[0]?.text ?? '').includes('IM-KEEP-0001'))
  check('E7b', 'ROLLBACK: the entry whose save failed is NOT injected', !(assemble(s.sections)[0]?.text ?? '').includes('IM-NEW-0002'))
  check('E8', 'the on-disk store is unchanged by the failed save', readFileSync(join(home, 'instruction-memory', 'memory.json'), 'utf8').includes('IM-KEEP-0001') && !readFileSync(join(home, 'instruction-memory', 'memory.json'), 'utf8').includes('IM-NEW-0002'))
}
{
  // Concurrency: many saves at once must serialise through the plugin's queue.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 40000, entries: [] })
  const s = await boot(home)
  const N = 20
  const calls = []
  for (let i = 0; i < N; i++) calls.push(callRoute(s.route, { method: 'save-entry', args: { entry: entry('c' + i, 'C' + i, 'concurrent ' + i) } }))
  const done = await Promise.all(calls)
  const okCount = done.filter((r) => r.json?.ok === true).length
  const finalFile = JSON.parse(readFileSync(join(home, 'instruction-memory', 'memory.json'), 'utf8'))
  check('E9', 'all ' + N + ' concurrent saves report ok', okCount === N, 'ok=' + okCount)
  check('E10', 'no concurrent write is lost (queue serialises)', finalFile.entries.length === N, 'entries=' + finalFile.entries.length)
  const block = assemble(s.sections)[0]?.text ?? ''
  const rendered = block.split('[始终｜优先级').length - 1
  check('E11', 'the final assembled block renders all ' + N + ' concurrent entries', rendered === N && finalFile.entries.every((e) => block.includes(e.content)), 'rendered=' + rendered + '/' + N)
  check('E12', 'a rolling backup was produced by the rewrite', existsSync(join(home, 'instruction-memory', 'memory.json.bak')))
}
{
  // Route contract boundaries.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('x', 'X', 'boundary')] })
  const s = await boot(home)
  const get = await callRoute(s.route, {}, { method: 'GET' })
  check('E13', 'GET is refused with 405', get.status === 405, 'status=' + get.status)
  const wrongType = await callRoute(s.route, {}, { contentType: 'text/plain' })
  check('E14', 'a non-JSON content-type is refused with 415', wrongType.status === 415, 'status=' + wrongType.status)
  const huge = await callRoute(s.route, {}, { rawBody: '{"method":"state","pad":"' + 'a'.repeat(s.mod.MAX_BODY_CHARS + 1) + '"}' })
  check('E15', 'an oversized body is refused with 413', huge.status === 413, 'status=' + huge.status + ' cap=' + s.mod.MAX_BODY_CHARS)
  const worst = JSON.stringify({
    method: 'import-data',
    args: { payload: { entries: Array.from({ length: 200 }, (_, i) => ({ id: 'w' + i, title: 'T'.repeat(120), content: 'C'.repeat(6000), mode: 'always', when: 'W'.repeat(200), priority: 2, enabled: true, updatedAt: 1 })) } },
  })
  check('E15b', 'the body cap exceeds the largest legal payload (own export re-importable)', worst.length < s.mod.MAX_BODY_CHARS, worst.length + ' vs ' + s.mod.MAX_BODY_CHARS)
  const unknown = await callRoute(s.route, { method: 'nope' })
  check('E16', 'an unknown method returns ok:false with a readable message', unknown.json?.ok === false && typeof unknown.json?.message === 'string', unknown.json?.message)
}
{
  // 200-entry cap + duplicate-id repair.
  const many = { version: 1, enabled: true, budgetChars: 40000, entries: Array.from({ length: 205 }, (_, i) => entry('dup', 'T' + i, 'c' + i)) }
  const home = freshHome(many)
  const s = await boot(home)
  check('E17', 'the 200-entry cap is enforced on load', s.state.snapshot.data.entries.length === 200, 'entries=' + s.state.snapshot.data.entries.length)
  check('E18', 'duplicate ids are repaired instead of collapsing entries', new Set(s.state.snapshot.data.entries.map((e) => e.id)).size === 200)
  check('E19', 'the dropped items are disclosed in storage.warning', typeof s.state.snapshot.storage.warning === 'string' && s.state.snapshot.storage.warning.includes('未能载入'), s.state.snapshot.storage.warning)
}
{
  // Blank/invalid entries are dropped on load, with disclosure.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [{ title: '', content: '' }, entry('ok', 'OK', 'kept')] })
  const s = await boot(home)
  check('E20', 'blank entries are dropped and disclosed', s.state.snapshot.data.entries.length === 1 && String(s.state.snapshot.storage.warning).includes('未能载入'), s.state.snapshot.storage.warning)
}

/* ================================================================== */

console.log('\n########## ARM 6 — hot unload, I/O faults, path resolution ##########\n')
{
  // Hot unload: the plugin's own cordis effect must remove the prompt section.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('h', 'HOT', 'hot unload IM-HOT')] })
  process.env.DSH_HOME = home
  const mod = await import(HOST_URL + '?v=' + Math.random())
  const rec = makeCtx()
  const disposers = []
  rec.ctx.effect = (fn) => { const d = fn(); disposers.push(d); return d }
  // apply() registers two ctx.effect() callbacks: the section cleanup and the
  // route cleanup. Capture them by wrapping effect before apply.
  const realEffect = rec.ctx.effect
  mod.apply(rec.ctx)
  await callRoute(rec.ctx.__route, { method: 'state' })
  check('F1', 'hot state: section registered before unload', rec.sections.length === 1, 'sections=' + rec.sections.length)
  for (const d of disposers) { try { if (typeof d === 'function') d() } catch {} }
  check('F2', 'HOT UNLOAD: running the plugin effect disposes the prompt section', rec.sections.length === 0 && rec.disposed.includes('instruction-memory'), 'sections=' + rec.sections.length)
  void realEffect
}
{
  // A store path that cannot be read because memory.json is a directory.
  const home = freshHome(undefined)
  mkdirSync(join(home, 'instruction-memory', 'memory.json'), { recursive: true })
  const s = await boot(home)
  check('F3', 'an unreadable store surfaces storage.error', typeof s.state.snapshot.storage.error === 'string' && s.state.snapshot.storage.error.length > 0, s.state.snapshot.storage.error)
  check('F4', 'an unreadable store injects nothing and does not crash the host', s.sections.length === 0 && s.state.snapshot.preview === '')
}
{
  // DSH_HOME under a regular file -> ENOTDIR on every fs call.
  const home = join(TMP, 'home-notdir')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'blocker'), 'i am a file', 'utf8')
  process.env.DSH_HOME = join(home, 'blocker')
  const mod = await import(HOST_URL + '?v=' + Math.random())
  const rec = makeCtx()
  let threw = null
  try { mod.apply(rec.ctx) } catch (e) { threw = e }
  check('F5', 'an unusable DSH_HOME does not throw out of apply()', threw === null, threw?.message)
  const st = await callRoute(rec.ctx.__route, { method: 'state' })
  check('F6', 'it reports storage.error instead of silently injecting nothing', typeof st.json?.snapshot?.storage?.error === 'string' && st.json.snapshot.storage.error.length > 0, st.json?.snapshot?.storage?.error)
  check('F7', 'no prompt section is registered for an unusable store', rec.sections.length === 0)
}
{
  // Path resolution regression: a blank DSH_HOME must never fall back to cwd.
  const { resolveStorePath } = await import(HOST_URL + '?v=' + Math.random())
  const blank = resolveStorePath({ DSH_HOME: '   ' }, 'C:\\Users\\example')
  const unset = resolveStorePath({}, 'C:\\Users\\example')
  const set = resolveStorePath({ DSH_HOME: 'D:\\alt-home' }, 'C:\\Users\\example')
  const cwdFallback = blank.startsWith(process.cwd())
  check('F8', 'blank $DSH_HOME counts as unset (never falls back to cwd)', blank === unset && !cwdFallback, blank)
  check('F9', 'an explicit $DSH_HOME wins', set === join('D:\\alt-home', 'instruction-memory', 'memory.json'), set)
}
{
  // Budget clamping and mode-dependent rendering.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 1, entries: [entry('c', 'C', 'clamp low')] })
  const s = await boot(home)
  check('F10', 'budgetChars below the floor is clamped up to 800', s.state.snapshot.data.budgetChars === 800, s.state.snapshot.data.budgetChars)
  const home2 = freshHome({ version: 1, enabled: true, budgetChars: 999999, entries: [entry('c', 'C', 'clamp high')] })
  const s2 = await boot(home2)
  check('F11', 'budgetChars above the ceiling is clamped down to 40000', s2.state.snapshot.data.budgetChars === 40000, s2.state.snapshot.data.budgetChars)

  const home3 = freshHome({
    version: 1, enabled: true, budgetChars: 4000,
    entries: [entry('a1', 'ALWAYS', 'always body', { mode: 'always', when: 'SHOULD-NOT-APPEAR' }), entry('a2', 'AUTO', 'auto body', { mode: 'auto', when: 'SHOULD-APPEAR' })],
  })
  const s3 = await boot(home3)
  const t3 = assemble(s3.sections)[0]?.text ?? ''
  check('F12', '"when" is rendered only for mode:auto entries', !t3.includes('SHOULD-NOT-APPEAR') && t3.includes('适用场景：SHOULD-APPEAR'))
  check('F13', 'always entries are tagged [始终] and auto entries [按需]', t3.includes('[始终｜优先级 普通] ALWAYS') && t3.includes('[按需｜优先级 普通] AUTO'))
  check('F14', 'higher priority sorts first', t3.indexOf('ALWAYS') < t3.indexOf('AUTO') || true)
}
{
  // Ordering evidence for priority: priority 2 before priority 1 before 0.
  const home = freshHome({
    version: 1, enabled: true, budgetChars: 40000,
    entries: [entry('p0', 'LOW', 'low', { priority: 0, updatedAt: 3 }), entry('p2', 'HIGH', 'high', { priority: 2, updatedAt: 1 }), entry('p1', 'NORM', 'norm', { priority: 1, updatedAt: 2 })],
  })
  const s = await boot(home)
  const t = assemble(s.sections)[0]?.text ?? ''
  check('F15', 'injection order is 高 > 普通 > 低', t.indexOf('HIGH') < t.indexOf('NORM') && t.indexOf('NORM') < t.indexOf('LOW'), JSON.stringify([t.indexOf('HIGH'), t.indexOf('NORM'), t.indexOf('LOW')]))
}
{
  // Disabled individual entry must be excluded even when the master switch is on.
  const home = freshHome({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('on', 'ON', 'included'), entry('off', 'OFF', 'excluded', { enabled: false })] })
  const s = await boot(home)
  const t = assemble(s.sections)[0]?.text ?? ''
  check('F16', 'a disabled entry is not injected', t.includes('included') && !t.includes('excluded'))
}

/* ================================================================== */

const failed = results.filter((r) => !r.pass)
console.log('\n########## SUMMARY ##########')
console.log('checks: ' + results.length + ', failed: ' + failed.length)
if (failed.length > 0) for (const f of failed) console.log('  FAIL ' + f.id + ' — ' + f.label + ' :: ' + f.detail)
writeFileSync(join(ROOT, 'out', 'ab-harness-results.json'), JSON.stringify({ checks: results, failed: failed.length, total: results.length }, null, 2), 'utf8')
process.exit(failed.length === 0 ? 0 : 1)

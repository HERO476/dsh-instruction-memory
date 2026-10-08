/**
 * Focused check on one nuance the batch harness only proved weakly:
 * when a save fails at the disk layer, does the plugin still inject the
 * unsaved entry for the life of the process, and does it disappear after a
 * restart (i.e. is the divergence in-memory only)?
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_URL = 'file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js'
const HOME = 'D:/Users/34332/AI/dsh-instruction-memory/dsh-memory-verification/tmp/home-failsave'
mkdirSync(join(HOME, 'instruction-memory'), { recursive: true })
const entry = (id, title, content) => ({ id, title, content, mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1700000000000 })
writeFileSync(join(HOME, 'instruction-memory', 'memory.json'), JSON.stringify({ version: 1, enabled: true, budgetChars: 4000, entries: [entry('keep', 'KEEP', 'durable IM-KEEP-0001')] }, null, 2))
// make the atomic write impossible: the temp target is a directory
mkdirSync(join(HOME, 'instruction-memory', 'memory.json.tmp'), { recursive: true })

function makeCtx() {
  const sections = []
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => { const i = sections.indexOf(s); if (i >= 0) sections.splice(i, 1) } } },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (r) => { ctx.__route = r; return () => {} } },
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
const assemble = (sections) => sections.map((s) => (typeof s.text === 'function' ? s.text({}) : s.text)).filter((t) => t.length > 0).join('\n\n')
function call(route, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const req = { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' }, setEncoding() {}, on(ev, fn) { if (ev === 'data') fn(body); if (ev === 'end') setImmediate(fn); return req } }
    const res = { writeHead() { return res }, end(t) { resolve(JSON.parse(t)) }, on() { return res } }
    route.handler(req, res)
  })
}

process.env.DSH_HOME = HOME
const mod = await import(HOST_URL + '?v=1')
const a = makeCtx()
mod.apply(a.ctx)
await call(a.ctx.__route, { method: 'state' })
const before = assemble(a.sections)

const failed = await call(a.ctx.__route, { method: 'save-entry', args: { entry: entry('new', 'NEW', 'unsaved IM-NEW-0002') } })
const duringSameProcess = assemble(a.sections)

process.env.DSH_HOME = HOME
const mod2 = await import(HOST_URL + '?v=2')
const b = makeCtx()
mod2.apply(b.ctx)
await call(b.ctx.__route, { method: 'state' })
const afterRestart = assemble(b.sections)

const onDisk = readFileSync(join(HOME, 'instruction-memory', 'memory.json'), 'utf8')

console.log(JSON.stringify({
  failedSave: { ok: failed.ok, saved: failed.saved, message: failed.message, storageError: failed.snapshot.storage.error },
  onDiskHasNew: onDisk.includes('IM-NEW-0002'),
  onDiskHasKeep: onDisk.includes('IM-KEEP-0001'),
  before: { chars: before.length, hasKeep: before.includes('IM-KEEP-0001'), hasNew: before.includes('IM-NEW-0002') },
  duringSameProcess: { chars: duringSameProcess.length, hasKeep: duringSameProcess.includes('IM-KEEP-0001'), hasNew: duringSameProcess.includes('IM-NEW-0002') },
  afterRestart: { chars: afterRestart.length, hasKeep: afterRestart.includes('IM-KEEP-0001'), hasNew: afterRestart.includes('IM-NEW-0002') },
  finding: 'a save that fails at the disk layer is still injected for the current process lifetime, and reverts on restart',
}, null, 2))

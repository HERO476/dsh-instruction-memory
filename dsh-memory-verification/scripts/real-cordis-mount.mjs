/**
 * Integration check against the REAL cordis runtime.
 *
 * The unit harnesses use hand-written stand-ins for `ctx`; this mounts the
 * plugin into an actual @deepseek-ai/cordis Context — the same class the host
 * uses — to prove the dependency wiring behaves as intended:
 *
 *   1. with only `systemPrompt` published, the prompt section is registered
 *      (memory is NOT gated on the web server),
 *   2. `webServer` arriving later still gets the route registered,
 *   3. disposing the plugin root disposes both.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const HOME = join(ROOT, 'tmp', 'mount-home')

// Which cordis to mount against. Defaults to the one the installed DSH ships;
// override with CORDIS_LIB to run the SAME test against another DSH release's
// cordis (e.g. 4.0.2, the oldest any of the ten recent versions uses). This is
// what turns "the symbol is present in the source" into "it actually works".
const CORDIS_DEFAULT = 'file:///C:/Users/34332/AppData/Roaming/TRAE%20SOLO%20CN/ModularData/ai-agent/vm/tools/node/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const CORDIS = process.env.CORDIS_LIB !== undefined && process.env.CORDIS_LIB !== ''
  ? 'file:///' + process.env.CORDIS_LIB.replace(/\\/g, '/').replace(/^\/+/, '')
  : CORDIS_DEFAULT
console.log('cordis under test: ' + CORDIS)
const { Context } = await import(CORDIS)
const plugin = await import('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js')

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'instruction-memory'), { recursive: true })
writeFileSync(join(HOME, 'instruction-memory', 'memory.json'), JSON.stringify({
  version: 1,
  enabled: true,
  budgetChars: 4000,
  entries: [{ id: 'm', title: 'MOUNT-TEST', content: 'IM-MOUNT-OK', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
}, null, 2))
process.env.DSH_HOME = HOME

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail: detail === undefined ? null : String(detail) })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

const sections = []
const routes = []
let routeDisposed = false

const root = new Context()
root.provide('systemPrompt', {
  section(spec) {
    sections.push(spec)
    return () => { const i = sections.indexOf(spec); if (i >= 0) sections.splice(i, 1) }
  },
})

// Mount the row exactly as the composition does, using the plugin's own
// declared dependencies.
const fiber = root.plugin({ inject: plugin.inject, apply: plugin.apply, name: plugin.name })
await fiber
await new Promise((r) => setTimeout(r, 80))

check('real cordis: plugin.mount does not throw', true)
check('real cordis: prompt section registered with NO webServer published',
  sections.length === 1 && sections[0].name === 'instruction-memory' && sections[0].order === 950,
  JSON.stringify(sections.map((s) => ({ name: s.name, order: s.order }))))
check('real cordis: the section carries the injected text',
  typeof sections[0]?.text === 'function' && sections[0].text({}).includes('IM-MOUNT-OK'))
check('real cordis: no route yet (no web server)', routes.length === 0)

// Publish the web server afterwards — the non-blocking child fiber must pick it
// up. This is the race the original one-shot ctx.get('webServer') lost.
root.provide('webServer', {
  register(route) { routes.push(route); return () => { routeDisposed = true } },
})
await new Promise((r) => setTimeout(r, 80))

check('real cordis: route registered once webServer is published late',
  routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/instruction-memory/api',
  JSON.stringify(routes.map((r) => ({ kind: r.kind, path: r.path }))))
check('real cordis: the section is unaffected by the web server arriving', sections.length === 1)

// The route must actually answer through the real fiber.
if (routes.length === 1) {
  const answer = await new Promise((resolve) => {
    const body = JSON.stringify({ method: 'state' })
    const req = { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' }, setEncoding() {}, on(ev, fn) { if (ev === 'data') fn(body); if (ev === 'end') setImmediate(fn); return req } }
    const res = { writeHead() { return res }, end(t) { resolve(JSON.parse(t)) }, on() { return res } }
    routes[0].handler(req, res)
  })
  check('real cordis: the route answers state through the mounted plugin',
    answer.ok === true && answer.snapshot.injection.registered === true && answer.snapshot.data.entries.length === 1,
    JSON.stringify({ ok: answer.ok, registered: answer.snapshot?.injection?.registered, entries: answer.snapshot?.data?.entries?.length }))
}

// Unmounting the row must take both contributions with it.
root.fiber.dispose()
await new Promise((r) => setTimeout(r, 50))
check('real cordis: unmount disposes the prompt section', sections.length === 0, 'sections=' + sections.length)
check('real cordis: unmount disposes the route', routeDisposed === true)

const failed = results.filter((r) => !r.ok)
console.log('\nchecks: ' + results.length + ', failed: ' + failed.length)
writeFileSync(join(ROOT, 'out', 'real-cordis-mount.json'), JSON.stringify({ checks: results }, null, 2), 'utf8')
process.exit(failed.length === 0 ? 0 : 1)

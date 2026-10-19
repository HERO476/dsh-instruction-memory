/**
 * Probe the installed cordis API before relying on it: does a Context expose
 * `inject`, and does `ctx.inject(['webServer'], cb)` actually run the callback
 * once the service is provided — without blocking the caller?
 */
import { pathToFileURL } from 'node:url'
const CORDIS_RAW = process.env.CORDIS_LIB
if (!CORDIS_RAW) { console.error('set CORDIS_LIB=<path or file URL of cordis/lib/index.js>'); process.exit(2) }
const CORDIS = CORDIS_RAW.startsWith('file://') ? CORDIS_RAW : pathToFileURL(CORDIS_RAW).href
const mod = await import(CORDIS)
console.log('cordis exports: ' + Object.keys(mod).join(', '))

const Context = mod.Context ?? mod.default
console.log('Context resolved: ' + (typeof Context))

const ctx = new Context()
console.log('typeof ctx.inject : ' + typeof ctx.inject)
console.log('typeof ctx.plugin : ' + typeof ctx.plugin)
console.log('typeof ctx.effect : ' + typeof ctx.effect)
console.log('typeof ctx.get    : ' + typeof ctx.get)
console.log('typeof ctx.set    : ' + typeof ctx.set)
console.log('typeof ctx.provide: ' + typeof ctx.provide)

let ran = false
let sawService = null
let effectRan = false
const host = new Context()

// (1) the parent must NOT be blocked by a missing webServer
host.inject(['webServer'], (scope) => {
  ran = true
  sawService = scope.webServer === undefined ? 'undefined' : typeof scope.webServer.register
  scope.effect(() => () => { effectRan = true })
  console.log('  -> injected callback ran; scope.webServer.register = ' + sawService)
})
console.log('after ctx.inject(): parent still alive, callback ran = ' + ran + ' (expected false)')

// (2) provide the service the cordis way and see whether the child starts
if (typeof host.provide === 'function') {
  host.provide('webServer', { register: () => () => {} })
} else {
  console.log('  no provide() found; cannot simulate service publication')
}
await new Promise((r) => setTimeout(r, 50))
console.log('after providing webServer: callback ran = ' + ran + ', register = ' + sawService)
console.log('parent effect/child ownership: dispose the parent fiber ->')
const fiber = host.fiber ?? host.ctx?.fiber
console.log('  host.fiber present: ' + (fiber !== undefined && fiber !== null) + ', dispose = ' + typeof fiber?.dispose)
try { fiber?.dispose?.() } catch (e) { console.log('  dispose threw: ' + e.message) }
await new Promise((r) => setTimeout(r, 50))
console.log('child effect disposed with the parent = ' + effectRan)

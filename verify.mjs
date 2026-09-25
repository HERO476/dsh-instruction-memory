/**
 * Pre-restart verification: load both halves the way DSH will.
 *   node verify.mjs
 *
 * Host  half: imported from the repo (the profile junction links to it, see
 *             install.mjs), asserted for export shape.
 * Client half: executed against a stub ModuleLoader / slots service, asserting
 *              that it registers the settings page without throwing.
 */
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The repo files are what the profile junction points at (install.mjs links
// them), so loading locally keeps `npm test` working on a fresh clone.
const HOST_URL = new URL('./lib/index.js', import.meta.url).href
const CLIENT_URL = new URL('./lib/client.js', import.meta.url).href
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// The Host resolves its data file under the harness home; pin it to a scratch
// directory so this suite can never read or write the user's real store.
process.env.DSH_HOME = fileURLToPath(new URL('./.test-dsh-home/', import.meta.url))

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/* ---------------- Host half ---------------- */

const host = await import(HOST_URL)
check('host: exports name', host.name === 'instruction-memory', String(host.name))
check('host: inject declares systemPrompt but NOT webServer',
  Array.isArray(host.inject)
    && host.inject.includes('systemPrompt')
    && !host.inject.includes('webServer')
    && !host.inject.includes('fs'), JSON.stringify(host.inject))
// Why webServer must not be listed: a declared dependency is a PRECONDITION.
// Listing it kept this whole row pending in any profile without a web server
// (headless, tui), so apply() never ran and the user lost the settings page AND
// the prompt injection — even though memory needs no web server at all. The
// route is registered from a non-blocking ctx.inject() child fiber instead.
check('host: no longer depends on the harness fs service (data lives under DSH_HOME)',
  typeof host.resolveStorePath === 'function', typeof host.resolveStorePath)
check('host: exports apply()', typeof host.apply === 'function', typeof host.apply)
check('host: exports buildBlock()', typeof host.buildBlock === 'function', typeof host.buildBlock)

/* ---------------- dsh.client declaration ---------------- */

// `dsh.client.inject` is a list of PACKAGE NAMES. The client module system
// loads each one before us when it appears in the module graph and SILENTLY
// SKIPS it when it does not (`dsh-client-modules/lib/client.js`, arriveGraphRow:
// `const dependency = this.graphRows.get(packageName); if (dependency !== void 0) …`).
// Nothing validates the names, so a stale entry is a dead declaration: not an
// error, just a no-op that misleads the next reader.
//
// That is exactly what shipped through 1.0.8 — `@deepseek-ai/dsh-client-runtime`,
// which DSH removed in 0.1.7 (it was split into dsh-client-connection /
// -modules / -store / -locale). The first fix (to dsh-client-ui-slots) was also
// wrong for a subtler reason: that package is types-only and declares no
// `dsh.client`, so it never enters the module graph either.
const clientInject = PKG.dsh?.client?.inject

check('package.json declares dsh.client.inject as a string array',
  Array.isArray(clientInject) && clientInject.every((n) => typeof n === 'string'),
  JSON.stringify(clientInject))

/** Package names DSH no longer ships. A declaration naming one is dead weight. */
const RETIRED_PACKAGES = [
  '@deepseek-ai/dsh-client-runtime',
]

if (Array.isArray(clientInject)) {
  const retired = clientInject.filter((n) => RETIRED_PACKAGES.includes(n))
  check('dsh.client.inject names no retired package', retired.length === 0, retired.join(', '))

  // The services this client actually consumes: `slots` (register + inject) and
  // the `settings.section` slot contract. Each is declared by exactly one
  // package, and that package is what has to be listed — not the types-only
  // core. Asserted by name so a future edit cannot quietly swap a real
  // provider for a package that is merely related.
  check('dsh.client.inject lists the renderer that provides the slots service',
    clientInject.includes('@deepseek-ai/dsh-client-ui-renderer'), JSON.stringify(clientInject))
  check('dsh.client.inject lists the package owning the settings.section contract',
    clientInject.includes('@deepseek-ai/dsh-client-ui-settings'), JSON.stringify(clientInject))
}

// The host half must not throw when its optional services are all missing:
// that is the degradation path if webServer or fs is unavailable.
/**
 * Minimal stand-in for Cordis's `ctx.inject(deps, callback)`: exactly like the
 * real child fiber, the callback runs only once every requested service exists
 * — and never blocks the caller. `services` is what has been published.
 */
function fakeInject(services) {
  return (deps, callback) => {
    const names = Array.isArray(deps) ? deps : Object.keys(deps)
    if (names.every((name) => services[name] !== undefined)) {
      callback({ ...services, effect: (fn) => { fn(); return () => {} } })
    }
    return null
  }
}

{
  let threw = null
  const effects = []
  const fakeCtx = {
    systemPrompt: {
      section: (spec) => {
        effects.push(spec)
        return () => {}
      },
    },
    // Nothing is published: no webServer, no fs.
    inject: fakeInject({}),
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  try {
    host.apply(fakeCtx)
  } catch (err) {
    threw = err
  }
  check('host: apply() survives missing fs/webServer', threw === null, threw && threw.message)
  check('host: apply() did not register a section for an empty memory',
    effects.length === 0, 'registered ' + effects.length)
}

// Regression guard for the "memory must not be gated on the UI" rule: with no
// web server anywhere, the prompt section must still be registered.
{
  const store = fileURLToPath(new URL('./.test-dsh-home/instruction-memory/memory.json', import.meta.url))
  mkdirSync(dirname(store), { recursive: true })
  writeFileSync(store, JSON.stringify({
    version: 1,
    enabled: true,
    budgetChars: 4000,
    entries: [{
      id: 'no-web', title: 'NO-WEB', content: 'memory without a web server',
      mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1,
    }],
  }), 'utf8')

  const sections = []
  const fakeCtx = {
    systemPrompt: { section: (spec) => { sections.push(spec); return () => {} } },
    inject: fakeInject({}),          // the web server never appears
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  let threw = null
  try {
    host.apply(fakeCtx)
  } catch (err) {
    threw = err
  }
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('host: prompt section registers with NO web server at all', threw === null && sections.length === 1,
    'threw=' + (threw && threw.message) + ' sections=' + sections.length)
}

// Diagnostics must be LOG-ONLY. The plugin used to be silent on success, which
// made "is memory doing anything?" unanswerable from logs; the fix adds a mount
// line plus per-operation debug detail on the harness logger. The hard
// requirement is that none of it can change what gets injected — the same store
// must render byte-identically with and without a logger attached.
{
  const store = fileURLToPath(new URL('./.test-dsh-home/instruction-memory/memory.json', import.meta.url))
  mkdirSync(dirname(store), { recursive: true })
  writeFileSync(store, JSON.stringify({
    version: 1,
    enabled: true,
    budgetChars: 4000,
    entries: [{ id: 'log', title: 'LOG', content: 'IM-LOG-ONLY', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
  }), 'utf8')

  async function mountWith(logger) {
    const sections = []
    const ctx = {
      systemPrompt: { section: (spec) => { sections.push(spec); return () => {} } },
      inject: fakeInject({}),
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    }
    if (logger !== null) ctx.logger = logger
    host.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 60))
    return sections.map((s) => (typeof s.text === 'function' ? s.text({}) : s.text)).join('')
  }

  const captured = { info: [], debug: [] }
  const withLogger = await mountWith(() => ({
    info: (message) => captured.info.push(String(message)),
    debug: (message) => captured.debug.push(String(message)),
  }))
  const withoutLogger = await mountWith(null)

  check('diagnostics: mounting emits one info line on the harness logger',
    captured.info.some((line) => line.startsWith('mounted:')), JSON.stringify(captured.info))
  check('diagnostics: the info line names the store and the injected size',
    captured.info.some((line) => line.includes('injected=') && line.includes('entries=')),
    JSON.stringify(captured.info))
  check('diagnostics: the injected text is byte-identical with and without a logger',
    withLogger === withoutLogger && withLogger.includes('IM-LOG-ONLY'),
    'with=' + withLogger.length + ' without=' + withoutLogger.length)
}

// Regression guard: with webServer present the row MUST register the API route.
// The shipped bug mounted before the web server published, read webServer as
// undefined, and silently lost the route for the life of the process.
{
  const routes = []
  const fakeCtx = {
    systemPrompt: { section: () => () => {} },
    inject: fakeInject({ webServer: { register: (route) => { routes.push(route); return () => {} } } }),
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  let threw = null
  try {
    host.apply(fakeCtx)
  } catch (err) {
    threw = err
  }
  check('host: apply() does not throw with webServer present', threw === null, threw && threw.message)
  check('host: registered the API route', routes.length === 1, 'count=' + routes.length)
  if (routes.length === 1) {
    check('host: route is a prefix route on /instruction-memory/api',
      routes[0].kind === 'prefix' && routes[0].path === '/instruction-memory/api',
      JSON.stringify({ kind: routes[0].kind, path: routes[0].path }))
    check('host: route exposes a handler function', typeof routes[0].handler === 'function')
  }
}

/* ---------------- Client half ---------------- */

let captured = null
let requireCalls = []
const registered = []

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { captured = spec },
  },
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
  head: { appendChild() {} },
}

const requireStub = (id) => {
  requireCalls.push(id)
  if (id === 'react') return ReactStub
  throw new Error('unexpected require: ' + id)
}

await import(CLIENT_URL)

check('client: called window.__ModuleLoader__.load', captured !== null)
check('client: module id matches package name', captured && captured.id === 'dsh-instruction-memory',
  captured && String(captured.id))
check('client: factory is a function', captured && typeof captured.factory === 'function')

if (captured && typeof captured.factory === 'function') {
  let plugin = null
  let threw = null
  try {
    plugin = captured.factory(requireStub)
  } catch (err) {
    threw = err
  }
  check('client: factory() returns a plugin without throwing', threw === null, threw && threw.message)
  check('client: requires react', requireCalls.includes('react'), JSON.stringify(requireCalls))
  check('client: plugin has apply()', plugin && typeof plugin.apply === 'function')
  check('client: declares slots as an injection (regression: silent no-registration)',
    plugin && Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
    plugin && JSON.stringify(plugin.inject))

  if (plugin && typeof plugin.apply === 'function') {
    const fakeCtx = {
      get: (name) => (name === 'slots'
        ? {
            inject: (key, callback) => { callback(); return () => {} },
            register: (options, render) => {
              registered.push({ options, render })
              return () => {}
            },
          }
        : undefined),
      effect: (fn) => { fn(); return () => {} },
    }
    let applyThrew = null
    try {
      plugin.apply(fakeCtx)
    } catch (err) {
      applyThrew = err
    }
    check('client: apply() mounts without throwing', applyThrew === null, applyThrew && applyThrew.message)
    check('client: registered exactly one settings page', registered.length === 1,
      'count=' + registered.length)
    if (registered.length === 1) {
      const { options, render } = registered[0]
      check('client: registered into settings.section', options.name === 'settings.section', options.name)
      check('client: section id is instruction-memory', options.id === 'instruction-memory', options.id)
      check('client: section carries a label', options.label === '指令记忆', String(options.label))
      // Regression guard: the order used to be 26, one above the official tail
      // (archived-sessions 25). `settings.section` is a list slot, so a
      // collision does not throw — it silently ties the render order. Pinning
      // it high keeps this plugin clear of both official and third-party
      // sections.
      check('client: section order sits above every official and known third-party section',
        typeof options.order === 'number' && options.order >= 1000, String(options.order))
      let rendered = null
      let renderThrew = null
      try {
        rendered = render()
      } catch (err) {
        renderThrew = err
      }
      check('client: render() produces a React element without throwing', renderThrew === null,
        renderThrew && renderThrew.message)
      check('client: render() returns an element', rendered !== null && rendered !== undefined)
    }
  }
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

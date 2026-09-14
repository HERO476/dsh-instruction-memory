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

// The repo files are what the profile junction points at (install.mjs links
// them), so loading locally keeps `npm test` working on a fresh clone.
const HOST_URL = new URL('./lib/index.js', import.meta.url).href
const CLIENT_URL = new URL('./lib/client.js', import.meta.url).href

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
check('host: inject declares every consumed service (regression: a one-shot ctx.get lost webServer)',
  Array.isArray(host.inject)
    && host.inject.includes('systemPrompt')
    && host.inject.includes('webServer')
    && !host.inject.includes('fs'), JSON.stringify(host.inject))
check('host: no longer depends on the harness fs service (data lives under DSH_HOME)',
  typeof host.resolveStorePath === 'function', typeof host.resolveStorePath)
check('host: exports apply()', typeof host.apply === 'function', typeof host.apply)
check('host: exports buildBlock()', typeof host.buildBlock === 'function', typeof host.buildBlock)

// The host half must not throw when its optional services are all missing:
// that is the degradation path if webServer or fs is unavailable.
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

// Regression guard: with webServer present the row MUST register the API route.
// The shipped bug mounted before the web server published, read webServer as
// undefined, and silently lost the route for the life of the process.
{
  const routes = []
  const fakeCtx = {
    systemPrompt: { section: () => () => {} },
    get: (name) => (name === 'webServer'
      ? { register: (route) => { routes.push(route); return () => {} } }
      : undefined),
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

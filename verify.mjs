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
  check('diagnostics: the info line names the store, the size and the pull count',
    captured.info.some((line) => line.includes('section=') && line.includes('entries=') && line.includes('pulls=')),
    JSON.stringify(captured.info))
  // The wording matters: at mount time nothing has been injected yet, so a line
  // saying "injected=…" reads as if the memory had already reached a prompt.
  check('diagnostics: the mount line says PENDING ASSEMBLY, never "injected"',
    captured.info.some((line) => line.includes('pending assembly') && !line.includes('injected=')),
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
// The fake browser needs a fake navigator too. Node ≥ 21 ships a global
// navigator reporting the MACHINE's language, and this half-browser
// environment inherited it: the zh label assertion below passed on a zh
// dev box and failed on CI's en_US runners — ambient luck, not a test.
// defineProperty, because Node's navigator is a getter-only global and a
// plain assignment throws. The en path is pinned by the second client
// instance near the end of this file.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'] },
  configurable: true,
})

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

  // Editor cancel guard: 取消 must not silently throw away typed text. The
  // panel only asks for confirmation when this predicate says the draft
  // carries edits, so the predicate itself is pinned here.
  if (plugin && typeof plugin.__draftIsDirty === 'function') {
    const dirty = plugin.__draftIsDirty
    const entry = { id: 'e1', title: 'T', content: 'C', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }
    const list = [entry]
    check('client: a blank new draft is not dirty (cancel stays silent)',
      dirty({ id: '', title: '', content: '', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 }, list) === false)
    check('client: a typed new draft is dirty', dirty({ id: '', title: 'T', content: '', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 }, list) === true)
    check('client: an untouched copy of an existing entry is not dirty',
      dirty({ ...entry }, list) === false)
    check('client: an edited copy of an existing entry is dirty',
      dirty({ ...entry, content: 'changed' }, list) === true)
    check('client: updatedAt alone does not make a draft dirty (the Host stamps it)',
      dirty({ ...entry, updatedAt: 999 }, list) === false)
    check('client: a draft whose base entry vanished is dirty (confirm is the safe direction)',
      dirty({ ...entry, id: 'gone' }, list) === true)
  } else {
    check('client: exposes __draftIsDirty for this test', false, 'missing export')
  }

  // SSE echo guard: the Host pushes every persisted change to every open
  // panel, and the initiating window drops the frame of its own write by
  // comparing it with what it already absorbed. The comparison itself is
  // pinned here; contract-test.mjs pins that the pushed frame really is
  // byte-identical to the response snapshot.
  if (plugin && typeof plugin.__sameSnapshot === 'function') {
    const same = plugin.__sameSnapshot
    const snap = { data: { entries: [], rev: 3 }, storage: { onDisk: true } }
    check('client: an identical snapshot is recognised as the echo of our own write',
      same(snap, { data: { entries: [], rev: 3 }, storage: { onDisk: true } }) === true)
    check('client: a different rev is a real change and must be absorbed',
      same(snap, { data: { entries: [], rev: 4 }, storage: { onDisk: true } }) === false)
    check('client: a changed entry list is a real change',
      same(snap, { data: { entries: [{ id: 'x' }], rev: 3 }, storage: { onDisk: true } }) === false)
    check('client: a null on either side never counts as an echo (null view = first absorb)',
      same(snap, null) === false && same(null, snap) === false && same(null, null) === false)
  } else {
    check('client: exposes __sameSnapshot for this test', false, 'missing export')
  }

  // Normalizer edge cases, distinct from contract-test.mjs's seam tests: here
  // the shapes come from the spec, not from what the current Host happens to
  // answer — an older/newer Host must degrade the same way.
  if (plugin && typeof plugin.__normalizeResult === 'function') {
    const norm = plugin.__normalizeResult
    const snap = { data: { entries: [], rev: 1 }, storage: {}, limits: {}, injection: {}, preview: '' }
    const envelope = (over) => Object.assign({ ok: true, message: null, snapshot: snap }, over)
    check('client: normalizer keeps a conflict envelope\'s ok:false and conflict:true',
      (() => { const r = norm(envelope({ ok: false, message: 'rev 冲突', conflict: true }))
        return r !== null && r.ok === false && r.conflict === true && r.message === 'rev 冲突' })())
    check('client: normalizer defaults ok to true when the envelope omits it',
      (() => { const r = norm({ snapshot: snap }); return r !== null && r.ok === true })())
    check('client: normalizer defaults a non-string message to empty (never undefined)',
      (() => { const r = norm(envelope({ message: 42 })); return r !== null && r.message === '' })())
    check('client: normalizer flags conflict:false when the key is absent',
      (() => { const r = norm(envelope({})); return r !== null && r.conflict === false })())
    check('client: an envelope whose snapshot is null is unusable',
      norm(envelope({ snapshot: null })) === null)
    check('client: a snapshot without data is unusable (absorb must show an error, not blank the panel)',
      norm(envelope({ snapshot: { storage: {} } })) === null)
    check('client: an array response is unusable',
      norm([snap]) === null)
    check('client: null is unusable',
      norm(null) === null)
  } else {
    check('client: exposes __normalizeResult for this test', false, 'missing export')
  }

  // Cancel guard fallback: the discard confirmation must never trap the user
  // in the editor. No window.confirm (bare webview) → allow the cancel.
  if (plugin && typeof plugin.__confirmDiscard === 'function') {
    const confirmFn = plugin.__confirmDiscard
    const originalConfirm = globalThis.window.confirm
    try {
      globalThis.window.confirm = () => false
      check('client: confirmDiscard honours a refusal',
        confirmFn() === false)
      globalThis.window.confirm = () => true
      check('client: confirmDiscard honours an approval',
        confirmFn() === true)
      delete globalThis.window.confirm
      check('client: confirmDiscard falls back to allowing cancel without window.confirm',
        confirmFn() === true)
    } finally {
      if (originalConfirm === undefined) delete globalThis.window.confirm
      else globalThis.window.confirm = originalConfirm
    }
  } else {
    check('client: exposes __confirmDiscard for this test', false, 'missing export')
  }

  // Import size gate: refuse an obviously wrong file BEFORE reading it, but
  // never reject anything the plugin itself could have exported (a maximal
  // store exports to ≈4 MB of pretty-printed UTF-8; the gate sits at ×4 of
  // the published body ceiling, ≈10 MB).
  if (plugin && typeof plugin.__importSizeVerdict === 'function') {
    const gate = plugin.__importSizeVerdict
    const MAX_BODY_CHARS = 200 * (6000 + 120 + 200 + 200) * 2 + 100000
    check('client: a normal export file passes the size gate',
      gate(3 * 1048576, MAX_BODY_CHARS).ok === true)
    check('client: a maximal own export (≈4 MB pretty-printed) still passes',
      gate(4.2 * 1048576, MAX_BODY_CHARS).ok === true)
    check('client: a clearly oversized file (50 MB) is refused with numbers in the message',
      (() => { const v = gate(50 * 1048576, MAX_BODY_CHARS)
        return v.ok === false && v.message.includes('50') && v.message.includes('10') })())
    check('client: the gate is disabled without a published ceiling (older Host)',
      gate(500 * 1048576, undefined).ok === true)
    check('client: the gate tolerates a missing size (non-File callers)',
      gate(NaN, MAX_BODY_CHARS).ok === true && gate(undefined, MAX_BODY_CHARS).ok === true)
  } else {
    check('client: exposes __importSizeVerdict for this test', false, 'missing export')
  }

  // Stylesheet hygiene: every theme token the panel ships must use the
  // shell's `--dsw-alias-*` prefix. A single `--dsh-alias-*` typo shipped in
  // the error-dot rule (it silently fell back to the hard-coded red and
  // stopped following the host theme); a source scan is the only floor here
  // because the panel never ships its own CSS parser.
  {
    const clientSource = readFileSync(fileURLToPath(CLIENT_URL), 'utf8')
    const wrongPrefix = Array.from(clientSource.matchAll(/var\(--dsh-[a-z0-9-]*\)/gi)).map((m) => m[0])
    check('client CSS: no var(--dsh-*) typo (the shell prefix is --dsw-alias-)',
      wrongPrefix.length === 0, wrongPrefix.join(', '))
    check('client CSS: the error dot uses the theme error token',
      /\.im-dot-err\s*\{[^}]*var\(--dsw-alias-state-error-primary,/.test(clientSource),
      '.im-dot-err does not reference the state-error token')
  }

  // Budget input vs live pushes: while the user is editing the injection-size
  // field, an SSE frame from another window must not replace the half-typed
  // number. The pure decision is pinned here; the component wires it through
  // a focus ref + onFocus/onBlur.
  if (plugin && typeof plugin.__nextBudgetText === 'function') {
    const next = plugin.__nextBudgetText
    check('client: a push while the budget input is focused keeps the draft',
      next('12', 4000, true) === '12', String(next('12', 4000, true)))
    check('client: a push while not focused adopts the committed value as text',
      next('12', 4000, false) === '4000', String(next('12', 4000, false)))
    check('client: the incoming value is always stringified (never a number)',
      typeof next('', 2000, false) === 'string' && next('', 2000, false) === '2000')
    check('client: an empty draft left alone while focused stays empty',
      next('', 800, true) === '', JSON.stringify(next('', 800, true)))
  } else {
    check('client: exposes __nextBudgetText for this test', false, 'missing export')
  }

  // i18n: the panel ships both locales from one dictionary pair. The lookup
  // chain falls back to zh, so a key missing from zh renders as the raw key;
  // a key missing from en silently degrades that user to Chinese. Placeholder
  // parity matters just as much: interpolate() only fills a name the template
  // actually contains, so an entry that drops {title} shows a half-rendered
  // string rather than a translated one.
  if (plugin && plugin.__strings && plugin.__ns) {
    const { zh, en } = plugin.__strings
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    check('i18n: zh and en dictionaries carry the identical key set',
      zhKeys.join(',') === enKeys.join(','),
      'only-zh=' + zhKeys.filter((k) => !(k in en)).join(',') + ' only-en=' + enKeys.filter((k) => !(k in zh)).join(','))
    check('i18n: the namespace is a non-empty dot-free identifier',
      typeof plugin.__ns === 'string' && plugin.__ns.length > 0 && !plugin.__ns.includes('.'),
      String(plugin.__ns))
    const names = (tpl) => Array.from(String(tpl).matchAll(/\{(\w+)\}/g)).map((m) => m[1]).sort().join(',')
    const drifted = zhKeys.filter((k) => names(zh[k]) !== names(en[k]))
    check('i18n: every key interpolates the same placeholders in both locales',
      drifted.length === 0,
      drifted.map((k) => k + ' zh=[' + names(zh[k]) + '] en=[' + names(en[k]) + ']').join('; '))
    check('i18n: the undo bar copy exists in both locales',
      ['undo.deleted', 'undo.restore', 'undo.dismiss', 'undo.restored'].every((k) => k in zh && k in en),
      'missing: ' + ['undo.deleted', 'undo.restore', 'undo.dismiss', 'undo.restored'].filter((k) => !(k in zh) || !(k in en)).join(','))

    // dictionaryT is the built-in translator that carries the panel until the
    // official locale service publishes — and forever on hosts without it.
    if (typeof plugin.__dictionaryT === 'function') {
      const tz = plugin.__dictionaryT('zh')
      const te = plugin.__dictionaryT('en')
      check('i18n: dictionaryT interpolates params in both locales',
        tz('undo.deleted', { title: 'X' }) === '已删除「X」' && te('undo.deleted', { title: 'X' }) === 'Deleted “X”',
        tz('undo.deleted', { title: 'X' }) + ' / ' + te('undo.deleted', { title: 'X' }))
      check('i18n: dictionaryT falls back to zh for a locale it does not ship',
        plugin.__dictionaryT('fr')('panel.title', {}) === zh['panel.title'])
      check('i18n: dictionaryT leaves an unfilled placeholder untouched',
        tz('undo.deleted', {}) === zh['undo.deleted'])
      check('i18n: a missing key surfaces as the key itself, never a blank',
        tz('no.such.key', {}) === 'no.such.key')
    } else {
      check('i18n: exposes __dictionaryT for this test', false, 'missing export')
    }
  } else {
    check('i18n: plugin exposes __strings and __ns for validation', false, 'missing exports')
  }

  // Undo bar lifetime: the delete offer must lapse on its own, so the TTL is
  // pinned here — a silently longer window resurrects long-dead entries, a
  // shorter one makes the button effectively unclickable.
  if (plugin && typeof plugin.__undoTtlMs === 'number') {
    check('client: undo TTL is 10 seconds', plugin.__undoTtlMs === 10000, String(plugin.__undoTtlMs))
  } else {
    check('client: exposes __undoTtlMs for this test', false, 'missing export')
  }
}

/* ------- Client half, second instance: an English browser ------- */

// The section label is resolved from the browser language at registration
// time, so the en fallback needs a fresh module instance — the query string
// busts the module cache (same file, distinct module record). Together with
// the zh pin above, both dictionary picks are now asserted, not assumed.
{
  captured = null
  const enRegistered = []
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US', languages: ['en-US', 'en'] },
    configurable: true,
  })
  globalThis.window.__ModuleLoader__.load = (spec) => { captured = spec }
  await import(CLIENT_URL + '?navigator=en-US')
  let enThrew = null
  try {
    const enPlugin = captured.factory(requireStub)
    enPlugin.apply({
      get: (name) => (name === 'slots'
        ? {
            inject: (key, callback) => { callback(); return () => {} },
            register: (options, render) => { enRegistered.push({ options, render }); return () => {} },
          }
        : undefined),
      effect: (fn) => { fn(); return () => {} },
    })
  } catch (err) {
    enThrew = err
  }
  check('client: an English browser gets the English label (regression: ambient Node navigator)',
    enThrew === null && enRegistered.length === 1
      && enRegistered[0].options.label === 'Instruction Memory',
    enThrew !== null ? enThrew.message
      : 'count=' + enRegistered.length + ' label=' + (enRegistered[0] && String(enRegistered[0].options.label)))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

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
// Per-process scratch home: two concurrent runs must not delete each other's
// store mid-write (see the same note in contract-test.mjs).
const SCRATCH_HOME = fileURLToPath(new URL('./.test-dsh-home-p' + process.pid + '/', import.meta.url))
const STORE_FILE = join(SCRATCH_HOME, 'instruction-memory', 'memory.json')
process.env.DSH_HOME = SCRATCH_HOME

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  // GitHub Actions annotation: surfaces the failing assertion on the public
  // check-run without needing log access.
  if (!ok) console.log('::error::' + label + (detail === undefined ? '' : ' | ' + String(detail).slice(0, 200)))
}

/**
 * Poll until `predicate` holds instead of trusting a fixed sleep: a loaded CI
 * runner can take longer than any constant for the async boot read to reach
 * section registration, and a fixed 60ms wait is what an ubuntu cell
 * occasionally lost to. Bounded at 5s; a timeout returns false and lets the
 * assertion report the actual state.
 */
const waitFor = async (predicate, deadlineMs = 5000) => {
  const start = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - start >= deadlineMs) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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

/* ---------------- shipped JSON Schema (F15) ---------------- */

// memory.schema.json is what a hand editor validates against, so it must agree
// with the loader EXACTLY: a schema advertising a larger limit than the code
// enforces would let a hand edit be silently truncated while the editor
// reported it as valid. The numbers are compared against the host's published
// LIMITS object rather than against literals, so both sides must move together.
{
  const schemaPath = new URL('./memory.schema.json', import.meta.url)
  let schema = null
  let threw = null
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  } catch (err) {
    threw = err
  }
  check('schema: memory.schema.json exists and parses', threw === null && schema !== null, threw && threw.message)

  check('schema: it is shipped in the package (files whitelist)',
    Array.isArray(PKG.files) && PKG.files.includes('memory.schema.json'), JSON.stringify(PKG.files))

  if (schema !== null) {
    const L = host.LIMITS
    check('schema: the host publishes its limits for this comparison',
      L !== null && typeof L === 'object' && typeof L.maxEntries === 'number', JSON.stringify(L))
    const props = schema.properties || {}
    const entryProps = (props.entries && props.entries.items && props.entries.items.properties) || {}
    const profileProps = (props.profiles && props.profiles.items && props.profiles.items.properties) || {}
    const setProps = (props.sets && props.sets.items && props.sets.items.properties) || {}
    const tagItems = (entryProps.tags && entryProps.tags.items) || {}
    const pairs = [
      ['version enum', props.version && props.version.enum, [1, L.formatVersion]],
      ['budgetChars.minimum', props.budgetChars && props.budgetChars.minimum, L.minBudget],
      ['budgetChars.maximum', props.budgetChars && props.budgetChars.maximum, L.maxBudget],
      ['backupDir.maxLength', props.backupDir && props.backupDir.maxLength, 512],
      ['sets.maxItems', props.sets && props.sets.maxItems, L.maxSets],
      ['sets name.maxLength', setProps.name && setProps.name.maxLength, L.maxSetName],
      ['entries.maxItems', props.entries && props.entries.maxItems, L.maxEntries],
      ['title.maxLength', entryProps.title && entryProps.title.maxLength, L.maxTitle],
      ['content.maxLength', entryProps.content && entryProps.content.maxLength, L.maxContent],
      ['when.maxLength', entryProps.when && entryProps.when.maxLength, L.maxWhen],
      ['priority enum', entryProps.priority && entryProps.priority.enum, [0, 1, 2]],
      ['mode enum', entryProps.mode && entryProps.mode.enum, ['always', 'auto']],
      ['tags.maxItems', entryProps.tags && entryProps.tags.maxItems, L.maxTagsPerEntry],
      ['tag.maxLength', tagItems.maxLength, L.maxTagLength],
      ['profiles.maxItems', props.profiles && props.profiles.maxItems, L.maxProfiles],
      ['profile name.maxLength', profileProps.name && profileProps.name.maxLength, L.maxProfileName],
      ['profile content.maxLength', profileProps.content && profileProps.content.maxLength, L.maxProfileContent],
    ]
    const drifted = pairs.filter(([, actual, want]) => JSON.stringify(actual) !== JSON.stringify(want))
    check('schema: every limit matches the code (no drift either way)',
      drifted.length === 0,
      drifted.map(([name, actual, want]) => name + ' schema=' + JSON.stringify(actual) + ' code=' + JSON.stringify(want)).join('; '))
    check('schema: it documents the $schema option it tells editors to use',
      props.$schema !== undefined, JSON.stringify(Object.keys(props).slice(0, 6)))
    check('schema: the F7 pause field is documented (optional integer, minimum 0)',
      props.disabledUntil !== undefined && props.disabledUntil.type === 'integer'
      && props.disabledUntil.minimum === 0,
      JSON.stringify(props.disabledUntil))
    check('schema: version 1 files still validate (no required setId)',
      !(entryProps.setId && entryProps.setId.required) && !(schema.required || []).includes('sets'),
      JSON.stringify(schema.required))
  }
}

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
  const store = STORE_FILE
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
  await waitFor(() => sections.length === 1)
  check('host: prompt section registers with NO web server at all', threw === null && sections.length === 1,
    'threw=' + (threw && threw.message) + ' sections=' + sections.length)
}

// Diagnostics must be LOG-ONLY. The plugin used to be silent on success, which
// made "is memory doing anything?" unanswerable from logs; the fix adds a mount
// line plus per-operation debug detail on the harness logger. The hard
// requirement is that none of it can change what gets injected — the same store
// must render byte-identically with and without a logger attached.
{
  const store = STORE_FILE
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
    await waitFor(() => sections.length === 1)
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
    // The real ceiling, straight from the Host, instead of a local copy of the
    // formula: a duplicated constant here silently stopped testing the gate the
    // day the Host's own derivation changed.
    const bodyCeiling = host.MAX_BODY_CHARS
    check('client: the gate is tested against the Host\'s own ceiling',
      typeof bodyCeiling === 'number' && bodyCeiling > 1000000, String(bodyCeiling))
    check('client: a normal export file passes the size gate',
      gate(3 * 1048576, bodyCeiling).ok === true)
    check('client: a maximal own export (≈4 MB pretty-printed) still passes',
      gate(4.2 * 1048576, bodyCeiling).ok === true)
    check('client: a clearly oversized file (50 MB) is refused with numbers in the message',
      (() => {
        const v = gate(50 * 1048576, bodyCeiling)
        const limitMb = Math.max(1, Math.round(bodyCeiling * 4 / 1048576))
        return v.ok === false && v.message.includes('50') && v.message.includes(String(limitMb))
      })(), JSON.stringify(gate(50 * 1048576, bodyCeiling)))
    check('client: the gate is disabled without a published ceiling (older Host)',
      gate(500 * 1048576, undefined).ok === true)
    check('client: the gate tolerates a missing size (non-File callers)',
      gate(NaN, bodyCeiling).ok === true && gate(undefined, bodyCeiling).ok === true)
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

  // F1 budget meter: the reducer that turns a snapshot's injection plan into
  // the header usage bar and the per-entry marks. Pinned here for the same
  // reason as nextBudgetText: it must survive older-host snapshots and bad
  // shapes without throwing inside a render.
  if (plugin && typeof plugin.__budgetMeter === 'function') {
    const meter = plugin.__budgetMeter
    const snap = (over) => ({
      data: { budgetChars: 4000 },
      injection: {
        registered: true, chars: 1000, budget: 800, activeCount: 3,
        included: [{ id: 'a', chars: 400, truncated: false }, { id: 'b', chars: 300, truncated: false }],
        omitted: [{ id: 'c', chars: 200 }],
      },
      ...over,
    })
    const m = meter(snap())
    check('client: meter prefers the plan budget over data.budgetChars',
      m.budget === 800, String(m.budget))
    check('client: meter reports used/omitted/truncated from the plan',
      m.used === 1000 && m.omitted === 1 && m.truncated === 0,
      JSON.stringify(m))
    check('client: meter percent is capped at 100 (used can equal, not exceed, budget)',
      m.percent === 100, String(m.percent))
    check('client: meter tokens are the documented 0.6 estimate',
      m.tokens === 600, String(m.tokens))
    const trunc = meter(snap({
      injection: {
        registered: true, chars: 400, budget: 800,
        included: [{ id: 'a', chars: 400, truncated: true }],
        omitted: [],
      },
    }))
    check('client: meter counts a truncated included entry',
      trunc.truncated === 1 && trunc.omitted === 0 && trunc.percent === 50,
      JSON.stringify(trunc))
    check('client: meter ignores malformed plan items',
      meter(snap({
        injection: { chars: 10, budget: 100, included: [null, 42, { id: '' }], omitted: [{ chars: 5 }] },
      })).omitted === 0)
    const oldHost = meter({ data: { budgetChars: 2000 }, injection: { registered: true, chars: 333 } })
    check('client: meter falls back to data.budgetChars on an older-host snapshot',
      oldHost.budget === 2000 && oldHost.used === 333 && oldHost.omitted === 0
      && oldHost.truncated === 0, JSON.stringify(oldHost))
    check('client: meter survives a null snapshot with all zeros',
      (() => { const g = meter(null); return g.budget === 0 && g.used === 0 && g.percent === 0 && g.tokens === 0 })())
    // A persona host reports chars for the WHOLE section but entryChars for
    // the budgeted instruction half; the meter must measure the latter so the
    // persona never inflates the instruction usage bar.
    const personaHost = meter({
      data: { budgetChars: 1000 },
      injection: { registered: true, chars: 1500, entryChars: 200, budget: 1000, included: [], omitted: [] },
    })
    check('client: meter uses entryChars (not whole-section chars) on a persona host',
      personaHost.used === 200 && personaHost.percent === 20 && personaHost.tokens === 120,
      JSON.stringify(personaHost))
  } else {
    check('client: exposes __budgetMeter for this test', false, 'missing export')
  }

  // F2 tag input: parse the free text the editor box commits into normalised
  // tag candidates. Pinned here because the Host applies the same limits
  // server-side, so the two normalisations must agree on shape.
  if (plugin && typeof plugin.__parseTagInput === 'function') {
    const parse = plugin.__parseTagInput
    const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want)
    check('client: tag parser splits on ASCII/full-width commas and semicolons',
      eq(parse('a,b，c;d；e'), ['a', 'b', 'c', 'd', 'e']), JSON.stringify(parse('a,b，c;d；e')))
    check('client: tag parser splits on newlines but keeps spaces inside a tag',
      eq(parse('code style\nreview'), ['code style', 'review']), JSON.stringify(parse('code style\nreview')))
    check('client: tag parser trims and drops empty pieces',
      eq(parse(' a , ,b, '), ['a', 'b']), JSON.stringify(parse(' a , ,b, ')))
    check('client: tag parser collapses internal whitespace runs',
      eq(parse('a    b'), ['a b']), JSON.stringify(parse('a    b')))
    check('client: tag parser de-duplicates after trimming',
      eq(parse('x, x ,x'), ['x']), JSON.stringify(parse('x, x ,x')))
    check('client: tag parser caps at 8 tags',
      parse('1,2,3,4,5,6,7,8,9,10').length === 8,
      String(parse('1,2,3,4,5,6,7,8,9,10').length))
    check('client: tag parser cuts one tag to 24 characters',
      parse('t'.repeat(40))[0].length === 24, String(parse('t'.repeat(40))[0].length))
    check('client: tag parser tolerates non-string input',
      eq(parse(null), []) && eq(parse(undefined), []))
  } else {
    check('client: exposes __parseTagInput for this test', false, 'missing export')
  }

  // F17 local preview: the heuristic is pure, so its behaviour is pinnable —
  // and it has to stay LOCAL (no fetch, no host call) to be honest about what
  // it is: a literal keyword overlap, never the model's judgement.
  if (plugin && typeof plugin.__relevancePreview === 'function' && typeof plugin.__relevanceTerms === 'function') {
    const terms = plugin.__relevanceTerms
    const preview = plugin.__relevancePreview
    check('client: terms split a latin phrase into words',
      JSON.stringify(terms('edit the config file')), (v) => v === JSON.stringify(['edit', 'the', 'config', 'file']),
      JSON.stringify(terms('edit the config file')))
    check('client: terms drop single characters and punctuation',
      JSON.stringify(terms('a, b? c#d')), (v) => v === JSON.stringify(['cd']), JSON.stringify(terms('a, b? c#d')))
    check('client: a CJK run becomes 2- and 3-character grams',
      (() => { const t2 = terms('配置文件'); return t2.includes('配置') && t2.includes('置文') && t2.includes('文件') && t2.includes('配置文') })(),
      JSON.stringify(terms('配置文件')))
    check('client: a short CJK run is also kept whole',
      terms('改配置').includes('改配置'), JSON.stringify(terms('改配置')))
    check('client: terms are capped so a pasted paragraph cannot explode',
      terms('前缀'.repeat(200)).length, (v) => v <= 40, String(terms('前缀'.repeat(200)).length))
    check('client: an empty or non-string query yields no terms',
      terms('') .length === 0 && terms('   ').length === 0 && terms(null).length === 0 && terms(undefined).length === 0)

    const entry = (over) => ({ id: 'e', title: 'T', content: 'C', mode: 'auto', when: '', priority: 1, enabled: true, ...over })
    const scored = preview([
      entry({ id: 'hit', title: '配置文件规则', content: '关于配置' }),
      entry({ id: 'miss', title: '聊天风格', content: '简短' }),
      entry({ id: 'always', title: '配置文件', content: '配置', mode: 'always' }),
    ], '帮我修改配置文件')
    check('client: only 按需 entries are scored (始终 entries never appear)',
      scored.results.every((hit) => hit.id !== 'always')
      && scored.autoTotal === 2, JSON.stringify(scored.results))
    check('client: a literal overlap is found and ranked above the miss',
      scored.results.length === 1 && scored.results[0].id === 'hit',
      JSON.stringify(scored.results))
    check('client: the hit carries a level, the matched terms and a when-empty flag',
      ['high', 'mid', 'low'].includes(scored.results[0].level)
      && Array.isArray(scored.results[0].terms) && scored.results[0].terms.length > 0
      && scored.results[0].whenEmpty === true,
      JSON.stringify(scored.results[0]))
    check('client: a scenario match outranks the same term in the body',
      (() => {
        const viaWhen = preview([entry({ id: 'w', when: '编写配置文件时' })], '配置文件')
        const viaBody = preview([entry({ id: 'b', content: '关于配置文件的一切' })], '配置文件')
        return viaWhen.results[0].score > viaBody.results[0].score
      })())
    check('client: an empty query scores nothing (and is not an error)',
      preview([entry({})], '').results.length === 0)
    check('client: junk input degrades to an empty result instead of throwing',
      preview(null, 'x').results.length === 0 && preview([null, 42, {}], 'x').results.length === 0)
    check('client: the ranking is deterministic',
      JSON.stringify(preview([entry({ id: 'a', title: '配置' }), entry({ id: 'b', title: '文件配置' })], '配置文件'))
      === JSON.stringify(preview([entry({ id: 'a', title: '配置' }), entry({ id: 'b', title: '文件配置' })], '配置文件')))
  } else {
    check('client: exposes __relevancePreview and __relevanceTerms for this test', false, 'missing exports')
  }

  // F16 source mode: the live verdict is ADVISORY (the authoritative answer
  // comes from the save), but it must catch the cheap mistakes without a round
  // trip and never throw on junk.
  if (plugin && typeof plugin.__sourceParseVerdict === 'function') {
    const verdict = plugin.__sourceParseVerdict
    const valid = verdict(JSON.stringify({ version: 2, entries: [{ title: 'a' }], profiles: [{ name: 'n' }] }, null, 2))
    check('client: a well-formed source is accepted and summarised',
      valid.ok === true && valid.message.includes('1 条指令') && valid.message.includes('1 个形象')
      && valid.message.includes('1 个配置集'),
      JSON.stringify(valid))
    check('client: an empty document is reported as empty',
      verdict('').ok === false && verdict('   ').ok === false)
    check('client: broken JSON is reported with the parser detail',
      (() => { const v = verdict('{ "a": }'); return v.ok === false && v.message.includes('JSON') })(),
      JSON.stringify(verdict('{ "a": }')))
    check('client: a non-object document is refused',
      verdict('[1,2]').ok === false && verdict('42').ok === false && verdict('null').ok === false)
    check('client: a source with no sets counts as one implicit set',
      verdict('{"entries":[]}').ok === true && verdict('{"entries":[]}').message.includes('1 个配置集'),
      JSON.stringify(verdict('{"entries":[]}')))
    check('client: past the size ceiling the live parse pauses (saving still guards)',
      (() => {
        const v = verdict('x'.repeat(600), 100)
        return v.ok === false && v.paused === true
      })(), JSON.stringify(verdict('x'.repeat(600), 100)))
  } else {
    check('client: exposes __sourceParseVerdict for this test', false, 'missing export')
  }

  // F12 diagnostics dump: the text an issue report carries. The contract is
  // fixed here: operational fields present, reporter environment present, and
  // NEVER any user text (entry titles, entry bodies, persona content) — the
  // preview field in the snapshot is deliberately poisoned with a secret to
  // prove the dump ignores it.
  if (plugin && typeof plugin.__diagnosticsText === 'function') {
    const dump = plugin.__diagnosticsText
    const diagSnap = {
      data: {
        version: 2, rev: 7, enabled: true, budgetChars: 4000, disabledUntil: 0,
        activeSetId: 'st-default',
        sets: [{ id: 'st-default', name: '默认' }],
        entries: [{ id: 'e1', title: 'DIAG-SECRET-TITLE', content: 'DIAG-SECRET-ENTRY-BODY', mode: 'always', when: '', priority: 1, enabled: true, tags: [], setId: 'st-default', updatedAt: 1 }],
        profiles: [{ id: 'p1', name: 'DIAG-SECRET-NAME', content: 'DIAG-SECRET-PROFILE-BODY', enabled: true, setId: 'st-default', updatedAt: 1 }],
      },
      sets: { activeId: 'st-default', scoped: true, total: { entries: 1, profiles: 1 }, list: [] },
      storage: {
        path: 'C:/demo/instruction-memory/memory.json', error: null, warning: 'DIAG-WARNING',
        savedAt: 1700000000000, migratedFrom: null, onDisk: true, backupDir: '',
        isDefaultBackupDir: true, backupPath: 'C:/demo/instruction-memory/memory.json.bak',
        historyDir: 'C:/demo/instruction-memory/history', historyCount: 2, historyError: null,
        schemaFile: 'C:/demo/instruction-memory/memory.schema.json',
      },
      injection: { registered: true, available: true, error: null, muted: false, chars: 120, budget: 4000, pulls: 3 },
      security: { hostGuarded: true, boundHost: '127.0.0.1' },
      diagnostics: { loadedFrom: 'adopted store file', rev: 7 },
      preview: 'DIAG-SECRET-ENTRY-BODY',
      limits: {},
    }
    const diagText = dump(diagSnap, { userAgent: 'DIAG-UA', language: 'zh-CN', now: '2026-01-01T00:00:00.000Z' })
    check('diagnostics: the dump carries the operational fields',
      diagText.includes('dsh-instruction-memory diagnostics')
      && diagText.includes('rev: 7') && diagText.includes('registered: true')
      && diagText.includes('pulls(since boot): 3')
      && diagText.includes('hostGuarded: true') && diagText.includes('boundHost: 127.0.0.1')
      && diagText.includes('loadedFrom: adopted store file')
      && diagText.includes('memory.json.bak') && diagText.includes('DIAG-WARNING'),
      diagText.slice(0, 200))
    check('diagnostics: the dump carries the reporter environment',
      diagText.includes('userAgent: DIAG-UA') && diagText.includes('language: zh-CN')
      && diagText.includes('time: 2026-01-01T00:00:00.000Z'))
    check('diagnostics: the dump never carries entry or persona text (not even via preview)',
      !diagText.includes('DIAG-SECRET-TITLE') && !diagText.includes('DIAG-SECRET-ENTRY-BODY')
      && !diagText.includes('DIAG-SECRET-NAME') && !diagText.includes('DIAG-SECRET-PROFILE-BODY'),
      diagText)
    check('diagnostics: junk input degrades to a labelled dump instead of throwing',
      (() => { const bare = dump(null, null); return typeof bare === 'string' && bare.includes('dsh-instruction-memory diagnostics') })())
  } else {
    check('client: exposes __diagnosticsText for this test', false, 'missing export')
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
    check('i18n: the F1 budget meter copy exists in both locales',
      ['budget.used', 'budget.omitted', 'tag.omitted', 'tag.truncated', 'tag.omittedTitle', 'tag.truncatedTitle']
        .every((k) => k in zh && k in en),
      'missing: ' + ['budget.used', 'budget.omitted', 'tag.omitted', 'tag.truncated', 'tag.omittedTitle', 'tag.truncatedTitle']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F2/F3 filter/bulk copy exists in both locales',
      ['tags.label', 'tags.placeholder', 'tags.hint', 'filter.all', 'filter.mode', 'filter.status',
        'sort.priority', 'sort.updated', 'sort.title', 'action.batch', 'batch.exit', 'batch.selectAll',
        'batch.selected', 'batch.enable', 'batch.disable', 'batch.priority', 'batch.addTags', 'batch.delete',
        'batch.confirmDelete', 'batch.tagPrompt', 'batch.noneSelected', 'list.filteredEmpty']
        .every((k) => k in zh && k in en),
      'missing: ' + ['tags.label', 'filter.all', 'sort.priority', 'action.batch', 'batch.delete', 'list.filteredEmpty']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the user-persona copy exists in both locales',
      ['profiles.section', 'profiles.subtitle', 'profiles.new', 'profiles.name', 'profiles.content',
        'profiles.use', 'profiles.untitled', 'profiles.confirmDelete', 'profiles.empty',
        'profiles.count', 'profiles.chars', 'profiles.saving']
        .every((k) => k in zh && k in en),
      'missing: ' + ['profiles.section', 'profiles.new', 'profiles.use', 'profiles.count', 'profiles.chars']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F13 instruction-set copy exists in both locales',
      ['sets.section', 'sets.note', 'sets.total', 'sets.activeHint', 'sets.create', 'sets.rename',
        'sets.duplicate', 'sets.delete', 'sets.nameLabel', 'sets.namePlaceholder', 'sets.confirm',
        'sets.nameEmpty', 'sets.itemMeta', 'sets.activeBadge', 'sets.switch', 'sets.switchHint',
        'sets.copySuffix', 'sets.deleteConfirm', 'sets.deleteActive']
        .every((k) => k in zh && k in en),
      'missing: ' + ['sets.section', 'sets.create', 'sets.switch', 'sets.itemMeta', 'sets.deleteConfirm']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F14 version-history copy exists in both locales',
      ['history.section', 'history.subtitle', 'history.show', 'history.hide', 'history.count',
        'history.loading', 'history.empty', 'history.itemMeta', 'history.itemMetaLite', 'history.foreign',
        'history.restore', 'history.restoreConfirm', 'history.delete', 'history.deleteConfirm', 'history.dir',
        'action.restore', 'restore.hint', 'restore.confirm']
        .every((k) => k in zh && k in en),
      'missing: ' + ['history.section', 'history.restore', 'history.dir', 'action.restore']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F16 source-mode copy exists in both locales',
      ['source.mode', 'source.exit', 'source.section', 'source.subtitle', 'source.save', 'source.reload',
        'source.valid', 'source.invalid', 'source.empty', 'source.notObject', 'source.keepDraft',
        'source.reloadConfirm', 'source.editorOpen', 'source.truncatedInput']
        .every((k) => k in zh && k in en),
      'missing: ' + ['source.mode', 'source.save', 'source.invalid', 'source.keepDraft']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F17 preview copy exists in both locales',
      ['sim.title', 'sim.toggle', 'sim.hide', 'sim.disclaimer', 'sim.placeholder', 'sim.hint',
        'sim.levelHigh', 'sim.levelMid', 'sim.levelLow', 'sim.matched', 'sim.noWhen', 'sim.none',
        'sim.onlyAuto', 'sim.summary', 'sim.omitted']
        .every((k) => k in zh && k in en),
      'missing: ' + ['sim.title', 'sim.disclaimer', 'sim.levelHigh', 'sim.summary']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F18 backup-location copy exists in both locales',
      ['backup.section', 'backup.label', 'backup.placeholder', 'backup.apply', 'backup.exportToDir',
        'backup.hint', 'backup.multiDevice']
        .every((k) => k in zh && k in en),
      'missing: ' + ['backup.section', 'backup.label', 'backup.apply', 'backup.hint']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F12 diagnostics copy exists in both locales',
      ['diag.section', 'diag.show', 'diag.hide', 'diag.copy', 'diag.copied', 'diag.copyManual',
        'diag.hostWarn', 'diag.groupStorage', 'diag.groupInjection', 'diag.groupBackup',
        'diag.groupIssues', 'diag.none', 'diag.storagePath', 'diag.onDisk', 'diag.loadedFrom',
        'diag.savedAt', 'diag.rev', 'diag.registered', 'diag.yes', 'diag.no', 'diag.pulls',
        'diag.chars', 'diag.backupDir', 'diag.backupDefault', 'diag.backupPath', 'diag.historyDir',
        'diag.historyCount', 'diag.schemaFile', 'diag.issueStorage', 'diag.issueWarning',
        'diag.issueHistory', 'diag.issueSection']
        .every((k) => k in zh && k in en),
      'missing: ' + ['diag.section', 'diag.hostWarn', 'diag.pulls', 'diag.issueSection']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    check('i18n: the F7 temporary-mute copy exists in both locales',
      ['mute.menu', 'mute.30m', 'mute.1h', 'mute.today', 'mute.resume', 'mute.active',
        'mute.hint', 'mute.remainingMs', 'mute.remainingH']
        .every((k) => k in zh && k in en),
      'missing: ' + ['mute.menu', 'mute.resume', 'mute.active', 'mute.remainingH']
        .filter((k) => !(k in zh) || !(k in en)).join(','))
    // The one wording rule this feature must not soften: the local preview has
    // to SAY it is not the model's judgement, in both locales.
    check('i18n: the preview disclaimer states it is not the model\'s judgement',
      zh['sim.disclaimer'].includes('模型的真实判断')
      && (zh['sim.disclaimer'].includes('≠') || zh['sim.disclaimer'].includes('不是'))
      && /NOT the model/i.test(en['sim.disclaimer']),
      zh['sim.disclaimer'].slice(0, 40) + ' / ' + en['sim.disclaimer'].slice(0, 40))

    // The dictionaries having the same KEY SET is not enough: a key the panel
    // actually calls but neither dictionary declares renders as the raw key at
    // runtime ("sets.itemMeta" on screen), and the key-set check above would
    // still pass. Every statically reachable t('…') call site is therefore
    // resolved against both dictionaries, from the source text.
    {
      const clientSource = readFileSync(fileURLToPath(CLIENT_URL), 'utf8')
      const used = new Set(Array.from(clientSource.matchAll(/\bt\(\s*'([^']+)'/g)).map((m) => m[1]))
      const missingZhKeys = Array.from(used).filter((key) => !(key in zh))
      const missingEnKeys = Array.from(used).filter((key) => !(key in en))
      check('i18n: every t(\'…\') call site exists in both dictionaries',
        used.size > 100 && missingZhKeys.length === 0 && missingEnKeys.length === 0,
        'call sites=' + used.size + ' missing-zh=' + missingZhKeys.join(',') + ' missing-en=' + missingEnKeys.join(','))
      // A key nothing calls is dead weight (or a half-finished feature). Two
      // tags.* keys predate this check and are kept deliberately.
      const allowedUnused = new Set(['tags.duplicate', 'tags.full'])
      const unusedKeys = Object.keys(zh).filter((key) => !used.has(key) && !allowedUnused.has(key))
      check('i18n: no dictionary key is left unused (dead copy)',
        unusedKeys.length === 0, unusedKeys.join(','))
    }

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

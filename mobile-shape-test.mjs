/**
 * Mobile-shape tests (1.6.4): the two client behaviours that decide whether
 * DSH Go (Android + WebView island) can export and delete at all.
 *
 * They exist because every "Android" branch in lib/client.js was unreachable
 * from the test suite: `grep isAndroidWebView|DshGoIsland` matched nothing in
 * any *.mjs, while two of those branches were silently wrong in opposite
 * directions —
 *
 *   - `window.confirm` in the WebView is a function that never shows anything
 *     and returns false, which the panel read as "the user pressed Cancel", so
 *     delete / import / restore were no-ops with no message;
 *   - the island bridge was chunked at 6000 CODE UNITS against a 16 KB BYTE
 *     ceiling, so a 6000-character CJK chunk serialised to 18098 bytes.
 *
 * No Android device is involved: both are pure functions of text and of the
 * ambient `window`/`navigator`, which this file replaces.
 */

import { existsSync, readFileSync } from 'node:fs'

let failures = 0
function check(name, actual, detail) {
  if (actual) {
    console.log('PASS  ' + name)
  } else {
    failures += 1
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail))
  }
}

const clientPath = new URL('./lib/client.js', import.meta.url)
if (!existsSync(clientPath)) {
  console.log('SKIP  lib/client.js is not present in this checkout')
  console.log('\nSKIPPED')
  process.exit(0)
}

/**
 * lib/client.js is the browser module-loader format (`__ModuleLoader__.load`),
 * so it needs the same half-browser the other suites build: a loader that
 * captures the spec, a React stub, and a navigator whose userAgent THIS file
 * controls (Node ≥ 21 ships its own read-only navigator).
 */
const captured = { spec: null }
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
}
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured.spec = spec } },
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
}
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', languages: ['zh-CN', 'zh'], userAgent: 'node-test' },
  configurable: true,
  writable: true,
})

await import(clientPath.href + '?mobile=' + Date.now())
if (captured.spec === null || typeof captured.spec.factory !== 'function') {
  console.log('FAIL  the client bundle did not register through __ModuleLoader__')
  console.log('\n1 FAILED')
  process.exit(1)
}
const plugin = captured.spec.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error('unexpected require: ' + id)
})
const { __splitByBytes, __splitForBridge, __confirmDialogsAreTrustworthy, __askConfirm, __islandChunkBytes, __islandFrameLimit, __hasIslandBridge } = plugin

check('the client exposes the byte splitter', typeof __splitByBytes === 'function')
check('the client exposes the dialog probe', typeof __confirmDialogsAreTrustworthy === 'function')
check('the island ceiling is a positive byte budget', typeof __islandChunkBytes === 'number' && __islandChunkBytes >= 1024,
  String(__islandChunkBytes))

/* ---------------- island chunking: bytes, not code units ---------------- */

{
  // The ceiling the shell enforces (`IslandMessageLimits.maxBytes` = 16 KB).
  const BRIDGE_LIMIT = 16 * 1024
  // What the bridge serialises per message, minus the payload: t/id/name/last.
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ t: 'save', id: 'im-abcdefgh', name: 'dsh-instruction-memory-2026-11-21.json', data: '', last: false }))

  const cjk = '记'.repeat(6000)
  const chunks = __splitByBytes(cjk)
  check('6000 CJK characters split into more than one chunk', chunks.length > 1, String(chunks.length))
  check('6000-character CJK text never exceeds the bridge ceiling per message',
    chunks.every((chunk) => envelopeBytes + Buffer.byteLength(JSON.stringify(chunk)) - 2 <= BRIDGE_LIMIT),
    'max=' + Math.max(...chunks.map((chunk) => envelopeBytes + Buffer.byteLength(JSON.stringify(chunk)) - 2)))
  check('the chunks reassemble byte-for-byte', chunks.join('') === cjk)

  // The old constant: 6000 code units of CJK is 18098 bytes, 1714 over.
  const legacy = JSON.stringify({ t: 'save', id: 'im-abcdefgh', name: 'x.json', data: cjk, last: false })
  check('the old 6000-code-unit chunk really was over the ceiling (regression guard)',
    Buffer.byteLength(legacy) > BRIDGE_LIMIT,
    Buffer.byteLength(legacy) + ' bytes')

  // A surrogate pair / emoji must never be torn across two messages.
  const emoji = '😀'.repeat(4000)
  const emojiChunks = __splitByBytes(emoji)
  check('emoji text reassembles exactly', emojiChunks.join('') === emoji)
  check('no chunk splits a surrogate pair',
    emojiChunks.every((chunk) => {
      const firstCode = chunk.charCodeAt(0)
      const lastCode = chunk.charCodeAt(chunk.length - 1)
      return !(lastCode >= 0xd800 && lastCode <= 0xdbff)
        && !(firstCode >= 0xdc00 && firstCode <= 0xdfff)
    }))
  check('no chunk exceeds the budget in bytes',
    emojiChunks.every((chunk) => Buffer.byteLength(chunk) <= __islandChunkBytes))

  check('ASCII still splits under the same budget',
    __splitByBytes('a'.repeat(40000)).every((chunk) => Buffer.byteLength(chunk) <= __islandChunkBytes))
  check('an empty document yields no messages', __splitByBytes('').length === 0)
  check('a document smaller than the budget stays one message', __splitByBytes('short').length === 1)
  check('a non-string argument yields no messages', __splitByBytes(null).length === 0)
}

/* ---------------- island FRAMES: escaped cost, not raw bytes ---------------- */

// R3 (1.6.5). The shell counts `raw.length` — UTF-16 units of the DECODED JSON
// string (`island_messages.dart`). A raw-byte budget therefore under-counts
// escaping: `"` and `\` cost two units each, a C0 control six. Measured with the
// 1.6.4 splitter: quotes/backslashes/newlines produced 24678-unit frames and a
// control-character payload 73830 — all past the 16384 ceiling, so the app
// would drop or truncate them and the reassembled file would be broken.
{
  const LIMIT = __islandFrameLimit
  const name = 'dsh-instruction-memory-2026-11-25.json'
  const id = 'im-abcdefgh'
  const frameOf = (chunk) => JSON.stringify({ t: 'save', id, name, data: chunk, last: false }).length
  const cases = [
    ['quotes', '"'.repeat(20000)],
    ['backslashes', '\\'.repeat(20000)],
    ['newlines', '\n'.repeat(20000)],
    ['control characters', '\u0001'.repeat(20000)],
    ['a realistic config snippet', '{\n  "a": "C:\\\\tmp\\\\x",\n  "b": "she said \\"hi\\""\n}\n'.repeat(400)],
    ['CJK', '记'.repeat(20000)],
    ['emoji', '😀'.repeat(8000)],
  ]
  for (const [label, text] of cases) {
    const chunks = __splitForBridge(text, name, id)
    const worst = chunks.reduce((max, chunk) => Math.max(max, frameOf(chunk)), 0)
    check('island frame for ' + label + ' stays under the shell ceiling',
      chunks.length > 0 && worst <= LIMIT, 'worst=' + worst + ' limit=' + LIMIT + ' chunks=' + chunks.length)
    check('island chunks for ' + label + ' reassemble byte-for-byte', chunks.join('') === text)
  }
  // The 1.6.4 budget really was unsafe: prove the regression guard is real.
  const legacyWorst = __splitByBytes('"'.repeat(20000), __islandChunkBytes)
    .reduce((max, chunk) => Math.max(max, frameOf(chunk)), 0)
  check('the old raw-byte budget really did overflow the ceiling (regression guard)',
    legacyWorst > LIMIT, 'legacyWorst=' + legacyWorst)

  // …and the bridge must actually USE the escaped-cost splitter. Testing the
  // helper alone would stay green while sendToAppBridge went back to raw bytes,
  // which is exactly how the 1.6.4 bug survived its own tests.
  const clientSource = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
  check('sendToAppBridge chunks with splitForBridge (not the raw-byte helper)',
    /const chunks = splitForBridge\(/.test(clientSource)
    && !/const chunks = splitByBytes\(/.test(clientSource))
}

/* ---------------- a bridge stub is not a bridge ---------------- */

// S3 (1.6.5): the probe used to accept `window.DshGoIsland = {}`, which any
// script — or another plugin sharing this settings page — can set. The mobile
// branch (no blob export, feedback replaced by a note, confirmations moved into
// the panel) must require a callable postMessage, the same test sendToAppBridge
// already applied.
{
  const savedWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    value: { confirm: () => true, DshGoIsland: {} },
    configurable: true,
    writable: true,
  })
  check('a bridge stub without postMessage is not a bridge', __hasIslandBridge() === false)
  check('a bridge stub does not flip the dialog probe', __confirmDialogsAreTrustworthy() === true)
  Object.defineProperty(globalThis, 'window', {
    value: { confirm: () => true, DshGoIsland: { postMessage() {} } },
    configurable: true,
    writable: true,
  })
  check('a callable bridge is a bridge', __hasIslandBridge() === true)
  check('a callable bridge makes dialogs untrustworthy', __confirmDialogsAreTrustworthy() === false)
  Object.defineProperty(globalThis, 'window', { value: savedWindow, configurable: true, writable: true })
}

/* ---------------- confirm: "no dialog" must not read as "no" ---------------- */

{
  const setWindow = (value) => {
    Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true })
  }
  const setUa = (ua) => {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true })
  }
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
  const WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36; wv)'

  // A real dialog on a plain browser.
  setUa(DESKTOP_UA)
  setWindow({ confirm: () => true })
  check('a plain browser with a working dialog is trusted', __confirmDialogsAreTrustworthy() === true)
  check('a plain browser: confirm(true) is a yes', __askConfirm('?') === 'yes')
  setWindow({ confirm: () => false })
  check('a plain browser: confirm(false) is a deliberate no', __askConfirm('?') === 'no')

  // The DSH Go shape: the function exists, answers false, shows nothing.
  setUa(WEBVIEW_UA)
  setWindow({ confirm: () => false })
  check('the Android WebView is NOT trusted even though confirm exists',
    __confirmDialogsAreTrustworthy() === false)
  check('the Android WebView answers "unavailable", never "no"',
    __askConfirm('?') === 'unavailable', String(__askConfirm('?')))
  check('the same surface still allows the unsaved-draft fallback',
    __askConfirm('?', 'allow') === 'yes')

  // The bridge is the second, protocol-level signal (a custom UA that still
  // ships the island must not be mistaken for a desktop browser).
  setUa(DESKTOP_UA)
  setWindow({ confirm: () => false, DshGoIsland: { postMessage() {} } })
  check('an injected DshGoIsland bridge is not trusted either', __confirmDialogsAreTrustworthy() === false)
  check('an injected bridge answers "unavailable"', __askConfirm('?') === 'unavailable')

  // Missing / throwing dialogs (the Electron 44 prompt pattern).
  setWindow({})
  check('a missing confirm is unavailable', __askConfirm('?') === 'unavailable')
  setWindow({ confirm: () => { throw new Error('not supported') } })
  check('a throwing confirm is unavailable, not a crash', __askConfirm('?') === 'unavailable')
  check('no window at all is unavailable', (() => {
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true })
    return __askConfirm('?') === 'unavailable'
  })())
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

/**
 * Section-order contract test: keep the injected block's placement honest.
 *   node section-order-test.mjs
 *
 * Why this exists (the bug it prevents):
 *
 * `lib/index.js` places the instruction block at `SECTION_ORDER = 950` — a
 * number borrowed from the host's own `SECTION_ORDERS` table, chosen because
 * 900 (FILE_REFERENCE) and 1000 (TOOL_BASH) left a gap there. The plugin only
 * borrows it; the host owns it. If a host release fills 950, or moves either
 * anchor, the plugin keeps loading normally and the block silently lands
 * somewhere else in the assembled prompt. Ordering contracts break without an
 * error — which is precisely why this one is asserted instead of trusted.
 *
 * Two earlier incidents make the point: through 1.0.8 the value was 900, an
 * exact tie with FILE_REFERENCE that only sorted correctly by accident of the
 * section name; and the whole `950` reasoning is pinned to a table read on
 * `0.1.7-rc.2`. Both are facts about a specific host, so this test reads the
 * table from whatever host is actually installed here — profile tree first,
 * then the desktop `app.asar` — never from a copy pasted into this file.
 *
 * Prints SKIP when no host is installed (bare checkout, CI), because there is
 * nothing to compare against; it never prints a green it cannot justify.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/* ---------------- the value this plugin declares ---------------- */

const pluginSource = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
const declaredMatch = /\nconst SECTION_ORDER = (\d+)\n/.exec(pluginSource)
const declared = declaredMatch === null ? null : Number(declaredMatch[1])
check('lib/index.js still declares a numeric SECTION_ORDER', declared !== null,
  'the declaration moved or changed shape; update this test rather than deleting it')

/* ---------------- locate a host that can be read ---------------- */

const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME.trim())
  : join(homedir(), '.dsh')

const SYSTEM_PROMPT_TAIL = join('@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')

/** Every visible profile's tree, then the shared one. */
function profileCandidates() {
  const out = []
  const profilesDir = join(DSH_HOME, 'profiles')
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(join(profilesDir, entry.name, 'node_modules', SYSTEM_PROMPT_TAIL))
    }
  } catch {
    // No profiles directory: the candidates below still apply.
  }
  out.push(join(profilesDir, 'node_modules', SYSTEM_PROMPT_TAIL))
  return out
}

/** Desktop installs keep the host inside app.asar. */
function desktopAsarCandidates() {
  const out = []
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    const programs = join(localAppData, 'Programs')
    try {
      for (const name of readdirSync(programs).sort()) {
        if (!/harness|deepseek/i.test(name)) continue
        out.push(join(programs, name, 'resources', 'app.asar'))
      }
    } catch {
      // Not a Windows desktop install.
    }
  }
  out.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  return out
}

/**
 * Read one file out of an Electron asar archive.
 *
 * The format is a fixed header: 16 bytes of pickle framing (sizes), then the
 * JSON directory, then the payload at `8 + headerPickleSize`. Only the two
 * numbers this needs are decoded; anything unexpected returns null so the
 * caller can fall through to the next candidate instead of throwing.
 */
function readFromAsar(archivePath, relativePath, cache) {
  const key = archivePath + '\u0000' + relativePath
  if (cache.has(key)) return cache.get(key)
  let result = null
  try {
    const handle = readFileSync(archivePath, { flag: 'r' })
    if (handle.length < 16) throw new Error('short archive')
    const headerPickleSize = handle.readUInt32LE(4)
    const stringLength = handle.readUInt32LE(12)
    const directory = JSON.parse(handle.subarray(16, 16 + stringLength).toString('utf8'))
    let node = directory
    for (const segment of relativePath.split('/')) {
      node = node?.files?.[segment]
      if (node === undefined) break
    }
    if (node === undefined || node.files !== undefined || typeof node.offset !== 'number') {
      throw new Error('not a file entry')
    }
    const start = 8 + headerPickleSize + Number(node.offset)
    result = handle.subarray(start, start + Number(node.size)).toString('utf8')
  } catch {
    result = null
  }
  cache.set(key, result)
  return result
}

const asarCache = new Map()
const ASAR_MEMBER = 'dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'

function loadHostSystemPromptSource() {
  for (const path of profileCandidates()) {
    if (!existsSync(path)) continue
    try {
      return { source: readFileSync(path, 'utf8'), where: path }
    } catch {
      // try the next candidate
    }
  }
  for (const archive of desktopAsarCandidates()) {
    if (!existsSync(archive)) continue
    const text = readFromAsar(archive, ASAR_MEMBER, asarCache)
    if (typeof text === 'string' && text !== '') return { source: text, where: archive + '!' + ASAR_MEMBER }
  }
  return null
}

/* ---------------- parse the host's table ---------------- */

/**
 * `SECTION_ORDERS` is a plain object literal of NAME: number pairs in every
 * host release checked so far. Parse it as text rather than importing it: the
 * module is ESM with its own dependencies, and requiring the real thing would
 * make this test fail on a host whose internals differ instead of reporting
 * the ordering fact it exists to report.
 */
function parseSectionOrders(source) {
  const start = source.indexOf('SECTION_ORDERS')
  if (start === -1) return null
  const open = source.indexOf('{', start)
  if (open === -1) return null
  // Walk to the matching brace so a nested object cannot truncate the scan.
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) return null
  const body = source.slice(open + 1, end)
  const table = {}
  // Host releases spell the values differently: 0.2.2 writes `TOOL_BASH: 1e3`
  // and `HARNESS_SOURCE: 1e4` where 0.1.7 wrote plain integers. Accept both, or
  // this test reports "TOOL_BASH = 1" and fails for a reason that is not real.
  for (const match of body.matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-fA-F]+)/g)) {
    table[match[1]] = Number(match[2])
  }
  return Object.keys(table).length === 0 ? null : table
}

const host = loadHostSystemPromptSource()
if (host === null) {
  console.log('SKIP  no installed host exposes @deepseek-ai/dsh-system-prompt (bare checkout or CI)')
  console.log('\nALL PASS (skipped)')
  process.exit(0)
}

const table = parseSectionOrders(host.source)
check('the installed host exposes a parseable SECTION_ORDERS table', table !== null,
  'read from ' + host.where + '; the table moved or changed shape — update parseSectionOrders()')

if (table !== null && declared !== null) {
  const anchors = { FILE_REFERENCE: 900, TOOL_BASH: 1000 }
  for (const [name, expected] of Object.entries(anchors)) {
    check('the host still places ' + name + ' at ' + expected, table[name] === expected,
      name + ' = ' + String(table[name]) + ' in ' + host.where)
  }

  const occupants = Object.entries(table).filter(([, value]) => value === declared)
  check('SECTION_ORDER ' + declared + ' is not occupied by a host section', occupants.length === 0,
    'taken by ' + occupants.map(([name]) => name).join(', ') + ' — move SECTION_ORDER to a free gap')

  const below = Object.entries(table)
    .filter(([, value]) => value < declared)
    .sort((left, right) => right[1] - left[1])[0]
  const above = Object.entries(table)
    .filter(([, value]) => value > declared)
    .sort((left, right) => left[1] - right[1])[0]

  check('SECTION_ORDER ' + declared + ' sits strictly between ' + anchors.FILE_REFERENCE
    + ' (FILE_REFERENCE) and ' + anchors.TOOL_BASH + ' (TOOL_BASH)',
  below !== undefined && above !== undefined
    && below[1] >= anchors.FILE_REFERENCE && above[1] <= anchors.TOOL_BASH,
  'nearest neighbours are ' + (below === undefined ? 'none' : below[0] + '@' + below[1])
    + ' and ' + (above === undefined ? 'none' : above[0] + '@' + above[1]))

  // The intent is "after the file-reference block, before the tool
  // descriptions". A free slot outside that neighbourhood would still pass a
  // bare uniqueness check while moving the block somewhere the docs do not
  // describe.
  check('the gap above SECTION_ORDER is still FILE_REFERENCE (the documented intent)',
    below !== undefined && below[0] === 'FILE_REFERENCE',
    'the section immediately below ' + declared + ' is ' + (below === undefined ? 'none' : below[0])
      + ' — README and lib/index.js explain the placement in terms of FILE_REFERENCE')
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

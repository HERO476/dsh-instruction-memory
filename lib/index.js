/**
 * dsh-instruction-memory — Host half.
 *
 * Registers one ordered `systemPrompt` section holding the user's long-lived
 * instructions, and persists them under the harness home so they survive a
 * process restart. Also exposes a small same-origin JSON route that the Client
 * half uses to read and edit the same store.
 *
 * Lifecycle: every side effect (prompt section, web route) belongs to this
 * plugin's fiber, so unmounting the row removes all of them.
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'instruction-memory'

/**
 * `systemPrompt` is the one hard dependency: without it there is nothing to
 * inject into. `webServer` deliberately is NOT declared here any more.
 *
 * It used to be, to fix a real race — this row mounts early, before the web
 * server has published, so a one-shot `ctx.get('webServer')` at apply time
 * resolved `undefined` and the route was lost for the life of the process. But
 * declaring it made the web server a *precondition for the whole plugin*: in a
 * profile that has no web server at all (headless, tui) the row stays pending
 * forever, `apply()` never runs, and the user silently loses BOTH the settings
 * page and the prompt injection — even though `apply()` has always been able to
 * serve memory without any web server. Memory must not be gated on the UI.
 *
 * The route is now registered from a non-blocking `ctx.inject(['webServer'], …)`
 * child fiber, which solves the original race properly: the callback runs
 * whenever the service is published, not only if it beat this row to it.
 *
 * The harness `fs` service is deliberately NOT used. Its default base is the
 * host process cwd, which is exactly what `@deepseek-ai/dsh-home-paths` warns
 * against: a user relaunching DSH from another directory would silently get a
 * second, empty store. Plugin-owned data belongs under the harness home.
 */
export const inject = ['systemPrompt']

const STORE_DIR_NAME = 'instruction-memory'
const STORE_FILE_NAME = 'memory.json'
/** Pre-release location, kept only so existing installs can migrate off it. */
const LEGACY_FILE_NAME = '.dsh-instruction-memory.json'
const SECTION_NAME = 'instruction-memory'
/**
 * Placement of the injected instruction block among the system prompt's
 * ordered sections. Sections are concatenated ascending; equal orders fall
 * back to code-unit name order, which is not something a plugin can reason
 * about — so this value must not collide with a reserved slot.
 *
 * `@deepseek-ai/dsh-system-prompt` owns a central `SECTION_ORDERS` table
 * (0.1.7-rc.2): HARNESS_IDENTITY -1000, DEPLOYMENT_PERSONA_PREFIX 0,
 * PLAN_POLICY 500, TEAM_POLICY 600, PTC_ONLY 800, FILE_REFERENCE **900**,
 * TOOL_BASH 1000, … STRUCTURED_OUTPUT 9900, HARNESS_SOURCE 10000,
 * WEB_SURFACE 10100, DEPLOYMENT_PERSONA_SUFFIX 10200.
 *
 * This was 900 through 1.0.8 — an exact tie with FILE_REFERENCE. It never
 * threw (a tie only degrades to dictionary order), and it happened to sort
 * the way we wanted: `instruction-memory` > `file-reference` on code units
 * ('i' 105 > 'f' 102), so the block landed just after the file references.
 * That is an accident of the name, not a decision, and renaming the section
 * would silently move it. 950 states the intent outright: in the gap between
 * FILE_REFERENCE (900) and TOOL_BASH (1000) — after the file-reference block,
 * before the tool descriptions, clear of every reserved value.
 */
const SECTION_ORDER = 950
const API_PREFIX = '/instruction-memory/api'

/**
 * Resolve this plugin's data file under the harness home.
 *
 * Precedence mirrors `@deepseek-ai/dsh-home-paths`: an explicit `$DSH_HOME`,
 * then `~/.dsh`. A blank override counts as unset and must never resolve to the
 * current working directory. Exported so tests can pin it.
 */
export function resolveStorePath(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = configured !== '' ? configured : join(home, '.dsh')
  return join(root, STORE_DIR_NAME, STORE_FILE_NAME)
}

const DEFAULT_BUDGET = 4000
const MIN_BUDGET = 800
const MAX_BUDGET = 40000
const MAX_ENTRIES = 200
const MAX_TITLE = 120
const MAX_CONTENT = 6000
const MAX_WHEN = 200

/**
 * Request body ceiling for the settings-page route; anything larger is refused
 * with a clean 413.
 *
 * Derived from the entry limits instead of hard-coded, because the two must not
 * drift apart. A fixed 1,000,000 sat BELOW the largest legal payload — 200
 * entries carrying 6,000 characters each is already 1.2 M characters of body —
 * so a maximal store could be exported by this plugin and then never imported
 * back into it: the route rejected the plugin's own export with 413. The factor
 * of two covers JSON string escaping (a `"` or a newline costs two characters);
 * the flat slack covers the `{method,args:{payload:{app,…,data:{entries:[…]}}}}`
 * wrapper.
 */
export const MAX_BODY_CHARS = MAX_ENTRIES * (MAX_CONTENT + MAX_TITLE + MAX_WHEN + 200) * 2 + 100_000

/* ------------------------------------------------------------------ *
 * Pure helpers (no ctx, fully unit-testable)
 * ------------------------------------------------------------------ */

function clampBudget(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_BUDGET
  if (n < MIN_BUDGET) return MIN_BUDGET
  if (n > MAX_BUDGET) return MAX_BUDGET
  return n
}

function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.split('\r\n').join('\n').split('\r').join('\n').trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Collapse a value onto a single line.
 *
 * A title carrying newlines breaks the injected block: the header renders as
 * several lines and the title ends up duplicating the body. This bit the
 * auto-title path, which took the first 40 characters of multi-line content —
 * newlines and all. The full text always survives in `content`.
 */
function singleLine(value, max) {
  return cleanText(value, max)
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ')
}

function makeId() {
  return 'im-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function priorityLabel(value) {
  if (value === 2) return '高'
  if (value === 0) return '低'
  return '普通'
}

export function sanitizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const title = singleLine(raw.title, MAX_TITLE)
  const content = cleanText(raw.content, MAX_CONTENT)
  if (title === '' && content === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : makeId(),
    title: title === '' ? singleLine(content, 40) : title,
    content,
    mode: raw.mode === 'auto' ? 'auto' : 'always',
    when: singleLine(raw.when, MAX_WHEN),
    priority: raw.priority === 2 || raw.priority === 0 ? raw.priority : 1,
    enabled: raw.enabled !== false,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/**
 * Which fields of a raw entry had to be cut to fit the stored limits.
 *
 * `sanitizeEntry` silently enforces MAX_TITLE / MAX_CONTENT / MAX_WHEN, which
 * is fine for the editor (its inputs carry the same maxLength) but wrong for
 * import and hand-edited payloads: a 7,000-character instruction came back
 * stored as 6,000 with no indication that anything was lost, contradicting the
 * plugin's stated rule of never discarding user text without saying so. Callers
 * use this to disclose the cut; the sanitizer itself stays pure and unchanged.
 *
 * @returns the names of the fields that were shortened, in field order.
 */
export function truncatedFields(raw) {
  if (raw === null || typeof raw !== 'object') return []
  const cut = []
  const unlimited = Number.MAX_SAFE_INTEGER
  if (typeof raw.title === 'string' && singleLine(raw.title, unlimited) !== singleLine(raw.title, MAX_TITLE)) cut.push('标题')
  if (typeof raw.content === 'string' && cleanText(raw.content, unlimited) !== cleanText(raw.content, MAX_CONTENT)) cut.push('内容')
  if (typeof raw.when === 'string' && singleLine(raw.when, unlimited) !== singleLine(raw.when, MAX_WHEN)) cut.push('适用场景')
  return cut
}

/**
 * Load a parsed memory file. Returns the sanitized data plus how many array
 * items were discarded (blank entries, or valid ones past the cap). The count
 * is surfaced rather than swallowed because the next save rewrites the file
 * without those items — silently destroying user data is exactly what this
 * plugin must never do.
 */
function normalizeData(raw) {
  const data = { version: 1, enabled: true, budgetChars: DEFAULT_BUDGET, entries: [] }
  if (raw === null || typeof raw !== 'object') return { data, dropped: 0 }
  if (typeof raw.enabled === 'boolean') data.enabled = raw.enabled
  data.budgetChars = clampBudget(raw.budgetChars)
  const list = Array.isArray(raw.entries) ? raw.entries : []
  const seen = new Set()
  let dropped = 0
  for (const candidate of list) {
    const entry = sanitizeEntry(candidate)
    if (entry === null) {
      dropped += 1
      continue
    }
    if (data.entries.length >= MAX_ENTRIES) {
      dropped += 1
      continue
    }
    if (seen.has(entry.id)) entry.id = makeId()
    seen.add(entry.id)
    data.entries.push(entry)
  }
  return { data, dropped }
}

/**
 * A structural copy of the store, shallow per entry.
 *
 * The mutating commands edit `state.data` in place (push, filter, field
 * assignment), so holding a plain reference is not enough to undo one — the
 * "previous" value would already have changed with it. Entries are flat
 * objects, so one spread per entry is a complete copy, and at the 200-entry cap
 * that is a trivial cost on a path that is already doing a disk write.
 */
function cloneData(data) {
  return {
    version: 1,
    enabled: data.enabled === true,
    budgetChars: data.budgetChars,
    entries: (Array.isArray(data.entries) ? data.entries : []).map((entry) => ({ ...entry })),
  }
}

const droppedEntriesMessage = (count) =>
  count > 0
    ? '存储文件中有 ' + count + ' 条条目未能载入（内容为空或超过 ' + MAX_ENTRIES + ' 条上限）；下次保存时它们将从文件中移除'
    : null

/**
 * Hostnames a loopback-bound server may legitimately be reached by.
 *
 * `localhost` is included for people who open the GUI that way; the IPv4-mapped
 * form covers a dual-stack listener reporting the client as `::ffff:127.0.0.1`.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])

/**
 * The hostname part of a `Host` header, lower-cased and without its port.
 *
 * `127.0.0.1:8080` -> `127.0.0.1`; `[::1]:8080` -> `::1`; `localhost` -> `localhost`.
 * Exported so the parsing itself can be pinned by tests.
 */
export function hostnameOf(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return ''
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/**
 * Why the settings-page route checks `Host` and `Origin` at all, when it already
 * refuses any content-type that is not `application/json`.
 *
 * The content-type rule stops a cross-site form post, and no CORS headers are
 * sent so a cross-origin `fetch` with a JSON body dies in preflight. Both
 * defences assume the browser sees the request as *cross-origin*. DNS
 * rebinding removes that assumption: a page served from `evil.com` whose DNS
 * is re-pointed at 127.0.0.1 is, to the browser, same-origin with the server it
 * then talks to — so no preflight happens, the JSON content-type is allowed,
 * and the plugin would happily rewrite the user's long-lived instructions,
 * which are injected into every later prompt. The one thing the attacker cannot
 * change is the `Host` header the browser sends: it still carries `evil.com`.
 *
 * So when the server is bound to loopback (the default) the route requires a
 * loopback `Host`. An operator who binds `0.0.0.0` has deliberately published
 * the whole server on every interface, where no Host value can be known in
 * advance — the check is disabled there rather than breaking every legitimate
 * client, and that trade-off is documented in the README.
 */
export function requestOriginVerdict(headers, guarded) {
  const read = (name) => {
    if (headers === null || typeof headers !== 'object') return ''
    const value = headers[name]
    return typeof value === 'string' ? value : ''
  }
  const requestHost = read('host').trim().toLowerCase()
  const requestHostname = hostnameOf(requestHost)

  if (guarded && !LOOPBACK_HOSTNAMES.has(requestHostname)) {
    return { ok: false, reason: 'Host 头不是回环地址（可能是 DNS 重绑定攻击）：' + (requestHost === '' ? '(缺失)' : requestHost) }
  }

  const origin = read('origin').trim()
  if (origin !== '') {
    let originHostname = ''
    try {
      originHostname = new URL(origin).hostname.toLowerCase()
    } catch {
      originHostname = ''
    }
    // Compare hostnames, not host:port: a proxy may rewrite the port, and the
    // hostname is the part rebinding actually attacks. `Origin: null`
    // (sandboxed iframe, file://) parses to no hostname and is refused.
    if (originHostname === '' || originHostname !== requestHostname) {
      return { ok: false, reason: 'Origin 与 Host 不同源：' + origin }
    }
  }

  return { ok: true, reason: null }
}

function formatEntry(entry, tag) {
  const lines = ['[' + tag + '｜优先级 ' + priorityLabel(entry.priority) + '] ' + entry.title]
  if (entry.mode === 'auto' && entry.when !== '') lines.push('适用场景：' + entry.when)
  lines.push(entry.content)
  return lines.join('\n')
}

/**
 * Render the injected block. Deliberately deterministic: identical memory
 * produces byte-identical text on every step, so the prompt prefix stays
 * cacheable across a session.
 */
export function buildBlock(data) {
  if (data === null || typeof data !== 'object' || data.enabled !== true) return ''
  const active = (Array.isArray(data.entries) ? data.entries : [])
    .filter((entry) => entry.enabled === true && entry.content !== '')
  if (active.length === 0) return ''
  active.sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))

  const budget = clampBudget(data.budgetChars)

  // Richest preamble that still leaves room for one real entry plus the
  // worst-case omission footer. A tight budget degrades the preamble instead of
  // silently injecting nothing.
  const HEADERS = [
    [
      '## 用户长期指令记忆（Instruction Memory）',
      '以下条目由用户在 DSH 设置 →「指令记忆」中长期保存，属于本次及后续所有对话的既有要求，请在回答、推理与执行任务时遵守；它们不覆盖系统与安全规则。',
      '· [始终] 条目必须无条件遵守。',
      '· [按需] 条目仅在与当前问题或任务相关时生效；不相关时直接忽略，不要强行套用。',
      '· 条目之间冲突时，优先遵守优先级更高或更具体的一条；无法判断时向用户确认。',
      '',
    ].join('\n'),
    [
      '## 用户长期指令记忆（Instruction Memory）',
      '[始终] 条目无条件遵守；[按需] 条目仅在与当前任务相关时生效。',
      '',
    ].join('\n'),
    '## 用户长期指令记忆\n',
  ]
  const footerFor = (count) =>
    count === 0
      ? ''
      : '\n\n（另有 ' + count + ' 条指令因注入字数上限未包含，可在「设置 → 指令记忆」中提高上限或调低其优先级。）'

  const MIN_ROOM = 80
  let header = HEADERS[HEADERS.length - 1]
  for (const candidate of HEADERS) {
    if (candidate.length + MIN_ROOM + footerFor(1).length <= budget) {
      header = candidate
      break
    }
  }

  const blocks = []
  let used = header.length
  let omitted = 0

  const consider = (entry, tag) => {
    const block = formatEntry(entry, tag)
    // Reserve the footer up front so a disclosure can never be squeezed out by
    // the very entries that caused it.
    const reserve = footerFor(omitted + 1).length
    if (used + block.length + 2 + reserve <= budget) {
      used += block.length + 2
      blocks.push(block)
      return
    }
    // The first entry always gets in, truncated if the budget demands it: a
    // memory that loads and then injects nothing is worse than a short one.
    if (blocks.length === 0) {
      const room = budget - used - 2 - reserve
      const note = '\n…（本条因注入字数上限被截断）'
      if (room > note.length + 20) {
        // Cut in UTF-16 units but back off one char when that lands between a
        // surrogate pair, so the truncation point can never end on the broken
        // half of an emoji or CJK ext-B character.
        let head = block.slice(0, room - note.length)
        const last = head.charCodeAt(head.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
        const body = head + note
        blocks.push(body)
        used += body.length + 2
        return
      }
    }
    omitted += 1
  }

  for (const entry of active) if (entry.mode === 'always') consider(entry, '始终')
  for (const entry of active) if (entry.mode !== 'always') consider(entry, '按需')

  if (blocks.length === 0) return ''
  return header + blocks.join('\n\n') + footerFor(omitted)
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const systemPrompt = ctx.systemPrompt

  const state = {
    data: { version: 1, enabled: true, budgetChars: DEFAULT_BUDGET, entries: [] },
    storagePath: null,
    storageDisplay: null,
    storageError: null,
    storageWarning: null,
    /** A failed rolling-backup refresh, shown only when no load warning wins. */
    backupError: null,
    /** Which branch of the load actually produced the current data (diagnostics). */
    loadedFrom: null,
    savedAt: null,
    migratedFrom: null,
    sectionRegistered: false,
    sectionError: null,
    /** Whether a store file is actually present on disk (diagnostics + the panel). */
    storeExists: false,
  }
  let sectionDispose = null

  /**
   * A first run deliberately writes NOTHING (see readFromDisk step 3). This flag
   * remembers that the store has not been materialised yet, so the file is
   * created by the first action that genuinely needs it — a save, or the
   * settings page asking for `state` — instead of by the bare act of the host
   * booting with no session and no task.
   */
  let needsMaterialize = false

  /**
   * How many times the host has pulled this section into a prompt, since boot.
   *
   * The plugin cannot see sessions or turns; it only knows that the harness
   * evaluated the thunk it registered. That is still the honest answer to "did
   * this actually reach a prompt?", and it is the thing the previous log line
   * could not distinguish: a registered section with pulls=0 has been prepared
   * but never injected.
   */
  let sectionPulls = 0

  const describeError = (err) => {
    if (err === null || err === undefined) return '未知错误'
    if (typeof err === 'string') return err
    if (typeof err.message === 'string' && err.message !== '') return err.message
    return String(err)
  }

  /* ---------------- diagnostics ---------------- */

  /**
   * The plugin used to be completely silent on success: every load, save and
   * injection produced no record at all, and only failures reached
   * `console.error`. "Is memory actually doing anything?" was therefore
   * unanswerable from logs — verifying it meant substituting route snapshots
   * and transcript forensics for real evidence.
   *
   * This adds an opt-in diagnostic channel on the harness logger. It is
   * log-only: it never touches what gets injected, so the rendered block stays
   * byte-identical with it on or off.
   *
   *   info  — one line per mount (where the store is, how much is injected)
   *   debug — per-operation detail, including the ones the route guards reject
   *
   * With no logger service (the offline harnesses) debug needs
   * DSH_INSTRUCTION_MEMORY_DEBUG=1; info always falls back to console.error so
   * a mount failure is never swallowed.
   */
  const logger = (() => {
    try {
      const candidate = typeof ctx.logger === 'function' ? ctx.logger('instruction-memory') : ctx.logger
      if (candidate !== null && candidate !== undefined && typeof candidate.info === 'function') return candidate
    } catch {
      // A context without a logger service must never break the plugin.
    }
    return null
  })()

  const debugToConsole = (() => {
    const raw = typeof process.env.DSH_INSTRUCTION_MEMORY_DEBUG === 'string'
      ? process.env.DSH_INSTRUCTION_MEMORY_DEBUG.trim().toLowerCase()
      : ''
    return raw === '1' || raw === 'true' || raw === 'yes'
  })()

  const logInfo = (message) => {
    if (logger !== null) logger.info(message)
    else console.error('[instruction-memory] ' + message)
  }

  const logDebug = (message) => {
    if (logger !== null) {
      if (typeof logger.debug === 'function') logger.debug(message)
      return
    }
    if (debugToConsole) console.error('[instruction-memory] ' + message)
  }

  const sectionText = () => {
    try {
      return buildBlock(state.data)
    } catch (err) {
      console.error('[instruction-memory] render failed:', err)
      return ''
    }
  }

  /**
   * The thunk handed to the harness.
   *
   * It is deliberately NOT `sectionText` itself: wrapping it lets the plugin
   * count the pulls the host performs (`assembled`), which is the only
   * first-hand evidence of "this reached a prompt" available on this side of the
   * API. The returned text is untouched — the render stays byte-identical
   * (verify.mjs pins that with and without a logger attached).
   */
  const assembledSectionText = () => {
    sectionPulls += 1
    logDebug('section pulled into a prompt (pull #' + sectionPulls + ')')
    return sectionText()
  }

  /**
   * Keep the registered section exactly in step with the stored data: present
   * when something must be injected, absent otherwise. An empty memory must
   * leave the prompt byte-identical to a deployment without this plugin.
   */
  const syncSection = () => {
    const wanted = sectionText() !== ''
    if (wanted && sectionDispose === null) {
      try {
        sectionDispose = systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: assembledSectionText })
        state.sectionRegistered = true
        state.sectionError = null
        logDebug('prompt section registered: order=' + SECTION_ORDER + ' chars=' + sectionText().length)
      } catch (err) {
        sectionDispose = null
        state.sectionRegistered = false
        state.sectionError = '注入注册失败：' + describeError(err)
        console.error('[instruction-memory] section registration failed:', err)
      }
      return
    }
    if (!wanted) {
      if (sectionDispose !== null) {
        const dispose = sectionDispose
        sectionDispose = null
        try {
          dispose()
          logDebug('prompt section disposed (nothing to inject)')
        } catch (err) {
          console.error('[instruction-memory] section dispose failed:', err)
        }
      }
      state.sectionRegistered = false
      state.sectionError = null
    }
  }

  ctx.effect(() => () => {
    if (sectionDispose !== null) {
      const dispose = sectionDispose
      sectionDispose = null
      try {
        dispose()
      } catch (err) {
        console.error('[instruction-memory] cleanup failed:', err)
      }
    }
  })

  /* ---------------- storage ---------------- */

  const storePath = resolveStorePath()

  const serialize = () => JSON.stringify(state.data, null, 2) + '\n'

  const writeToDisk = async () => {
    // Atomic replace (write a sibling temp file, then rename) with a rolling
    // one-version backup: a crash mid-write must never leave a truncated
    // memory.json, and an edit the user regrets must still be recoverable
    // from memory.json.bak. The .bak holds the previous good version.
    //
    // The backup is a COPY, not a rename. Renaming the live file out of the way
    // first opened a window in which memory.json did not exist: if the rename
    // that followed failed (a lock, a full disk, an indexer holding the file)
    // the primary path stayed missing, and the next boot — finding no
    // memory.json — materialised an EMPTY store and silently discarded the
    // user's memory while their real data sat untouched in .bak. Copying keeps
    // the primary in place until the atomic replace succeeds, so a failure at
    // any step leaves the previous store readable at its own path.
    const tmpPath = storePath + '.tmp'
    const bakPath = storePath + '.bak'
    try {
      await mkdir(dirname(storePath), { recursive: true })
      const text = serialize()
      await writeFile(tmpPath, text, 'utf8')
      try {
        await copyFile(storePath, bakPath)
        state.backupError = null
      } catch (err) {
        // ENOENT is simply the very first save: there is no previous version
        // to roll. Any other failure means the promised rolling backup did not
        // happen — non-fatal for this save, because the primary is still intact
        // and the replace below is the real gate, but it must be disclosed
        // rather than swallowed.
        state.backupError = err.code === 'ENOENT'
          ? null
          : '上一版未能保留为 memory.json.bak：' + describeError(err)
      }
      try {
        await rename(tmpPath, storePath)
      } catch (err) {
        await unlink(tmpPath).catch(() => {})
        throw err
      }
      state.storagePath = storePath
      state.storageDisplay = storePath
      state.storageError = null
      state.storeExists = true
      // A successful write is the one thing that makes the file real, so it is
      // also what clears the "not materialised yet" flag set by a first run.
      needsMaterialize = false
      state.savedAt = Date.now()
      logDebug('store written: ' + storePath + ' bytes=' + text.length
        + ' entries=' + state.data.entries.length
        + (state.backupError === null ? ' backup=refreshed' : ' backup=FAILED'))
      return true
    } catch (err) {
      state.storageError = '保存失败：' + describeError(err)
      return false
    }
  }

  const readStoreFile = async (path) => {
    const text = await readFile(path, 'utf8')
    return text.trim() === '' ? null : JSON.parse(text)
  }

  const readFromDisk = async () => {
    state.storagePath = storePath
    state.storageDisplay = storePath
    state.storageWarning = null
    state.loadedFrom = null
    state.storeExists = false

    // 1. The canonical location under the harness home.
    try {
      const parsed = await readStoreFile(storePath)
      if (parsed !== null) {
        const loaded = normalizeData(parsed)
        state.data = loaded.data
        state.storageWarning = droppedEntriesMessage(loaded.dropped)
        state.loadedFrom = 'memory.json'
        state.storeExists = true
      }
      state.storageError = null
      return
    } catch (err) {
      if (err === null || err === undefined || err.code !== 'ENOENT') {
        // The main file is unreadable or corrupt. A previous good version
        // may survive in the rolling backup — recover from it rather than
        // presenting an empty memory, but say so loudly. The corrupt file
        // itself stays untouched for hand repair; it gets overwritten on the
        // next save (the pre-existing and disclosed behaviour).
        if (err instanceof SyntaxError) {
          try {
            const backup = await readStoreFile(storePath + '.bak')
            if (backup !== null) {
              const loaded = normalizeData(backup)
              state.data = loaded.data
              state.storageWarning = (droppedEntriesMessage(loaded.dropped) || '')
                + (loaded.dropped > 0 ? '；' : '')
                + 'memory.json 解析失败（' + describeError(err) + '），已临时回退到最近备份 memory.json.bak；损坏文件已保留，下次保存时会覆盖它'
              state.loadedFrom = 'memory.json.bak (main file corrupt)'
              return
            }
          } catch {
            // No usable backup either; fall through to the error below.
          }
        }
        // A file we cannot understand must never be silently overwritten.
        state.storageError = err instanceof SyntaxError
          ? '配置文件解析失败（' + describeError(err) + '），原文件已保留；你下次保存时会覆盖它'
          : '读取失败：' + describeError(err)
        return
      }
    }

    // 1b. The primary file is gone but a rolling backup survives. That is the
    //     state an interrupted save leaves behind (the backup step used to
    //     rename the primary out of the way before the replace), and it is also
    //     what a stray delete looks like. Falling through to "first run" here
    //     would materialise an EMPTY store and silently present the user with
    //     no memory at all while their previous version sat right there in
    //     .bak — so recover it, and promote the recovered data back to the
    //     canonical path so the next boot finds it normally.
    try {
      const backup = await readStoreFile(storePath + '.bak')
      if (backup !== null) {
        const loaded = normalizeData(backup)
        state.data = loaded.data
        const promoted = await writeToDisk()
        state.storageWarning = (droppedEntriesMessage(loaded.dropped) || '')
          + (loaded.dropped > 0 ? '；' : '')
          + 'memory.json 不存在，已从最近备份 memory.json.bak 恢复'
          + (promoted ? '，并已写回 memory.json' : '；写回 memory.json 失败，下次保存时会重试')
        state.loadedFrom = 'memory.json.bak (main file missing)'
        return
      }
    } catch {
      // An unusable backup must never block a fresh store; fall through.
    }

    // 2. Migrate the pre-release location (host process cwd). This is the only
    //    reason the legacy name is still known to this plugin.
    const legacyPath = join(process.cwd(), LEGACY_FILE_NAME)
    try {
      const parsed = await readStoreFile(legacyPath)
      if (parsed !== null) {
        const loaded = normalizeData(parsed)
        state.data = loaded.data
        state.storageWarning = droppedEntriesMessage(loaded.dropped)
        if (await writeToDisk()) {
          state.migratedFrom = legacyPath
          // Keep the original as evidence instead of deleting user data.
          await rename(legacyPath, legacyPath + '.migrated').catch(() => {})
        }
        state.loadedFrom = 'legacy cwd file (migrated)'
        return
      }
    } catch (err) {
      // A missing or unreadable legacy file must never block a fresh store.
      if (err instanceof SyntaxError) state.storageError = '旧位置文件解析失败，已忽略：' + describeError(err)
    }

    // 3. First run: there is no store anywhere. Deliberately write NOTHING.
    //
    //    This used to materialise an empty memory.json so the settings page had
    //    a real path to show. That made the plugin perform a disk write at
    //    process boot — i.e. with no session, no turn and no task — which is the
    //    one side effect that a behaviour audit can legitimately call "running
    //    with nothing to do". The file is now created by the first action that
    //    genuinely needs it: a save, an import, or the settings page reading
    //    `state` (see ensureStoreMaterialized). Until then the panel shows
    //    "尚未写入磁盘", a state its UI already renders.
    needsMaterialize = true
    state.loadedFrom = 'first run (no store on disk yet)'
    state.storeExists = false
  }

  /**
   * Write the empty store, once, the first time something actually needs the
   * file to exist. A failed attempt leaves the flag set so the next caller
   * retries instead of silently pretending the file is there.
   *
   * @returns whether a write was performed and succeeded.
   */
  const ensureStoreMaterialized = async () => {
    if (!needsMaterialize) return false
    return writeToDisk()
  }

  /* ---------------- boot ---------------- */

  // Load the store, then register the section if anything must be injected.
  // Every entry point awaits this, so a request that arrives before the disk
  // read settles can never overwrite the file with an empty in-memory state.
  const boot = readFromDisk()
    .catch((err) => {
      state.storageError = '读取失败：' + describeError(err)
    })
    .then(() => {
      syncSection()
      // The one always-on line: it answers "is memory mounted, where does it
      // live, and how much is being injected?" without any further digging.
      // 措辞很重要：`section=` 说的是"这个段落已就绪、若被装配会产出多少字符"，
      // 而不是"已经注入"。在零会话时打印 `injected=` 会让人误以为记忆已经进入
      // 了某个提示词。真正的注入证据是 pulls：宿主每拉取一次加一（初始必为 0）。
      const chars = sectionText().length
      logInfo('mounted: store=' + storePath
        + ' from=' + String(state.loadedFrom)
        + ' onDisk=' + (state.storeExists ? 'yes' : 'no')
        + ' entries=' + state.data.entries.length
        + ' enabled=' + (state.data.enabled === true)
        + ' section=' + (chars > 0 ? chars + ' chars (pending assembly)' : 'nothing to inject')
        + ' pulls=' + sectionPulls
        + (state.storageError !== null ? ' error=' + state.storageError : ''))
    })

  /**
   * All state-mutating work (edits and 重新载入) runs through this chain, so a
   * save that is still flushing to disk can never interleave with a reload
   * reading the file back — the old lost-update window in which the panel
   * briefly resurrected data the user had just replaced. Each operation
   * returns its full response payload, computed in the same tick as the
   * mutation, so a snapshot can never straddle the next queued operation.
   */
  let diskQueue = Promise.resolve()
  const enqueue = (op) => {
    const run = diskQueue.then(op, op)
    diskQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /* ---------------- snapshots ---------------- */

  const snapshot = () => {
    const preview = sectionText()
    return {
      data: {
        version: 1,
        enabled: state.data.enabled === true,
        budgetChars: clampBudget(state.data.budgetChars),
        entries: (Array.isArray(state.data.entries) ? state.data.entries : []).map((entry) => ({ ...entry })),
      },
      storage: {
        path: state.storageDisplay !== null ? state.storageDisplay : state.storagePath,
        error: state.storageError,
        warning: state.storageWarning !== null ? state.storageWarning : state.backupError,
        savedAt: state.savedAt,
        migratedFrom: state.migratedFrom,
        /** false until the store file has actually been written (see readFromDisk step 3). */
        onDisk: state.storeExists,
      },
      injection: {
        registered: state.sectionRegistered,
        available: true,
        error: state.sectionError,
        chars: preview.length,
        /**
         * How many times the harness has pulled this section into a prompt since
         * boot. 0 means "prepared, never assembled" — the distinction the old
         * `injected=` log line could not make.
         */
        pulls: sectionPulls,
      },
      preview,
      limits: { minBudget: MIN_BUDGET, maxBudget: MAX_BUDGET, maxEntries: MAX_ENTRIES },
    }
  }

  const settle = (message, saved) => {
    if (saved !== true && state.storageError !== null) {
      return { ok: false, saved: false, message: state.storageError, snapshot: snapshot() }
    }
    return { ok: true, saved: saved === true, message, snapshot: snapshot() }
  }

  /* ---------------- commands (shared by route and callers) ---------------- */

  /**
   * Apply an in-memory mutation, persist it, and UNDO it when the write fails.
   *
   * Every mutating command used to edit `state.data`, re-register the prompt
   * section, and only then find out that the disk write had failed. The panel
   * said 保存失败 and memory.json was correctly left alone — but the injected
   * system prompt kept carrying the unsaved edit for the rest of the process
   * lifetime, so the model went on obeying an instruction the user had just
   * been told was not saved. The successful write is the commit point: fail it
   * and the in-memory state, the prompt section and the panel roll back
   * together.
   *
   * @returns whether the store was persisted.
   */
  const commit = async (mutate) => {
    const previousData = cloneData(state.data)
    const previousWarning = state.storageWarning
    mutate()
    syncSection()
    if (await writeToDisk()) {
      // A successful save has rewritten the file to match memory, so a
      // dropped-entries warning from load time ("they will be removed on the
      // next save") has played out and must not keep showing.
      state.storageWarning = null
      return true
    }
    logDebug('commit rolled back: the disk write failed, in-memory state restored')
    state.data = previousData
    state.storageWarning = previousWarning
    syncSection()
    return false
  }

  const saveEntry = (raw) => enqueue(async () => {
    const entry = sanitizeEntry(raw)
    if (entry === null) return { ok: false, saved: false, message: '标题与指令内容不能同时为空', snapshot: snapshot() }
    entry.updatedAt = Date.now()
    // Resolved before the mutation so a refusal can return a response instead
    // of being swallowed as an early exit inside it.
    const replacesExisting = state.data.entries.some((candidate) => candidate.id === entry.id)
    if (!replacesExisting && state.data.entries.length >= MAX_ENTRIES) {
      return { ok: false, saved: false, message: '最多保存 ' + MAX_ENTRIES + ' 条指令', snapshot: snapshot() }
    }
    const cut = truncatedFields(raw)
    const saved = await commit(() => {
      const list = state.data.entries
      const index = list.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) list[index] = entry
      else list.push(entry)
    })
    const note = cut.length > 0
      ? '已保存；' + cut.join('、') + '超过长度上限（标题 ' + MAX_TITLE + ' / 内容 ' + MAX_CONTENT + ' / 适用场景 ' + MAX_WHEN + ' 字符），超出部分已被截断'
      : null
    return settle(note, saved)
  })

  const deleteEntry = (id) => enqueue(async () => {
    const saved = await commit(() => {
      state.data.entries = state.data.entries.filter((entry) => entry.id !== id)
    })
    return settle(null, saved)
  })

  const setOptions = (patch) => enqueue(async () => {
    const saved = await commit(() => {
      if (patch !== null && typeof patch === 'object') {
        if (typeof patch.enabled === 'boolean') state.data.enabled = patch.enabled
        if (typeof patch.budgetChars === 'number' && Number.isFinite(patch.budgetChars)) {
          state.data.budgetChars = clampBudget(patch.budgetChars)
        }
      }
    })
    return settle(null, saved)
  })

  const reload = () => enqueue(async () => {
    await readFromDisk()
    syncSection()
    return { ok: state.storageError === null, saved: true, message: state.storageError, snapshot: snapshot() }
  })

  const exportData = () => enqueue(async () => ({
    ok: true,
    saved: true,
    message: null,
    // A self-describing envelope: re-importable by this plugin, and readable
    // as plain JSON by anything else.
    export: { app: 'dsh-instruction-memory', version: 1, exportedAt: new Date().toISOString(), data: snapshot().data },
    snapshot: snapshot(),
  }))

  const importData = (payload) => enqueue(async () => {
    if (payload === null || typeof payload !== 'object') {
      return { ok: false, saved: false, message: '导入内容不是有效的 JSON 对象', snapshot: snapshot() }
    }
    // Accept both the plugin's own export envelope ({app, data:{entries}}) and
    // a bare {entries} array (e.g. a hand-assembled file).
    const rawEntries = Array.isArray(payload.entries)
      ? payload.entries
      : (payload.data !== null && typeof payload.data === 'object' && Array.isArray(payload.data.entries)
        ? payload.data.entries
        : null)
    if (rawEntries === null || rawEntries.length === 0) {
      return { ok: false, saved: false, message: '导入文件中没有找到条目', snapshot: snapshot() }
    }
    // Merge, never replace: importing must not be able to wipe what is here.
    // Duplicates (same id, or same title+content) and invalid items are
    // skipped and counted, not silently dropped.
    //
    // The whole plan is computed BEFORE the store is touched, so the merge and
    // its counters cannot disagree with what actually gets appended.
    const existing = state.data.entries
    const seenIds = new Set(existing.map((entry) => entry.id))
    const seenBodies = new Set(existing.map((entry) => entry.title + '\u0000' + entry.content))
    const accepted = []
    const cutFields = new Set()
    let truncatedCount = 0
    let skipped = 0
    for (const candidate of rawEntries) {
      const entry = sanitizeEntry(candidate)
      if (entry === null || seenIds.has(entry.id) || seenBodies.has(entry.title + '\u0000' + entry.content)) {
        skipped += 1
        continue
      }
      if (existing.length + accepted.length >= MAX_ENTRIES) {
        skipped += 1
        continue
      }
      const cut = truncatedFields(candidate)
      if (cut.length > 0) {
        // sanitizeEntry enforces the limits silently, which is fine for the
        // editor (its inputs carry the same maxLength) but wrong here: an
        // imported 7,000-character instruction would come back as 6,000 with
        // nothing said about the loss.
        truncatedCount += 1
        for (const field of cut) cutFields.add(field)
      }
      entry.updatedAt = Date.now()
      accepted.push(entry)
      seenIds.add(entry.id)
      seenBodies.add(entry.title + '\u0000' + entry.content)
    }
    if (accepted.length === 0) {
      // Nothing was written to disk, so claiming saved:true would be a lie the
      // panel cannot distinguish from a real save.
      return { ok: true, saved: false, message: '没有新增条目：' + skipped + ' 条已存在或无效', snapshot: snapshot() }
    }
    const saved = await commit(() => {
      state.data.entries.push(...accepted)
    })
    const truncated = truncatedCount > 0
      ? '；其中 ' + truncatedCount + ' 条超过长度上限，' + [...cutFields].join('、') + '已被截断'
      : ''
    return settle('导入完成：新增 ' + accepted.length + ' 条，跳过 ' + skipped + ' 条（已存在或无效）' + truncated, saved)
  })

  const dispatch = async (method, args) => {
    await boot
    switch (method) {
      case 'state': {
        // The settings page is the first thing that needs a real file on disk —
        // it displays the absolute path, and the user may then hand-edit it.
        // A first run writes nothing at boot (readFromDisk step 3), so the
        // materialisation happens here, on a deliberate user action, instead of
        // as a side effect of the host merely starting up.
        await ensureStoreMaterialized()
        // Same envelope as every other method. One response shape means the
        // Client can never again be handed a payload it silently ignores.
        return { ok: true, saved: true, message: null, snapshot: snapshot() }
      }
      case 'save-entry':
        return saveEntry(args !== null && typeof args === 'object' ? args.entry : null)
      case 'delete-entry':
        return deleteEntry(args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : '')
      case 'set-options':
        return setOptions(args)
      case 'reload':
        return reload()
      case 'export-data':
        return exportData()
      case 'import-data':
        return importData(args !== null && typeof args === 'object' ? args.payload : null)
      default:
        return { ok: false, saved: false, message: '未知方法：' + String(method), snapshot: snapshot() }
    }
  }

  /* ---------------- same-origin JSON route for the Client half ---------------- */

  // Which Host values this route accepts. Set when the route is registered,
  // from the address the web server is actually bound to (see the long note on
  // requestOriginVerdict). Until then the route does not exist at all, so the
  // default only matters if something registers it out of band.
  let guardHost = true

  let routeDispose = null
  const handler = (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, message: 'only POST is supported' }))
      return
    }
    // Origin/Host guard, before anything else is read. See
    // requestOriginVerdict() for why the content-type rule below is not enough
    // on its own.
    const verdict = requestOriginVerdict(req.headers, guardHost)
    if (!verdict.ok) {
      logInfo('route rejected a request: ' + verdict.reason)
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, message: '请求来源被拒绝：' + verdict.reason }))
      return
    }
    // The settings page always posts application/json. Enforcing it turns
    // the anti-CSRF coincidence (a plain HTML form cannot fabricate a JSON
    // body) into a hard rule: a cross-site or malformed post now gets a
    // readable 415 instead of a confusing parse failure.
    const contentType = String(
      (req.headers !== null && typeof req.headers === 'object') ? (req.headers['content-type'] || '') : '',
    )
    if (contentType.indexOf('application/json') === -1) {
      res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, message: 'content-type 必须是 application/json' }))
      return
    }
    // A call aborted mid-flight (settings page closed, tab navigated away)
    // makes these streams emit 'error'. A server stream with no error
    // listener turns that into an uncaught exception — i.e. it would take
    // the whole host process down over one dead HTTP request.
    req.on('error', () => {})
    res.on('error', () => {})
    let body = ''
    // Over the ceiling we stop accumulating but keep draining, so the
    // response can go out as a clean 413 instead of a destroyed socket the
    // Client can only report as a generic network failure.
    let overflow = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (overflow) return
      body += chunk
      if (body.length > MAX_BODY_CHARS) {
        overflow = true
        body = ''
      }
    })
    req.on('end', () => {
      void (async () => {
        if (overflow) {
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, message: '请求体超过 ' + MAX_BODY_CHARS + ' 字符上限' }))
          return
        }
        let result
        try {
          const payload = body === '' ? {} : JSON.parse(body)
          result = await dispatch(payload.method, payload.args === undefined ? null : payload.args)
        } catch (err) {
          result = { ok: false, saved: false, message: describeError(err), snapshot: snapshot() }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(result))
      })()
    })
  }

  // Register the settings-page route from a NON-BLOCKING child fiber. A web
  // server must not be a precondition for this plugin: in a profile without one
  // (headless, tui) a blocking dependency would keep the whole row pending,
  // losing the prompt injection along with the settings page. The callback also
  // fixes the original race properly — it runs whenever the service is
  // published, not only if it happened to beat this row to the mount.
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      console.error('[instruction-memory] webServer published without a register(); the settings page cannot reach the host')
      return
    }
    // The Host allowlist only makes sense when the operator bound the server to
    // loopback. `0.0.0.0` means they deliberately published it on every
    // interface, where no Host value can be known in advance — enforcing a
    // loopback allowlist there would break every legitimate client, so the
    // check is disabled and the trade-off is documented in the README.
    const boundHost = typeof webServer.host === 'string' ? webServer.host.trim().toLowerCase() : '127.0.0.1'
    guardHost = boundHost !== '0.0.0.0'
    try {
      routeDispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
      logDebug('settings route registered at ' + API_PREFIX + ' (boundHost=' + boundHost + ', hostGuard=' + guardHost + ')')
    } catch (err) {
      console.error('[instruction-memory] route registration failed:', err)
      routeDispose = null
    }
    // The child fiber is owned by this one, so unmounting the plugin still
    // disposes the route even though it was registered here.
    scope.effect(() => () => {
      if (routeDispose !== null) {
        const dispose = routeDispose
        routeDispose = null
        try {
          dispose()
        } catch (err) {
          console.error('[instruction-memory] route dispose failed:', err)
        }
      }
    })
  })
}

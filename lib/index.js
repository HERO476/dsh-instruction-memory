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

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'instruction-memory'

/**
 * Hard dependencies, declared rather than probed.
 *
 * This row mounts early — before the web server has published — so a one-shot
 * `ctx.get('webServer')` at apply time resolves `undefined` and the route is
 * lost for the life of the process. Declaring it here makes Cordis hold the row
 * until the service exists.
 *
 * The harness `fs` service is deliberately NOT used. Its default base is the
 * host process cwd, which is exactly what `@deepseek-ai/dsh-home-paths` warns
 * against: a user relaunching DSH from another directory would silently get a
 * second, empty store. Plugin-owned data belongs under the harness home.
 */
export const inject = ['systemPrompt', 'webServer']

const STORE_DIR_NAME = 'instruction-memory'
const STORE_FILE_NAME = 'memory.json'
/** Pre-release location, kept only so existing installs can migrate off it. */
const LEGACY_FILE_NAME = '.dsh-instruction-memory.json'
const SECTION_NAME = 'instruction-memory'
const SECTION_ORDER = 900
const API_PREFIX = '/instruction-memory/api'
/** Request body ceiling for the settings-page route; anything larger is rejected. */
const MAX_BODY_CHARS = 1_000_000

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

const droppedEntriesMessage = (count) =>
  count > 0
    ? '存储文件中有 ' + count + ' 条条目未能载入（内容为空或超过 ' + MAX_ENTRIES + ' 条上限）；下次保存时它们将从文件中移除'
    : null

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
  const webServer = ctx.get('webServer')

  const state = {
    data: { version: 1, enabled: true, budgetChars: DEFAULT_BUDGET, entries: [] },
    storagePath: null,
    storageDisplay: null,
    storageError: null,
    storageWarning: null,
    savedAt: null,
    migratedFrom: null,
    sectionRegistered: false,
    sectionError: null,
  }
  let sectionDispose = null

  const describeError = (err) => {
    if (err === null || err === undefined) return '未知错误'
    if (typeof err === 'string') return err
    if (typeof err.message === 'string' && err.message !== '') return err.message
    return String(err)
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
   * Keep the registered section exactly in step with the stored data: present
   * when something must be injected, absent otherwise. An empty memory must
   * leave the prompt byte-identical to a deployment without this plugin.
   */
  const syncSection = () => {
    const wanted = sectionText() !== ''
    if (wanted && sectionDispose === null) {
      try {
        sectionDispose = systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: sectionText })
        state.sectionRegistered = true
        state.sectionError = null
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
    const tmpPath = storePath + '.tmp'
    const bakPath = storePath + '.bak'
    try {
      await mkdir(dirname(storePath), { recursive: true })
      await writeFile(tmpPath, serialize(), 'utf8')
      try {
        await rename(storePath, bakPath)
      } catch (err) {
        // No previous version on the very first save; anything else is real.
        if (err.code !== 'ENOENT') throw err
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
      state.savedAt = Date.now()
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

    // 1. The canonical location under the harness home.
    try {
      const parsed = await readStoreFile(storePath)
      if (parsed !== null) {
        const loaded = normalizeData(parsed)
        state.data = loaded.data
        state.storageWarning = droppedEntriesMessage(loaded.dropped)
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
        return
      }
    } catch (err) {
      // A missing or unreadable legacy file must never block a fresh store.
      if (err instanceof SyntaxError) state.storageError = '旧位置文件解析失败，已忽略：' + describeError(err)
    }

    // 3. First run: materialise an empty store so the path is real and the
    //    settings page can show it.
    await writeToDisk()
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
        warning: state.storageWarning,
        savedAt: state.savedAt,
        migratedFrom: state.migratedFrom,
      },
      injection: {
        registered: state.sectionRegistered,
        available: true,
        error: state.sectionError,
        chars: preview.length,
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

  const saveEntry = (raw) => enqueue(async () => {
    const entry = sanitizeEntry(raw)
    if (entry === null) return { ok: false, saved: false, message: '标题与指令内容不能同时为空', snapshot: snapshot() }
    entry.updatedAt = Date.now()
    const list = state.data.entries
    const index = list.findIndex((candidate) => candidate.id === entry.id)
    if (index >= 0) list[index] = entry
    else {
      if (list.length >= MAX_ENTRIES) {
        return { ok: false, saved: false, message: '最多保存 ' + MAX_ENTRIES + ' 条指令', snapshot: snapshot() }
      }
      list.push(entry)
    }
    syncSection()
    const saved = await writeToDisk()
    // A successful save has rewritten the file to match memory, so a
    // dropped-entries warning from load time ("they will be removed on the
    // next save") has played out and must not keep showing.
    if (saved) state.storageWarning = null
    return settle(null, saved)
  })

  const deleteEntry = (id) => enqueue(async () => {
    state.data.entries = state.data.entries.filter((entry) => entry.id !== id)
    syncSection()
    const saved = await writeToDisk()
    if (saved) state.storageWarning = null
    return settle(null, saved)
  })

  const setOptions = (patch) => enqueue(async () => {
    if (patch !== null && typeof patch === 'object') {
      if (typeof patch.enabled === 'boolean') state.data.enabled = patch.enabled
      if (typeof patch.budgetChars === 'number' && Number.isFinite(patch.budgetChars)) {
        state.data.budgetChars = clampBudget(patch.budgetChars)
      }
    }
    syncSection()
    const saved = await writeToDisk()
    if (saved) state.storageWarning = null
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
    const existing = state.data.entries
    const seenIds = new Set(existing.map((entry) => entry.id))
    const seenBodies = new Set(existing.map((entry) => entry.title + '\u0000' + entry.content))
    let imported = 0
    let skipped = 0
    for (const candidate of rawEntries) {
      const entry = sanitizeEntry(candidate)
      if (entry === null || seenIds.has(entry.id) || seenBodies.has(entry.title + '\u0000' + entry.content)) {
        skipped += 1
        continue
      }
      if (existing.length >= MAX_ENTRIES) {
        skipped += 1
        continue
      }
      entry.updatedAt = Date.now()
      existing.push(entry)
      seenIds.add(entry.id)
      seenBodies.add(entry.title + '\u0000' + entry.content)
      imported += 1
    }
    if (imported === 0) {
      return { ok: true, saved: true, message: '没有新增条目：' + skipped + ' 条已存在或无效', snapshot: snapshot() }
    }
    syncSection()
    const saved = await writeToDisk()
    if (saved) state.storageWarning = null
    return settle('导入完成：新增 ' + imported + ' 条，跳过 ' + skipped + ' 条（已存在或无效）', saved)
  })

  const dispatch = async (method, args) => {
    await boot
    switch (method) {
      case 'state':
        // Same envelope as every other method. One response shape means the
        // Client can never again be handed a payload it silently ignores.
        return { ok: true, saved: true, message: null, snapshot: snapshot() }
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

  let routeDispose = null
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const handler = (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, message: 'only POST is supported' }))
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
    try {
      routeDispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    } catch (err) {
      console.error('[instruction-memory] route registration failed:', err)
      routeDispose = null
    }
  } else {
    console.error('[instruction-memory] webServer unavailable: settings page will not be able to reach the host')
  }

  ctx.effect(() => () => {
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
}

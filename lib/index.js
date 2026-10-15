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
 *
 * Storage format v2 (F13 多情境配置集 / instruction sets): the file holds a
 * named `sets` list plus one flat `entries`/`profiles` array where every item
 * carries a `setId`; `activeSetId` names the one set that is injected. A v1
 * file (no `sets` field) loads transparently — every item is folded into the
 * single 默认 set — and is rewritten as v2 by the next save. Switching the
 * active set is ALWAYS an explicit user command; nothing here ever derives a
 * set from the process cwd (a real incident: a cwd-derived store location made
 * memory appear to vanish when the user relaunched from another directory).
 *
 * Also in v2: timestamped history snapshots (F14) written into a `history/`
 * subdirectory — deliberately NOT into the watched store directory entry that
 * `fs.watch` listens on — a JSON Schema shipped for hand editing (F15), a raw
 * source read/write pair for the settings page (F16), and an optional
 * user-chosen backup directory (F18).
 */

import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * The store format this build writes.
 *
 * v2 introduced named instruction sets (F13). The bump is not cosmetic: an
 * OLDER build of this plugin reads `version` and refuses anything that is not
 * 1, so a downgrade meets an explicit "unsupported version" refusal with
 * mutations paused instead of silently loading a v2 file as a v1 one (which
 * would hide every set name and, on the next save, rewrite the file without
 * them). v1 files keep loading here — every entry is folded into the single
 * 默认 set — and the next save writes v2.
 */
const FORMAT_VERSION = 2
const SUPPORTED_VERSIONS = [1, 2]
/** The id/name of the set a fresh or migrated store gets. Stable on purpose. */
const DEFAULT_SET_ID = 'st-default'
const DEFAULT_SET_NAME = '默认'
const MAX_SETS = 20
const MAX_SET_NAME = 30
/** Rolling history snapshots (F14): how many are kept PER writing device. */
const MAX_HISTORY = 20
const HISTORY_DIR_NAME = 'history'
/** Name of the JSON Schema shipped with the package and copied next to the store. */
const SCHEMA_FILE_NAME = 'memory.schema.json'
/** The `$schema` value written into every store file (resolves next to it). */
const SCHEMA_REF = './' + SCHEMA_FILE_NAME
/** Upper bound for a user-chosen backup directory path. */
const MAX_BACKUP_DIR = 512
const BACKUP_FILE_SUFFIX = '.bak'
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
/** Tags are short grouping labels for the settings page only; they never enter the injected block. */
const MAX_TAGS_PER_ENTRY = 8
const MAX_TAG_LENGTH = 24

/**
 * User-persona profiles ("用户形象"): facts about the USER (background,
 * preferences, personality, goals) used to tilt how answers are framed. They
 * are NOT roles the model is asked to play, and they are injected ahead of the
 * instruction block under a header that demotes them to "tilt only, never
 * override correctness or the question itself". They do not take part in the
 * per-entry budget trimming: an identity must never be silently dropped.
 */
const MAX_PROFILES = 50
const MAX_PROFILE_NAME = 40
const MAX_PROFILE_CONTENT = 4000

/**
 * The batch operations the `batch` route accepts. Kept here so the command and
 * the route's dispatch share one list.
 */
const BATCH_OPS = ['set-enabled', 'set-priority', 'add-tags', 'remove-tags', 'delete']

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
export const MAX_BODY_CHARS = (MAX_ENTRIES * (MAX_CONTENT + MAX_TITLE + MAX_WHEN + MAX_TAGS_PER_ENTRY * MAX_TAG_LENGTH + 200)
  + MAX_PROFILES * (MAX_PROFILE_CONTENT + MAX_PROFILE_NAME + 200)
  + MAX_SETS * (MAX_SET_NAME + 200)) * 2 + 100_000

/**
 * Every numeric ceiling in one object, published on the snapshot and used by
 * verify.mjs to pin `memory.schema.json` (the hand-edit JSON Schema) to the
 * code. Two sources of truth that must never drift: a schema advertising a
 * larger limit than the loader enforces would let a hand edit be silently
 * truncated while the IDE reported it as valid.
 */
export const LIMITS = Object.freeze({
  formatVersion: FORMAT_VERSION,
  maxEntries: MAX_ENTRIES,
  maxTitle: MAX_TITLE,
  maxContent: MAX_CONTENT,
  maxWhen: MAX_WHEN,
  maxTagsPerEntry: MAX_TAGS_PER_ENTRY,
  maxTagLength: MAX_TAG_LENGTH,
  maxProfiles: MAX_PROFILES,
  maxProfileName: MAX_PROFILE_NAME,
  maxProfileContent: MAX_PROFILE_CONTENT,
  maxSets: MAX_SETS,
  maxSetName: MAX_SET_NAME,
  minBudget: MIN_BUDGET,
  maxBudget: MAX_BUDGET,
  maxHistory: MAX_HISTORY,
})

/** How long a crashed holder's `memory.json.lock` may block writes before it is stolen. */
const LOCK_STALE_MS = 10_000
/** How long a write waits for the cross-process lock before proceeding unlocked. */
const LOCK_WAIT_MS = 2_000
/** Coalescing window for store-directory watcher events before a re-read. */
const WATCH_DEBOUNCE_MS = 250

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

function makeSetId() {
  return 'st-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function priorityLabel(value) {
  if (value === 2) return '高'
  if (value === 0) return '低'
  return '普通'
}

/**
 * Normalise an entry's `tags`: a de-duplicated, single-line, capped string
 * array used ONLY by the settings page for grouping/filtering. Tags never
 * appear in the injected block, so they do not touch buildBlock. Exported for
 * tests and reused by the batch "add-tags" path so both merge through one
 * rule. Non-array input (an old/hand-made entry without tags) is simply no
 * tags, not an error; non-string/blank items are dropped; anything past
 * MAX_TAGS_PER_ENTRY is ignored after de-duplication.
 */
export function sanitizeTags(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    // Collapse ALL whitespace runs (newlines and repeated spaces) so the same
    // typed label normalises identically whether it came from the editor's
    // tag box, an import, or a hand edit — otherwise "a b" and "a  b" would
    // both survive and fail to de-duplicate.
    const tag = singleLine(item, MAX_TAG_LENGTH).replace(/\s+/g, ' ').trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    if (out.length >= MAX_TAGS_PER_ENTRY) break
    out.push(tag)
  }
  return out
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
    tags: sanitizeTags(raw.tags),
    /**
     * Which instruction set (F13) this entry belongs to. Preserved here — NOT
     * re-derived — because both the loader and the importer need to honour a
     * declared membership; the interactive save path overwrites it with the
     * active set instead (an edit can never move an entry between sets).
     * `normalizeData` guarantees a valid value on everything this plugin
     * serves, so a blank/absent id on a hand-built object means "unattributed"
     * (see inScope), not "no set".
     */
    setId: typeof raw.setId === 'string' && raw.setId !== '' ? raw.setId.slice(0, 64) : '',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/**
 * Normalise one instruction set (F13).
 *
 * Shape: { id, name }. A set carries no content of its own — entries and
 * user profiles point AT it through `setId` — so "switching the active set"
 * never moves a byte of user text, which is what makes the operation safe to
 * perform in one transaction. `id` is stable (it is what every item stores);
 * `name` is a short single-line label. A blank name is rejected (null): unlike
 * an entry, a set has nothing else to derive a label from.
 */
export function sanitizeSet(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const name = singleLine(raw.name, MAX_SET_NAME)
  if (name === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : makeSetId(),
    name,
  }
}

/**
 * Normalise one "用户形象" (a fact about the USER, not a role for the model).
 *
 * Shape: { id, name, content, enabled, updatedAt }. `name` is a short single-
 * line topic label ("职业背景"、"沟通偏好"、"性格"、"长期追求"); `content` is
 * the multi-line description. Both blank means the profile is discarded
 * (returns null) the same way a blank entry is. A blank name falls back to the
 * first 20 characters of the content so an unnamed profile is still listable.
 * Exported for tests.
 */
export function sanitizeProfile(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const name = singleLine(raw.name, MAX_PROFILE_NAME)
  const content = cleanText(raw.content, MAX_PROFILE_CONTENT)
  if (name === '' && content === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : makeId(),
    name: name === '' ? singleLine(content, 20) : name,
    content,
    enabled: raw.enabled !== false,
    /** Instruction set membership (F13); see the note in sanitizeEntry. */
    setId: typeof raw.setId === 'string' && raw.setId !== '' ? raw.setId.slice(0, 64) : '',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/**
 * The scope decision behind everything that renders or lists items: with a
 * usable `sets` list plus a matching `activeSetId`, only the active set is in
 * scope; without them the store is the legacy single-set shape and everything
 * is in scope.
 *
 * Exported because THREE places must never disagree — the injection planner,
 * the snapshot the settings page renders, and the commands that edit — and a
 * missed filter here is exactly how a 某客户 set would leak into a 个人
 * conversation. One predicate, used three times.
 *
 * The fallback when `activeSetId` names nothing (a hand-edited file): the
 * FIRST set, which is also what normalizeData adopts. That keeps a pure
 * consumer (planInjection called directly, as the tests do) in agreement with
 * the loader instead of inventing a third behaviour.
 */
export function activeScope(data) {
  if (data === null || typeof data !== 'object') return { scoped: false, activeId: '', ids: [] }
  const sets = (Array.isArray(data.sets) ? data.sets : [])
    .filter((set) => set !== null && typeof set === 'object' && typeof set.id === 'string' && set.id !== '')
  if (sets.length === 0) return { scoped: false, activeId: '', ids: [] }
  const wanted = typeof data.activeSetId === 'string' && data.activeSetId !== '' ? data.activeSetId : ''
  const activeId = sets.some((set) => set.id === wanted) ? wanted : sets[0].id
  return { scoped: true, activeId, ids: sets.map((set) => set.id) }
}

/**
 * Whether one entry/profile takes part under a scope from activeScope().
 * An item with no `setId` counts as belonging to the active set, mirroring
 * the loader's stamping rule — an unattributed item must follow the user's
 * current context rather than disappear from both the list and the prompt.
 * The comparison is exact and case-sensitive: set ids are minted here.
 */
export function inScope(item, scope) {
  if (scope === null || typeof scope !== 'object' || scope.scoped !== true) return true
  const id = item !== null && typeof item === 'object' && typeof item.setId === 'string' ? item.setId : ''
  return id === '' || id === scope.activeId
}

/* ------------------------------------------------------------------ *
 * History snapshot naming (F14) — pure, so the format is pinnable
 * ------------------------------------------------------------------ */

/**
 * A filesystem-safe UTC stamp: `20261015T072355123Z`. Fixed width, so plain
 * lexicographic sorting on a filename is chronological sorting — which is what
 * lets the history index sort without reading a single file.
 */
export function historyStamp(epoch) {
  const date = new Date(epoch)
  const pad = (value, width) => String(value).padStart(width, '0')
  return pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1, 2) + pad(date.getUTCDate(), 2)
    + 'T' + pad(date.getUTCHours(), 2) + pad(date.getUTCMinutes(), 2) + pad(date.getUTCSeconds(), 2)
    + pad(date.getUTCMilliseconds(), 3) + 'Z'
}

/** This machine's short tag, used so two devices sharing one backup folder stay distinguishable. */
export function deviceTag(rawHostname) {
  const source = typeof rawHostname === 'string' && rawHostname !== '' ? rawHostname : 'unknown'
  const tag = source.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16)
  return tag === '' ? 'unknown' : tag
}

/**
 * `20261015T072355123Z-r12-laptop.json` — stamp, revision, writing device.
 * The revision is IN the name so a snapshot is identifiable in a plain file
 * listing, and the device tag is sanitised to `[a-z0-9_]` so it can never be
 * confused with the separators.
 */
export function historyFileName(epoch, rev, device) {
  return historyStamp(epoch) + '-r' + (Number.isFinite(rev) ? rev : 0) + '-' + device + '.json'
}

/**
 * What counts as one of OUR snapshots, and what we are therefore allowed to
 * prune or delete. Anything else in the history directory — a hand-made file,
 * another tool's backup, a cloud client's conflict copy — fails this pattern
 * and is left strictly alone.
 */
export const HISTORY_FILE_PATTERN = /^\d{8}T\d{9}Z-r\d+-[a-z0-9_]+(?:\.json)$/

/** The device tag inside a snapshot name, or '' when the name is not ours. */
export function historyDeviceOf(name) {
  if (typeof name !== 'string') return ''
  const match = /-r\d+-([a-z0-9_]+)\.json$/.exec(name)
  return match === null ? '' : match[1]
}

/** The revision inside a snapshot name, or 0 when the name is not ours. */
export function historyRevOf(name) {
  if (typeof name !== 'string') return 0
  const match = /-r(\d+)-[a-z0-9_]+\.json$/.exec(name)
  return match === null ? 0 : Number(match[1])
}

/** The epoch (ms) from a snapshot name's UTC stamp, or 0 when it is not ours. */
export function historyEpochOf(name) {
  if (typeof name !== 'string') return 0
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-r/.exec(name)
  if (match === null) return 0
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]),
  )
}

/** Exported for the settings page: the stamp a manual export file carries. */
export function exportFileName(epoch) {
  const stamp = historyStamp(epoch)
  return 'dsh-instruction-memory-' + stamp.slice(0, 8) + '-' + stamp.slice(9, 15) + 'Z.json'
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

/** Same disclosure as truncatedFields, but for a profile's name/content. */
export function truncatedProfileFields(raw) {
  if (raw === null || typeof raw !== 'object') return []
  const cut = []
  const unlimited = Number.MAX_SAFE_INTEGER
  if (typeof raw.name === 'string' && singleLine(raw.name, unlimited) !== singleLine(raw.name, MAX_PROFILE_NAME)) cut.push('形象名称')
  if (typeof raw.content === 'string' && cleanText(raw.content, unlimited) !== cleanText(raw.content, MAX_PROFILE_CONTENT)) cut.push('形象内容')
  return cut
}

/** Same disclosure, for an instruction set's name. */
export function truncatedSetFields(raw) {
  if (raw === null || typeof raw !== 'object') return []
  const unlimited = Number.MAX_SAFE_INTEGER
  return typeof raw.name === 'string' && singleLine(raw.name, unlimited) !== singleLine(raw.name, MAX_SET_NAME)
    ? ['配置集名称']
    : []
}

/** JSON.stringify keeps quotes/type visible; the String() tail is for values JSON cannot encode. */
const describeValue = (value) => {
  const text = JSON.stringify(value)
  return typeof text === 'string' ? text : String(value)
}

/**
 * Load a parsed memory file. Returns the sanitized data plus how many array
 * items were discarded (blank entries, or valid ones past the cap). The count
 * is surfaced rather than swallowed because the next save rewrites the file
 * without those items — silently destroying user data is exactly what this
 * plugin must never do.
 *
 * `rev` is the store revision, bumped on every committed write and persisted
 * in the file. Clients echo it back as `baseRev` so a write built on a stale
 * snapshot (another window, another process) can be refused instead of
 * silently overwriting it. Missing (pre-rev files) reads as 0.
 *
 * Format versions: 1 and 2 both load; anything else numeric sets
 * `rejectedVersion` and leaves the data untouched — a future format's fields
 * cannot be best-effort parsed, and adopting a misread would let the next save
 * rewrite the file in the wrong shape. A MISSING version still loads as v1 —
 * the field has been written as 1 since the first release, so absence is an
 * old/hand-made file, not a foreign format.
 *
 * v1 → v2 (F13) is fully automatic and never loses an item: with no usable
 * `sets` list the store gets one 默认 set, and every entry/profile is stamped
 * with its id. Items already naming a set that does not exist are re-attributed
 * to the active set and COUNTED (`reattributed`), because that is a hand edit
 * this loader had to overrule and the user must be told.
 *
 * `optionFixes` lists options the file carried but the loader had to correct
 * (a non-boolean `enabled`, an out-of-range or non-numeric `budgetChars`, a
 * non-string/over-long `backupDir`, an `activeSetId` naming no set). Each is a
 * human-readable "field 原值 → 修正值 (原因)" string, surfaced the same way as
 * `dropped`: the next save persists the corrected values, so the user must be
 * told their hand edit did not survive verbatim.
 */
function normalizeData(raw) {
  const data = {
    version: FORMAT_VERSION,
    rev: 0,
    enabled: true,
    budgetChars: DEFAULT_BUDGET,
    backupDir: '',
    activeSetId: DEFAULT_SET_ID,
    sets: [],
    entries: [],
    profiles: [],
  }
  const loaded = { data, dropped: 0, droppedProfiles: 0, droppedSets: 0, reattributed: 0, optionFixes: [], formatNote: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return loaded
  if (typeof raw.version === 'number' && !SUPPORTED_VERSIONS.includes(raw.version)) {
    return { data, dropped: 0, droppedProfiles: 0, droppedSets: 0, reattributed: 0, optionFixes: [], rejectedVersion: raw.version }
  }
  if (typeof raw.rev === 'number' && Number.isFinite(raw.rev) && raw.rev >= 0) {
    data.rev = Math.round(raw.rev)
  }
  // Hand-edited options the loader has to correct are disclosed, not silently
  // adopted: the next save would otherwise rewrite the file with the fixed
  // values and the user would never learn their edit had been ignored.
  const optionFixes = loaded.optionFixes
  if (typeof raw.enabled === 'boolean') {
    data.enabled = raw.enabled
  } else if ('enabled' in raw) {
    optionFixes.push('enabled ' + describeValue(raw.enabled) + ' → true（需要 true/false）')
  }
  if ('budgetChars' in raw) {
    const clamped = clampBudget(raw.budgetChars)
    if (clamped !== raw.budgetChars) {
      optionFixes.push(typeof raw.budgetChars === 'number' && Number.isFinite(raw.budgetChars)
        ? 'budgetChars ' + raw.budgetChars + ' → ' + clamped + '（有效范围 ' + MIN_BUDGET + '–' + MAX_BUDGET + '）'
        : 'budgetChars ' + describeValue(raw.budgetChars) + ' → ' + clamped + '（需要 ' + MIN_BUDGET + '–' + MAX_BUDGET + ' 的数字）')
    }
    data.budgetChars = clamped
  }
  // Custom backup location (F18). A path is machine-local data, so anything
  // unusable is dropped rather than guessed at — with a disclosure, because a
  // silently ignored path would look like "backups point there" while they do
  // not.
  if (typeof raw.backupDir === 'string') {
    const wanted = raw.backupDir.trim()
    if (wanted.length > MAX_BACKUP_DIR) {
      optionFixes.push('backupDir 超过 ' + MAX_BACKUP_DIR + ' 字符上限 → 已清空')
    } else {
      data.backupDir = wanted
    }
  } else if ('backupDir' in raw && raw.backupDir !== null && raw.backupDir !== '') {
    optionFixes.push('backupDir ' + describeValue(raw.backupDir) + ' → ""（需要字符串路径）')
  }

  // Instruction sets (F13). A missing/blank list means a v1 file (or a hand
  // edit that removed it): synthesise the single 默认 set and record the fact,
  // so the panel can say what happened instead of appearing to have invented a
  // set out of nowhere.
  const rawSets = Array.isArray(raw.sets) ? raw.sets : []
  const seenSetIds = new Set()
  let synthesized = false
  for (const candidate of rawSets) {
    const set = sanitizeSet(candidate)
    if (set === null || data.sets.length >= MAX_SETS) {
      loaded.droppedSets += 1
      continue
    }
    if (seenSetIds.has(set.id)) set.id = makeSetId()
    seenSetIds.add(set.id)
    data.sets.push(set)
  }
  if (data.sets.length === 0) {
    data.sets.push({ id: DEFAULT_SET_ID, name: DEFAULT_SET_NAME })
    synthesized = true
  }
  const rawActive = typeof raw.activeSetId === 'string' ? raw.activeSetId.trim() : ''
  if (rawActive !== '' && data.sets.some((set) => set.id === rawActive)) {
    data.activeSetId = rawActive
  } else {
    data.activeSetId = data.sets[0].id
    if (rawActive !== '') {
      optionFixes.push('activeSetId ' + describeValue(raw.activeSetId) + ' → ' + data.activeSetId + '（没有该配置集）')
    } else if ('activeSetId' in raw && raw.activeSetId !== null) {
      optionFixes.push('activeSetId ' + describeValue(raw.activeSetId) + ' → ' + data.activeSetId + '（需要配置集 id 字符串）')
    }
  }
  const knownSet = (id) => data.sets.some((set) => set.id === id)
  // A silent load is the normal path on a current-format file; everything else
  // is stated outright, because both branches change what the NEXT save writes.
  const declaredVersion = typeof raw.version === 'number' ? raw.version : null
  if (synthesized) {
    loaded.formatNote = '存储文件未包含配置集信息（' + (declaredVersion !== null ? '格式版本 ' + declaredVersion : '未声明格式版本')
      + '），其中的条目与形象已归入「' + DEFAULT_SET_NAME + '」配置集；下次保存时文件将写为格式版本 ' + FORMAT_VERSION
  } else if (declaredVersion !== FORMAT_VERSION) {
    loaded.formatNote = declaredVersion === null
      ? '存储文件未声明格式版本，已按格式版本 ' + FORMAT_VERSION + ' 载入；下次保存时文件将补写版本号'
      : '存储文件为旧版格式（版本 ' + declaredVersion + '），已按格式版本 ' + FORMAT_VERSION + ' 载入；下次保存时文件将写为版本 ' + FORMAT_VERSION
  }

  const list = Array.isArray(raw.entries) ? raw.entries : []
  const seen = new Set()
  for (const candidate of list) {
    const entry = sanitizeEntry(candidate)
    if (entry === null) {
      loaded.dropped += 1
      continue
    }
    if (data.entries.length >= MAX_ENTRIES) {
      loaded.dropped += 1
      continue
    }
    if (seen.has(entry.id)) entry.id = makeId()
    seen.add(entry.id)
    if (entry.setId === '' || !knownSet(entry.setId)) {
      // A blank setId is simply an unfiled item (v1 file, hand-added entry) and
      // files silently; a NON-blank id naming a set that does not exist is a
      // broken reference the loader overrules, and that is counted.
      if (entry.setId !== '') loaded.reattributed += 1
      entry.setId = data.activeSetId
    }
    data.entries.push(entry)
  }
  // User profiles ("用户形象") follow the same tolerant rules: a missing
  // field on an old/hand-made file is just an empty list; blank or
  // over-cap profiles are dropped and counted for disclosure, never adopted
  // silently (the next save rewrites the file without them).
  const profileList = Array.isArray(raw.profiles) ? raw.profiles : []
  const seenProfileIds = new Set()
  for (const candidate of profileList) {
    const profile = sanitizeProfile(candidate)
    if (profile === null || data.profiles.length >= MAX_PROFILES) {
      loaded.droppedProfiles += 1
      continue
    }
    if (seenProfileIds.has(profile.id)) profile.id = makeId()
    seenProfileIds.add(profile.id)
    if (profile.setId === '' || !knownSet(profile.setId)) {
      if (profile.setId !== '') loaded.reattributed += 1
      profile.setId = data.activeSetId
    }
    data.profiles.push(profile)
  }
  return loaded
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
    version: FORMAT_VERSION,
    rev: data.rev || 0,
    enabled: data.enabled === true,
    budgetChars: data.budgetChars,
    backupDir: typeof data.backupDir === 'string' ? data.backupDir : '',
    activeSetId: data.activeSetId,
    sets: (Array.isArray(data.sets) ? data.sets : []).map((set) => ({ ...set })),
    entries: (Array.isArray(data.entries) ? data.entries : []).map((entry) => ({ ...entry })),
    profiles: (Array.isArray(data.profiles) ? data.profiles : []).map((profile) => ({ ...profile })),
  }
}

const droppedEntriesMessage = (count) =>
  count > 0
    ? '存储文件中有 ' + count + ' 条条目未能载入（内容为空或超过 ' + MAX_ENTRIES + ' 条上限）；下次保存时它们将从文件中移除'
    : null

const droppedProfilesMessage = (count) =>
  count > 0
    ? '存储文件中有 ' + count + ' 个用户形象未能载入（名称与内容同时为空或超过 ' + MAX_PROFILES + ' 个上限）；下次保存时它们将从文件中移除'
    : null

const droppedSetsMessage = (count) =>
  count > 0
    ? '存储文件中有 ' + count + ' 个配置集未能载入（名称为空或超过 ' + MAX_SETS + ' 个上限）；下次保存时它们将从文件中移除，其条目会归入当前配置集'
    : null

const reattributedMessage = (count) =>
  count > 0
    ? '存储文件中有 ' + count + ' 项（条目或形象）指向不存在的配置集，已归入当前配置集'
    : null

/**
 * The load-time disclosures for one normalizeData result: dropped entries and
 * corrected hand-edited options, joined with a full-width semicolon.
 * Returns null when neither applies, so callers can assign it directly to
 * `state.storageWarning` (a null means "no warning", not an empty string).
 */
const loadWarnings = (loaded) => {
  const parts = []
  if (typeof loaded.formatNote === 'string' && loaded.formatNote !== '') parts.push(loaded.formatNote)
  const dropped = droppedEntriesMessage(loaded.dropped)
  if (dropped !== null) parts.push(dropped)
  const droppedProfiles = droppedProfilesMessage(loaded.droppedProfiles || 0)
  if (droppedProfiles !== null) parts.push(droppedProfiles)
  const droppedSets = droppedSetsMessage(loaded.droppedSets || 0)
  if (droppedSets !== null) parts.push(droppedSets)
  const reattributed = reattributedMessage(loaded.reattributed || 0)
  if (reattributed !== null) parts.push(reattributed)
  if (Array.isArray(loaded.optionFixes) && loaded.optionFixes.length > 0) {
    parts.push('存储文件中的以下选项值无效，已按规则修正：' + loaded.optionFixes.join('；') + '；下次保存时修正值将写入文件')
  }
  return parts.length > 0 ? parts.join('；') : null
}

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
 *
 * HTTP requires IPv6 literals in Host to wear brackets, so the bracketed
 * form is the one real traffic uses; the bare form still has to parse instead
 * of being chopped at the last colon (the old code turned a bare `::1` into
 * `:`, which never matched the loopback set). A bare value carrying MORE than
 * one colon is an IPv6 literal with no port — with at most one colon it is
 * host:port.
 */
export function hostnameOf(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return ''
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  // Unbracketed IPv6 literal: the colons are part of the address, not a port.
  if (trimmed.indexOf(':') !== trimmed.lastIndexOf(':')) return trimmed
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/**
 * Normalise a hostname the same way on BOTH sides of the Origin comparison.
 *
 * `new URL('http://[::1]:8080').hostname` keeps the brackets (`[::1]`), while
 * `hostnameOf('[::1]:8080')` strips them (`::1`) — comparing the two raw forms
 * rejected every same-origin request that reached the GUI over IPv6 loopback.
 * Strip one surrounding pair of brackets here so both sides spell an IPv6
 * literal identically.
 */
const normalizeHostname = (value) => (
  typeof value === 'string' && value.startsWith('[') && value.endsWith(']') && value.length >= 2
    ? value.slice(1, -1)
    : value
)

/**
 * Expand an IPv6 literal to eight lower-cased zero-padded groups, translating a
 * trailing embedded IPv4 suffix to two hex groups. Returns null for anything
 * that is not a valid literal.
 *
 * Needed because the two sides of the Origin check spell the SAME address
 * differently: a browser sends Host `[::ffff:127.0.0.1]` while the URL parser
 * canonicalises Origin to `[::ffff:7f00:1]` — text comparison says these are
 * different; address comparison must say they are the same.
 */
export function canonicalIp(value) {
  if (typeof value !== 'string') return null
  let addr = normalizeHostname(value.trim().toLowerCase())
  const percent = addr.indexOf('%')
  if (percent !== -1) addr = addr.slice(0, percent)
  if (isIP(addr) === 4) {
    return 'v4:' + addr.split('.').map((part) => Number(part)).join('.')
  }
  if (isIP(addr) !== 6) return null

  // Translate a trailing dotted-quad (e.g. ::ffff:127.0.0.1) into two groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  if (v4 !== null) {
    const octets = v4[1].split('.').map((part) => Number(part))
    if (octets.some((octet) => octet > 255)) return null
    const prefix = addr.slice(0, v4.index)
    const hi = (octets[0] << 8 | octets[1]).toString(16)
    const lo = (octets[2] << 8 | octets[3]).toString(16)
    // Keep the trailing ':' of the prefix as the separator before the two
    // translated groups; it may also be the second ':' of a '::' compression,
    // which must survive (so do not strip a leading colon afterwards).
    addr = (prefix.endsWith(':') ? prefix : prefix + ':') + hi + ':' + lo
  }

  const halves = addr.split('::')
  if (halves.length > 2) return null
  if (halves.length === 1) {
    const groups = halves[0].split(':')
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null
    return groups.map((group) => parseInt(group, 16).toString(16).padStart(4, '0')).join(':')
  }
  const [leftRaw, rightRaw] = halves
  const left = leftRaw === '' ? [] : leftRaw.split(':')
  const right = rightRaw === '' ? [] : rightRaw.split(':')
  const missing = 8 - left.length - right.length
  if (missing < 0) return null
  const groups = left.concat(Array(missing).fill('0'), right)
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null
  return groups.map((group) => parseInt(group, 16).toString(16).padStart(4, '0')).join(':')
}

/** Whether two hostnames are the same endpoint: exact text or same IP literal. */
const sameHostname = (a, b) => {
  if (a === b) return true
  const ca = canonicalIp(a)
  const cb = canonicalIp(b)
  return ca !== null && cb !== null && ca === cb
}

/** Loopback by exact name or by equivalent IP spelling (mapped/hex forms). */
const isLoopbackName = (name) => {
  if (LOOPBACK_HOSTNAMES.has(name)) return true
  const canonical = canonicalIp(name)
  if (canonical === null) return false
  for (const known of LOOPBACK_HOSTNAMES) {
    const knownCanonical = canonicalIp(known)
    if (knownCanonical !== null && knownCanonical === canonical) return true
  }
  return false
}

/**
 * Why the settings-page route checks `Host`, `Origin` and `Sec-Fetch-Site` at
 * all, when it already refuses any content-type that is not
 * `application/json`.
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
 * loopback `Host`. An operator who binds a non-loopback address (`0.0.0.0`,
 * `::`, or a concrete one) has deliberately published the server beyond this
 * machine, where no Host value can be known in advance — the check is disabled
 * there rather than breaking every legitimate client, and that trade-off is
 * documented in the README.
 *
 * `Sec-Fetch-Site` adds a second browser-only signal (absent from curl, Node,
 * and pre-2020 browsers, which is exactly why it can only ADD rejections, never
 * replace the checks above): a modern browser stamps every request with it, so
 * a page at evil.com talking to this route — even through tricks that drop the
 * `Origin` header — still says `cross-site`. Only `cross-site` is refused;
 * `same-site` must pass because schemeful same-site ignores ports (the GUI and
 * the route live on the same host but different ports), and local non-browser
 * clients never send the header at all, so they are governed by the Host and
 * content-type checks alone.
 */
export function requestOriginVerdict(headers, guarded) {
  const read = (name) => {
    if (headers === null || typeof headers !== 'object') return ''
    const value = headers[name]
    return typeof value === 'string' ? value : ''
  }
  const requestHost = read('host').trim().toLowerCase()
  const requestHostname = hostnameOf(requestHost)

  if (guarded && !isLoopbackName(requestHostname)) {
    return { ok: false, reason: 'Host 头不是回环地址（可能是 DNS 重绑定攻击）：' + (requestHost === '' ? '(缺失)' : requestHost) }
  }

  const fetchSite = read('sec-fetch-site').trim().toLowerCase()
  if (fetchSite === 'cross-site') {
    return { ok: false, reason: '请求被浏览器标记为跨站（Sec-Fetch-Site: cross-site）' }
  }

  const origin = read('origin').trim()
  if (origin !== '') {
    let originHostname = ''
    try {
      // URL.hostname keeps the brackets on an IPv6 literal; normalizeHostname
      // takes them off so it can meet the bracket-free Host parsing on equal
      // terms.
      originHostname = normalizeHostname(new URL(origin).hostname.toLowerCase())
    } catch {
      originHostname = ''
    }
    // Compare hostnames, not host:port: a proxy may rewrite the port, and the
    // hostname is the part rebinding actually attacks. `Origin: null`
    // (sandboxed iframe, file://) parses to no hostname and is refused.
    // Canonical IP comparison covers the two spellings of one address:
    // ::1 vs [::1], and ::ffff:127.0.0.1 vs ::ffff:7f00:1.
    if (originHostname === '' || !sameHostname(originHostname, requestHostname)) {
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
 * Build the injection plan: the exact text assembled into the system prompt
 * PLUS the per-entry decisions behind it, so the settings page can show how
 * much of the character budget is in use and flag the enabled entries the
 * current budget leaves out.
 *
 * Deliberately deterministic: identical memory produces a byte-identical
 * plan on every step, so the prompt prefix stays cacheable across a session.
 *
 * Returned shape:
 *   {
 *     text:        string  — exactly what buildBlock() returns
 *     budget:      number  — the clamped budgetChars in effect
 *     activeCount: number  — enabled, non-blank candidates considered
 *     included:    [{ id, chars, truncated }] — entries that reach the prompt,
 *                    in consideration order (始终 first, then 按需; within
 *                    each, priority desc then updatedAt desc); chars is the
 *                    rendered length of that entry's block (its cut length
 *                    when truncated)
 *     omitted:     [{ id, chars }] — active entries the budget could not fit;
 *                    chars is the full rendered block length they would need
 *   }
 *
 * Disabled or blank entries are candidates for neither list: they are not
 * competing for the budget at all. When nothing renders, `text` is '' and
 * `included` is [] even though `budget` still reports the effective ceiling.
 */
/**
 * The persona ("用户形象") preamble. One fixed header whether one or several
 * profiles are active: each is a SIDE of the same user (background, tastes,
 * personality, goals), so there is no "play multiple roles" framing. The
 * wording deliberately demotes the whole section to a tilt on framing —
 * correctness, completeness and the question itself always win.
 */
const PERSONA_HEADER = [
  '## 关于用户（用户形象）',
  '以下是用户本人提供的个人形象信息，描述其身份背景、喜好、性格与追求，不是要求你扮演的角色。请在保证回答正确、完整、客观且紧扣问题本身的前提下，结合这些信息调整解释的深浅、详略、举例与建议的侧重；不得为了迎合这些信息而改变事实、省略必要的风险提示或偏离问题核心；与当前问题无关时直接忽略。',
  '',
].join('\n')

/**
 * Build the persona section from enabled profiles with non-empty content, in
 * stored order. Returns the rendered text plus one { id, name, chars } item
 * per rendered profile, in the same shape the snapshot exposes. Deterministic:
 * no timestamps, no counts, identical profiles in produce byte-identical
 * text. An empty/disabled set renders to '' so callers can join unconditionally.
 */
function buildProfilesBlock(profiles) {
  const active = (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => profile !== null && typeof profile === 'object'
      && profile.enabled === true
      && typeof profile.content === 'string' && profile.content !== '')
  if (active.length === 0) return { text: '', profiles: [], chars: 0 }
  const blocks = []
  const items = []
  for (const profile of active) {
    const name = typeof profile.name === 'string' && profile.name !== ''
      ? profile.name
      : singleLine(profile.content, 20)
    const block = '### ' + name + '\n' + profile.content
    blocks.push(block)
    items.push({ id: typeof profile.id === 'string' ? profile.id : '', name, chars: block.length })
  }
  const text = PERSONA_HEADER + '\n' + blocks.join('\n\n')
  return { text, profiles: items, chars: text.length }
}

/**
 * The entry half of the plan: the existing instruction block with its budget
 * trimming. Kept as the inner function so planInjection can prepend the
 * persona section without touching (and risking) the trimming logic.
 */
function planEntries(data, budget) {
  const blank = () => ({ text: '', activeCount: 0, included: [], omitted: [] })
  if (data === null || typeof data !== 'object' || data.enabled !== true) return blank()
  const active = (Array.isArray(data.entries) ? data.entries : [])
    .filter((entry) => entry.enabled === true && entry.content !== '')
  if (active.length === 0) return blank()
  active.sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))

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
  const included = []
  const omittedPlan = []
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
      included.push({ id: entry.id, chars: block.length, truncated: false })
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
        included.push({ id: entry.id, chars: body.length, truncated: true })
        return
      }
    }
    omitted += 1
    omittedPlan.push({ id: entry.id, chars: block.length })
  }

  for (const entry of active) if (entry.mode === 'always') consider(entry, '始终')
  for (const entry of active) if (entry.mode !== 'always') consider(entry, '按需')

  if (blocks.length === 0) {
    return { text: '', budget, activeCount: active.length, included: [], omitted: omittedPlan }
  }
  return {
    text: header + blocks.join('\n\n') + footerFor(omitted),
    budget,
    activeCount: active.length,
    included,
    omitted: omittedPlan,
  }
}

/**
 * Compose the full injected section: the persona block ("关于用户", when at
 * least one profile is enabled) followed by the existing instruction block.
 *
 * Returned shape extends the entry plan with:
 *   profiles:    [{ id, name, chars }] — rendered persona profiles, in order
 *   profileChars: total characters of the persona section (0 when none)
 *   entryChars:  length of the entry half alone
 *
 * Guarantees:
 *  - zero enabled profiles => the result is byte-identical to the old
 *    entries-only plan (existing tests pin this);
 *  - personas are NOT subject to the entry budget — the budget/included/
 *    omitted fields still describe instructions only, and an identity is
 *    never silently trimmed;
 *  - a profile-only store (no instructions) still injects, and the master
 *    `enabled` switch suppresses both halves as before.
 */
export function planInjection(data) {
  const budget = clampBudget(data !== null && typeof data === 'object' ? data.budgetChars : undefined)
  const blank = () => ({
    text: '', budget, activeCount: 0, included: [], omitted: [],
    profiles: [], profileChars: 0, entryChars: 0,
  })
  if (data === null || typeof data !== 'object' || data.enabled !== true) return blank()
  /**
   * The set filter (F13) is applied HERE, at the one place both the rendered
   * text and the budget decision are produced, so no caller can inject an
   * inactive set by accident. A store with no `sets` at all is the legacy
   * single-set shape and is injected whole (see activeScope).
   */
  const scope = activeScope(data)
  const scoped = {
    ...data,
    entries: (Array.isArray(data.entries) ? data.entries : []).filter((entry) => inScope(entry, scope)),
    profiles: (Array.isArray(data.profiles) ? data.profiles : []).filter((profile) => inScope(profile, scope)),
  }
  const persona = buildProfilesBlock(scoped.profiles)
  const entryPlan = planEntries(scoped, budget)
  const parts = []
  if (persona.text !== '') parts.push(persona.text)
  if (entryPlan.text !== '') parts.push(entryPlan.text)
  return {
    text: parts.join('\n\n'),
    budget,
    activeCount: entryPlan.activeCount,
    included: entryPlan.included,
    omitted: entryPlan.omitted,
    entryChars: entryPlan.text.length,
    profiles: persona.profiles,
    profileChars: persona.chars,
  }
}

/**
 * Render the injected block text. A thin wrapper over planInjection: the
 * decision process lives in one place, and callers that only need the text
 * (the prompt section) keep this byte-stable entry point.
 */
export function buildBlock(data) {
  return planInjection(data).text
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const systemPrompt = ctx.systemPrompt

  const state = {
    data: {
      version: FORMAT_VERSION,
      rev: 0,
      enabled: true,
      budgetChars: DEFAULT_BUDGET,
      backupDir: '',
      activeSetId: DEFAULT_SET_ID,
      sets: [{ id: DEFAULT_SET_ID, name: DEFAULT_SET_NAME }],
      entries: [],
      profiles: [],
    },
    storagePath: null,
    storageDisplay: null,
    storageError: null,
    storageWarning: null,
    /** A failed rolling-backup refresh, shown only when no load warning wins. */
    backupError: null,
    /**
     * A failed history snapshot (F14). Non-fatal by design — the store itself
     * was written — but shown, because "history is being kept" is a promise the
     * panel makes on this feature's behalf.
     */
    historyError: null,
    /** Which branch of the load actually produced the current data (diagnostics). */
    loadedFrom: null,
    savedAt: null,
    migratedFrom: null,
    /**
     * Set while the store on disk declares an unsupported format version.
     * Mutating commands are refused in that state: a save would rewrite a
     * future-format file into v1, destroying whatever the newer format meant.
     */
    versionRejected: false,
    rejectedVersion: null,
    sectionRegistered: false,
    sectionError: null,
    /** Whether a store file is actually present on disk (diagnostics + the panel). */
    storeExists: false,
    /** How many history snapshots the current directory holds (diagnostics). */
    historyCount: 0,
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
   * The full injection plan (text + per-entry budget decisions) behind the
   * registered section. The snapshot publishes it so the settings page can
   * show budget usage and mark the enabled entries that currently do not fit.
   * A render failure degrades to an empty plan at the effective ceiling
   * rather than throwing into the route/SSE path.
   */
  const sectionPlan = () => {
    try {
      return planInjection(state.data)
    } catch (err) {
      console.error('[instruction-memory] render failed:', err)
      return {
        text: '', budget: clampBudget(state.data.budgetChars), activeCount: 0, included: [], omitted: [],
        profiles: [], profileChars: 0, entryChars: 0,
      }
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
    stopWatching()
    disposeStreams()
  })

  /* ---------------- external-change watching (SSE) ---------------- */

  /**
   * Live subscribers to the settings page's event stream. Each entry maps a
   * stream's `send(payload)` writer to its own teardown, so a write that fails
   * (the socket went away) can dispose THAT stream instead of just dropping
   * it from the broadcast set while its response stays open.
   */
  const sseStreams = new Map()
  let storeWatcher = null
  let watchDebounce = null

  const pushSnapshot = () => {
    if (sseStreams.size === 0) return
    const payload = 'data: ' + JSON.stringify(snapshot()) + '\n\n'
    for (const [send, cleanup] of Array.from(sseStreams)) {
      try {
        send(payload)
      } catch {
        // The response is dead: run its full teardown (end + unsubscribe),
        // not just a set delete that leaves the stream half-registered.
        cleanup()
      }
    }
  }

  /**
   * A store file changed on disk. Debounced (one atomic save fires rename +
   * copy events), then serialised through the same diskQueue as every other
   * mutation so a watcher re-read can never interleave with a save.
   *
   * The file is read WITHOUT adopting it first, because this plugin's own
   * writes fire the watcher too: if the sanitised content is identical to the
   * in-memory state, the event was ours and there is nothing to tell anyone.
   * A failed read (the file is momentarily absent mid-replace, or corrupt) is
   * skipped rather than recovered-from — recovery belongs to reload, which a
   * human asked for.
   */
  const onStoreFileEvent = () => {
    if (watchDebounce !== null) clearTimeout(watchDebounce)
    watchDebounce = setTimeout(() => {
      watchDebounce = null
      void enqueue(async () => {
        try {
          const parsed = await readStoreFile(storePath)
          if (parsed === null) return
          const loaded = normalizeData(parsed)
          if (loaded.rejectedVersion === undefined
            && JSON.stringify(loaded.data) === JSON.stringify(state.data)) {
            return
          }
          await readFromDisk()
          syncSection()
          pushSnapshot()
        } catch {
          // Transient: the next event, or the panel's 重新载入, catches up.
        }
      })
    }, WATCH_DEBOUNCE_MS)
  }

  const stopWatching = () => {
    if (watchDebounce !== null) {
      clearTimeout(watchDebounce)
      watchDebounce = null
    }
    if (storeWatcher !== null) {
      const watcher = storeWatcher
      storeWatcher = null
      try {
        watcher.close()
      } catch {
        // Already closed by the OS side.
      }
    }
  }

  /**
   * Watch the store DIRECTORY, not the file: this plugin's saves replace
   * memory.json through an atomic rename, which on Windows can orphan a
   * file-level watch handle (the watched inode is gone). Directory events
   * survive replaces. A missing directory (first run, nothing materialised
   * yet) throws and is retried by the first successful write.
   */
  const startWatching = () => {
    if (storeWatcher !== null) return
    try {
      storeWatcher = watch(dirname(storePath), { persistent: false }, (event, filename) => {
        // Only events naming memory.json matter; the .tmp/.bak/.lock churn of
        // our own writes is filtered out here (the content compare in
        // onStoreFileEvent catches what slips through).
        if (typeof filename === 'string' && filename !== basename(storePath)) return
        onStoreFileEvent()
      })
      storeWatcher.on('error', () => stopWatching())
    } catch {
      storeWatcher = null
    }
  }

  const disposeStreams = () => {
    for (const cleanup of Array.from(sseStreams.values())) {
      try {
        cleanup()
      } catch {
        // The response is already gone.
      }
    }
    sseStreams.clear()
  }

  /* ---------------- storage ---------------- */

  const storePath = resolveStorePath()

  /**
   * The exact object written to memory.json — and the one an export carries.
   *
   * `$schema` comes first on purpose: opening the file in an editor then offers
   * validation and field completion against the copy of memory.schema.json the
   * host keeps next to the store (see ensureSchemaFile). The loader ignores the
   * key, so it costs nothing to anyone who never opens the file.
   */
  const persistableData = () => ({
    $schema: SCHEMA_REF,
    version: FORMAT_VERSION,
    rev: state.data.rev || 0,
    enabled: state.data.enabled === true,
    budgetChars: clampBudget(state.data.budgetChars),
    backupDir: typeof state.data.backupDir === 'string' ? state.data.backupDir : '',
    activeSetId: state.data.activeSetId,
    sets: (Array.isArray(state.data.sets) ? state.data.sets : []).map((set) => ({ ...set })),
    entries: (Array.isArray(state.data.entries) ? state.data.entries : []).map((entry) => ({ ...entry })),
    profiles: (Array.isArray(state.data.profiles) ? state.data.profiles : []).map((profile) => ({ ...profile })),
  })

  const serialize = () => JSON.stringify(persistableData(), null, 2) + '\n'

  /* ---------------- backup location + history snapshots (F14 / F18) ---------------- */

  const backupDirOf = () => (typeof state.data.backupDir === 'string' ? state.data.backupDir : '')
  /** Where the rolling pre-write copy lives: ALWAYS next to the store (crash recovery). */
  const localBackupPath = () => storePath + BACKUP_FILE_SUFFIX
  /** The user-facing copy under a custom backup location, or null (F18). */
  const customBackupPath = () => (backupDirOf() !== '' ? join(backupDirOf(), basename(storePath) + BACKUP_FILE_SUFFIX) : null)
  /**
   * History snapshots live in a `history/` SUBDIRECTORY of the backup location
   * (default: the store directory). Two reasons for the subdirectory:
   *   1. the external-change watcher listens on the store directory and must
   *      never see a snapshot as a change to memory.json — a subdirectory is
   *      not reported by a non-recursive watch, and the filename filter drops
   *      anything that is not memory.json anyway;
   *   2. a custom (e.g. cloud-synced) backup directory stays tidy: one known
   *      folder holds the history, nothing else is touched.
   */
  const historyDirPath = () => join(backupDirOf() !== '' ? backupDirOf() : dirname(storePath), HISTORY_DIR_NAME)

  /**
   * Cross-process write lock: a `memory.json.lock` marker created exclusively
   * (`wx`) holding a random owner token, kept for the duration of one atomic
   * replace, and removed afterwards ONLY BY ITS OWNER.
   *
   * The in-process diskQueue serialises this plugin's own writes, but two DSH
   * processes sharing a `$DSH_HOME` (e.g. `web` and `tui` profiles running at
   * once) can interleave a copy-backup/atomic-rename sequence. The rename
   * itself keeps the file uncorrupted; what the lock narrows is the
   * last-write-wins window in which one process's edit silently erases the
   * other's.
   *
   * Availability beats exclusion for a user-facing store: a lock that cannot
   * be acquired within a short wait is NEVER allowed to fail the save — the
   * write proceeds anyway (disclosed in the debug log). A lock older than
   * LOCK_STALE_MS is treated as crashed-holder debris and stolen, so a killed
   * process cannot wedge every later save behind a stale marker.
   *
   * The token matters: stealing used to be a plain unlink, and the slow
   * holder's `finally` then unlinked the lock the NEW owner had just created —
   * a classic TOCTOU that silently unlocked the third writer. The marker
   * carries this attempt's UUID, and release deletes it only when the file
   * still carries that UUID, so a finished holder can never remove a lock it
   * no longer owns.
   *
   * @returns `{ path, token }` while held, or `null` when the wait elapsed
   * (the save proceeds unlocked by design).
   */
  const acquireStoreLock = async () => {
    const lockPath = storePath + '.lock'
    const token = randomUUID()
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await writeFile(lockPath, token, { flag: 'wx' })
        return { path: lockPath, token }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const info = await stat(lockPath).catch(() => null)
        if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          // Crashed-holder debris. It may be recreated by a live process
          // between this unlink and the next wx attempt — that case simply
          // loops and re-evaluates freshness instead of forcing its way in.
          await unlink(lockPath).catch(() => {})
          continue
        }
        if (Date.now() >= deadline) return null
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }

  /**
   * Release a lock only when THIS attempt still owns it. Reading the marker
   * back and comparing the token closes the window in which a finished slow
   * holder deleted a lock the next owner had already taken over.
   */
  const releaseStoreLock = async (lock) => {
    if (lock === null) return
    try {
      const owner = await readFile(lock.path, 'utf8').catch(() => null)
      if (owner === lock.token) await unlink(lock.path).catch(() => {})
    } catch {
      // Cleanup must never throw into the save's finally.
    }
  }

  /* ---------------- custom backup location (F18) ---------------- */

  /**
   * Can this directory actually hold backups right now? Setting a path is a
   * promise ("my backups live there"), so it is verified at the moment it is
   * set — exists, is a directory, and accepts a write — instead of being
   * discovered to be wrong by the first save that silently failed to copy.
   *
   * @returns null when usable, otherwise a human-readable reason.
   */
  const probeBackupDir = async (dir) => {
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) return '该路径不是目录'
    } catch {
      return '目录不存在或不可访问'
    }
    const probe = join(dir, '.dsh-instruction-memory-probe-' + randomUUID())
    try {
      await writeFile(probe, 'probe', 'utf8')
      await unlink(probe).catch(() => {})
      return null
    } catch (err) {
      return '目录不可写：' + describeError(err)
    }
  }

  /* ---------------- history snapshots and the schema copy (both best-effort) ---------------- */

  /** This machine's tag inside snapshot filenames; see deviceTag(). */
  const DEVICE = deviceTag((() => {
    try {
      return hostname()
    } catch {
      return ''
    }
  })())

  /**
   * The bytes of the most recent snapshot, so two writes that produce the same
   * file (a no-op-ish save, a repeat restore) do not each mint a "version".
   */
  let lastHistoryText = null

  /**
   * Enforce the per-device retention limit. Grouping by the device tag inside
   * the filename is deliberate: two machines sharing one backup folder (the
   * documented F18 setup) each keep MAX_HISTORY of their OWN snapshots, so one
   * device can never prune the other's history away. Files that do not match
   * our naming pattern are never touched.
   */
  const pruneHistory = async (dir) => {
    const names = (await readdir(dir)).filter((name) => HISTORY_FILE_PATTERN.test(name))
    const byDevice = new Map()
    for (const name of names) {
      const key = historyDeviceOf(name)
      const bucket = byDevice.get(key)
      if (bucket === undefined) byDevice.set(key, [name])
      else bucket.push(name)
    }
    let removed = 0
    let kept = 0
    for (const bucket of byDevice.values()) {
      // Fixed-width UTC stamp first => lexicographic order is chronological.
      bucket.sort()
      const excess = bucket.length - MAX_HISTORY
      for (let index = 0; index < bucket.length; index += 1) {
        if (index < excess) {
          await unlink(join(dir, bucket[index])).catch(() => {})
          removed += 1
        } else {
          kept += 1
        }
      }
    }
    return { removed, kept }
  }

  /**
   * Record the just-written store as a new history snapshot (F14).
   *
   * Written AFTER the atomic replace, so a snapshot always equals a state that
   * really was committed; a failure here is disclosed and never fails the save,
   * because the store itself is already safely on disk.
   */
  const writeHistorySnapshot = async (text) => {
    if (typeof text !== 'string' || text === '' || text === lastHistoryText) return
    try {
      const dir = historyDirPath()
      await mkdir(dir, { recursive: true })
      const epoch = Date.now()
      let written = false
      // `wx` never overwrites: same-millisecond saves (two rapid bulk actions)
      // bump the stamp by a millisecond instead of losing one of the two.
      for (let attempt = 0; attempt < 5 && !written; attempt += 1) {
        try {
          await writeFile(join(dir, historyFileName(epoch + attempt, state.data.rev || 0, DEVICE)), text, { encoding: 'utf8', flag: 'wx' })
          written = true
        } catch (err) {
          if (err.code !== 'EEXIST') throw err
        }
      }
      if (!written) throw new Error('快照文件名重复')
      lastHistoryText = text
      const { kept } = await pruneHistory(dir)
      state.historyCount = kept
      state.historyError = null
    } catch (err) {
      state.historyError = '版本历史快照未能写入（' + describeError(err) + '）；本次保存本身已完成'
    }
  }

  /**
   * Keep a copy of the shipped JSON Schema next to the store, so the `$schema`
   * reference inside memory.json resolves for a hand editor who has no idea
   * where the package lives. Content-compared: one small read on a save, a
   * write only when the shipped schema actually changed. Never throws — the
   * schema is a convenience, not a precondition for holding memory.
   */
  const ensureSchemaFile = async () => {
    try {
      const source = await readFile(fileURLToPath(new URL('../' + SCHEMA_FILE_NAME, import.meta.url)), 'utf8')
      const target = join(dirname(storePath), SCHEMA_FILE_NAME)
      const existing = await readFile(target, 'utf8').catch(() => null)
      if (existing !== source) await writeFile(target, source, 'utf8')
    } catch {
      // Best effort by design.
    }
  }

  /**
   * Recount the snapshot directory for the panel's diagnostics. Best effort:
   * an unreadable directory simply leaves the count as it was, because the
   * history list (the actual UI, which reports its own errors) is what the
   * user acts on.
   */
  const refreshHistoryCount = async () => {
    try {
      const names = await readdir(historyDirPath())
      state.historyCount = names.filter((name) => HISTORY_FILE_PATTERN.test(name)).length
    } catch {
      // No directory yet (nothing written) — count stays 0.
    }
  }

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
    let lock = null
    let previousRev = null
    try {
      await mkdir(dirname(storePath), { recursive: true })
      lock = await acquireStoreLock()
      if (lock === null) {
        logDebug('store lock still held by another process; writing anyway (last write wins)')
      }
      // The rev is bumped before serialising so the file on disk and the state
      // in memory agree on it; a failed write restores the old value.
      previousRev = state.data.rev || 0
      state.data.rev = previousRev + 1
      const text = serialize()
      await writeFile(tmpPath, text, 'utf8')
      // Both rolling copies stand for the PREVIOUS good version, so both are
      // taken before the atomic replace, and neither may ever be renamed into
      // place (see the long note above).
      let hadPrevious = true
      try {
        await copyFile(storePath, localBackupPath())
        state.backupError = null
      } catch (err) {
        // ENOENT is simply the very first save: there is no previous version
        // to roll. Any other failure means the promised rolling backup did not
        // happen — non-fatal for this save, because the primary is still intact
        // and the replace below is the real gate, but it must be disclosed
        // rather than swallowed.
        hadPrevious = err.code !== 'ENOENT'
        state.backupError = err.code === 'ENOENT'
          ? null
          : '上一版未能保留为 ' + localBackupPath() + '：' + describeError(err)
      }
      // The user-facing copy under a custom backup location (F18). The LOCAL
      // copy above stays the one crash recovery reads, so a failure here
      // degrades the extra copy only — never the plugin's own safety net.
      const customBak = customBackupPath()
      if (customBak !== null && hadPrevious) {
        try {
          await copyFile(storePath, customBak)
        } catch (err) {
          if (state.backupError === null) {
            state.backupError = '备份位置未能保留上一版（' + customBak + '）：' + describeError(err)
          }
        }
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
      // ...and what guarantees the store directory exists, so the watcher can
      // be (re)armed after a first run that had nothing to watch.
      startWatching()
      state.savedAt = Date.now()
      // Best-effort side files, each guarded inside itself: a failure in either
      // must never be mistaken for "the save failed" — the save already
      // committed, and the store is on disk whatever happens next.
      await writeHistorySnapshot(text)
      await ensureSchemaFile()
      logDebug('store written: ' + storePath + ' bytes=' + text.length
        + ' entries=' + state.data.entries.length + ' rev=' + state.data.rev
        + ' sets=' + state.data.sets.length + ' activeSet=' + state.data.activeSetId
        + ' history=' + state.historyCount
        + (state.backupError === null ? ' backup=refreshed' : ' backup=FAILED'))
      return true
    } catch (err) {
      if (previousRev !== null) state.data.rev = previousRev
      state.storageError = '保存失败：' + describeError(err)
      return false
    } finally {
      await releaseStoreLock(lock)
    }
  }

  const readStoreFile = async (path) => {
    const text = await readFile(path, 'utf8')
    return text.trim() === '' ? null : JSON.parse(text)
  }

  /**
   * Load the store from disk. Most branches only read; two of them also write —
   * the missing-primary recovery promotes the backup to memory.json, and the
   * legacy-location migration writes the migrated store. The return value says
   * which happened, because `reload` reports it as its `saved` field: the
   * response envelope's `saved` means "this operation persisted the store",
   * and a read-only reload claiming true would be indistinguishable from a
   * real save.
   *
   * @returns whether this load performed a successful write.
   */
  const readFromDisk = async () => {
    state.storagePath = storePath
    state.storageDisplay = storePath
    state.storageWarning = null
    state.loadedFrom = null
    state.storeExists = false
    state.versionRejected = false
    state.rejectedVersion = null

    /**
     * A store declaring an unsupported format version: adopt nothing, write
     * nothing, and say why. The one thing that must NEVER happen in this
     * state is a save — it would rewrite the file in this build's format and
     * destroy whatever the newer format meant (the mutating commands refuse
     * while versionRejected is set).
     *
     * This is also the guard that makes a DOWNGRADE safe: a file written by a
     * newer plugin (e.g. version 2 from an F13-aware build) opened by an older
     * one is refused here, with the data left untouched, instead of being
     * half-read and then rewritten without the fields the old build cannot
     * see.
     */
    const rejectVersion = (version, source) => {
      state.versionRejected = true
      state.rejectedVersion = version
      state.storageError = '存储文件声明为格式版本 ' + version + '，本插件支持的格式版本为 ' + SUPPORTED_VERSIONS.join(' / ')
        + '；已拒绝载入以防数据损坏，原文件已保留，修改操作已暂停。请升级插件，或手动将文件改回受支持的版本后点「重新载入」'
      state.loadedFrom = source + ' (unsupported version ' + version + ')'
      state.storeExists = true
    }

    // 1. The canonical location under the harness home.
    try {
      const parsed = await readStoreFile(storePath)
      if (parsed !== null) {
        const loaded = normalizeData(parsed)
        if (loaded.rejectedVersion !== undefined) {
          rejectVersion(loaded.rejectedVersion, 'memory.json')
          return false
        }
        state.data = loaded.data
        state.storageWarning = loadWarnings(loaded)
        state.loadedFrom = 'memory.json'
        state.storeExists = true
        // A real file is now in memory, so the "materialise on first need"
        // flag is spent — see ensureStoreMaterialized.
        needsMaterialize = false
      }
      state.storageError = null
      return false
    } catch (err) {
      if (err === null || err === undefined || err.code !== 'ENOENT') {
        // The main file is unreadable or corrupt. A previous good version
        // may survive in the rolling backup — recover from it rather than
        // presenting an empty memory, but say so loudly. The corrupt file
        // itself stays untouched for hand repair; it gets overwritten on the
        // next save (the pre-existing and disclosed behaviour).
        if (err instanceof SyntaxError) {
          // The file was READ and only failed to PARSE, so a store file is
          // physically present on disk. Saying onDisk=no here contradicted
          // the branch's own story ("损坏文件已保留") and produced a mounted
          // log line reading "from=memory.json.bak (main file corrupt)
          // onDisk=no". (Other non-ENOENT errors stay no: ENOTDIR, say, means
          // nothing exists at the store path at all.)
          state.storeExists = true
          try {
            const backup = await readStoreFile(storePath + '.bak')
            if (backup !== null) {
              const loaded = normalizeData(backup)
              if (loaded.rejectedVersion !== undefined) {
                rejectVersion(loaded.rejectedVersion, 'memory.json.bak')
                return false
              }
              state.data = loaded.data
              const warnings = loadWarnings(loaded)
              state.storageWarning = (warnings !== null ? warnings + '；' : '')
                + 'memory.json 解析失败（' + describeError(err) + '），已临时回退到最近备份 memory.json.bak；损坏文件已保留，下次保存时会覆盖它'
              state.loadedFrom = 'memory.json.bak (main file corrupt)'
              return false
            }
          } catch {
            // No usable backup either; fall through to the error below.
          }
        }
        // A file we cannot understand must never be silently overwritten.
        state.storageError = err instanceof SyntaxError
          ? '配置文件解析失败（' + describeError(err) + '），原文件已保留；你下次保存时会覆盖它'
          : '读取失败：' + describeError(err)
        return false
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
        if (loaded.rejectedVersion !== undefined) {
          rejectVersion(loaded.rejectedVersion, 'memory.json.bak')
          return false
        }
        state.data = loaded.data
        const promoted = await writeToDisk()
        const warnings = loadWarnings(loaded)
        state.storageWarning = (warnings !== null ? warnings + '；' : '')
          + 'memory.json 不存在，已从最近备份 memory.json.bak 恢复'
          + (promoted ? '，并已写回 memory.json' : '；写回 memory.json 失败，下次保存时会重试')
        state.loadedFrom = 'memory.json.bak (main file missing)'
        return promoted
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
        if (loaded.rejectedVersion !== undefined) {
          // A legacy file in a future format is not ours to migrate or judge.
          state.storageError = '旧位置文件为不支持的格式版本 ' + loaded.rejectedVersion + '，已忽略'
          return false
        }
        state.data = loaded.data
        state.storageWarning = loadWarnings(loaded)
        const migrated = await writeToDisk()
        if (migrated) {
          state.migratedFrom = legacyPath
          // Keep the original as evidence instead of deleting user data.
          await rename(legacyPath, legacyPath + '.migrated').catch(() => {})
        }
        state.loadedFrom = 'legacy cwd file (migrated)'
        return migrated
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
    return false
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
    /**
     * A store may have APPEARED since boot — a hand-copied memory.json, a
     * backup restored by another tool, a second process. Materialising the
     * empty in-memory store over it would destroy exactly what the user just
     * put there, so the disk is re-checked first and an existing file is
     * adopted instead. (The gap is wide enough to matter: the panel's first
     * `state` call can come minutes after boot.)
     */
    const appeared = await readStoreFile(storePath).catch(() => null)
    if (appeared !== null) {
      const wrote = await readFromDisk()
      syncSection()
      return wrote
    }
    return writeToDisk()
  }

  /* ---------------- boot ---------------- */

  // Load the store, then register the section if anything must be injected.
  // Every entry point awaits this, so a request that arrives before the disk
  // read settles can never overwrite the file with an empty in-memory state.
  //
  // `bootSettled` flips only after the read lands. The SSE connect frame is
  // gated on it: a stream opened in the gap between apply() and the read
  // finishing must wait, or its first frame would describe the EMPTY boot
  // state and the panel would flash "no instructions" before the real
  // snapshot arrived (POST /state already awaited boot; the stream did not).
  let bootSettled = false
  const boot = readFromDisk()
    .catch((err) => {
      state.storageError = '读取失败：' + describeError(err)
    })
    .then(async () => {
      bootSettled = true
      syncSection()
      await refreshHistoryCount()
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
        + ' sets=' + state.data.sets.length + ' activeSet=' + state.data.activeSetId
        + ' enabled=' + (state.data.enabled === true)
        + ' section=' + (chars > 0 ? chars + ' chars (pending assembly)' : 'nothing to inject')
        + ' pulls=' + sectionPulls
        + (state.storageError !== null ? ' error=' + state.storageError : ''))
      // Arm the external-change watcher once the store is known to exist. A
      // first run has nothing to watch yet; the first successful write rearms.
      if (state.storeExists) startWatching()
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

  /**
   * The snapshot the settings page renders (and the SSE frames carry).
   *
   * `data.entries`/`data.profiles` publish ONLY the active set (F13): the panel
   * lists and edits exactly what is being injected, so a 某客户 set can never
   * appear in the 个人 panel — the isolation guarantee the feature exists for.
   * The set list, with per-set counts and the active flag, travels in `sets`,
   * and the raw arrays are in `data.sets`/`data.activeSetId` for the switcher.
   * Anything needing the WHOLE store (export, source mode) goes through
   * persistableData(), which is also what the file holds.
   */
  const snapshot = () => {
    const plan = sectionPlan()
    const preview = plan.text
    const scope = activeScope(state.data)
    const belongsTo = (item, id) => {
      const own = item !== null && typeof item === 'object' && typeof item.setId === 'string' && item.setId !== ''
        ? item.setId
        : state.data.activeSetId
      return own === id
    }
    const activeEntries = state.data.entries.filter((entry) => inScope(entry, scope))
    const activeProfiles = state.data.profiles.filter((profile) => inScope(profile, scope))
    return {
      data: {
        version: FORMAT_VERSION,
        rev: state.data.rev || 0,
        enabled: state.data.enabled === true,
        budgetChars: clampBudget(state.data.budgetChars),
        backupDir: typeof state.data.backupDir === 'string' ? state.data.backupDir : '',
        activeSetId: state.data.activeSetId,
        sets: state.data.sets.map((set) => ({ id: set.id, name: set.name })),
        entries: activeEntries.map((entry) => ({ ...entry })),
        profiles: activeProfiles.map((profile) => ({ ...profile })),
      },
      /**
       * Instruction sets (F13): the switcher's data source. `total` counts the
       * WHOLE store (all sets), which is what the 200-entry cap is measured
       * against — the panel says "共 N 条" per active set but the cap message
       * must quote the store-wide number.
       */
      sets: {
        activeId: state.data.activeSetId,
        scoped: scope.scoped,
        total: { entries: state.data.entries.length, profiles: state.data.profiles.length },
        list: state.data.sets.map((set) => ({
          id: set.id,
          name: set.name,
          active: set.id === state.data.activeSetId,
          entries: state.data.entries.filter((entry) => belongsTo(entry, set.id)).length,
          profiles: state.data.profiles.filter((profile) => belongsTo(profile, set.id)).length,
        })),
      },
      storage: {
        path: state.storageDisplay !== null ? state.storageDisplay : state.storagePath,
        error: state.storageError,
        warning: state.storageWarning !== null ? state.storageWarning : state.backupError,
        savedAt: state.savedAt,
        migratedFrom: state.migratedFrom,
        /** false until the store file has actually been written (see readFromDisk step 3). */
        onDisk: state.storeExists,
        /** Backup location (F18): '' means "next to the store file". */
        backupDir: backupDirOf(),
        isDefaultBackupDir: backupDirOf() === '',
        /** Where the rolling pre-write copy actually sits (diagnostics). */
        backupPath: localBackupPath(),
        /** Version history (F14). */
        historyDir: historyDirPath(),
        historyCount: state.historyCount,
        historyError: state.historyError,
        schemaFile: join(dirname(storePath), SCHEMA_FILE_NAME),
      },
      injection: {
        registered: state.sectionRegistered,
        available: true,
        error: state.sectionError,
        chars: preview.length,
        /**
         * The budget decision behind `preview`, for the settings page's
         * usage meter and per-entry marks. `budget` is the effective ceiling;
         * `included`/`omitted` carry one item per active entry in
         * consideration order; disabled or blank entries appear in neither.
         */
        budget: plan.budget,
        activeCount: plan.activeCount,
        included: plan.included.map((item) => ({ id: item.id, chars: item.chars, truncated: item.truncated === true })),
        omitted: plan.omitted.map((item) => ({ id: item.id, chars: item.chars })),
        /**
         * Persona section detail: rendered profiles (id/name/chars, in order)
         * and their total size. `entryChars` is the instruction half alone,
         * which is what the budget meter measures; `chars` above stays the
         * whole section (personas + instructions) for diagnostics.
         */
        profiles: plan.profiles.map((item) => ({ id: item.id, name: item.name, chars: item.chars })),
        profileChars: plan.profileChars,
        entryChars: plan.entryChars,
        /**
         * How many times the harness has pulled this section into a prompt since
         * boot. 0 means "prepared, never assembled" — the distinction the old
         * `injected=` log line could not make.
         */
        pulls: sectionPulls,
      },
      preview,
      /**
       * `maxBodyChars` is the route's request-body ceiling, published so the
       * Client can refuse an obviously oversized import file BEFORE reading it
       * into memory. It is a character budget against byte sizes, so the
       * Client applies a generous multiplier — see importSizeVerdict there.
       */
      limits: {
        minBudget: MIN_BUDGET,
        maxBudget: MAX_BUDGET,
        maxEntries: MAX_ENTRIES,
        maxProfiles: MAX_PROFILES,
        maxProfileName: MAX_PROFILE_NAME,
        maxProfileContent: MAX_PROFILE_CONTENT,
        maxSets: MAX_SETS,
        maxSetName: MAX_SET_NAME,
        maxHistory: MAX_HISTORY,
        maxBackupDir: MAX_BACKUP_DIR,
        maxBodyChars: MAX_BODY_CHARS,
      },
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
   * Optimistic concurrency: a mutating command may carry `baseRev` — the
   * `data.rev` its caller last saw. A mismatch means another window or process
   * committed in between, and applying this command now would build on a stale
   * view (e.g. resurrect an entry another tab just deleted). The refusal hands
   * back the FRESH snapshot so the panel resyncs immediately; the user retries
   * and the retry carries the new rev.
   *
   * Absent `baseRev` (older clients) disables the check entirely — legacy
   * behaviour, not an error.
   */
  const isStaleBaseRev = (baseRev) =>
    typeof baseRev === 'number' && Number.isFinite(baseRev) && baseRev !== (state.data.rev || 0)

  const conflictResponse = () => ({
    ok: false,
    saved: false,
    conflict: true,
    message: '指令记忆刚被其他窗口或进程修改，已为你载入最新内容；请检查后重试本次操作',
    snapshot: snapshot(),
  })

  /**
   * Refusal while the store on disk declares an unsupported format version:
   * a save here would rewrite it in this build's format and destroy whatever
   * the newer format meant. The file stays untouched until the user upgrades
   * the plugin or restores a supported-version file and hits 重新载入.
   */
  const versionRefusal = () => ({
    ok: false,
    saved: false,
    message: '存储文件为不支持的格式版本 ' + state.rejectedVersion + '，修改已暂停：现在保存会用版本 ' + FORMAT_VERSION
      + ' 覆盖它，可能损坏数据。请先升级插件，或手动将文件改回受支持的版本（' + SUPPORTED_VERSIONS.join(' / ') + '）后点「重新载入」',
    snapshot: snapshot(),
  })

  /**
   * Adopt a whole parsed store — the shared core of 源码模式 (F16) and the
   * 整体替换 restore (F14). Both hand the user the SAME safety story as every
   * other entry point: only a v1/v2 store object is accepted (a stray `{}` or
   * an unrelated JSON file must never be able to wipe the store), the format
   * version gate applies, and every correction normalizeData makes is
   * reported.
   *
   * `backupDir` is deliberately NOT adopted: the backup location is
   * machine-local state, so restoring a file — from another machine, or from
   * before the path existed — must not silently redirect where backups go.
   */
  const adoptParsedStore = (parsed) => {
    const looksLikeStore = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && ['version', 'rev', 'enabled', 'budgetChars', 'backupDir', 'activeSetId', 'sets', 'entries', 'profiles']
        .some((key) => key in parsed)
    if (!looksLikeStore) {
      return {
        error: '内容不像本插件的存储文件：顶层需要是对象，且至少包含 entries / profiles / sets / version 之一。'
          + '若要清空记忆，请使用界面上的删除操作，而不是保存一个空对象',
      }
    }
    const loaded = normalizeData(parsed)
    if (loaded.rejectedVersion !== undefined) return { rejectedVersion: loaded.rejectedVersion }
    loaded.data.backupDir = backupDirOf()
    return { loaded }
  }

  /** Per-field truncation disclosure for an adopted raw store (mirrors import). */
  const truncationNotes = (parsed) => {
    const lists = [
      [parsed.entries, truncatedFields],
      [parsed.profiles, truncatedProfileFields],
      [parsed.sets, truncatedSetFields],
    ]
    let items = 0
    const fields = new Set()
    for (const [list, fieldsOf] of lists) {
      for (const raw of (Array.isArray(list) ? list : [])) {
        const cut = fieldsOf(raw)
        if (cut.length > 0) {
          items += 1
          for (const name of cut) fields.add(name)
        }
      }
    }
    return items > 0 ? '有 ' + items + ' 项超过长度上限，' + [...fields].join('、') + '已被截断' : null
  }

  const describeStoreShape = (data) =>
    data.entries.length + ' 条指令 / ' + data.profiles.length + ' 个用户形象 / ' + data.sets.length + ' 个配置集'

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
      // The write is real, so every OTHER open panel must hear about it. The
      // file watcher stays silent for this plugin's own writes (disk now
      // equals memory, see onStoreFileEvent), which is correct for recovery —
      // but a second window on the same host would otherwise sit on its stale
      // view until someone clicks 重新载入. The initiating window receives the
      // same frame and drops it client-side (identical content), so pushing to
      // everyone is safe and closing the loop needs no per-client bookkeeping.
      pushSnapshot()
      return true
    }
    logDebug('commit rolled back: the disk write failed, in-memory state restored')
    state.data = previousData
    state.storageWarning = previousWarning
    syncSection()
    return false
  }

  const saveEntry = (raw, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    const entry = sanitizeEntry(raw)
    if (entry === null) return { ok: false, saved: false, message: '标题与指令内容不能同时为空', snapshot: snapshot() }
    entry.updatedAt = Date.now()
    /**
     * The active set is authoritative for the interactive save path: the panel
     * edits what is being injected, and an edit must never be able to move an
     * item into another set (or drag one in). Moving content between sets is a
     * deliberate act — create the entry where it belongs, or use 复制配置集.
     */
    entry.setId = state.data.activeSetId
    /**
     * An id that already belongs to ANOTHER set is not this command's to
     * replace (entries are addressed by id alone): honouring it would move the
     * other set's entry into this one and overwrite its text — a cross-set
     * leak in the one direction the whole feature exists to prevent. Mint a
     * fresh id instead, and say so, because the caller's id silently changed.
     */
    const foreignId = state.data.entries.some((candidate) => candidate.id === entry.id
      && candidate.setId !== state.data.activeSetId)
    if (foreignId) entry.id = makeId()
    // Resolved before the mutation so a refusal can return a response instead
    // of being swallowed as an early exit inside it.
    const replacesExisting = state.data.entries.some((candidate) => candidate.id === entry.id)
    if (!replacesExisting && state.data.entries.length >= MAX_ENTRIES) {
      return {
        ok: false,
        saved: false,
        message: '最多保存 ' + MAX_ENTRIES + ' 条指令（全部配置集合计，当前 ' + state.data.entries.length + ' 条）',
        snapshot: snapshot(),
      }
    }
    const cut = truncatedFields(raw)
    const saved = await commit(() => {
      const list = state.data.entries
      const index = list.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) list[index] = entry
      else list.push(entry)
    })
    const notes = []
    if (cut.length > 0) {
      notes.push(cut.join('、') + '超过长度上限（标题 ' + MAX_TITLE + ' / 内容 ' + MAX_CONTENT + ' / 适用场景 ' + MAX_WHEN + ' 字符），超出部分已被截断')
    }
    if (foreignId) {
      notes.push('提交的 id 属于其他配置集，已改用新 id 在当前配置集新建（其他配置集的内容未被改动）')
    }
    return settle(notes.length > 0 ? '已保存；' + notes.join('；') : null, saved)
  })

  const deleteEntry = (id, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    // Deleting an id that is not there changes nothing, so it must not touch
    // disk, bump rev, or push an echo frame — otherwise two panels deleting
    // the same entry one after another would manufacture a pointless write
    // (and an external process watching the file would wake for nothing).
    //
    // Scoped to the ACTIVE set: the panel only ever lists those ids, so an id
    // from another set is not "an entry that is not there" by accident — it is
    // a request this command must not honour (deleting across sets from a
    // settings page that claims to show one set would be a data-loss bug).
    const scope = activeScope(state.data)
    if (!state.data.entries.some((entry) => entry.id === id && inScope(entry, scope))) {
      return { ok: true, saved: false, message: null, snapshot: snapshot() }
    }
    const saved = await commit(() => {
      state.data.entries = state.data.entries.filter((entry) => entry.id !== id)
    })
    return settle(null, saved)
  })

  const setOptions = (patch, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    // The custom backup location (F18) is validated BEFORE anything is queued
    // into the store: an unusable path must be refused with a reason, not
    // accepted and then discovered as a failed copy on the next save.
    if (patch !== null && typeof patch === 'object' && typeof patch.backupDir === 'string') {
      const wanted = patch.backupDir.trim()
      if (wanted !== '') {
        if (wanted.length > MAX_BACKUP_DIR) {
          return { ok: false, saved: false, message: '备份位置路径过长（上限 ' + MAX_BACKUP_DIR + ' 字符）', snapshot: snapshot() }
        }
        if (!isAbsolute(wanted)) {
          return {
            ok: false,
            saved: false,
            message: '备份位置需要绝对路径（例如 D:\\云盘\\dsh-memory 或 /home/me/cloud/dsh-memory）；留空表示与存储文件同目录',
            snapshot: snapshot(),
          }
        }
        const problem = await probeBackupDir(wanted)
        if (problem !== null) {
          return { ok: false, saved: false, message: '备份位置不可用（' + problem + '）：' + wanted, snapshot: snapshot() }
        }
      }
    }
    const saved = await commit(() => {
      if (patch !== null && typeof patch === 'object') {
        if (typeof patch.enabled === 'boolean') state.data.enabled = patch.enabled
        if (typeof patch.budgetChars === 'number' && Number.isFinite(patch.budgetChars)) {
          state.data.budgetChars = clampBudget(patch.budgetChars)
        }
        if (typeof patch.backupDir === 'string') state.data.backupDir = patch.backupDir.trim()
      }
    })
    // A changed backup location moves where history snapshots and manual
    // exports go, so it is reported rather than left to be discovered.
    let note = null
    if (patch !== null && typeof patch === 'object' && typeof patch.backupDir === 'string') {
      const wanted = patch.backupDir.trim()
      note = wanted === ''
        ? '已恢复默认备份位置（版本历史与导出与存储文件同目录）'
        : '备份位置已更新：' + wanted + '（版本历史与「导出到备份目录」随之改变；存储文件本身不移动）'
    }
    return settle(note, saved)
  })

  /**
   * Apply ONE operation to many entries in a single transaction.
   *
   * The settings page's multi-select must not loop save-entry/delete-entry:
   * that would bump `rev`, write the file and broadcast an SSE frame once per
   * id. Instead the whole batch is planned first (only entries that actually
   * change are touched — an all-no-op batch, like deleting ids that are not
   * there, writes nothing and keeps `rev` still), then committed through the
   * same commit()/writeToDisk() path as every other mutation, so the lock, rev
   * guard, rollback-on-failed-write and broadcast all apply once.
   *
   * `value` semantics per op: set-enabled -> boolean; set-priority -> 0|1|2;
   * add-tags/remove-tags -> string[] (run through sanitizeTags); delete ->
   * unused. Batch edits deliberately do NOT re-stamp updatedAt: enabling a
   * group or tagging it must not reshuffle the within-priority injection
   * order, which is tied to updatedAt.
   */
  const batchEntries = (op, ids, value, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    if (typeof op !== 'string' || !BATCH_OPS.includes(op)) {
      return { ok: false, saved: false, message: '未知的批量操作：' + String(op), snapshot: snapshot() }
    }
    const uniqueIds = Array.isArray(ids)
      ? [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))]
      : []
    if (uniqueIds.length === 0) {
      return { ok: false, saved: false, message: '没有选择任何条目', snapshot: snapshot() }
    }

    const list = state.data.entries
    // Scoped to the active set, exactly like the single-entry commands: the
    // panel's selection can only ever contain active-set ids, so an id from
    // another set is reported as "not found" rather than acted on.
    const scope = activeScope(state.data)
    const targets = list.filter((entry) => uniqueIds.includes(entry.id) && inScope(entry, scope))
    const missing = uniqueIds.length - targets.length
    const missingNote = missing > 0
      ? '（另有 ' + missing + ' 条未找到，可能已被其他窗口或进程修改）'
      : ''

    if (op === 'delete') {
      // Deleting ids that are all absent changes nothing — mirror single
      // deleteEntry's no-write behaviour rather than manufacturing a save.
      if (targets.length === 0) {
        return { ok: true, saved: false, message: null, snapshot: snapshot() }
      }
      const gone = new Set(targets.map((entry) => entry.id))
      const affected = targets.length
      const saved = await commit(() => {
        state.data.entries = state.data.entries.filter((entry) => !gone.has(entry.id))
      })
      return settle('已删除 ' + affected + ' 条指令' + missingNote, saved)
    }

    // Pure planners: return the patch to apply, or null when this entry is
    // already at the target state. Nothing is mutated here.
    let planner
    if (op === 'set-enabled') {
      if (typeof value !== 'boolean') {
        return { ok: false, saved: false, message: '批量启停需要一个布尔值', snapshot: snapshot() }
      }
      planner = (entry) => (entry.enabled === value ? null : { enabled: value })
    } else if (op === 'set-priority') {
      if (value !== 0 && value !== 1 && value !== 2) {
        return { ok: false, saved: false, message: '批量优先级只能是 0、1 或 2', snapshot: snapshot() }
      }
      planner = (entry) => (entry.priority === value ? null : { priority: value })
    } else if (op === 'add-tags') {
      if (!Array.isArray(value)) {
        return { ok: false, saved: false, message: '批量添加标签需要一个标签数组', snapshot: snapshot() }
      }
      const add = sanitizeTags(value)
      if (add.length === 0) {
        return { ok: false, saved: false, message: '没有可添加的有效标签（单个标签不超过 ' + MAX_TAG_LENGTH + ' 字符）', snapshot: snapshot() }
      }
      planner = (entry) => {
        const cur = Array.isArray(entry.tags) ? entry.tags : []
        const merged = sanitizeTags([...cur, ...add])
        if (merged.length === cur.length && merged.every((tag) => cur.includes(tag))) return null
        return { tags: merged }
      }
    } else {
      // remove-tags
      if (!Array.isArray(value)) {
        return { ok: false, saved: false, message: '批量移除标签需要一个标签数组', snapshot: snapshot() }
      }
      const remove = new Set(sanitizeTags(value))
      if (remove.size === 0) {
        return { ok: false, saved: false, message: '没有可移除的有效标签', snapshot: snapshot() }
      }
      planner = (entry) => {
        const cur = Array.isArray(entry.tags) ? entry.tags : []
        const kept = cur.filter((tag) => !remove.has(tag))
        return kept.length === cur.length ? null : { tags: kept }
      }
    }

    const changes = []
    for (const entry of targets) {
      const patch = planner(entry)
      if (patch !== null) changes.push({ entry, patch })
    }
    if (changes.length === 0) {
      return { ok: true, saved: false, message: '所选条目均已是目标状态' + missingNote, snapshot: snapshot() }
    }
    const saved = await commit(() => {
      for (const change of changes) Object.assign(change.entry, change.patch)
    })
    const done = {
      'set-enabled': value ? '已启用 ' : '已停用 ',
      'set-priority': '已将 ',
      'add-tags': '已为 ',
      'remove-tags': '已从 ',
    }[op]
    const tail = {
      'set-enabled': changes.length + ' 条指令',
      'set-priority': changes.length + ' 条指令的优先级设为「' + priorityLabel(value) + '」',
      'add-tags': changes.length + ' 条指令添加标签',
      'remove-tags': changes.length + ' 条指令移除标签',
    }[op]
    return settle(done + tail + missingNote, saved)
  })

  const saveProfile = (raw, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    const profile = sanitizeProfile(raw)
    if (profile === null) return { ok: false, saved: false, message: '形象名称与内容不能同时为空', snapshot: snapshot() }
    profile.updatedAt = Date.now()
    /** Same rule as entries: the interactive path files into the active set. */
    profile.setId = state.data.activeSetId
    // ...and an id owned by another set is re-minted rather than replaced (see
    // the note in saveEntry — same cross-set hazard, same guard).
    const foreignProfileId = state.data.profiles.some((candidate) => candidate.id === profile.id
      && candidate.setId !== state.data.activeSetId)
    if (foreignProfileId) profile.id = makeId()
    const replacesExisting = state.data.profiles.some((candidate) => candidate.id === profile.id)
    if (!replacesExisting && state.data.profiles.length >= MAX_PROFILES) {
      return { ok: false, saved: false, message: '最多保存 ' + MAX_PROFILES + ' 个用户形象', snapshot: snapshot() }
    }
    const cut = truncatedProfileFields(raw)
    const saved = await commit(() => {
      const list = state.data.profiles
      const index = list.findIndex((candidate) => candidate.id === profile.id)
      if (index >= 0) list[index] = profile
      else list.push(profile)
    })
    const note = cut.length > 0
      ? '已保存；' + cut.join('、') + '超过长度上限（名称 ' + MAX_PROFILE_NAME + ' / 内容 ' + MAX_PROFILE_CONTENT + ' 字符），超出部分已被截断'
      : null
    return settle(note, saved)
  })

  const deleteProfile = (id, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    // Mirror deleteEntry: an absent id changes nothing and must not touch disk,
    // and an id belonging to a different set is not this panel's to delete.
    const scope = activeScope(state.data)
    if (!state.data.profiles.some((profile) => profile.id === id && inScope(profile, scope))) {
      return { ok: true, saved: false, message: null, snapshot: snapshot() }
    }
    const saved = await commit(() => {
      state.data.profiles = state.data.profiles.filter((profile) => profile.id !== id)
    })
    return settle(null, saved)
  })

  /* ---------------- instruction sets (F13) ---------------- */

  /**
   * Create or rename an instruction set.
   *
   * A blank `set.id` is a CREATE (the Host mints the id), the same convention
   * entry edits use, and a supplied id is a RENAME. Creating does NOT switch:
   * switching is what changes what gets injected, and it stays a separate,
   * explicit click (the response says so). Nothing in this file ever derives a
   * set from the process cwd or from an open folder — see the README note on
   * the incident that rule comes from.
   */
  const saveSet = (raw, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    const wanted = sanitizeSet(raw)
    if (wanted === null) {
      return { ok: false, saved: false, message: '配置集名称不能为空（单行，最多 ' + MAX_SET_NAME + ' 字符）', snapshot: snapshot() }
    }
    const index = state.data.sets.findIndex((set) => set.id === wanted.id)
    if (state.data.sets.some((set, at) => at !== index && set.name === wanted.name)) {
      return { ok: false, saved: false, message: '已存在同名配置集「' + wanted.name + '」', snapshot: snapshot() }
    }
    if (index < 0) {
      if (state.data.sets.length >= MAX_SETS) {
        return { ok: false, saved: false, message: '最多创建 ' + MAX_SETS + ' 个配置集', snapshot: snapshot() }
      }
      const cut = truncatedSetFields(raw)
      const saved = await commit(() => {
        state.data.sets.push({ id: wanted.id, name: wanted.name })
      })
      const note = '已创建配置集「' + wanted.name + '」'
        + (cut.length > 0 ? '；名称超过 ' + MAX_SET_NAME + ' 字符上限，超出部分已被截断' : '')
        + '；它是空的，点击「切换」后才会注入它'
      return settle(note, saved)
    }
    if (state.data.sets[index].name === wanted.name) {
      return { ok: true, saved: false, message: '名称未变化', snapshot: snapshot() }
    }
    const cut = truncatedSetFields(raw)
    const saved = await commit(() => {
      state.data.sets[index].name = wanted.name
    })
    return settle('已重命名为「' + wanted.name + '」' + (cut.length > 0 ? '（名称已按长度上限截断）' : ''), saved)
  })

  /**
   * Delete a set together with everything filed under it. Refused for the
   * ACTIVE set: deleting what is currently injected would change the prompt as
   * a side effect of a management action, so the user switches first and the
   * deletion becomes a separate, visible step.
   */
  const deleteSet = (id, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    const index = state.data.sets.findIndex((set) => set.id === id)
    if (index < 0) {
      return { ok: false, saved: false, message: '没有该配置集（可能已被其他窗口或进程删除）', snapshot: snapshot() }
    }
    if (state.data.sets.length <= 1) {
      return { ok: false, saved: false, message: '至少要保留一个配置集', snapshot: snapshot() }
    }
    if (id === state.data.activeSetId) {
      return { ok: false, saved: false, message: '不能删除当前激活的配置集；请先切换到其他配置集', snapshot: snapshot() }
    }
    const doomedEntries = state.data.entries.filter((entry) => entry.setId === id).length
    const doomedProfiles = state.data.profiles.filter((profile) => profile.setId === id).length
    const saved = await commit(() => {
      state.data.sets.splice(index, 1)
      state.data.entries = state.data.entries.filter((entry) => entry.setId !== id)
      state.data.profiles = state.data.profiles.filter((profile) => profile.setId !== id)
    })
    return settle('已删除配置集，并移除其中的 ' + doomedEntries + ' 条指令、' + doomedProfiles + ' 个用户形象', saved)
  })

  /**
   * Make one set the active one — the single command that changes what is
   * injected. It writes (the choice survives a restart) and therefore bumps
   * `rev`, so every other open panel follows along.
   */
  const setActiveSet = (id, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    const target = state.data.sets.find((set) => set.id === id)
    if (target === undefined) {
      return { ok: false, saved: false, message: '没有该配置集（可能已被其他窗口或进程删除）', snapshot: snapshot() }
    }
    if (id === state.data.activeSetId) {
      return { ok: true, saved: false, message: null, snapshot: snapshot() }
    }
    const saved = await commit(() => {
      state.data.activeSetId = id
    })
    return settle('已切换到配置集「' + target.name + '」，注入内容已随之更新', saved)
  })

  /**
   * Copy a set (its entries and profiles, with fresh ids) into a new one — the
   * "start from a template" flow for per-client isolation. The copy is NOT
   * activated: it is a new, untested configuration until the user switches.
   */
  const duplicateSet = (id, name, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    const source = state.data.sets.find((set) => set.id === id)
    if (source === undefined) {
      return { ok: false, saved: false, message: '没有该配置集（可能已被其他窗口或进程删除）', snapshot: snapshot() }
    }
    if (state.data.sets.length >= MAX_SETS) {
      return { ok: false, saved: false, message: '最多 ' + MAX_SETS + ' 个配置集', snapshot: snapshot() }
    }
    const wanted = singleLine(typeof name === 'string' ? name : '', MAX_SET_NAME)
      || singleLine(source.name + ' 副本', MAX_SET_NAME)
    if (state.data.sets.some((set) => set.name === wanted)) {
      return { ok: false, saved: false, message: '已存在同名配置集「' + wanted + '」', snapshot: snapshot() }
    }
    const sourceEntries = state.data.entries.filter((entry) => entry.setId === id)
    if (state.data.entries.length + sourceEntries.length > MAX_ENTRIES) {
      return {
        ok: false,
        saved: false,
        message: '复制后条目总数会超过 ' + MAX_ENTRIES + ' 条上限（当前 ' + state.data.entries.length
          + ' 条，需复制 ' + sourceEntries.length + ' 条）',
        snapshot: snapshot(),
      }
    }
    const sourceProfiles = state.data.profiles.filter((profile) => profile.setId === id)
    if (state.data.profiles.length + sourceProfiles.length > MAX_PROFILES) {
      return { ok: false, saved: false, message: '复制后用户形象总数会超过 ' + MAX_PROFILES + ' 个上限', snapshot: snapshot() }
    }
    const newId = makeSetId()
    const stamp = Date.now()
    const entries = sourceEntries.map((entry) => ({ ...entry, id: makeId(), setId: newId, updatedAt: stamp }))
    const profiles = sourceProfiles.map((profile) => ({ ...profile, id: makeId(), setId: newId, updatedAt: stamp }))
    const saved = await commit(() => {
      state.data.sets.push({ id: newId, name: wanted })
      state.data.entries.push(...entries)
      state.data.profiles.push(...profiles)
    })
    return settle('已复制为「' + wanted + '」（' + entries.length + ' 条指令、' + profiles.length + ' 个用户形象）'
      + '；点击「切换」后才会注入它', saved)
  })

  /* ---------------- version history (F14) ---------------- */

  /**
   * The snapshot index, newest first. Names carry the timestamp, revision and
   * device, so nothing here needs to read a file to sort; counts are read from
   * the small ones only, so a maximal store cannot make listing expensive.
   */
  const HISTORY_INDEX_MAX_BYTES = 1048576
  const historyList = () => enqueue(async () => {
    const dir = historyDirPath()
    let names = []
    try {
      names = (await readdir(dir)).filter((name) => HISTORY_FILE_PATTERN.test(name))
    } catch (err) {
      // A missing directory is not an error: nothing has been written yet.
      if (err === null || err === undefined || err.code !== 'ENOENT') {
        return { ok: false, saved: false, message: '无法读取版本历史目录：' + describeError(err), snapshot: snapshot(), history: { dir, items: [] } }
      }
    }
    const items = []
    for (const name of names) {
      const full = join(dir, name)
      let info = null
      try {
        info = await stat(full)
      } catch {
        continue
      }
      const item = {
        name,
        epoch: historyEpochOf(name),
        rev: historyRevOf(name),
        device: historyDeviceOf(name),
        foreign: historyDeviceOf(name) !== DEVICE,
        bytes: info.size,
        entries: null,
        profiles: null,
        sets: null,
      }
      if (info.size <= HISTORY_INDEX_MAX_BYTES) {
        try {
          const parsed = JSON.parse(await readFile(full, 'utf8'))
          item.entries = Array.isArray(parsed.entries) ? parsed.entries.length : 0
          item.profiles = Array.isArray(parsed.profiles) ? parsed.profiles.length : 0
          item.sets = Array.isArray(parsed.sets) ? parsed.sets.length : 1
        } catch {
          // An unreadable snapshot still lists; restore will report the detail.
        }
      }
      items.push(item)
    }
    items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    state.historyCount = items.length
    return { ok: true, saved: false, message: null, snapshot: snapshot(), history: { dir, items } }
  })

  /**
   * Roll the store back to one snapshot. The snapshot becomes the new CURRENT
   * state and is written as a new revision (rev only ever moves forward, so a
   * client holding an older rev is refused rather than silently reverted) —
   * and, like every other write, it leaves its own snapshot behind, so the
   * rollback itself can be undone from the history list.
   */
  const historyRestore = (name, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    if (typeof name !== 'string' || !HISTORY_FILE_PATTERN.test(name)) {
      return { ok: false, saved: false, message: '历史快照名称无效', snapshot: snapshot() }
    }
    let parsed = null
    try {
      parsed = JSON.parse(await readFile(join(historyDirPath(), name), 'utf8'))
    } catch (err) {
      return { ok: false, saved: false, message: '无法读取该历史快照：' + describeError(err), snapshot: snapshot() }
    }
    const adopted = adoptParsedStore(parsed)
    if (adopted.error !== undefined) {
      return { ok: false, saved: false, message: '该历史快照不是有效的存储文件：' + adopted.error, snapshot: snapshot() }
    }
    if (adopted.rejectedVersion !== undefined) {
      return {
        ok: false,
        saved: false,
        message: '该历史快照为格式版本 ' + adopted.rejectedVersion + '，本插件支持的格式版本为 ' + SUPPORTED_VERSIONS.join(' / ')
          + '；已拒绝回滚，当前内容未被修改',
        snapshot: snapshot(),
      }
    }
    const { loaded } = adopted
    const notes = []
    const warnings = loadWarnings(loaded)
    if (warnings !== null) notes.push(warnings)
    const saved = await commit(() => {
      loaded.data.rev = state.data.rev || 0
      loaded.data.backupDir = backupDirOf()
      state.data = loaded.data
    })
    const when = new Date(historyEpochOf(name)).toLocaleString()
    const head = '已回滚到 ' + when + ' 的快照（快照 rev ' + historyRevOf(name) + '，本次写为新 rev ' + (state.data.rev || 0) + '）：'
      + describeStoreShape(state.data)
    return settle([head, ...notes].join('；'), saved)
  })

  /**
   * Delete one snapshot. `saved` stays false: the STORE was not written, which
   * is exactly what the field means everywhere else.
   */
  const historyDelete = (name) => enqueue(async () => {
    if (typeof name !== 'string' || !HISTORY_FILE_PATTERN.test(name)) {
      return { ok: false, saved: false, message: '历史快照名称无效', snapshot: snapshot() }
    }
    try {
      await unlink(join(historyDirPath(), name))
    } catch (err) {
      return { ok: false, saved: false, message: '删除历史快照失败：' + describeError(err), snapshot: snapshot() }
    }
    await refreshHistoryCount()
    return { ok: true, saved: false, message: '已删除该历史快照', snapshot: snapshot() }
  })

  const reload = () => enqueue(async () => {
    // `saved` is only true when the load itself wrote to disk (the
    // backup-promotion or legacy-migration branch); a plain re-read claiming
    // true would be indistinguishable from a real save on the wire.
    const wrote = await readFromDisk()
    syncSection()
    return { ok: state.storageError === null, saved: wrote === true, message: state.storageError, snapshot: snapshot() }
  })
  /**
   * An export is a BACKUP, so it carries the whole store — every set, with
   * each item's `setId` — not just the active one (F13). `version` is the
   * envelope's own version; `data.version` is the store format inside it.
   */
  const exportEnvelope = () => ({
    app: 'dsh-instruction-memory',
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    data: persistableData(),
  })

  const exportData = () => enqueue(async () => ({
    ok: true,
    // An export reads the store and never writes it; a truthful `saved:false`
    // keeps the field's meaning ("this operation persisted the store") intact.
    saved: false,
    message: null,
    // A self-describing envelope: re-importable by this plugin, and readable
    // as plain JSON by anything else.
    export: exportEnvelope(),
    snapshot: snapshot(),
  }))

  /**
   * Write an export straight into the backup directory (F18) — the "land the
   * backup in my cloud-synced folder" button. The default directory is the
   * store directory, so this works before a custom location is configured too.
   */
  const exportToDir = () => enqueue(async () => {
    const dir = backupDirOf() !== '' ? backupDirOf() : dirname(storePath)
    const target = join(dir, exportFileName(Date.now()))
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(target, JSON.stringify(exportEnvelope(), null, 2) + '\n', 'utf8')
    } catch (err) {
      return { ok: false, saved: false, message: '写入备份目录失败：' + describeError(err), snapshot: snapshot() }
    }
    return { ok: true, saved: false, message: '已写入 ' + target, snapshot: snapshot() }
  })

  /**
   * The raw store text for 源码模式 (F16): exactly the bytes a save would write.
   * Editing it is therefore equivalent to editing memory.json — but it goes
   * through the same loader, version gate, disclosures and rev check as every
   * other write instead of being trusted because it came from the UI.
   */
  const readSource = () => enqueue(async () => {
    /**
     * While the file on disk declares an unsupported version, the in-memory
     * state is a placeholder (nothing was adopted), so handing it out as "the
     * source" would show an EMPTY store and invite the user to save it over
     * their real file. The documented way out of that state is to fix the file
     * (or upgrade the plugin) and hit 重新载入 — so say that instead.
     */
    if (state.versionRejected) {
      return {
        ok: false,
        saved: false,
        message: '存储文件为不支持的格式版本 ' + state.rejectedVersion + '，源码模式已暂停：请先用编辑器修改 '
          + storePath + '（或升级插件）后点「重新载入」',
        snapshot: snapshot(),
      }
    }
    // Opening source mode is a deliberate user action, so it is also allowed to
    // materialise a first-run store (same rule as the `state` method).
    const materialized = await ensureStoreMaterialized()
    return { ok: true, saved: materialized === true, message: null, source: serialize(), snapshot: snapshot() }
  })

  /**
   * The shared core of 源码保存 (F16) and 整体替换恢复 (F14): adopt a whole
   * parsed store and commit it in one transaction, reporting every correction
   * the loader had to make. Callers add their own opening line.
   */
  const commitAdoptedStore = async (parsed, head) => {
    const adopted = adoptParsedStore(parsed)
    if (adopted.error !== undefined) {
      return { ok: false, saved: false, message: adopted.error, snapshot: snapshot() }
    }
    if (adopted.rejectedVersion !== undefined) {
      return {
        ok: false,
        saved: false,
        message: '内容声明为格式版本 ' + adopted.rejectedVersion + '，本插件支持的格式版本为 ' + SUPPORTED_VERSIONS.join(' / ')
          + '；已拒绝保存，当前内容未被修改',
        snapshot: snapshot(),
      }
    }
    const { loaded } = adopted
    const notes = []
    const warnings = loadWarnings(loaded)
    if (warnings !== null) notes.push(warnings)
    const truncation = truncationNotes(parsed)
    if (truncation !== null) notes.push(truncation)
    const saved = await commit(() => {
      // rev only ever moves forward: a restore is a NEW revision of the store,
      // so a client holding an older one is refused rather than silently
      // reverted (and `baseRev` conflict handling stays meaningful).
      loaded.data.rev = state.data.rev || 0
      loaded.data.backupDir = backupDirOf()
      state.data = loaded.data
    })
    return settle([head + describeStoreShape(state.data), ...notes].join('；'), saved)
  }

  const writeSource = (text, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    if (typeof text !== 'string') {
      return { ok: false, saved: false, message: '源码必须是 JSON 文本', snapshot: snapshot() }
    }
    if (text.length > MAX_BODY_CHARS) {
      return {
        ok: false,
        saved: false,
        message: '源码过长：' + text.length + ' 字符，上限 ' + MAX_BODY_CHARS + ' 字符',
        snapshot: snapshot(),
      }
    }
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      return { ok: false, saved: false, message: '源码不是有效的 JSON：' + describeError(err), snapshot: snapshot() }
    }
    return commitAdoptedStore(parsed, '已按源码保存：')
  })

  /**
   * Replace the whole store from a backup file — the "用备份整体替换" door
   * (F14). Import merges by design and can never restore an older whole-store
   * state; this is that missing path, and it is explicit: the panel confirms
   * first, and nothing is unrecoverable (the replaced content stays in
   * memory.json.bak and, whenever history is writable, in the version list).
   */
  const restoreData = (payload, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    if (payload === null || typeof payload !== 'object') {
      return { ok: false, saved: false, message: '恢复内容不是有效的 JSON 对象', snapshot: snapshot() }
    }
    // Accept our own export envelope as well as a bare store object.
    const inner = payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : payload
    return commitAdoptedStore(inner, '已用备份整体替换当前记忆：')
  })

  const importData = (payload, baseRev) => enqueue(async () => {
    if (state.versionRejected) return versionRefusal()
    if (isStaleBaseRev(baseRev)) return conflictResponse()
    if (payload === null || typeof payload !== 'object') {
      return { ok: false, saved: false, message: '导入内容不是有效的 JSON 对象', snapshot: snapshot() }
    }
    // Accept both the plugin's own export envelope ({app, data:{entries,…}})
    // and a bare {entries}/{profiles} object (e.g. a hand-assembled file).
    const inner = payload.data !== null && typeof payload.data === 'object' ? payload.data : payload
    const rawEntries = Array.isArray(payload.entries) ? payload.entries
      : (Array.isArray(inner.entries) ? inner.entries : null)
    const rawProfiles = Array.isArray(payload.profiles) ? payload.profiles
      : (Array.isArray(inner.profiles) ? inner.profiles : null)
    // Our own export also carries the set list, which is what lets an import
    // recreate the sets its items belong to instead of dumping everything into
    // the active one.
    const rawSets = Array.isArray(payload.sets) ? payload.sets
      : (Array.isArray(inner.sets) ? inner.sets : null)
    if ((rawEntries === null || rawEntries.length === 0)
      && (rawProfiles === null || rawProfiles.length === 0)) {
      return { ok: false, saved: false, message: '导入文件中没有找到条目或用户形象', snapshot: snapshot() }
    }
    /**
     * Set mapping (F13). An imported item is filed under the set it names when
     * that set already exists here, or when the payload DECLARES it (our own
     * export carries the sets array) and there is room to create it. Anything
     * else lands in the active set, and how many did so is disclosed — the
     * alternative, dropping items whose set is unknown, would be data loss.
     */
    const localSetIds = new Set(state.data.sets.map((set) => set.id))
    const declaredSets = []
    const declaredIds = new Set()
    for (const candidate of (Array.isArray(rawSets) ? rawSets : [])) {
      const set = sanitizeSet(candidate)
      if (set === null || localSetIds.has(set.id) || declaredIds.has(set.id)) continue
      declaredIds.add(set.id)
      declaredSets.push(set)
    }
    const activeId = state.data.activeSetId
    // Merge, never replace: importing must not be able to wipe what is here.
    // Duplicates (same id within the same set, or same title+content within the
    // same set) and invalid items are skipped and counted, not silently
    // dropped. De-duplicating per set is what makes re-importing idempotent
    // while still allowing the same instruction to exist in two sets.
    //
    // The whole plan is computed BEFORE the store is touched, so the merge and
    // its counters cannot disagree with what actually gets appended.
    const existing = state.data.entries
    const bodyKey = (setId, title, content) => setId + '\u0000' + title + '\u0000' + content
    const seenIds = new Set(existing.map((entry) => entry.setId + '\u0000' + entry.id))
    const seenBodies = new Set(existing.map((entry) => bodyKey(entry.setId, entry.title, entry.content)))
    const accepted = []
    const cutFields = new Set()
    let truncatedCount = 0
    let skipped = 0
    for (const candidate of (rawEntries || [])) {
      const entry = sanitizeEntry(candidate)
      if (entry === null) {
        skipped += 1
        continue
      }
      const wanted = entry.setId !== '' ? entry.setId : activeId
      if (seenIds.has(wanted + '\u0000' + entry.id) || seenBodies.has(bodyKey(wanted, entry.title, entry.content))) {
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
      accepted.push({ entry, wanted })
      seenIds.add(wanted + '\u0000' + entry.id)
      seenBodies.add(bodyKey(wanted, entry.title, entry.content))
    }
    // Persona profiles merge under the same rules (same id, or same
    // name+content) in the SAME transaction, so a mixed import never lands
    // half-way.
    const existingProfiles = state.data.profiles
    const seenProfileIds = new Set(existingProfiles.map((profile) => profile.setId + '\u0000' + profile.id))
    const seenProfileBodies = new Set(existingProfiles.map((profile) => profile.setId + '\u0000' + profile.name + '\u0000' + profile.content))
    const acceptedProfiles = []
    const cutProfileFields = new Set()
    let truncatedProfileCount = 0
    let skippedProfiles = 0
    for (const candidate of (rawProfiles || [])) {
      const profile = sanitizeProfile(candidate)
      if (profile === null) {
        skippedProfiles += 1
        continue
      }
      const wanted = profile.setId !== '' ? profile.setId : activeId
      if (seenProfileIds.has(wanted + '\u0000' + profile.id)
        || seenProfileBodies.has(wanted + '\u0000' + profile.name + '\u0000' + profile.content)) {
        skippedProfiles += 1
        continue
      }
      if (existingProfiles.length + acceptedProfiles.length >= MAX_PROFILES) {
        skippedProfiles += 1
        continue
      }
      const cut = truncatedProfileFields(candidate)
      if (cut.length > 0) {
        truncatedProfileCount += 1
        for (const field of cut) cutProfileFields.add(field)
      }
      profile.updatedAt = Date.now()
      acceptedProfiles.push({ profile, wanted })
      seenProfileIds.add(wanted + '\u0000' + profile.id)
      seenProfileBodies.add(wanted + '\u0000' + profile.name + '\u0000' + profile.content)
    }
    if (accepted.length === 0 && acceptedProfiles.length === 0) {
      // Nothing was written to disk, so claiming saved:true would be a lie the
      // panel cannot distinguish from a real save.
      return {
        ok: true,
        saved: false,
        message: '没有新增内容：' + skipped + ' 条条目、' + skippedProfiles + ' 个用户形象已存在或无效',
        snapshot: snapshot(),
      }
    }
    // Create only the declared sets that the accepted items actually reference,
    // in declaration order, while there is room.
    const wantedIds = []
    for (const item of [...accepted, ...acceptedProfiles]) {
      if (!localSetIds.has(item.wanted) && !wantedIds.includes(item.wanted)) wantedIds.push(item.wanted)
    }
    const createdSets = []
    const createdIds = new Set()
    for (const id of wantedIds) {
      if (state.data.sets.length + createdSets.length >= MAX_SETS) break
      const declared = declaredSets.find((set) => set.id === id)
      if (declared === undefined) continue
      createdSets.push({ id: declared.id, name: declared.name })
      createdIds.add(declared.id)
    }
    let fellBack = 0
    const finalIdOf = (wanted) => {
      if (localSetIds.has(wanted) || createdIds.has(wanted)) return wanted
      fellBack += 1
      return activeId
    }
    const saved = await commit(() => {
      state.data.sets.push(...createdSets)
      for (const item of accepted) {
        item.entry.setId = finalIdOf(item.wanted)
        state.data.entries.push(item.entry)
      }
      for (const item of acceptedProfiles) {
        item.profile.setId = finalIdOf(item.wanted)
        state.data.profiles.push(item.profile)
      }
    })
    const parts = []
    if (createdSets.length > 0) {
      parts.push('新建配置集 ' + createdSets.length + ' 个（' + createdSets.map((set) => '「' + set.name + '」').join('、') + '）')
    }
    if (fellBack > 0) {
      parts.push('有 ' + fellBack + ' 项因原配置集不存在或已达 ' + MAX_SETS + ' 个上限，已归入当前配置集')
    }
    if (accepted.length > 0) {
      const truncated = truncatedCount > 0
        ? '；其中 ' + truncatedCount + ' 条超过长度上限，' + [...cutFields].join('、') + '已被截断'
        : ''
      parts.push('新增指令 ' + accepted.length + ' 条，跳过 ' + skipped + ' 条' + truncated)
    } else if (skipped > 0) {
      parts.push('指令跳过 ' + skipped + ' 条（已存在或无效）')
    }
    if (acceptedProfiles.length > 0) {
      const truncated = truncatedProfileCount > 0
        ? '；其中 ' + truncatedProfileCount + ' 个超过长度上限，' + [...cutProfileFields].join('、') + '已被截断'
        : ''
      parts.push('新增用户形象 ' + acceptedProfiles.length + ' 个，跳过 ' + skippedProfiles + ' 个' + truncated)
    } else if (skippedProfiles > 0) {
      parts.push('用户形象跳过 ' + skippedProfiles + ' 个（已存在或无效）')
    }
    return settle('导入完成：' + parts.join('；'), saved)
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
        const materialized = await ensureStoreMaterialized()
        // Same envelope as every other method. One response shape means the
        // Client can never again be handed a payload it silently ignores.
        // `saved` is true only on the first run, when materialisation actually
        // wrote the file; every later read wrote nothing and says so.
        return { ok: true, saved: materialized === true, message: null, snapshot: snapshot() }
      }
      case 'save-entry':
        return saveEntry(
          args !== null && typeof args === 'object' ? args.entry : null,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'delete-entry':
        return deleteEntry(
          args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : '',
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'set-options':
        return setOptions(args, args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'save-set':
        return saveSet(
          args !== null && typeof args === 'object' ? args.set : null,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'delete-set':
        return deleteSet(
          args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : '',
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'set-active-set':
        return setActiveSet(
          args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : '',
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'duplicate-set':
        return duplicateSet(
          args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : '',
          args !== null && typeof args === 'object' ? args.name : undefined,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'history-list':
        return historyList()
      case 'history-restore':
        return historyRestore(
          args !== null && typeof args === 'object' && typeof args.name === 'string' ? args.name : '',
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'history-delete':
        return historyDelete(args !== null && typeof args === 'object' && typeof args.name === 'string' ? args.name : '')
      case 'read-source':
        return readSource()
      case 'write-source':
        return writeSource(
          args !== null && typeof args === 'object' ? args.text : null,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'restore-data':
        return restoreData(
          args !== null && typeof args === 'object' ? args.payload : null,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'export-to-dir':
        return exportToDir()
      case 'reload':
        return reload()
      case 'export-data':
        return exportData()
      case 'import-data':
        return importData(
          args !== null && typeof args === 'object' ? args.payload : null,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'batch':
        return batchEntries(
          args !== null && typeof args === 'object' ? args.op : null,
          args !== null && typeof args === 'object' ? args.ids : null,
          args !== null && typeof args === 'object' ? args.value : undefined,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'save-profile':
        return saveProfile(
          args !== null && typeof args === 'object' ? args.profile : null,
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
      case 'delete-profile':
        return deleteProfile(
          args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : '',
          args !== null && typeof args === 'object' ? args.baseRev : undefined)
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

  /**
   * The live-update stream for the settings page (GET + `Accept:
   * text/event-stream`, i.e. exactly what an EventSource sends).
   *
   * Why the method/accept pair instead of a sub-path: the route is registered
   * as a plain prefix and how the harness presents `req.url` to it is not part
   * of any contract, while `req.method` and the Accept header are. A plain GET
   * (someone navigating to the URL) keeps the old 405.
   *
   * Frames carry the bare snapshot — the same shape `state` answers with —
   * which the Client's normalizer already accepts.
   */
  const handleEventStream = (req, res) => {
    const verdict = requestOriginVerdict(req.headers, guardHost)
    if (!verdict.ok) {
      logInfo('route rejected a request: ' + verdict.reason)
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, message: '请求来源被拒绝：' + verdict.reason }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    // Ask the browser to retry politely if the stream drops (e.g. the host was
    // restarted) instead of hammering the route.
    res.write('retry: 5000\n\n')
    const send = (payload) => { res.write(payload) }
    let closed = false
    const cleanup = () => {
      closed = true
      sseStreams.delete(send)
      try {
        res.end()
      } catch {
        // The response is already gone.
      }
    }
    sseStreams.set(send, cleanup)
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('error', cleanup)
    // A snapshot on connect, so a late subscriber synchronises immediately
    // instead of waiting for the next change. It must wait for boot: a stream
    // opened while the initial disk read is still in flight would otherwise be
    // handed the empty boot state as its first frame, flashing "no
    // instructions" before the loaded store arrives.
    const sendConnectFrame = () => {
      if (closed) return
      try {
        send('data: ' + JSON.stringify(snapshot()) + '\n\n')
      } catch {
        cleanup()
      }
    }
    if (bootSettled) {
      sendConnectFrame()
    } else {
      boot.then(sendConnectFrame, sendConnectFrame)
    }
  }

  const handler = (req, res) => {
    if (req.method === 'GET') {
      const accept = String(
        (req.headers !== null && typeof req.headers === 'object') ? (req.headers.accept || '') : '',
      )
      if (accept.indexOf('text/event-stream') !== -1) {
        // A call aborted mid-flight makes these streams emit 'error'; a server
        // stream with no error listener would take the host process down over
        // one dead HTTP request.
        req.on('error', () => {})
        res.on('error', () => {})
        handleEventStream(req, res)
        return
      }
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, message: 'only POST is supported' }))
      return
    }
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
    // loopback. Anything else — `0.0.0.0`/`::` (every interface) or a concrete
    // address such as `192.168.1.5` — is a deliberate publication beyond this
    // machine, where no Host value can be known in advance; enforcing a
    // loopback allowlist there would 403 every legitimate client of that
    // published deployment. (The previous check compared against `0.0.0.0`
    // only, which silently broke `::` and concrete-address binds.) The check is
    // disabled for all non-loopback binds and the trade-off is documented in
    // the README.
    const boundHost = typeof webServer.host === 'string' ? webServer.host.trim().toLowerCase() : ''
    guardHost = boundHost === '' || isLoopbackName(boundHost)
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

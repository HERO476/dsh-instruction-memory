/**
 * UI test: drive the settings panel the way a user does.
 *   node ui-test.mjs
 *
 * verify.mjs only proves the panel REGISTERS; contract-test.mjs only feeds its
 * normalizer. Neither ever executes the render body, so every branch added by
 * a feature (a card, a button, an interaction) could throw a ReferenceError in
 * the real webview and still pass the suite. This file closes that hole with a
 * ~60-line React shim: hooks keep their state between passes, effects run when
 * their deps change, and the tree is searched for the button a person would
 * click. The element handlers are then invoked directly.
 *
 * The Host half is the REAL one, reached through the REAL route handler, so
 * what these tests drive is the actual seam (fetch -> route -> store -> SSE
 * snapshot shape) rather than a mock of it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Per-process scratch home: two concurrent runs must not delete each other's
// store mid-write (see the same note in contract-test.mjs).
const SCRATCH_HOME = fileURLToPath(new URL('./.test-dsh-home-ui-p' + process.pid + '/', import.meta.url))
const STORE_FILE = join(SCRATCH_HOME, 'instruction-memory', 'memory.json')
process.env.DSH_HOME = SCRATCH_HOME
await rm(SCRATCH_HOME, { recursive: true, force: true })
await mkdir(join(SCRATCH_HOME, 'instruction-memory'), { recursive: true })

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/* ---------------- the real Host, behind the real route ---------------- */

const host = await import(new URL('./lib/index.js', import.meta.url).href)

let handler = null
const sections = []
{
  const ctx = {
    systemPrompt: { section: (spec) => { sections.push(spec); return () => {} } },
    inject: (deps, callback) => {
      callback({
        webServer: { register: (route) => { handler = route.handler; return () => {} } },
        effect: (fn) => { fn(); return () => {} },
      })
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  host.apply(ctx)
}

const injected = () => sections
  .map((section) => (typeof section.text === 'function' ? section.text({}) : section.text))
  .filter((text) => text.length > 0)
  .join('\n\n')

/** One request through the real handler, exactly as the route shapes it. */
async function rawRoute(body) {
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
    setEncoding() {},
    destroy() {},
    on(event, callback) { (listeners[event] = listeners[event] || []).push(callback); return this },
    fire() {
      for (const cb of listeners.data || []) cb(body)
      for (const cb of listeners.end || []) cb()
    },
  }
  const out = { status: 0, body: '' }
  const res = {
    writeHead(status) { out.status = status },
    end(chunk) { out.body = chunk || '' },
    on() {},
    read: () => out,
  }
  handler(req, res)
  req.fire()
  for (let i = 0; i < 400; i += 1) {
    if (out.body !== '') return out
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('route never responded')
}

// The panel talks to the Host through fetch; route that straight into the
// handler above so nothing is stubbed but the transport.
//
// `inFlight` is what makes this suite deterministic: a fixed number of "quiet"
// render passes is a RACE (a write that takes longer than the window — a cold
// page cache, an antivirus scanning freshly written files — left an assertion
// sampling the tree before the response was absorbed). The counter stays up
// until the response BODY has been consumed, because the client parses it and
// then updates state in the same microtask chain.
let inFlight = 0
globalThis.fetch = async (url, options) => {
  inFlight += 1
  const out = await rawRoute(options.body)
  return {
    ok: out.status >= 200 && out.status < 300,
    status: out.status,
    json: async () => {
      try {
        return JSON.parse(out.body)
      } finally {
        inFlight -= 1
      }
    },
  }
}

/* ---------------- the React shim ---------------- */

const shim = {
  index: 0,
  states: [],
  fx: {},
  refs: [],
  order: [],
  dirty: false,
  pending: [],

  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children: children.flat() }
  },
  useState(initial) {
    const at = this.index
    this.index += 1
    this.order[at] = 's'
    if (this.states[at] === undefined) {
      this.states[at] = { value: typeof initial === 'function' ? initial() : initial, set: null }
    }
    const cell = this.states[at]
    if (cell.set === null) {
      cell.set = (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
        this.dirty = true
      }
    }
    return [cell.value, cell.set]
  },
  useEffect(fn, deps) {
    const at = this.index
    this.index += 1
    this.order[at] = 'e'
    const declared = Array.isArray(deps) ? deps : null
    const previous = this.fx[at]
    const changed = previous === undefined || declared === null
      || previous.deps === null
      || previous.deps.length !== declared.length
      || previous.deps.some((value, i) => !Object.is(value, declared[i]))
    // React semantics the old shim lacked: a re-run (deps changed, or a
    // no-deps effect) runs the previous cleanup FIRST. Without this, the F7
    // countdown interval leaked past the resume and kept every later settle()
    // permanently noisy. Deps-less effects never report changed here, so the
    // SSE close() still only runs on unmount — exactly like React.
    if (changed && previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
    const slot = { deps: declared, cleanup: null }
    this.fx[at] = slot
    if (changed) {
      this.pending.push(() => {
        const cleanup = fn()
        if (typeof cleanup === 'function') slot.cleanup = cleanup
      })
    }
  },
  useRef(initial) {
    const at = this.index
    this.index += 1
    this.order[at] = 'r'
    if (this.refs[at] === undefined) this.refs[at] = { current: initial }
    return this.refs[at]
  },
}

globalThis.window = {
  __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  confirm: () => true,
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
  head: { appendChild() {} },
}
/**
 * Pin the panel's language. Node >= 21 ships a global `navigator` reporting the
 * MACHINE's language, so the same assertions passed on a zh dev box and failed
 * on the English CI runners (where the panel renders "Instruction sets" and the
 * Chinese labels this file looks for do not exist). defineProperty, because
 * Node's navigator is getter-only and a plain assignment throws.
 */
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'] },
  configurable: true,
})

const clientModule = await import(new URL('./lib/client.js', import.meta.url).href)
const plugin = globalThis.__spec.factory((id) => {
  if (id === 'react') return shim
  throw new Error('unexpected require: ' + id)
})

let renderPanel = null
plugin.apply({
  get: (name) => (name === 'slots'
    ? {
      inject: (key, callback) => { callback(); return () => {} },
      register: (options, render) => { renderPanel = render; return () => {} },
    }
    : undefined),
  effect: (fn) => { fn(); return () => {} },
})

/**
 * Expand function components the way React would, sharing ONE hook index for
 * the whole tree walk — the same order React uses (a parent's body runs before
 * its children's), so every component the panel ships (editors, tag input,
 * expandable body) executes for real.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.flatMap((child) => expand(child))
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, children: (node.children || []).flatMap((child) => expand(child)) }
}

/** Render the panel until it stops changing state, and return the tree. */
async function settle(rounds = 30, wait = 25) {
  let tree = null
  const orders = []
  let quiet = 0
  for (let pass = 0; pass < rounds; pass += 1) {
    shim.index = 0
    shim.pending = []
    shim.dirty = false
    tree = expand(renderPanel())
    orders.push(shim.order.slice(0, shim.index).join(''))
    const effects = shim.pending.slice()
    shim.pending = []
    for (const effect of effects) {
      try {
        effect()
      } catch (err) {
        check('effect runs without throwing', false, String(err && err.message ? err.message : err))
      }
    }
    // A host round trip started by this pass must LAND before the pass can
    // count as quiet: the panel's state changes only when the response is
    // absorbed, so breaking early is how a stale tree used to be returned.
    for (let guard = 0; guard < 600 && inFlight > 0; guard += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await new Promise((resolve) => setTimeout(resolve, wait))
    // A round trip has to be allowed to LAND before the tree is treated as
    // final; requiring several quiet passes is what keeps an assertion from
    // sampling the panel mid-flight.
    quiet = shim.dirty ? 0 : quiet + 1
    if (quiet >= 3 && pass > 0) break
  }
  // Only the QUIET passes may be compared: a pass that still renders the
  // pre-action branch (loading, an open editor) legitimately walks a different
  // set of components. A mismatch among the last three would mean a hook is
  // called conditionally — the one mistake this shim can actually catch.
  const tail = [...new Set(orders.slice(-3))]
  check('panel: hook order is stable across the settling passes',
    tail.length === 1, tail.join(' vs ').slice(0, 160))
  return tree
}

/* ---------------- tree helpers ---------------- */

function walk(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    out.push(node)
    for (const child of node.children || []) walk(child, out)
  }
  return out
}

function texts(node) {
  const out = []
  for (const element of walk(node)) {
    for (const child of element.children || []) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child))
    }
  }
  return out
}

const hasText = (node, text) => texts(node).some((line) => line === text)
const hasTextContaining = (node, fragment) => texts(node).some((line) => line.includes(fragment))

/** Every button whose label is exactly `text` (a string child). */
function buttons(node, text) {
  return walk(node).filter((element) =>
    element.type === 'button'
    && (element.children || []).some((child) => typeof child === 'string' && child === text))
}

function anyElement(node, predicate) {
  return walk(node).find(predicate)
}

async function click(node, text) {
  const targets = buttons(node, text)
  if (targets.length === 0) throw new Error('no button labelled ' + JSON.stringify(text))
  if (typeof targets[0].props.disabled === 'boolean' && targets[0].props.disabled === true) {
    throw new Error('button is disabled: ' + JSON.stringify(text))
  }
  targets[0].props.onClick({ target: {}, preventDefault() {} })
  return settle()
}

async function type(node, predicate, value) {
  const field = anyElement(node, predicate)
  if (field === undefined) throw new Error('no matching input')
  if (typeof field.props.onFocus === 'function') field.props.onFocus({ target: {} })
  field.props.onChange({ target: { value } })
  return settle()
}

/**
 * One interaction plus the debounce window: the source editor validates 250 ms
 * after the last keystroke (the effect that arms the timer only runs during a
 * render pass), so a plain settle() would sample the verdict from BEFORE the
 * edit.
 */
async function settleAfterDebounce() {
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  return settle()
}

/** Change a field and let its debounced effects land. */
async function retype(node, predicate, value) {
  const field = anyElement(node, predicate)
  if (field === undefined) throw new Error('no matching input')
  field.props.onChange({ target: { value } })
  return settleAfterDebounce()
}

/* ---------------- seed a v1 store, then drive the panel ---------------- */

await writeFile(STORE_FILE, JSON.stringify({
  version: 1,
  rev: 3,
  enabled: true,
  budgetChars: 4000,
  entries: [
    { id: 'e1', title: '回答语言', content: '所有回答使用简体中文。', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 10 },
    { id: 'e2', title: '代码规范', content: '缩进用两个空格。', mode: 'auto', when: '编写或修改配置文件时', priority: 2, enabled: true, updatedAt: 20 },
  ],
  profiles: [{ id: 'p1', name: '职业背景', content: '后端工程师。', enabled: true, updatedAt: 30 }],
}), 'utf8')

let tree = await settle()
check('panel: renders with the loaded store', hasText(tree, '指令记忆') || hasTextContaining(tree, '指令记忆'), JSON.stringify(texts(tree).slice(0, 6)))
check('panel: F13 set switcher shows the migrated 默认 set',
  hasTextContaining(tree, '默认') && hasTextContaining(tree, '使用中'), JSON.stringify(texts(tree).slice(0, 30)))
check('panel: v1 migration warning is on screen',
  texts(tree).some((line) => line.includes('默认') && line.includes('版本')), JSON.stringify(texts(tree).filter((l) => l.includes('版本')).slice(0, 3)))
check('panel: entries of the active set are listed', hasText(tree, '回答语言') && hasText(tree, '代码规范'))
check('panel: F14 history card is present', hasText(tree, '版本历史'))
check('panel: F18 backup card is present', hasTextContaining(tree, '自定义备份位置'))
check('panel: F17 preview card is present', hasText(tree, '按需指令本地预演'))
check('panel: F16 source-mode button is present', buttons(tree, '源码模式').length === 1)

// ---- F13: create a set through the form, then switch to it ----
tree = await click(tree, '＋ 新建')
check('panel: the set form opens', anyElement(tree, (el) => el.type === 'input' && el.props.maxLength === 30) !== undefined)
tree = await type(tree, (el) => el.type === 'input' && el.props.maxLength === 30, '工作')
tree = await click(tree, '确定')
check('panel: the new set appears and stays inactive',
  hasText(tree, '工作') && texts(tree).filter((line) => line === '使用中').length === 1,
  JSON.stringify(texts(tree).filter((l) => l === '使用中' || l === '工作')))
check('panel: creating a set does not change what is injected', injected().includes('回答语言'), injected().slice(0, 80))

// ---- Review-fix regression (defect 1): a draft left open across a set ----
// switch used to survive it, so the form on screen belonged to the OLD set
// while 保存 filed into the NEW one (the server-side cross-set guard kept the
// data safe; the UX was still wrong). Two structural facts shape this block:
// the entry editor is a FULL TAKEOVER (the set switcher is not reachable while
// it is open — pinned here so a future layout change cannot hide that), and
// the persona editor renders INLINE inside the header, so the switcher stays
// reachable — that is the path the bug ships through, and the block below
// drives the real fix through it.
tree = await click(tree, '＋ 新增指令')
check('panel: the entry editor is open and takes over the panel (no switcher reachable)',
  anyElement(tree, (el) => el.type === 'textarea' && el.props.maxLength === 6000) !== undefined
  && buttons(tree, '切换').length === 0,
  JSON.stringify({ switchButtons: buttons(tree, '切换').length }))
tree = await click(tree, '取消')
check('panel: cancelling the blank entry editor returns to the list',
  buttons(tree, '切换').length === 1)

tree = await click(tree, '＋ 新增形象')
check('panel: the persona editor is open before the set switch',
  anyElement(tree, (el) => el.type === 'textarea' && el.props.maxLength === 4000) !== undefined)

tree = await click(tree, '切换')
check('panel: switching reports back and empties the list',
  texts(tree).some((line) => line.includes('已切换到配置集')) && !hasText(tree, '回答语言'),
  JSON.stringify(texts(tree).filter((l) => l.includes('切换')).slice(0, 3)))
check('panel: the set switch closed the persona editor that was open',
  anyElement(tree, (el) => el.type === 'textarea' && el.props.maxLength === 4000) === undefined)
check('panel: the closed draft is disclosed in the notice',
  texts(tree).some((line) => line.includes('已关闭切换前打开的编辑草稿')),
  JSON.stringify(texts(tree).filter((l) => l.includes('草稿') || l.includes('切换')).slice(0, 3)))
check('ISOLATION through the UI: the old set is no longer injected', !injected().includes('回答语言'), injected().slice(0, 120))
check('ISOLATION through the UI: personas follow the set too', !injected().includes('后端工程师'))

// ---- F13: an entry saved while the new set is active lands in it ----
tree = await click(tree, '＋ 新增指令')
tree = await type(tree, (el) => el.type === 'input' && el.props.maxLength === 120, '只在工作集')
tree = await type(tree, (el) => el.type === 'textarea' && el.props.maxLength === 6000, '工作集专用指令')
// Switch the editor to 按需 and give it a scenario, so the F17 preview below
// has something to match on in the ACTIVE set.
{
  const modeSelect = anyElement(tree, (el) => el.type === 'select'
    && (el.children || []).some((child) => child && child.props && child.props.value === 'auto'))
  if (modeSelect === undefined) throw new Error('mode select not found')
  modeSelect.props.onChange({ target: { value: 'auto' } })
  tree = await settle()
}
tree = await type(tree, (el) => el.type === 'input' && el.props.maxLength === 200, '编写或修改配置文件时')
tree = await click(tree, '保存')
check('panel: the entry was saved into the active set', hasText(tree, '只在工作集'))
check('panel: injection now carries only the active set',
  injected().includes('只在工作集') && !injected().includes('回答语言'), injected().slice(0, 200))
check('panel: the saved entry kept its 按需 mode and scenario',
  injected().includes('适用场景：编写或修改配置文件时'), injected().slice(0, 240))

// ---- F17: the local preview highlights a matching on-demand entry ----
tree = await click(tree, '本地预演')
check('panel: the preview shows its disclaimer',
  texts(tree).some((line) => line.includes('模型的真实判断')), JSON.stringify(texts(tree).filter((l) => l.includes('预演')).slice(0, 4)))
tree = await type(tree, (el) => el.type === 'input' && String(el.props.placeholder || '').includes('任务描述'), '帮我修改配置文件')
check('panel: a matching on-demand entry is listed as a preview hit',
  hasTextContaining(tree, '字面命中') || texts(tree).some((line) => line.includes('按需指令') && line.includes('命中')),
  JSON.stringify(texts(tree).filter((l) => l.includes('命中') || l.includes('没有「')).slice(0, 4)))

// ---- F14: history list + rollback ----
tree = await click(tree, '查看版本历史')
check('panel: history rows render with revision + counts',
  texts(tree).some((line) => /^rev \d+$/.test(line)) && texts(tree).some((line) => line.includes('条指令')),
  JSON.stringify(texts(tree).filter((l) => l.startsWith('rev')).slice(0, 4)))
const revBefore = texts(tree).filter((line) => /^rev \d+$/.test(line)).map((line) => Number(line.slice(4)))
tree = await click(tree, '回滚到此版本')
check('panel: rollback produced a new revision',
  texts(tree).some((line) => line.includes('已回滚到')),
  JSON.stringify(texts(tree).filter((l) => l.includes('回滚')).slice(0, 3)))
check('panel: rollback did not lose the store',
  texts(tree).some((line) => /^rev \d+$/.test(line)) && revBefore.length > 0,
  JSON.stringify(revBefore))

// ---- F16: source mode ----
tree = await click(tree, '源码模式')
check('panel: source mode renders the raw store text',
  anyElement(tree, (el) => el.type === 'textarea' && typeof el.props.value === 'string' && el.props.value.includes('"$schema"')) !== undefined,
  JSON.stringify(texts(tree).slice(0, 8)))
tree = await settleAfterDebounce()
check('panel: live validation reports a valid document',
  texts(tree).some((line) => line.includes('JSON 语法正确')), JSON.stringify(texts(tree).filter((l) => l.includes('JSON')).slice(0, 3)))

// Break the JSON on purpose: the verdict must follow, and Save must be off.
const sourceField = anyElement(tree, (el) => el.type === 'textarea' && typeof el.props.value === 'string' && el.props.value.includes('"$schema"'))
tree = await retype(tree, (el) => el.type === 'textarea' && typeof el.props.value === 'string', sourceField.props.value + ',,')
check('panel: broken JSON is reported live',
  texts(tree).some((line) => line.includes('JSON 语法错误')), JSON.stringify(texts(tree).filter((l) => l.includes('JSON')).slice(0, 3)))
check('panel: saving is disabled while the source does not parse',
  buttons(tree, '保存源码').length === 1 && buttons(tree, '保存源码')[0].props.disabled === true)

// Fix it back and save: the entry title must reach the store.
const fixed = JSON.parse(sourceField.props.value)
fixed.entries = fixed.entries.map((entry) => (entry.title === '只在工作集' ? { ...entry, title: '源码改过的标题' } : entry))
tree = await retype(tree, (el) => el.type === 'textarea' && typeof el.props.value === 'string', JSON.stringify(fixed, null, 2))
check('panel: the repaired source validates again',
  texts(tree).some((line) => line.includes('JSON 语法正确')), JSON.stringify(texts(tree).filter((l) => l.includes('JSON')).slice(0, 3)))
tree = await click(tree, '保存源码')
check('panel: the source save is reported and applied',
  texts(tree).some((line) => line.includes('已按源码保存')), JSON.stringify(texts(tree).filter((l) => l.includes('源码')).slice(0, 3)))
check('panel: the edited title is in the store now', injected().includes('源码改过的标题'), injected().slice(0, 200))
tree = await click(tree, '退出源码模式')
check('panel: leaving source mode returns to the list', hasText(tree, '源码改过的标题'))

// ---- F18: the backup location field ----
const BACKUP_DIR = join(SCRATCH_HOME, 'cloud')
await mkdir(BACKUP_DIR, { recursive: true })
tree = await type(tree, (el) => el.type === 'input' && String(el.props.placeholder || '').includes('cloud'), BACKUP_DIR)
tree = await click(tree, '应用')
check('panel: the backup location is reported back as applied',
  texts(tree).some((line) => line.includes('备份位置已更新') && line.includes(BACKUP_DIR)),
  JSON.stringify(texts(tree).filter((l) => l.includes('备份')).slice(0, 3)))
check('panel: the field shows the committed path',
  anyElement(tree, (el) => el.type === 'input' && el.props.value === BACKUP_DIR) !== undefined,
  JSON.stringify(texts(tree).filter((l) => l.includes('cloud')).slice(0, 3)))
tree = await click(tree, '导出到备份目录')
check('panel: export-to-dir reports the written path',
  texts(tree).some((line) => line.includes('已写入')), JSON.stringify(texts(tree).filter((l) => l.includes('已写入')).slice(0, 2)))

// ---- F12: the diagnostics card (default collapsed; display-only) ----
tree = await click(tree, '展开诊断')
check('panel: the diagnostics card lists the operational fields',
  hasTextContaining(tree, '自本次插件启动') && hasTextContaining(tree, '修订号（rev）')
  && texts(tree).some((line) => line.includes('memory.json')),
  JSON.stringify(texts(tree).filter((l) => l.includes('rev') || l.includes('存储文件')).slice(0, 4)))
tree = await click(tree, '复制诊断信息')
{
  const dumpArea = anyElement(tree, (el) => el.type === 'textarea'
    && typeof el.props.value === 'string' && el.props.value.includes('dsh-instruction-memory diagnostics'))
  check('panel: copy degrades to a selectable dump when no clipboard exists', dumpArea !== undefined)
  check('panel: the dump carries security/environment and never user text',
    dumpArea !== undefined
    && dumpArea.props.value.includes('hostGuarded: true')
    && dumpArea.props.value.includes('boundHost:')
    && dumpArea.props.value.includes('userAgent:')
    && dumpArea.props.value.includes('源码改过的标题') === false,
    dumpArea === undefined ? 'no dump' : dumpArea.props.value.slice(0, 160))
}
tree = await click(tree, '收起诊断')
check('panel: the diagnostics card collapses again', !hasTextContaining(tree, '自本次插件启动'))

// ---- F12: the non-loopback security warning ----
// A second host instance whose web server reports a non-loopback bind; its
// route replaces the handler for one reload, then the panel goes back.
{
  const warnHost = await import(new URL('./lib/index.js', import.meta.url).href + '?diag-warn-' + Date.now())
  let warnHandler = null
  warnHost.apply({
    systemPrompt: { section: () => () => {} },
    inject: (deps, callback) => {
      callback({
        webServer: { host: '0.0.0.0', register: (route) => { warnHandler = route.handler; return () => {} } },
        effect: (fn) => { fn(); return () => {} },
      })
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  })
  const realHandler = handler
  handler = warnHandler
  tree = await click(tree, '重新载入')
  check('panel: a non-loopback bind shows the security warning at the top',
    hasTextContaining(tree, '非回环地址') && hasTextContaining(tree, '0.0.0.0'),
    JSON.stringify(texts(tree).filter((l) => l.includes('回环')).slice(0, 2)))
  handler = realHandler
  tree = await click(tree, '重新载入')
  check('panel: back on a loopback bind the warning is gone', !hasTextContaining(tree, '非回环地址'))
}

// ---- F7: pause injection (menu → countdown bar → resume; 50ms expiry smoke) ----
check('panel: pre-pause the section is injected', injected().length > 0, injected().slice(0, 80))
tree = await click(tree, '暂停注入…')
check('panel: the pause menu offers the three durations and the hint',
  buttons(tree, '30 分钟').length === 1 && buttons(tree, '1 小时').length === 1
  && buttons(tree, '到今天结束').length === 1 && hasTextContaining(tree, '暂停期间不注入'),
  JSON.stringify(texts(tree).filter((l) => l.includes('分钟') || l.includes('小时') || l.includes('今天')).slice(0, 4)))
tree = await click(tree, '30 分钟')
check('panel: pausing shows the countdown bar with resume',
  hasTextContaining(tree, '注入已暂停') && hasTextContaining(tree, '剩余') && buttons(tree, '立即恢复').length === 1,
  JSON.stringify(texts(tree).filter((l) => l.includes('暂停')).slice(0, 3)))
check('ISOLATION while muted: nothing reaches the prompt', injected() === '', injected().slice(0, 80))
tree = await click(tree, '立即恢复')
check('panel: resume clears the bar and the section returns',
  buttons(tree, '立即恢复').length === 0 && !hasTextContaining(tree, '注入已暂停') && injected().length > 0,
  injected().slice(0, 80))

// The host-side expiry timer: a 50ms pause ends on its own — no user action,
// and (pinned via the file bytes) no write. The one real-timer smoke allowed
// by the spec; everything else pins the clock through parameters.
{
  const pauseUntil = Date.now() + 50
  const resp = await globalThis.fetch('http://instruction-memory.local', {
    body: JSON.stringify({ method: 'set-options', args: { disabledUntil: pauseUntil } }),
  })
  await resp.json()
  // The pause itself is a real write (it records the instant); expiry must add
  // NOT ONE byte on top of that — the stale instant is simply ignored.
  const afterPause = readFileSync(STORE_FILE, 'utf8')
  // Whether the 50ms mute is still live at THIS line is a race against the
  // scheduler (a loaded CI runner can lapse it before we look), so the
  // deterministic evidence that the pause landed is the recorded instant in
  // the file — the expiry itself is what this smoke asserts, after a wait
  // generous enough for a loaded runner.
  check('F7: the 50ms pause landed (the instant is recorded in the store file)',
    JSON.parse(afterPause).disabledUntil > 0, JSON.parse(afterPause).disabledUntil)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  check('F7: a 50ms pause expires by itself (section re-registered, no user action)',
    injected().length > 0, injected().slice(0, 80))
  check('F7: the expiry wrote nothing (file bytes unchanged, stale instant left in place)',
    readFileSync(STORE_FILE, 'utf8') === afterPause
    && JSON.parse(afterPause).disabledUntil > 0)
  tree = await settle()
  check('panel: after expiry the bar is gone and the pause control is back',
    !hasTextContaining(tree, '注入已暂停') && buttons(tree, '立即恢复').length === 0
    && buttons(tree, '暂停注入…').length === 1,
    JSON.stringify({ resume: buttons(tree, '立即恢复').length, menu: buttons(tree, '暂停注入…').length }))
}

// ---- master switch + budget still work through the UI ----
tree = await click(tree, '重新载入')
check('panel: reload keeps the panel alive', hasText(tree, '指令记忆') || hasTextContaining(tree, '指令记忆'))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
await rm(SCRATCH_HOME, { recursive: true, force: true }).catch(() => {})
process.exit(failures === 0 ? 0 : 1)

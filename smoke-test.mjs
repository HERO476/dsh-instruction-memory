/**
 * Smoke test for the pure Host logic. Runs with plain node, no deps:
 *   node smoke-test.mjs
 */
import { isAbsolute, join } from 'node:path'
import { buildBlock, resolveStorePath, sanitizeEntry } from './lib/index.js'

let failures = 0
const check = (label, actual, predicate) => {
  const ok = predicate(actual)
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) console.log('      got: ' + JSON.stringify(actual).slice(0, 400))
}

const entry = (over) => ({
  id: 'im-1', title: 'T', content: 'C', mode: 'always', when: '',
  priority: 1, enabled: true, updatedAt: 1, ...over,
})

const base = { version: 1, enabled: true, budgetChars: 4000, entries: [] }

// An empty or disabled memory must contribute nothing at all.
check('empty memory -> empty block', buildBlock(base), (v) => v === '')
check('master switch off -> empty block',
  buildBlock({ ...base, enabled: false, entries: [entry()] }), (v) => v === '')
check('all entries disabled -> empty block',
  buildBlock({ ...base, entries: [entry({ enabled: false })] }), (v) => v === '')
check('blank content -> empty block',
  buildBlock({ ...base, entries: [entry({ content: '' })] }), (v) => v === '')

// A real entry renders with its tag and body.
const one = buildBlock({ ...base, entries: [entry({ title: '回答语言', content: '所有回答使用简体中文。' })] })
check('single entry includes title + content',
  one, (v) => v.includes('[始终｜优先级 普通] 回答语言') && v.includes('所有回答使用简体中文。'))

// mode/when/priority surface in the rendered text.
const auto = buildBlock({
  ...base,
  entries: [entry({ mode: 'auto', when: '编写代码时', priority: 2, content: 'X' })],
})
check('auto entry renders 按需 + 适用场景 + 高优先级',
  auto, (v) => v.includes('[按需｜优先级 高]') && v.includes('适用场景：编写代码时'))

// 始终 entries are ordered before 按需 ones regardless of recency.
const mixed = buildBlock({
  ...base,
  entries: [
    entry({ id: 'a', title: 'AUTO', mode: 'auto', priority: 0, updatedAt: 99 }),
    entry({ id: 'b', title: 'ALWAYS', mode: 'always', priority: 0, updatedAt: 1 }),
  ],
})
check('始终 block precedes 按需 block',
  mixed, (v) => v.indexOf('ALWAYS') !== -1 && v.indexOf('ALWAYS') < v.indexOf('AUTO'))

// Priority ordering within a mode.
const prio = buildBlock({
  ...base,
  entries: [
    entry({ id: 'lo', title: 'LOW', priority: 0 }),
    entry({ id: 'hi', title: 'HIGH', priority: 2 }),
    entry({ id: 'mid', title: 'MID', priority: 1 }),
  ],
})
check('priority orders 高 > 普通 > 低',
  prio, (v) => v.indexOf('HIGH') < v.indexOf('MID') && v.indexOf('MID') < v.indexOf('LOW'))

// Budget is respected, and the omission is disclosed rather than silent.
// 800 is MIN_BUDGET: the tightest setting the UI permits.
const many = {
  ...base,
  budgetChars: 800,
  entries: Array.from({ length: 12 }, (_, i) =>
    entry({ id: 'e' + i, title: 'E' + i, content: 'x'.repeat(80), updatedAt: 100 - i })),
}
const trimmed = buildBlock(many)
check('tight budget still injects something (never silently empty)', trimmed.length, (v) => v > 0)
check('tight budget stays within ceiling', trimmed.length, (v) => v <= 800)
check('tight budget discloses omissions', trimmed, (v) => v.includes('因注入字数上限未包含'))
check('tight budget keeps the highest-priority entries',
  trimmed, (v) => v.includes('E0') && !v.includes('E11'))

// Determinism: identical input must give byte-identical output (prompt cache).
check('render is deterministic', buildBlock(many) === trimmed, (v) => v === true)

// A single oversized entry is truncated, never allowed to blow the ceiling.
const huge = buildBlock({ ...base, budgetChars: 800, entries: [entry({ content: 'y'.repeat(5000) })] })
check('oversized entry still injects and stays within ceiling',
  huge.length, (v) => v > 0 && v <= 800)
check('truncation is labelled', huge, (v) => v.includes('被截断'))

// Property sweep: across every permitted budget the ceiling always holds and
// an active memory is never dropped entirely.
{
  let bad = null
  for (let b = 800; b <= 6000; b += 137) {
    const out = buildBlock({ ...many, budgetChars: b })
    if (out.length > b || out.length === 0) { bad = { b, len: out.length }; break }
  }
  check('budget sweep: never over ceiling, never empty', bad, (v) => v === null)
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
// ---- storage location: the harness home, never the working directory ----
//
// Regression guard. The first build resolved its data file against the harness
// `fs` service, whose default base is the host process cwd; launching DSH from
// another directory then produced a second, empty store and the user's
// memories appeared to vanish.

const FAKE_HOME = join('C:', 'Users', 'example')
const EXPECTED = join('instruction-memory', 'memory.json')

check('store path honours an explicit $DSH_HOME',
  resolveStorePath({ DSH_HOME: join('D:', 'harness-home') }, FAKE_HOME),
  (v) => v === join('D:', 'harness-home', EXPECTED))

check('blank $DSH_HOME falls back to ~/.dsh, never to cwd',
  resolveStorePath({ DSH_HOME: '   ' }, FAKE_HOME),
  (v) => v === join(FAKE_HOME, '.dsh', EXPECTED))

check('unset $DSH_HOME falls back to ~/.dsh',
  resolveStorePath({}, FAKE_HOME),
  (v) => v === join(FAKE_HOME, '.dsh', EXPECTED))

check('store path is always absolute',
  resolveStorePath({}, FAKE_HOME),
  (v) => isAbsolute(v))

// ---- titles and applicability hints are always single-line ----
//
// Regression guard. A blank title used to be derived from the first 40
// characters of `content`, newlines included, which rendered the injected
// block's header across several lines and duplicated the body.

const derived = sanitizeEntry({ title: '', content: '第一行\n第二行\n第三行', mode: 'always' })

check('blank title derives a title from content',
  derived.title, (v) => v.includes('第一行'))
check('derived title has no newline (the shipped bug)',
  derived.title, (v) => !v.includes('\n'))
check('content keeps its newlines — only the title is flattened',
  derived.content, (v) => v === '第一行\n第二行\n第三行')

check('an explicitly multi-line title is collapsed',
  sanitizeEntry({ title: 'A\nB\n\nC', content: 'x' }).title,
  (v) => v === 'A B C')

check('a multi-line 适用场景 is collapsed',
  sanitizeEntry({ title: 't', content: 'c', when: '写代码时\n或改配置时' }).when,
  (v) => v === '写代码时 或改配置时')

// The rendered header must be exactly one line even for the derived-title case.
// Under the shipped bug the header line stopped at the first newline, so this
// exact-match assertion is what fails.
{
  const block = buildBlock({
    version: 1, enabled: true, budgetChars: 4000, entries: [derived],
  })
  const header = block.split('\n').find((line) => line.startsWith('[始终｜优先级'))
  check('rendered entry header is exactly one line carrying the derived title',
    header, (v) => v === '[始终｜优先级 普通] 第一行 第二行 第三行')
}

// Proof the guard above is not vacuous: hand buildBlock an entry that bypassed
// sanitizeEntry and the header breaks exactly as it did in the shipped bug.
{
  const unsanitized = {
    id: 'x', title: '第一行\n第二行\n第三行', content: 'c',
    mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1,
  }
  const header = buildBlock({ version: 1, enabled: true, budgetChars: 4000, entries: [unsanitized] })
    .split('\n').find((line) => line.startsWith('[始终｜优先级'))
  check('an un-sanitized multi-line title DOES break the header (so the guard can fail)',
    header, (v) => v === '[始终｜优先级 普通] 第一行')
}

process.exit(failures === 0 ? 0 : 1)

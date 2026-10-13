/**
 * Smoke test for the pure Host logic. Runs with plain node, no deps:
 *   node smoke-test.mjs
 */
import { isAbsolute, join } from 'node:path'
import { buildBlock, canonicalIp, hostnameOf, planInjection, requestOriginVerdict, resolveStorePath, sanitizeEntry, sanitizeTags } from './lib/index.js'

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

// ---- injection plan (F1): the budget decision is observable -------------
//
// buildBlock() is now a thin wrapper over planInjection(); the text must stay
// byte-identical, while the plan additionally reports which active entries
// made it into the prompt and which the current budget left out.
{
  const truthy = (v) => v === true
  const emptyPlan = planInjection(base)
  check('plan: empty memory renders nothing', emptyPlan.text, (v) => v === '')
  check('plan: empty memory still reports the effective ceiling',
    emptyPlan.budget, (v) => v === 4000)
  check('plan: empty memory has no candidates',
    emptyPlan.activeCount === 0 && emptyPlan.included.length === 0 && emptyPlan.omitted.length === 0,
    truthy)

  const offPlan = planInjection({ ...base, enabled: false, entries: [entry()] })
  check('plan: master switch off renders nothing', offPlan.text, (v) => v === '')
  check('plan: master switch off keeps the budget ceiling',
    offPlan.budget === 4000 && offPlan.included.length === 0 && offPlan.omitted.length === 0,
    truthy)

  check('plan: non-object input degrades to an empty plan',
    planInjection(null).text === '' && planInjection(null).budget === 4000, truthy)
  check('plan: budget is clamped in the plan',
    planInjection({ ...base, budgetChars: 999999, entries: [entry()] }).budget === 40000
    && planInjection({ ...base, budgetChars: 5, entries: [entry()] }).budget === 800,
    truthy)

  const mixedCandidates = {
    ...base,
    entries: [
      entry({ id: 'a', title: 'ACTIVE', content: 'AAA' }),
      entry({ id: 'off', title: 'DISABLED', content: 'BBB', enabled: false }),
      entry({ id: 'blank', title: 'BLANK', content: '' }),
    ],
  }
  const p = planInjection(mixedCandidates)
  check('plan: text stays byte-identical to buildBlock()',
    p.text === buildBlock(mixedCandidates) && p.text.length > 0, truthy)
  check('plan: only the active non-blank entry is a candidate',
    p.activeCount === 1 && p.included.length === 1 && p.omitted.length === 0, truthy)
  check('plan: the included entry carries id, positive chars and truncated:false',
    p.included[0].id === 'a' && p.included[0].chars > 0 && p.included[0].truncated === false, truthy)
  check('plan: disabled/blank entries are in neither list',
    !p.included.some((x) => x.id === 'off' || x.id === 'blank')
    && !p.omitted.some((x) => x.id === 'off' || x.id === 'blank'), truthy)

  // 始终 precedes 按需 in the consideration order as well as the text.
  const modePlan = planInjection({
    ...base,
    entries: [
      entry({ id: 'auto1', title: 'AUTO', mode: 'auto', priority: 0, updatedAt: 99 }),
      entry({ id: 'always1', title: 'ALWAYS', mode: 'always', priority: 0, updatedAt: 1 }),
    ],
  })
  check('plan: included order is 始终 first then 按需',
    modePlan.included.map((x) => x.id).join(','), (v) => v === 'always1,auto1')

  const tight = planInjection(many)
  check('plan: tight-budget text is the existing block, unchanged',
    tight.text === trimmed && tight.text.length > 0 && tight.text.length <= 800, truthy)
  check('plan: tight budget reports the 800 ceiling', tight.budget, (v) => v === 800)
  check('plan: every candidate is classified exactly once',
    tight.activeCount === 12 && tight.included.length + tight.omitted.length === 12, truthy)
  check('plan: included ids and omitted ids partition the candidates',
    (() => {
      const ids = [...tight.included, ...tight.omitted].map((x) => x.id).sort().join(',')
      return ids === Array.from({ length: 12 }, (_, i) => 'e' + i).sort().join(',')
    })(), truthy)
  check('plan: the highest-priority first entry is included',
    tight.included[0].id === 'e0' && tight.omitted.some((x) => x.id === 'e11'), truthy)
  check('plan: included/omitted items carry their rendered char costs',
    tight.included.every((x) => x.chars > 0) && tight.omitted.every((x) => x.chars > 0), truthy)
  check('plan: at least one entry is omitted under the tight budget',
    tight.omitted.length, (v) => v >= 1)
  check('plan: every included item declares a boolean truncated flag',
    tight.included.every((x) => typeof x.truncated === 'boolean'), truthy)

  const hugePlan = planInjection({ ...base, budgetChars: 800, entries: [entry({ content: 'y'.repeat(5000) })] })
  check('plan: the single oversized entry is included but flagged truncated',
    hugePlan.included.length === 1 && hugePlan.included[0].truncated === true
    && hugePlan.omitted.length === 0 && hugePlan.text === huge, truthy)

  // Determinism for the plan itself, not just its text.
  check('plan: identical input yields a byte-identical plan',
    JSON.stringify(planInjection(many)) === JSON.stringify(tight), truthy)
}

// ---- tags (F2): normalised grouping labels that never reach the prompt ---
{
  const truthy = (v) => v === true
  check('tags: non-array input is no tags', JSON.stringify(sanitizeTags('x')), (v) => v === '[]')
  check('tags: null/undefined input is no tags',
    sanitizeTags(null).length === 0 && sanitizeTags(undefined).length === 0, truthy)
  check('tags: non-string and blank items are dropped',
    JSON.stringify(sanitizeTags(['a', 1, null, '', '   ', 'b'])), (v) => v === JSON.stringify(['a', 'b']))
  check('tags: surrounding whitespace is trimmed',
    sanitizeTags(['  code  '])[0], (v) => v === 'code')
  check('tags: inner whitespace runs collapse to one space',
    sanitizeTags(['code   style'])[0], (v) => v === 'code style')
  check('tags: newlines collapse to a space (single-line labels)',
    sanitizeTags(['a\nb'])[0], (v) => v === 'a b')
  check('tags: values de-duplicate after trimming',
    JSON.stringify(sanitizeTags(['x', 'x', ' x '])), (v) => v === JSON.stringify(['x']))
  check('tags: an over-long tag is cut to 24 characters',
    sanitizeTags(['t'.repeat(40)])[0].length, (v) => v === 24)
  check('tags: at most 8 tags survive, de-duplicated first',
    sanitizeTags(['1', '2', '3', '4', '5', '6', '7', '8', '9', '1']).length, (v) => v === 8)

  const withTags = sanitizeEntry({ id: 't1', title: 'T', content: 'C', tags: ['代码', ' 规范 '] })
  check('tags: sanitizeEntry keeps normalised tags',
    JSON.stringify(withTags.tags), (v) => v === JSON.stringify(['代码', '规范']))
  const noTags = sanitizeEntry({ id: 't2', title: 'T', content: 'C' })
  check('tags: an entry without tags gets an empty array (old stores stay valid)',
    Array.isArray(noTags.tags) && noTags.tags.length === 0, truthy)
  const badTags = sanitizeEntry({ id: 't3', title: 'T', content: 'C', tags: { nope: 1 } })
  check('tags: a non-array tags field degrades to no tags',
    Array.isArray(badTags.tags) && badTags.tags.length === 0, truthy)

  // Tags are management-only: they must never appear in the injected block or
  // change its decisions.
  const tagged = buildBlock({
    version: 1, enabled: true, budgetChars: 4000,
    entries: [sanitizeEntry({ id: 'a', title: 'T', content: 'C', tags: ['绝不应该出现的标签'] })],
  })
  const tagless = buildBlock({
    version: 1, enabled: true, budgetChars: 4000,
    entries: [sanitizeEntry({ id: 'a', title: 'T', content: 'C' })],
  })
  check('tags: tag text never appears in the injected block', !tagged.includes('绝不应该出现的标签'), truthy)
  check('tags: tags do not change the injected text', tagged === tagless, truthy)
  const plan = planInjection({
    version: 1, enabled: true, budgetChars: 4000,
    entries: [sanitizeEntry({ id: 'a', title: 'T', content: 'C', tags: ['x'] })],
  })
  check('tags: the injection plan is unaffected (one included entry)',
    plan.included.length === 1 && plan.included[0].id === 'a' && plan.omitted.length === 0, truthy)
}

// ---- storage location: the harness home, never the working directory ----
//
// Regression guard. The first build resolved its data file against the harness
// `fs` service, whose default base is the host process cwd; launching DSH from
// another directory then produced a second, empty store and the user's
// memories appeared to vanish.

// Path fixtures are built with join() on platform-appropriate roots, so the
// same assertions hold on Windows CI and a POSIX checkout.
const FAKE_HOME = process.platform === 'win32'
  ? join('C:', 'Users', 'example')
  : join('/', 'home', 'example')
const ALT_ROOT = process.platform === 'win32'
  ? join('D:', 'harness-home')
  : join('/', 'opt', 'harness-home')
const EXPECTED = join('instruction-memory', 'memory.json')

check('store path honours an explicit $DSH_HOME',
  resolveStorePath({ DSH_HOME: ALT_ROOT }, FAKE_HOME),
  (v) => v === join(ALT_ROOT, EXPECTED))

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

// ---- IPv6 loopback must not be rejected by the request guard ------------
//
// Two shipped defects made the settings page unusable when the GUI was opened
// through http://[::1]:port:
//   1. hostnameOf('::1') chopped a bare IPv6 literal at the last colon,
//      returning ':' which never matched the loopback allowlist;
//   2. URL.hostname keeps the brackets ('[::1]') while the Host parsing
//      strips them ('::1'), so the same-origin comparison never succeeded.
{
  const hCases = [
    ['127.0.0.1:8080', '127.0.0.1'],
    ['localhost:8080', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['[::1]:8080', '::1'],
    ['[::1]', '::1'],
    // Bare IPv6 literal (non-conforming Host, but it must parse to the
    // address rather than the port-chopped ':' the old code returned).
    ['::1', '::1'],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
    ['[::ffff:127.0.0.1]:8080', '::ffff:127.0.0.1'],
    // A malformed, unclosed bracket still yields the address inside.
    ['[::1', '::1'],
  ]
  for (const [input, expected] of hCases) {
    check('hostnameOf(' + JSON.stringify(input) + ') = ' + JSON.stringify(expected),
      hostnameOf(input), (x) => x === expected)
  }

  // Canonical IP spelling — the WHATWG URL parser emits the hex form of a
  // mapped address while Host keeps the dotted-quad form; the guard compares
  // ADDRESSES, so both spellings must collapse to one value.
  check('canonicalIp: ::ffff:127.0.0.1 equals its hex spelling ::ffff:7f00:1',
    canonicalIp('::ffff:127.0.0.1'),
    (x) => x === canonicalIp('::ffff:7f00:1')
      && x === '0000:0000:0000:0000:0000:ffff:7f00:0001')
  check('canonicalIp: ::1 expands to the full eight groups',
    canonicalIp('[::1]'), (x) => x === '0000:0000:0000:0000:0000:0000:0000:0001')
  check('canonicalIp: a full literal round-trips to padded lower case',
    canonicalIp('2001:DB8::1'), (x) => x === '2001:0db8:0000:0000:0000:0000:0000:0001')
  check('canonicalIp: a zone id is ignored for the comparison',
    canonicalIp('fe80::1%eth0'), (x) => x === 'fe80:0000:0000:0000:0000:0000:0000:0001')
  check('canonicalIp: an IPv4 literal gets a distinct family prefix',
    canonicalIp('127.0.0.1'), (x) => x === 'v4:127.0.0.1' && x !== canonicalIp('::1'))
  check('canonicalIp: hostnames and garbage are not IPs (null)',
    canonicalIp('not-an-ip'), (x) => x === null)
  check('canonicalIp: evil.com / ::gggg / null are not IPs',
    [canonicalIp('localhost'), canonicalIp('evil.com'), canonicalIp('::gggg'), canonicalIp(null)],
    (xs) => xs.every((x) => x === null))

  const v = (headers, guarded = true) => requestOriginVerdict(headers, guarded).ok
  check('IPv6 bracketed loopback Host + same Origin is accepted',
    v({ host: '[::1]:8080', origin: 'http://[::1]:8080' }), (x) => x === true)
  check('IPv6 loopback with an Origin on a different port is same-host',
    v({ host: '[::1]:8080', origin: 'http://[::1]:9999' }), (x) => x === true)
  check('a bare ::1 Host is treated as loopback',
    v({ host: '::1' }), (x) => x === true)
  check('IPv4-mapped loopback is accepted with its bracketed Origin',
    v({ host: '[::ffff:127.0.0.1]:8080', origin: 'http://[::ffff:127.0.0.1]:8080' }), (x) => x === true)
  check('IPv4-mapped loopback: dotted Host vs the URL-parser hex Origin is accepted',
    v({ host: '[::ffff:127.0.0.1]:8080', origin: 'http://[::ffff:7f00:1]:8080' }), (x) => x === true)
  check('IPv4-mapped loopback: the hex Host form is recognised as loopback',
    v({ host: '[::ffff:7f00:1]:8080', origin: 'http://[::ffff:7f00:1]:8080' }), (x) => x === true)
  // The guard must still do its actual job on IPv6:
  check('a foreign Origin against [::1] is refused (rebinding still blocked)',
    v({ host: '[::1]:8080', origin: 'http://evil.com' }), (x) => x === false)
  check('a non-loopback Host on an ::1 bind is refused',
    v({ host: 'evil.com:8080', origin: 'http://evil.com:8080' }), (x) => x === false)
  // And the IPv4 path the fix could not regress:
  check('IPv4 same-origin is still accepted',
    v({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }), (x) => x === true)
  check('localhost same-origin is still accepted',
    v({ host: 'localhost:8080', origin: 'http://localhost:9000' }), (x) => x === true)
  // Non-loopback binds disable the Host allowlist but keep Origin checks.
  check('a published bind keeps accepting a concrete Host',
    v({ host: '192.168.1.5:8080' }, false), (x) => x === true)
  check('a published bind still refuses a cross Origin',
    v({ host: '192.168.1.5:8080', origin: 'http://evil.com' }, false), (x) => x === false)
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

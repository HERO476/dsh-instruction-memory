/**
 * Smoke test for the pure Host logic. Runs with plain node, no deps:
 *   node smoke-test.mjs
 */
import { isAbsolute, join } from 'node:path'
import { MAX_BODY_CHARS, LIMITS, HISTORY_FILE_PATTERN, activeScope, buildBlock, canonicalIp, deviceTag, exportFileName, historyDeviceOf, historyEpochOf, historyFileName, historyRevOf, historyStamp, hostnameOf, inScope, isMuted, muteExpired, planInjection, requestOriginVerdict, resolveStorePath, sanitizeEntry, sanitizeProfile, sanitizeSet, sanitizeTags, truncatedProfileFields, truncatedSetFields } from './lib/index.js'

let failures = 0
/**
 * Three call shapes are accepted, because the later blocks want the shorter
 * ones: `(label, value, predicate)`, `(label, boolean)` — where the value must
 * BE true — and `(label, boolean, detail)` where the third argument is only
 * text for the failure line. (Requiring a comparator for every boolean
 * assertion used to crash instead of failing.)
 */
const check = (label, actual, predicate) => {
  const ok = typeof predicate === 'function' ? predicate(actual) : actual === true
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    const shown = typeof predicate === 'function' || predicate === undefined ? actual : predicate
    console.log('      got: ' + JSON.stringify(shown).slice(0, 400))
  }
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

// ---- 用户形象 (persona profiles): facts about the user, never a role ----
{
  const truthy = (v) => v === true

  // sanitizeProfile
  check('profile: non-object/blank is null',
    sanitizeProfile(null) === null && sanitizeProfile({ name: '   ', content: '' }) === null, truthy)
  check('profile: name is forced onto one line and capped at 40',
    (() => { const p = sanitizeProfile({ name: 'a\nb' + 'x'.repeat(60), content: 'C' }); return p.name.indexOf('\n') === -1 && p.name.length === 40 })(),
    truthy)
  check('profile: content is capped at 4000',
    sanitizeProfile({ name: 'n', content: 'y'.repeat(5000) }).content.length === 4000, truthy)
  check('profile: enabled defaults to true and honours false',
    sanitizeProfile({ name: 'a', content: 'b' }).enabled === true
    && sanitizeProfile({ name: 'a', content: 'b', enabled: false }).enabled === false, truthy)
  check('profile: a missing id is minted; a supplied one is kept and cut',
    (() => { const minted = sanitizeProfile({ name: 'a', content: 'b' }); const kept = sanitizeProfile({ id: 'p1', name: 'a', content: 'b' }); return typeof minted.id === 'string' && minted.id !== '' && kept.id === 'p1' })(),
    truthy)
  check('profile: a blank name falls back to the first 20 chars of content',
    sanitizeProfile({ content: '1234567890123456789012345' }).name === '12345678901234567890', truthy)
  check('profile: truncatedProfileFields reports name/content cuts',
    JSON.stringify(truncatedProfileFields({ name: 'x'.repeat(50), content: 'y'.repeat(5000) })),
    (v) => v === JSON.stringify(['形象名称', '形象内容']))

  const entryOnly = (profiles) => ({
    version: 1, enabled: true, budgetChars: 4000,
    entries: [sanitizeEntry({ id: 'e1', title: 'T', content: 'C' })],
    profiles,
  })

  // 0 enabled profiles => byte-identical to the old entries-only block.
  const none = planInjection(entryOnly(undefined))
  const old = planInjection({ version: 1, enabled: true, budgetChars: 4000, entries: [sanitizeEntry({ id: 'e1', title: 'T', content: 'C' })] })
  check('profile: no profiles field renders byte-identically to the old block',
    none.text === old.text && none.profileChars === 0 && JSON.stringify(none.profiles) === '[]', truthy)
  check('profile: empty/disabled profiles render nothing',
    planInjection(entryOnly([
      sanitizeProfile({ id: 'p0', name: 'off', content: 'x', enabled: false }),
    ])).profileChars === 0, truthy)

  // 1 enabled profile: header about the USER, placed before the instructions.
  const one = planInjection(entryOnly([
    sanitizeProfile({ id: 'p1', name: '职业背景', content: '有 8 年后端经验' }),
  ]))
  check('profile: one profile injects the "关于用户" persona header',
    one.text.includes('## 关于用户（用户形象）') && one.text.includes('### 职业背景')
    && one.text.includes('有 8 年后端经验'), truthy)
  check('profile: persona section is placed BEFORE the instruction block',
    one.text.indexOf('## 关于用户（用户形象）') < one.text.indexOf('## 用户长期指令记忆'), truthy)
  check('profile: the wording demotes it to a tilt, not a role',
    one.text.includes('不是要求你扮演的角色') && one.text.includes('紧扣问题本身'), truthy)
  check('profile: plan exposes profile metadata and entryChars',
    one.profiles.length === 1 && one.profiles[0].name === '职业背景'
    && one.profileChars > 0 && one.entryChars === old.text.length, truthy)

  // Multiple profiles: one ### subsection each, in stored order.
  const two = planInjection(entryOnly([
    sanitizeProfile({ id: 'p1', name: '职业背景', content: '后端工程师' }),
    sanitizeProfile({ id: 'p2', name: '沟通偏好', content: '先结论后步骤' }),
  ]))
  check('profile: two profiles render two subsections in order',
    (two.text.match(/### /g) || []).length === 2
    && two.text.indexOf('### 职业背景') < two.text.indexOf('### 沟通偏好'), truthy)

  // Profile-only store (no instructions) still injects.
  const personaOnly = planInjection({
    version: 1, enabled: true, budgetChars: 4000, entries: [],
    profiles: [sanitizeProfile({ id: 'p1', name: '性格', content: '喜欢简洁' })],
  })
  check('profile: a profile-only store injects the persona with no instruction header',
    personaOnly.text.includes('## 关于用户（用户形象）')
    && !personaOnly.text.includes('## 用户长期指令记忆')
    && personaOnly.entryChars === 0 && personaOnly.activeCount === 0, truthy)

  // Master switch suppresses BOTH halves.
  const switchedOff = planInjection({
    version: 1, enabled: false, budgetChars: 4000,
    entries: [sanitizeEntry({ id: 'e1', title: 'T', content: 'C' })],
    profiles: [sanitizeProfile({ id: 'p1', name: 'n', content: 'c' })],
  })
  check('profile: master enabled=false suppresses persona and instructions',
    switchedOff.text === '' && switchedOff.profiles.length === 0, truthy)

  // Personas are NOT subject to the entry budget: a big profile survives a
  // tight budget in full while instructions are trimmed independently.
  const longContent = '形象'.repeat(1500) // 3000 chars
  const tight = planInjection({
    version: 1, enabled: true, budgetChars: 800,
    entries: [sanitizeEntry({ id: 'e1', title: 'T', content: '指令内容 '.repeat(400) })],
    profiles: [sanitizeProfile({ id: 'p1', name: '长篇背景', content: longContent })],
  })
  check('profile: persona content is injected in full regardless of the entry budget',
    tight.text.includes(longContent) && tight.profiles[0].chars >= longContent.length, truthy)
  check('profile: persona does not perturb the entry budget decision',
    tight.budget === 800 && Array.isArray(tight.included) && Array.isArray(tight.omitted), truthy)

  // Determinism of the persona rendering.
  const data = entryOnly([
    sanitizeProfile({ id: 'p1', name: '职业背景', content: '后端' }),
    sanitizeProfile({ id: 'p2', name: '追求', content: '严谨' }),
  ])
  check('profile: rendering is deterministic',
    planInjection(data).text === planInjection(JSON.parse(JSON.stringify(data))).text, truthy)
}

// ---- F13 配置集: scope resolution, membership, and the cwd red line ----
//
// The one rule this feature must never break: nothing derives a set from the
// process's working directory. The incident that rule comes from is documented
// in the README (a cwd-derived store location made memory look like it had
// vanished when DSH was relaunched from another folder). These checks pin the
// pure half of it — resolution is a function of the DATA alone.
{
  const truthy = (v) => v === true
  const set = (id, name) => ({ id, name })
  const item = (over) => ({ id: 'e', title: 'T', content: 'C', setId: 'st-a', ...over })

  check('scope: a store with no sets is the legacy single-set shape',
    activeScope({ entries: [] }).scoped === false, JSON.stringify(activeScope({ entries: [] })))
  check('scope: an empty sets array is not a scope either',
    activeScope({ sets: [], activeSetId: 'st-a' }).scoped === false, 'expected scoped=false')
  check('scope: null and junk degrade to "everything in scope"',
    activeScope(null).scoped === false && activeScope('x').scoped === false
    && inScope(item(), activeScope(null)) === true, truthy)
  check('scope: sets + activeSetId resolve to that set',
    activeScope({ sets: [set('st-a', 'A'), set('st-b', 'B')], activeSetId: 'st-b' }).activeId === 'st-b')
  check('scope: an unknown activeSetId falls back to the FIRST set (as the loader does)',
    activeScope({ sets: [set('st-a', 'A'), set('st-b', 'B')], activeSetId: 'st-gone' }).activeId === 'st-a')
  check('scope: a missing activeSetId falls back to the first set too',
    activeScope({ sets: [set('st-a', 'A')] }).activeId === 'st-a')
  check('scope: set entries without an id are ignored',
    activeScope({ sets: [{ name: 'no id' }, set('st-a', 'A')] }).ids.join(','), (v) => v === 'st-a')

  const scope = activeScope({ sets: [set('st-a', 'A'), set('st-b', 'B')], activeSetId: 'st-a' })
  check('scope: an item of the active set is in scope', inScope(item({ setId: 'st-a' }), scope) === true)
  check('scope: an item of another set is NOT', inScope(item({ setId: 'st-b' }), scope) === false)
  check('scope: an unattributed item follows the active set (never disappears)',
    inScope(item({ setId: '' }), scope) === true && inScope({ id: 'x' }, scope) === true)
  check('ISOLATION: only the active set reaches the block',
    (() => {
      const data = {
        version: 2, enabled: true, budgetChars: 4000,
        activeSetId: 'st-a',
        sets: [set('st-a', 'A'), set('st-b', 'B')],
        entries: [
          { ...entry({ id: 'in', title: 'IN-A', content: 'AAA' }), setId: 'st-a' },
          { ...entry({ id: 'out', title: 'IN-B', content: 'BBB' }), setId: 'st-b' },
        ],
        profiles: [
          { ...sanitizeProfile({ id: 'p-in', name: 'pa', content: 'pa' }), setId: 'st-a' },
          { ...sanitizeProfile({ id: 'p-out', name: 'pb', content: 'pb' }), setId: 'st-b' },
        ],
      }
      const planA = planInjection(data)
      const planB = planInjection({ ...data, activeSetId: 'st-b' })
      return planA.text.includes('IN-A') && !planA.text.includes('IN-B')
        && !planA.text.includes('### pb') && planA.profiles.length === 1
        && planB.text.includes('IN-B') && !planB.text.includes('IN-A')
        && planB.included.length === 1 && planB.included[0].id === 'out'
    })(), truthy)
  check('ISOLATION: switching sets is the ONLY thing that changes the text (deterministic)',
    (() => {
      const data = {
        version: 2, enabled: true, budgetChars: 4000, activeSetId: 'st-a',
        sets: [set('st-a', 'A'), set('st-b', 'B')],
        entries: [{ ...entry({ id: 'in', title: 'IN-A', content: 'AAA' }), setId: 'st-a' }],
      }
      return buildBlock(data) === buildBlock(JSON.parse(JSON.stringify(data)))
        && buildBlock(data) !== buildBlock({ ...data, activeSetId: 'st-b' })
    })(), truthy)
  check('scope: a store with sets but no matching items injects nothing at all',
    (() => {
      const data = {
        version: 2, enabled: true, budgetChars: 4000, activeSetId: 'st-b',
        sets: [set('st-a', 'A'), set('st-b', 'B')],
        entries: [{ ...entry({ id: 'in', title: 'IN-A', content: 'AAA' }), setId: 'st-a' }],
      }
      return buildBlock(data) === '' && planInjection(data).included.length === 0
    })(), truthy)
  check('scope: a legacy store (no sets) still injects everything, as before',
    ((v) => v.includes('IN-A') && v.includes('IN-B'))(buildBlock({
      version: 1, enabled: true, budgetChars: 4000,
      entries: [
        { ...entry({ id: 'a', title: 'IN-A', content: 'AAA' }), setId: 'st-whatever' },
        { ...entry({ id: 'b', title: 'IN-B', content: 'BBB' }), setId: 'st-other' },
      ],
    })), truthy)

  // sanitizeSet
  check('set: a blank name is rejected',
    sanitizeSet(null) === null && sanitizeSet({ name: '   ' }) === null
    && sanitizeSet({ name: '\n\n' }) === null, truthy)
  check('set: a name is forced onto one line and capped at 30',
    (() => { const s = sanitizeSet({ name: 'a\nb' + 'x'.repeat(60) }); return s.name.indexOf('\n') === -1 && s.name.length === 30 })(),
    truthy)
  check('set: a missing id is minted with the st- prefix; a supplied one is kept',
    (() => { const minted = sanitizeSet({ name: 'n' }); const kept = sanitizeSet({ id: 'st-1', name: 'n' }); return /^st-/.test(minted.id) && kept.id === 'st-1' })(),
    truthy)
  check('set: truncatedSetFields reports an over-long name',
    JSON.stringify(truncatedSetFields({ name: 'x'.repeat(40) })), (v) => v === JSON.stringify(['配置集名称']))
  check('set: scope readers ignore a malformed sets entry',
    activeScope({ sets: [{ id: 42, name: 'x' }], activeSetId: 1 }).scoped === false)
}

// ---- F13/F14: entry & profile membership survives sanitisation ----
{
  const truthy = (v) => v === true
  check('member: sanitizeEntry keeps a declared setId',
    sanitizeEntry({ title: 't', content: 'c', setId: 'st-work' }).setId === 'st-work')
  check('member: a missing setId becomes empty (unattributed), not an error',
    sanitizeEntry({ title: 't', content: 'c' }).setId === '')
  check('member: a non-string/id-less setId degrades to empty',
    sanitizeEntry({ title: 't', content: 'c', setId: 7 }).setId === ''
    && sanitizeEntry({ title: 't', content: 'c', setId: '' }).setId === '')
  check('member: sanitizeProfile keeps a declared setId too',
    sanitizeProfile({ name: 'n', content: 'c', setId: 'st-work' }).setId === 'st-work')
}

// ---- F14: snapshot naming is a pinned format, and pruning is per device ----
{
  const truthy = (v) => v === true
  // Both helpers format in UTC (the store must not change meaning with the
  // machine's timezone), so the expectation is the plain UTC wall clock.
  const epoch = Date.UTC(2026, 9, 15, 15, 23, 55, 123)
  const stamp = historyStamp(epoch)
  check('history: the stamp is a fixed-width UTC string',
    stamp.length === 19 && /^\d{8}T\d{9}Z$/.test(stamp), stamp)
  const name = historyFileName(epoch, 12, 'laptop')
  check('history: a snapshot name carries stamp + revision + device',
    name === '20261015T152355123Z-r12-laptop.json', name)
  check('history: the plugin recognises its own names only',
    HISTORY_FILE_PATTERN.test(name) === true
    && HISTORY_FILE_PATTERN.test('memory.json') === false
    && HISTORY_FILE_PATTERN.test('20261015T072355123Z.json') === false
    && HISTORY_FILE_PATTERN.test('../' + name) === false
    && HISTORY_FILE_PATTERN.test('20261015T072355123Z-r12-LAPTOP.json') === false, truthy)
  check('history: name parsing round-trips stamp, rev and device',
    historyEpochOf(name) === epoch
    && historyRevOf(name) === 12 && historyDeviceOf(name) === 'laptop',
    JSON.stringify({ e: historyEpochOf(name), r: historyRevOf(name), d: historyDeviceOf(name) }))
  check('history: a foreign name yields no metadata instead of throwing',
    historyEpochOf('memory.json') === 0 && historyRevOf(null) === 0 && historyDeviceOf({}) === '')
  check('history: sorting names sorts chronologically (fixed width pays off)',
    [historyFileName(2000, 2, 'a'), historyFileName(1000, 1, 'a')].sort().join(','),
    (v) => v === historyFileName(1000, 1, 'a') + ',' + historyFileName(2000, 2, 'a'))
  check('history: revision 0 and a huge revision both format',
    historyFileName(0, 0, 'd') === '19700101T000000000Z-r0-d.json'
    && historyRevOf(historyFileName(0, 987654321, 'd')) === 987654321,
    historyFileName(0, 0, 'd'))

  check('device: a hostname is sanitised into a filename-safe tag',
    deviceTag('DESKTOP-ABC 123') === 'desktop_abc_123'
    && deviceTag('..\\/evil') === 'evil'
    && deviceTag('') === 'unknown' && deviceTag('中文') === 'unknown', JSON.stringify([
    deviceTag('DESKTOP-ABC 123'), deviceTag('..\\/evil'), deviceTag('中文'),
  ]))
  check('device: the tag is capped so a long hostname cannot bloat the name',
    deviceTag('a'.repeat(64)).length === 16, String(deviceTag('a'.repeat(64)).length))
  check('export: the manual export filename carries a UTC stamp',
    exportFileName(epoch) === 'dsh-instruction-memory-20261015-152355Z.json',
    exportFileName(epoch))
}

// ---- the published limits object (the schema is pinned to it) ----
{
  const truthy = (v) => v === true
  check('limits: the published object carries every ceiling the UI quotes',
    LIMITS.formatVersion === 2 && LIMITS.maxEntries === 200 && LIMITS.maxTitle === 120
    && LIMITS.maxContent === 6000 && LIMITS.maxWhen === 200 && LIMITS.maxTagsPerEntry === 8
    && LIMITS.maxTagLength === 24 && LIMITS.maxProfiles === 50 && LIMITS.maxProfileName === 40
    && LIMITS.maxProfileContent === 4000 && LIMITS.maxSets === 20 && LIMITS.maxSetName === 30
    && LIMITS.minBudget === 800 && LIMITS.maxBudget === 40000 && LIMITS.maxHistory === 20,
    JSON.stringify(LIMITS))
  check('limits: the object is frozen (a consumer cannot mutate the ceilings)',
    Object.isFrozen(LIMITS) === true)
  check('body ceiling: it still exceeds the largest store this plugin can export',
    MAX_BODY_CHARS > LIMITS.maxEntries * LIMITS.maxContent + LIMITS.maxProfiles * LIMITS.maxProfileContent,
    String(MAX_BODY_CHARS))
}

// ---- F7 临时静音：isMuted 真值表 + planInjection/buildBlock 的注入时钟 ----
{
  const NOW = 1_700_000_000_000
  const muted = (over) => isMuted({ ...base, entries: [entry()], ...over }, NOW)

  check('mute: a store without disabledUntil is never muted', muted({}) === false)
  check('mute: disabledUntil 0 is not a pause', muted({ disabledUntil: 0 }) === false)
  check('mute: a past instant is not a pause', muted({ disabledUntil: NOW - 1 }) === false)
  check('mute: a future instant is a pause', muted({ disabledUntil: NOW + 1 }) === true)
  check('mute: NaN is not a pause', muted({ disabledUntil: NaN }) === false)
  check('mute: the master switch off overrides any pause',
    muted({ enabled: false, disabledUntil: NOW + 1 }) === false)
  check('mute: a null store is not muted', isMuted(null, NOW) === false)

  check('mute: muteExpired matches only the lapsed instants',
    muteExpired({ ...base, disabledUntil: NOW - 1 }, NOW) === true
    && muteExpired({ ...base, disabledUntil: NOW + 1 }, NOW) === false
    && muteExpired({ ...base, disabledUntil: 0 }, NOW) === false
    && muteExpired({ ...base, enabled: false, disabledUntil: NOW - 1 }, NOW) === false)

  // The injectable clock: the SAME store is byte-identical to enabled:false
  // while the pause is live, and byte-identical to the never-paused store once
  // the instant has passed. No real waiting anywhere — the clock is a param.
  const live = { ...base, entries: [entry()], profiles: [{ id: 'p1', name: 'P', content: 'C', enabled: true }] }
  const paused = { ...live, disabledUntil: NOW + 1000 }
  check('mute: paused plan is byte-identical to enabled:false (text + every plan field)',
    JSON.stringify(planInjection(paused, NOW)) === JSON.stringify(planInjection({ ...live, enabled: false }, NOW)))
  check('mute: paused block is empty while the pause is live', buildBlock(paused, NOW) === '')
  check('mute: the same store renders again once the instant has passed',
    buildBlock(paused, NOW + 2000) === buildBlock(live, NOW + 2000)
    && buildBlock(paused, NOW + 2000).length > 0)
  check('mute: the wall-clock default equals an explicit now',
    buildBlock({ ...base, entries: [entry()] }) === buildBlock({ ...base, entries: [entry()] }, Date.now()))
  check('mute: personas are suppressed with the instructions while paused',
    planInjection(paused, NOW).profiles.length === 0 && planInjection(paused, NOW).profileChars === 0)
  check('mute: the clock parameters are optional (arity stays 1)',
    planInjection.length === 1 && buildBlock.length === 1)
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

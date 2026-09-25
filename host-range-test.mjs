/**
 * Host-range contract test: pin the declared DSH compatibility range.
 *   node host-range-test.mjs
 *
 * Why this exists (the bug it prevents):
 *
 * `dsh.engines.dsh` used to end with a single `>=0.1.5-alpha.1`. That LOOKS
 * unbounded, but npm's prerelease gate is evaluated per `||` set: a version
 * carrying a prerelease tag satisfies a set only when some comparator in that
 * set shares its [major, minor, patch] tuple AND carries a prerelease of its
 * own. The gate runs before the comparisons, so
 * `>=0.1.5-alpha.1` + `0.1.6-alpha.2` failed on `0.1.5 !== 0.1.6` alone —
 * the host actually installed on this machine was judged incompatible by
 * standard semver while passing under `includePrerelease: true` (which is
 * what dshmarket's discovery path happens to pass). A silent, environment-
 * dependent false negative.
 *
 * The fix enumerates each prerelease tuple explicitly, so both evaluation
 * modes agree. This test freezes that: it reads the range from package.json
 * (never a copy — a hand-kept duplicate is how the two drifted) and asserts
 * the full version matrix under BOTH modes.
 *
 * It happened AGAIN, one minor later: DSH shipped 0.1.7-rc.2 against a range
 * whose last prerelease tuple was 0.1.6. Same silent false negative, same
 * masking by includePrerelease. Two lessons are baked into this file now —
 * (1) the matrix enumerates every line the range claims, and (2) a LIVE guard
 * reads whatever host is actually installed and asserts it, so the next
 * uncovered prerelease line fails here rather than shipping.
 *
 * Runs on the semver instance the profile ships, falling back to node's own
 * resolution, so it needs no dependency of its own.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/* ---------------- read the range from the single source of truth ---------------- */

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const declared = pkg.dsh?.engines?.dsh
const compatibility = pkg.dsh?.compatibility?.dsh

check('package.json declares dsh.engines.dsh', typeof declared === 'string' && declared !== '')
check('package.json declares dsh.compatibility.dsh', typeof compatibility === 'string' && compatibility !== '')
check('the two declarations are identical', declared === compatibility,
  JSON.stringify({ engines: declared, compatibility }))

/* ---------------- the range's single source of truth ---------------- */

// Enumerating one `||` segment per prerelease tuple IS the fix for the two
// shipped false negatives — but it is also a maintenance trap: 1.0.8 stopped
// enumerating at 0.1.6, so DSH's 0.1.7-rc.2 was silently judged incompatible.
// Hand-editing a long `||` string is how that happens.
//
// So the segments are declared here as data, and the string in package.json is
// GENERATED from them. Adding a DSH minor means adding one line to this list;
// the drift check below then prints the exact string to paste.
const COVERED_LINES = [
  // Each line covers [floor, below); RANGE_TAIL is the unbounded tail.
  { floor: '0.1.3-alpha.2', below: '0.1.4' },
  { floor: '0.1.4-0', below: '0.1.5-0' },
  { floor: '0.1.5-alpha.1', below: '0.1.6-0' },
  { floor: '0.1.6-alpha.0', below: '0.1.7-0' },
  { floor: '0.1.7-alpha.0', below: '0.2.0-0' },
]
const RANGE_TAIL = '>=0.2.0-0'

const generateRange = (lines, tail) =>
  [...lines.map((line) => '>=' + line.floor + ' <' + line.below), tail].join(' || ')

const generated = generateRange(COVERED_LINES, RANGE_TAIL)

check('package.json range equals the range generated from COVERED_LINES',
  declared === generated,
  declared === generated
    ? ''
    : 'package.json has:  ' + declared + '   the list generates:  ' + generated)

/**
 * The exact edit that would cover a host version this range does not admit.
 *
 * A range edit is unavoidable: npm's prerelease gate matches the
 * [major, minor, patch] tuple exactly, so no range can reach `0.1.8-rc.1` while
 * also reaching `0.1.8`. What this removes is the guesswork — it names the line
 * to append and the bound to move, and the LIVE GUARD below proves the
 * suggestion actually admits the version before printing it.
 */
function remedyFor(version) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (parsed === null) return null
  const major = Number(parsed[1])
  const minor = Number(parsed[2])
  const patch = Number(parsed[3])
  const tuple = major + '.' + minor + '.' + patch
  const previousBelow = tuple + '-0'
  const appended = { floor: tuple + '-alpha.0', below: major + '.' + (minor + 1) + '.0-0' }
  return {
    hint: 'append { floor: \'' + appended.floor + '\', below: \'' + appended.below + '\' } to COVERED_LINES '
      + 'and set the preceding line\'s below to \'' + previousBelow + '\'',
    applied: [
      ...COVERED_LINES.slice(0, -1),
      { ...COVERED_LINES[COVERED_LINES.length - 1], below: previousBelow },
      appended,
    ],
  }
}

/* ---------------- load a semver ---------------- */

// Prefer the profile's own semver (the one every DSH host actually evaluates
// with); fall back to whatever node resolves so the suite still runs on a
// machine with no DSH profile.
function loadSemver() {
  const roots = [
    join(homedir(), '.dsh', 'profiles', 'web', 'node_modules'),
    join(homedir(), '.dsh', 'profiles', 'node_modules'),
  ]
  for (const root of roots) {
    try {
      return createRequire(join(root, 'noop.js'))('semver')
    } catch {
      // try the next root
    }
  }
  try {
    return createRequire(import.meta.url)('semver')
  } catch {
    return null
  }
}

const semver = loadSemver()
if (semver === null) {
  console.log('SKIP  no semver implementation available on this machine')
  console.log('\nALL PASS (skipped)')
  process.exit(0)
}
console.log('#       semver ' + semver.SEMVER_SPEC_VERSION + ' semantics\n')

/* ---------------- the enumerated lines must be live and ordered ---------------- */

// Every declared line must actually be reachable, and the lines must ascend.
// This is the meaningful form of "no gaps": a line no version can satisfy is
// dead weight, and a line whose floor sits below the previous line's floor
// means the enumeration drifted out of order (how 1.0.8 missed 0.1.7).
{
  const unreachable = COVERED_LINES
    .filter((line) => semver.satisfies(line.floor, generated) !== true)
    .map((line) => line.floor)
  check('every enumerated line is reachable from the generated range',
    unreachable.length === 0, unreachable.join(', '))

  const outOfOrder = []
  for (let i = 1; i < COVERED_LINES.length; i += 1) {
    if (semver.gt(COVERED_LINES[i].floor, COVERED_LINES[i - 1].floor) !== true) {
      outOfOrder.push(COVERED_LINES[i].floor + ' after ' + COVERED_LINES[i - 1].floor)
    }
  }
  check('the enumerated lines ascend strictly', outOfOrder.length === 0, outOfOrder.join('; '))
}

/* ---------------- locate the DSH actually installed here ---------------- */

// The profile's own dependency tree is the authoritative "what is running"
// answer when a profile exists; the editor-bundled copy is the other way DSH
// reaches a machine. Both are probed, in that order, because a profile can
// pin an older host than the editor ships.
//
// Returns null (→ SKIP, not FAIL) when neither is present: this suite has to
// stay runnable on a bare checkout and in CI, where no DSH is installed.
function readInstalledHostVersion() {
  const candidates = [
    join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    // Windows: the TRAE-packaged runtime. Kept as a literal rather than a scan
    // so a failing lookup costs one stat, not a directory walk.
    join(homedir(), 'AppData', 'Roaming', 'TRAE SOLO CN', 'ModularData', 'ai-agent',
      'vm', 'tools', 'node', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed.version === 'string' && semver.valid(parsed.version) !== null) {
        return parsed.version
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/* ---------------- the matrix ---------------- */

// Every host version this plugin has actually been exercised against, plus the
// surrounding prereleases that the old range silently rejected. All must pass.
//
// Only the 0.1.3 … 0.1.7 prerelease lines can be listed here. npm's gate
// matches the [major, minor, patch] tuple EXACTLY, so a prerelease on a line
// that has no comparator of its own is unreachable from any range —
// `0.1.8-rc.1` cannot be admitted while `0.1.8` itself is admitted, just as
// `^0.1.0` can never match `0.1.8-rc.1`. Future prerelease lines therefore
// require a range edit; the released forms below need no such care.
const MUST_PASS = [
  // verified on Windows / Node 22 (README's tested table)
  '0.1.3-alpha.2',
  '0.1.5-alpha.1',
  '0.1.5-alpha.2',
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  // the 0.1.4 line and its prereleases
  '0.1.4-0',
  '0.1.4-1',
  '0.1.4-alpha.0',
  '0.1.4',
  // the exact host that exposed the first bug: 0.1.6 prereleases
  '0.1.6-alpha.0',
  '0.1.6-alpha.2',
  // the 0.1.7 line — the second occurrence of the same bug, and the reason
  // this file enumerates tuples instead of trusting one `>=` tail
  '0.1.7-alpha.0',
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  // released forms and the unbounded tail the README promises.
  // `0.1.8-rc.1` is deliberately absent — see the note above.
  '0.1.3',
  '0.1.5',
  '0.1.6',
  '0.1.7',
  '0.2.0-alpha.1',
  '0.2.0',
  '0.3.0',
  '1.0.0',
  // `2.0.0-rc.1` is deliberately absent for the same reason as `0.1.8-rc.1`:
  // its tuple has no comparator, so no range can reach it.
]

// Below the declared floor: the plugin has never seen these. They must be
// rejected, so "supports everything" cannot quietly become true either.
const MUST_FAIL = ['0.0.9', '0.1.0', '0.1.2', '0.1.3-alpha.0', '0.1.3-alpha.1']

for (const version of MUST_PASS) {
  const plain = semver.satisfies(version, declared)
  const pre = semver.satisfies(version, declared, { includePrerelease: true })
  check('range admits ' + version + ' (both evaluation modes)', plain && pre,
    'default=' + plain + ' includePrerelease=' + pre)
}

for (const version of MUST_FAIL) {
  const plain = semver.satisfies(version, declared)
  const pre = semver.satisfies(version, declared, { includePrerelease: true })
  check('range rejects ' + version + ' (below the floor, both modes)', !plain && !pre,
    'default=' + plain + ' includePrerelease=' + pre)
}

/* ---------------- the shipped hosts must never regress ---------------- */

// The concrete false negatives this suite was written for. Pinned by name so a
// future edit that reintroduces the tail-only `>=0.1.5-alpha.1` form fails here
// with an unmistakable label.
//
// 0.1.6-alpha.2 was the first occurrence (fixed in 1.0.8). 0.1.7-rc.2 was the
// second (fixed in 1.0.9) — the same bug, one minor later, which is why the
// matrix above now enumerates every line the range claims.
for (const host of ['0.1.6-alpha.2', '0.1.7-rc.2']) {
  const plain = semver.satisfies(host, declared)
  const pre = semver.satisfies(host, declared, { includePrerelease: true })
  check('REGRESSION GUARD: the shipped host ' + host + ' is admitted by both modes',
    plain === true && pre === true,
    'default=' + plain + ' includePrerelease=' + pre)
}

// The strongest form of the guard: read whatever DSH is actually installed on
// this machine and assert it directly. The named guards above are frozen
// facts; this one is a live check, so a host upgrade to an uncovered
// prerelease line fails here instead of shipping as a false negative.
{
  const installed = readInstalledHostVersion()
  if (installed === null) {
    console.log('SKIP  no installed DSH found to check against')
  } else {
    const plain = semver.satisfies(installed, declared)
    const pre = semver.satisfies(installed, declared, { includePrerelease: true })
    const admitted = plain === true && pre === true

    // When this fails, say exactly what to change — the 1.0.8 and 1.0.9 misses
    // were both "the guard knew but told nobody how to fix it".
    let detail = 'default=' + plain + ' includePrerelease=' + pre
    const remedy = admitted ? null : remedyFor(installed)
    if (remedy !== null) {
      detail += '  -> NOT COVERED. Fix: ' + remedy.hint
      // Prove the suggested edit works before recommending it, so the advice
      // can never be stale or wrong.
      const patched = generateRange(remedy.applied, RANGE_TAIL)
      const patchedOk = semver.satisfies(installed, patched) === true
        && semver.satisfies(installed, patched, { includePrerelease: true }) === true
      detail += patchedOk
        ? '  [verified: that edit admits ' + installed + ']'
        : '  [WARNING: that suggested edit does NOT admit ' + installed + ' — fix remedyFor()]'
    }
    check('LIVE GUARD: the installed host ' + installed + ' is admitted by both modes',
      admitted, admitted ? '' : detail)
  }
}

/* ---------------- the remedy recipe is itself verified ---------------- */

// The one hard limit: a prerelease on an UNDECLARED future minor can never be
// reached by any range, because npm matches the [major, minor, patch] tuple
// exactly. `0.1.8-rc.1` is unreachable today. That cannot be fixed — but the
// remedy for it can be, so it is exercised here instead of trusted: if the
// recipe ever stops working, this fails before a user hits it.
{
  const hypothetical = '0.1.8-rc.1'
  check('0.1.8-rc.1 is unreachable from the current range (the documented limit)',
    semver.satisfies(hypothetical, declared) === false,
    'it was unexpectedly admitted')

  const remedy = remedyFor(hypothetical)
  const patched = generateRange(remedy.applied, RANGE_TAIL)
  check('the documented remedy makes 0.1.8-rc.1 reachable (both modes)',
    semver.satisfies(hypothetical, patched) === true
    && semver.satisfies(hypothetical, patched, { includePrerelease: true }) === true,
    remedy.hint)
  check('the remedied range still rejects everything below the floor',
    semver.satisfies('0.1.3-alpha.1', patched) === false
    && semver.satisfies('0.0.9', patched) === false)
  check('the remedied range still admits every currently covered version',
    MUST_PASS.every((version) => semver.satisfies(version, patched) === true),
    MUST_PASS.filter((version) => semver.satisfies(version, patched) !== true).join(', '))
}

/* ---------------- the two modes must agree on every declared line ---------------- */

// No version on a line this range explicitly covers may be judged differently
// by npm's default semantics and by the wider includePrerelease mode. That
// divergence is exactly how the shipped bug hid: dshmarket's discovery passes
// includePrerelease, so the market said "compatible" while plain npm said
// "incompatible" for the same host.
{
  const disagreeing = []
  const sweep = []
  for (const minor of [3, 4, 5, 6, 7]) {
    for (const tag of ['-alpha.0', '-alpha.1', '-alpha.2', '-beta.0', '-rc.1', '-rc.9', '']) {
      sweep.push('0.1.' + minor + tag)
    }
  }
  for (const version of sweep) {
    const plain = semver.satisfies(version, declared)
    const pre = semver.satisfies(version, declared, { includePrerelease: true })
    if (plain !== pre) disagreeing.push(version + ' (default=' + plain + ' pre=' + pre + ')')
  }
  check('no disagreement on the covered 0.1.3-0.1.7 lines (' + sweep.length + ' swept)',
    disagreeing.length === 0, disagreeing.join(', '))
}

/* ---------------- the declared lines are covered contiguously ---------------- */

// Guard against a future edit that drops a tuple: every prerelease on the
// 0.1.3+ covered lines must be admitted, and nothing below 0.1.3-alpha.2 may
// sneak in. 0.1.8+ is intentionally out of scope (see MUST_PASS note).
{
  const admitted = []
  for (const minor of [3, 4, 5, 6, 7]) {
    for (const tag of ['-alpha.1', '-alpha.2', '-rc.1', '']) {
      admitted.push('0.1.' + minor + tag)
    }
  }
  const gaps = admitted
    .filter((version) => !semver.satisfies(version, declared))
    .filter((version) => version !== '0.1.3-alpha.1')
  check('the covered 0.1.3-0.1.7 lines have no gaps', gaps.length === 0, gaps.join(', '))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

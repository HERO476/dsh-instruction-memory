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

/* ---------------- the matrix ---------------- */

// Every host version this plugin has actually been exercised against, plus the
// surrounding prereleases that the old range silently rejected. All must pass.
//
// Only the 0.1.3 / 0.1.4 / 0.1.5 / 0.1.6 prerelease lines can be listed here.
// npm's gate matches the [major, minor, patch] tuple EXACTLY, so a prerelease
// on a line that has no comparator of its own is unreachable from any range —
// `0.1.7-rc.1` cannot be admitted while `0.1.7` itself is admitted, just as
// `^0.1.0` can never match `0.1.7-rc.1`. Future prerelease lines therefore
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
  // the exact host that exposed the bug: 0.1.6 prereleases
  '0.1.6-alpha.0',
  '0.1.6-alpha.2',
  // released forms and the unbounded tail the README promises.
  // `0.1.7-rc.1` is deliberately absent — see the note above.
  '0.1.3',
  '0.1.5',
  '0.1.6',
  '0.2.0-alpha.1',
  '0.2.0',
  '0.3.0',
  '1.0.0',
  // `2.0.0-rc.1` is deliberately absent for the same reason as `0.1.7-rc.1`:
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

/* ---------------- the shipped host must never regress ---------------- */

// The concrete false negative this suite was written for. Pinned by name so a
// future edit that reintroduces the tail-only `>=0.1.5-alpha.1` form fails here
// with an unmistakable label.
{
  const host = '0.1.6-alpha.2'
  const plain = semver.satisfies(host, declared)
  const pre = semver.satisfies(host, declared, { includePrerelease: true })
  check('REGRESSION GUARD: the installed host ' + host + ' is admitted by both modes',
    plain === true && pre === true,
    'default=' + plain + ' includePrerelease=' + pre)
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
  for (const minor of [3, 4, 5, 6]) {
    for (const tag of ['-alpha.0', '-alpha.1', '-alpha.2', '-beta.0', '-rc.1', '-rc.9', '']) {
      sweep.push('0.1.' + minor + tag)
    }
  }
  for (const version of sweep) {
    const plain = semver.satisfies(version, declared)
    const pre = semver.satisfies(version, declared, { includePrerelease: true })
    if (plain !== pre) disagreeing.push(version + ' (default=' + plain + ' pre=' + pre + ')')
  }
  check('no disagreement on the covered 0.1.3-0.1.6 lines (' + sweep.length + ' swept)',
    disagreeing.length === 0, disagreeing.join(', '))
}

/* ---------------- the declared lines are covered contiguously ---------------- */

// Guard against a future edit that drops a tuple: every prerelease on the
// 0.1.3+ covered lines must be admitted, and nothing below 0.1.3-alpha.2 may
// sneak in. 0.1.7+ is intentionally out of scope (see MUST_PASS note).
{
  const admitted = []
  for (const minor of [3, 4, 5, 6]) {
    for (const tag of ['-alpha.1', '-alpha.2', '-rc.1', '']) {
      admitted.push('0.1.' + minor + tag)
    }
  }
  const gaps = admitted
    .filter((version) => !semver.satisfies(version, declared))
    .filter((version) => version !== '0.1.3-alpha.1')
  check('the covered 0.1.3-0.1.6 lines have no gaps', gaps.length === 0, gaps.join(', '))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)

/**
 * Install / uninstall dsh-instruction-memory into a DSH profile.
 *
 *   node install.mjs                          # install into the default profile
 *   node install.mjs --profile superagent     # install into a named profile
 *   node install.mjs --remove                 # roll back completely
 *
 * The profile is resolved in this order: $DSH_PROFILE_DIR (a path), then
 * --profile <name>, then $DSH_PROFILE, then 'web' UNDER $DSH_HOME. Note which
 * variable decides what: $DSH_HOME moves the profiles ROOT, while the name
 * comes from $DSH_PROFILE_DIR / --profile / $DSH_PROFILE. A DSH that spawned
 * this shell exports both, so $DSH_PROFILE_DIR wins over the home you just
 * set — the script warns when the two disagree instead of silently writing
 * into the live profile.
 *
 * A profile that holds no package.json is refused before anything is written,
 * and the profiles that do exist are listed.
 *
 * Three idempotent steps:
 *   1. make the package resolvable from the profile's node_modules (junction)
 *   2. register it in `dsh.profile.bundles`, so the boot composes its
 *      cordis.patch.yml host row
 *   3. declare it in the profile's `dependencies` as `link:<this checkout>`.
 *      A junction plus a bundle entry is enough for the HOST to load the
 *      plugin, but NOT enough to be seen by the market: dshmarket's installed
 *      list is built from the profile's `dependencies` only
 *      (`readInstalled` in dshmarket/src/profile.ts), so a plugin installed
 *      by steps 1-2 alone runs while showing up nowhere under 「已安装」.
 *
 * The profile package.json is backed up before the first modification.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync, lstatSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Profile location follows the same precedence as @deepseek-ai/dsh-home-paths
// (and this plugin's own store resolution): explicit $DSH_HOME, else ~/.dsh.
// A relative override is resolved ONCE, for the same reason the plugin does it:
// every path this script prints and writes must be absolute.
const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME.trim())
  : join(homedir(), '.dsh')

// Which profile to install into.
//
// $DSH_HOME only moves the profiles ROOT. The NAME comes from the variables
// below, and DSH exports both to every child process — so a shell that merely
// sets DSH_HOME to a scratch directory still installs into $DSH_PROFILE_DIR
// (the live profile). That mismatch is announced rather than silently obeyed.
//
// This used to be hardcoded to 'web'. On a machine whose DSH runs the
// `superagent` profile the script created a junction and a bundle entry inside
// a profile nothing loads, then printed INSTALLED — the plugin looked installed
// and stayed invisible. Resolve it instead, with the same precedence the boot
// uses (an explicit directory wins over a name; the environment wins over the
// default):
//
//   $DSH_PROFILE_DIR  (a path)
//   --profile <name>
//   $DSH_PROFILE      (a name)
//   'web'
const PROFILES_ROOT = join(DSH_HOME, 'profiles')

function profileNameFromArgv() {
  const index = process.argv.indexOf('--profile')
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    console.error('--profile needs a profile name, e.g. --profile superagent')
    console.error('  nothing was changed.')
    process.exit(1)
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    console.error('--profile takes a profile NAME (e.g. superagent), not a path: ' + value)
    console.error('  use --profile to pick a name, or $DSH_PROFILE_DIR for an explicit directory.')
    console.error('  nothing was changed.')
    process.exit(1)
  }
  return value
}

const explicitProfileDir = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.trim() !== ''
  ? resolve(process.env.DSH_PROFILE_DIR.trim())
  : null
const profileName = profileNameFromArgv()
  ?? (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : null)
  ?? 'web'
const PROF = explicitProfileDir ?? join(PROFILES_ROOT, profileName)

// A DSH that spawned this shell exports BOTH DSH_HOME and DSH_PROFILE_DIR.
// Setting only DSH_HOME therefore does not redirect the install: the explicit
// profile directory still wins, and the write lands in the live profile. Say
// so BEFORE it happens rather than after.
if (explicitProfileDir !== null && !explicitProfileDir.startsWith(DSH_HOME)) {
  console.error('warning: DSH_PROFILE_DIR (' + explicitProfileDir + ') is not inside DSH_HOME (' + DSH_HOME + ')')
  console.error('  the explicit profile directory wins, so this install goes to the profile above,')
  console.error('  not to the home you may have just set. Unset DSH_PROFILE_DIR to use DSH_HOME.')
}

/** Profile directories that actually hold a manifest, for the failure message. */
function visibleProfiles() {
  try {
    return readdirSync(PROFILES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(PROFILES_ROOT, entry.name, 'package.json')))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

// Fail before any filesystem change: writing into a profile that does not
// exist would create `profiles/<typo>/` and report success for an install that
// can never load.
if (!existsSync(join(PROF, 'package.json'))) {
  const visible = visibleProfiles()
  console.error('profile not found: ' + PROF)
  console.error('  choose one with  --profile <name>  (or set $DSH_PROFILE / $DSH_PROFILE_DIR).')
  console.error(visible.length > 0
    ? '  profiles available under ' + PROFILES_ROOT + ': ' + visible.join(', ')
    : '  no profile with a package.json under ' + PROFILES_ROOT)
  console.error('  nothing was changed.')
  process.exit(1)
}
// This script lives in the package root, so the source is wherever it runs from.
const SRC = dirname(fileURLToPath(import.meta.url))
const NAME = 'dsh-instruction-memory'

const remove = process.argv.includes('--remove')
const link = join(PROF, 'node_modules', NAME)
const pkgPath = join(PROF, 'package.json')
const backupPath = pkgPath + '.dsh-instruction-memory.bak'

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, 'utf8'))
}

/**
 * Read the profile manifest BEFORE touching anything on disk.
 *
 * Reading it late turned one unparsable `package.json` (interrupted write, hand
 * edit, failed market install) into a half state: `--remove` had already
 * unlinked the junction when the parse threw, and `install` had already created
 * the junction and rolled the backup, so the profile either kept dependency
 * entries for a plugin that is gone or listed a link that was never enabled.
 * Failing first keeps the filesystem exactly as it was.
 */
function readPkgOrExit() {
  try {
    return readPkg()
  } catch (err) {
    console.error('cannot read ' + pkgPath + ': ' + (err && err.message ? err.message : String(err)))
    console.error('  it is not valid JSON — an interrupted write or a hand edit is the usual cause.')
    console.error('  nothing was changed. Restore it from ' + backupPath + ' and run this again.')
    process.exit(1)
  }
}

function writePkg(pkg) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

function bundlesOf(pkg) {
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
  return pkg.dsh.profile.bundles
}

if (remove) {
  let touched = false
  // Fail before any filesystem change: see readPkgOrExit.
  const pkg = readPkgOrExit()
  // `link` is normally a junction, and unlinking one removes only the link —
  // the real package stays where it is. It can also be a REAL directory (pnpm
  // materialises `link:` dependencies into node_modules as a copy), and there
  // the old `rmSync(link, {recursive: true})` fallback deleted the installed
  // copy itself: an uninstall that silently destroys the thing it was told to
  // detach. Refuse that case and say what to do instead.
  let linkKind = null
  try {
    linkKind = lstatSync(link).isSymbolicLink() ? 'link' : 'directory'
  } catch {
    linkKind = null
  }
  if (linkKind === 'link') {
    // A junction can still refuse to go away (EBUSY/EPERM while DSH holds it
    // open). The old call let that throw as an unhandled rejection, which read
    // as a crash rather than "nothing was removed".
    try {
      unlinkSync(link)
      console.log('removed junction: ' + link)
      touched = true
    } catch (err) {
      console.error('could not remove ' + link + ': ' + (err && err.code ? err.code : String(err)))
      console.error('  close DSH (or any process using the plugin) and run this again.')
      process.exitCode = 1
    }
  } else if (linkKind === 'directory') {
    console.error('refusing to delete ' + link)
    console.error('  it is a real directory (a pnpm-materialised copy), not a junction;')
    console.error('  recursive deletion would remove the installed plugin itself.')
    console.error('  delete it yourself once you have confirmed that is what you want.')
    // Stop HERE: continuing would strip the dependency and the bundle entry
    // while the plugin is still on disk, leaving a profile that reports the
    // plugin as absent and an install that cannot find it either.
    console.log('\nNOT UNINSTALLED — see the refusal above.')
    process.exit(1)
  }
  if (process.exitCode) {
    // The junction could not be removed; do not report the plugin as detached.
    console.log('\nNOT UNINSTALLED — see the refusal above.')
    process.exit(process.exitCode)
  }
  let changed = false
  if (pkg.dependencies !== undefined && Object.hasOwn(pkg.dependencies, NAME)) {
    delete pkg.dependencies[NAME]
    changed = true
    console.log('removed from dependencies')
  }
  const bundles = pkg.dsh?.profile?.bundles
  const index = Array.isArray(bundles) ? bundles.indexOf(NAME) : -1
  if (index >= 0) {
    bundles.splice(index, 1)
    changed = true
    console.log('removed from dsh.profile.bundles')
  }
  if (changed) {
    writePkg(pkg)
    touched = true
  }
  if (existsSync(backupPath)) console.log('backup kept at: ' + backupPath)
  if (process.exitCode) {
    console.log('\nNOT UNINSTALLED — see the refusal above.')
  } else {
    console.log(touched ? '\nUNINSTALLED — restart DSH to unload the plugin.' : '\nnothing to remove')
  }
  // Honour the failure flag the refused-deletion branch may have set: a bare
  // process.exit(0) would report success for an uninstall that did nothing.
  process.exit(process.exitCode ?? 0)
}

// ---- install ----
if (!existsSync(SRC)) {
  console.error('source package not found: ' + SRC)
  process.exit(1)
}

const pkg = readPkgOrExit()

if (existsSync(link)) {
  console.log('junction already present: ' + link)
} else {
  // A freshly initialised profile has no node_modules directory yet; symlink()
  // does not create the parent, so this used to fail with ENOENT on exactly
  // the "new profile" case this script exists to support.
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(SRC, link, 'junction')
  console.log('junction created: ' + link)
}

// Roll the previous backup forward instead of keeping the first one forever:
// a profile package.json broken by a later run is exactly what the user needs
// the backup for, and a backup frozen at the first install cannot restore it.
const lastBackupPath = backupPath + '.last'
if (existsSync(backupPath)) {
  copyFileSync(backupPath, lastBackupPath)
  console.log('rotated previous backup -> ' + lastBackupPath)
}
copyFileSync(pkgPath, backupPath)
console.log('backed up profile package.json -> ' + backupPath)

let changed = false

// Step 3: a link: dependency, so the market lists it under 「已安装」.
// package.json only — the target is the junction from step 1, so no
// reinstall of the package itself is needed.
const spec = 'link:' + SRC.replaceAll('\\', '/')
pkg.dependencies = pkg.dependencies || {}
if (pkg.dependencies[NAME] === spec) {
  console.log('already a profile dependency: ' + spec)
} else {
  pkg.dependencies[NAME] = spec
  changed = true
  console.log('declared as a profile dependency: ' + spec)
}

const bundles = bundlesOf(pkg)
if (bundles.includes(NAME)) {
  console.log('already in dsh.profile.bundles')
} else {
  bundles.push(NAME)
  changed = true
  console.log('added to dsh.profile.bundles (position ' + bundles.length + ')')
}

if (changed) writePkg(pkg)

console.log('\nINSTALLED. Restart DSH to mount the plugin.')
console.log('Roll back with:  node install.mjs --remove')

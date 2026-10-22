/**
 * Install / uninstall dsh-instruction-memory into the web profile.
 *
 *   node install.mjs           # install
 *   node install.mjs --remove  # roll back completely
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
import { existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, unlinkSync, copyFileSync } from 'node:fs'
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
const PROF = join(DSH_HOME, 'profiles', 'web')
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
  if (existsSync(link)) {
    try {
      unlinkSync(link)
    } catch {
      rmSync(link, { recursive: true, force: true })
    }
    console.log('removed junction: ' + link)
    touched = true
  }
  const pkg = readPkg()
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
  console.log(touched ? '\nUNINSTALLED — restart DSH to unload the plugin.' : '\nnothing to remove')
  process.exit(0)
}

// ---- install ----
if (!existsSync(SRC)) {
  console.error('source package not found: ' + SRC)
  process.exit(1)
}

if (!existsSync(join(PROF, 'package.json'))) {
  console.error('web profile not found at ' + PROF + '（DSH 尚未初始化该 profile？）')
  process.exit(1)
}

if (existsSync(link)) {
  console.log('junction already present: ' + link)
} else {
  symlinkSync(SRC, link, 'junction')
  console.log('junction created: ' + link)
}

if (!existsSync(backupPath)) {
  copyFileSync(pkgPath, backupPath)
  console.log('backed up profile package.json -> ' + backupPath)
}

const pkg = readPkg()
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

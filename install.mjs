/**
 * Install / uninstall dsh-instruction-memory into the web profile.
 *
 *   node install.mjs           # install
 *   node install.mjs --remove  # roll back completely
 *
 * Two idempotent steps:
 *   1. make the package resolvable from the profile's node_modules (junction)
 *   2. register it in `dsh.profile.bundles`, so the boot composes its
 *      cordis.patch.yml host row
 *
 * The profile package.json is backed up before the first modification.
 */
import { existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, unlinkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const PROF = 'C:\\Users\\34332\\.dsh\\profiles\\web'
const SRC = 'D:\\Users\\34332\\AI\\dsh-instruction-memory'
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
  const bundles = bundlesOf(pkg)
  const index = bundles.indexOf(NAME)
  if (index >= 0) {
    bundles.splice(index, 1)
    writePkg(pkg)
    console.log('removed from dsh.profile.bundles')
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
const bundles = bundlesOf(pkg)
if (bundles.includes(NAME)) {
  console.log('already in dsh.profile.bundles')
} else {
  bundles.push(NAME)
  writePkg(pkg)
  console.log('added to dsh.profile.bundles (position ' + bundles.length + ')')
}

console.log('\nINSTALLED. Restart DSH to mount the plugin.')
console.log('Roll back with:  node install.mjs --remove')

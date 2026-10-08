/**
 * Compare the packages bundled inside the DSH desktop app (app.asar) against the
 * same packages as published on npm.
 *
 *   node desktop-vs-npm.mjs <version> <extractedDir> <pkg> [<pkg> ...]
 *
 * <extractedDir>/<pkg>/package/** is the unpacked npm tarball.
 *
 * Why this matters: the desktop app does not ship `@deepseek-ai/dsh`; it ships a
 * private `@deepseek-ai/dsh-desktop-runtime`. If the sub-packages it bundles are
 * byte-identical to the public ones, then every contract conclusion already
 * verified against a public release transfers to the desktop app — and any
 * difference is exactly where desktop-specific risk lives.
 *
 * `.d.ts` files are excluded from the archive by its packaging, so they are
 * reported separately and never counted as a behavioural difference.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ARCHIVE =
  process.env.DSH_ASAR ??
  'D:\\Users\\34332\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'

const [version, extractedDir, ...pkgs] = process.argv.slice(2)

function openArchive(archive) {
  const fd = openSync(archive, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const jsonLength = head.readUInt32LE(12)
  if (jsonLength <= 0 || 16 + jsonLength > statSync(archive).size) {
    throw new Error('implausible asar header length: ' + jsonLength)
  }
  const jsonBuf = Buffer.alloc(jsonLength)
  readSync(fd, jsonBuf, 0, jsonLength, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  return { fd, baseOffset: 16 + Math.ceil(jsonLength / 4) * 4, header }
}

function collect(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix + '/' + name
    if (entry.files !== undefined) collect(entry, path, out)
    else out.set(path, entry)
  }
  return out
}

const { fd, baseOffset, header } = openArchive(ARCHIVE)
const archived = collect(header, '', new Map())

const hashInArchive = (path) => {
  const entry = archived.get(path)
  if (entry === undefined) return null
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset))
  return createHash('sha256').update(buf).digest('hex').toUpperCase()
}

const isTypeDeclaration = (p) => p.endsWith('.d.ts')
// The archive vendors declared dependencies under node_modules/ (npm tarballs do
// not ship them), so those are additive and never a behavioural difference.
const isVendoredDependency = (p) => p.includes('node_modules/')
// package.json is compared semantically instead: the desktop repack rewrites it
// and JSON key order is not part of its meaning. It still matters, because
// getDshRuntimeVersion() returns the version inside dsh-app-boot's package.json.
const isManifest = (p) => p === 'package.json'
const isRuntimeCode = (p) =>
  !isTypeDeclaration(p) && !isVendoredDependency(p) && !isManifest(p) && /\.(js|mjs|cjs)$/.test(p)

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.join('\u0000') !== kb.join('\u0000')) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

let hardFailures = 0

for (const pkg of pkgs) {
  const archivePrefix = `/dsh/node_modules/@deepseek-ai/${pkg}/`
  const tarballRoot = join(extractedDir, pkg, 'package')

  const archiveFiles = new Map()
  for (const path of archived.keys()) {
    if (!path.startsWith(archivePrefix)) continue
    archiveFiles.set(path.slice(archivePrefix.length), hashInArchive(path))
  }

  const tarballFiles = new Map()
  const walkTar = (dir, rel) => {
    for (const entry of readdirSyncSafe(dir)) {
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walkTar(abs, rel + entry + '/')
      else tarballFiles.set(
        rel + entry,
        createHash('sha256').update(readFileSync(abs)).digest('hex').toUpperCase(),
      )
    }
  }
  walkTar(tarballRoot, '')

  const onlyArchive = []
  const onlyTarball = []
  const differing = []
  for (const [rel, hash] of archiveFiles) {
    if (!tarballFiles.has(rel)) onlyArchive.push(rel)
    else if (tarballFiles.get(rel) !== hash) differing.push(rel)
  }
  for (const rel of tarballFiles.keys()) if (!archiveFiles.has(rel)) onlyTarball.push(rel)

  // Only runtime code can change behaviour.
  const codeDiffering = differing.filter(isRuntimeCode)
  const codeMissing = onlyArchive.filter(isRuntimeCode)
  const codeExtra = onlyTarball.filter(isRuntimeCode)

  // package.json: semantically equal, and the version must match.
  let manifestNote = 'absent from archive'
  if (archiveFiles.has('package.json') && tarballFiles.has('package.json')) {
    const a = JSON.parse(readFileSync(join(tarballRoot, 'package.json'), 'utf8'))
    const b = JSON.parse(readArchiveText(archivePrefix + 'package.json'))
    const sameSemantics = deepEqual(a, b)
    const sameVersion = a.version === b.version
    manifestNote = sameSemantics
      ? 'semantically identical'
      : sameVersion
        ? 'same version, other fields differ'
        : `VERSION MISMATCH (archive ${b.version} vs npm ${a.version})`
    if (!sameVersion) hardFailures += 1
  }

  const clean = codeDiffering.length === 0 && codeMissing.length === 0 && codeExtra.length === 0
  if (!clean) hardFailures += 1

  console.log(`${pkg}  [npm ${version}]`)
  console.log(`  files: archive ${archiveFiles.size}, tarball ${tarballFiles.size}`)
  console.log(`  runtime JS: ${clean ? 'IDENTICAL' : 'DIFFERS'}`)
  if (codeDiffering.length > 0) console.log(`    content differs: ${codeDiffering.join(', ')}`)
  if (codeMissing.length > 0) console.log(`    only in archive: ${codeMissing.join(', ')}`)
  if (codeExtra.length > 0) console.log(`    only in tarball: ${codeExtra.join(', ')}`)
  console.log(`  package.json: ${manifestNote}`)
  const typesOnly = [...onlyTarball, ...onlyArchive].filter(isTypeDeclaration)
  const vendored = [...onlyArchive].filter(isVendoredDependency)
  const notes = []
  if (typesOnly.length > 0) notes.push(`${typesOnly.length} .d.ts stripped by packaging`)
  if (vendored.length > 0) notes.push(`${vendored.length} vendored dependency file(s)`)
  if (notes.length > 0) console.log(`    (${notes.join('; ')}) — no runtime effect`)
}

closeSync(fd)
console.log('')
console.log(hardFailures === 0
  ? 'ALL PACKAGES: runtime-identical to the published release'
  : hardFailures + ' package(s) differ at runtime — inspect above')
process.exit(hardFailures === 0 ? 0 : 1)

function readArchiveText(path) {
  const entry = archived.get(path)
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset))
  return buf.toString('utf8')
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

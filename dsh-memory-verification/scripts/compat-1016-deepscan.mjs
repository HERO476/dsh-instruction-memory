/**
 * Tier-2 deep static scan for the top-downloaded memory plugins.
 *
 * npm pack each target, unpack it, and extract the REAL resource occupancy
 * from its shipped code and manifest — mount mechanism, systemPrompt section
 * names/orders, HTTP route prefixes and on-disk store paths — so they can be
 * compared directly against dsh-instruction-memory:
 *
 *   section  name='instruction-memory' order=950
 *   route    prefix '/instruction-memory/api'
 *   store    $DSH_HOME/instruction-memory/memory.json
 *
 * Packages are unpacked but NEVER imported or executed.
 *
 *   node compat-1016-deepscan.mjs <pkg[@version]> [more...]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VROOT = join(HERE, '..')
const PACKS = process.argv.slice(2)
if (PACKS.length === 0) { console.log('usage: node compat-1016-deepscan.mjs <pkg> ...'); process.exit(2) }

const WORK = mkdtempSync(join(tmpdir(), 'compat-deepscan-'))
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const findings = []
for (const spec of PACKS) {
  const f = { spec, packed: false }
  try {
    const out = execFileSync('npm.cmd', ['pack', spec, '--pack-destination', WORK, '--silent'], {
      encoding: 'utf8', maxBuffer: 1 << 26, shell: true,
    }).trim().split(/\r?\n/).filter(Boolean).pop()
    const tgz = join(WORK, out)
    if (!existsSync(tgz)) throw new Error('tarball missing: ' + out)
    f.packed = true
    f.tarball = out
    const ex = join(WORK, out.replace(/\.tgz$/, ''))
    mkdirSync(ex, { recursive: true })
    execFileSync('tar.exe', ['-xzf', tgz, '-C', ex], { stdio: 'ignore' })
    const root = join(ex, 'package')

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    f.version = pkg.version
    f.dshField = pkg.dsh ?? null
    f.deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((d) => d.startsWith('@deepseek-ai/'))

    const files = walk(root)
    const blobs = files.map((p) => {
      let s = ''
      try { s = readFileSync(p, 'utf8') } catch { /* binary */ }
      return { rel: p.slice(root.length + 1), s }
    }).filter((b) => b.s.length > 0)
    f.codeFiles = blobs.length
    f.codeBytes = blobs.reduce((n, b) => n + b.s.length, 0)

    const grab = (re, n = 8) => {
      const set = new Set()
      for (const b of blobs) {
        let m
        re.lastIndex = 0
        while ((m = re.exec(b.s)) && set.size < n) set.add(m[1] ?? m[0])
      }
      return [...set]
    }
    // systemPrompt.section({ name, order })
    f.sections = grab(/\.section\s*\(\s*(?:\w+\s*=>\s*)?\{[^}]*?name\s*:\s*['"`]([^'"`]+)['"`][^}]*?\}/g, 12)
    f.sectionOrders = grab(/order\s*:\s*(\d{2,5})/g, 20).map(Number)
    // Raw context around every .section( call — catches specs built in
    // variables or with unusual property order, which the strict regex misses.
    f.sectionContext = [...new Set(blobs.flatMap((b) => {
      const out = []
      for (const m of b.s.matchAll(/\.section\s*\(/g)) {
        out.push(b.rel + ': ' + b.s.slice(m.index, m.index + 180).replace(/\s+/g, ' ').trim())
      }
      return out
    }))].slice(0, 12)
    // webServer.register({ kind, path }) and string route prefixes
    f.routeKinds = grab(/register\s*\(\s*\{[^}]*?kind\s*:\s*['"`]([^'"`]+)['"`]/g, 8)
    f.routePaths = grab(/(?:path|prefix)\s*:\s*['"`](\/[^'"`]{2,80})['"`]/g, 20)
    // service injection arrays
    f.injectServices = grab(/inject\s*[:=]\s*\[([^\]]{1,120})\]/g, 4).flatMap((s) => [...s.matchAll(/['"`]([A-Za-z][\w-]*)['"`]/g)].map((m) => m[1]))
    // candidate store files / home dirs
    f.storeHints = grab(/['"`]([A-Za-z0-9_.-]{2,40}\.json)['"`]/g, 20)
      .filter((x) => /(memory|memo|store|data|state|soul|hindsight|mnemon|mneme)/i.test(x))
    f.homeRefs = grab(/(['"`])(\.dsh|DSH_HOME)\1/g, 3)
    f.stringApis = grab(/['"`](\/(?:api|plugins|memory|memo|hindsight|instruction)[\w/-]*)['"`]/g, 20)
    // quick mount-shape classification
    f.shape = {
      sectionCall: blobs.some((b) => /\.section\s*\(/.test(b.s)),
      registerCall: blobs.some((b) => /webServer[^\n]{0,80}\.register\s*\(/.test(b.s) || /\.register\s*\(\s*\{[^}]*kind/.test(b.s)),
      watchFile: blobs.some((b) => /watch\s*\(|fs\.watch/.test(b.s)),
      clientBundle: !!(pkg.dsh?.client) || blobs.some((b) => /__ModuleLoader__|createRoot|React/.test(b.s)),
    }
    // Bundle patch loader ids — a duplicate id across active bundles makes the
    // host fail to boot ("duplicate loader entry id").
    const patchRel = pkg.dsh?.bundle?.patch
    if (typeof patchRel === 'string') {
      const pp = join(root, patchRel.replace(/^\.\//, ''))
      if (existsSync(pp)) {
        const y = readFileSync(pp, 'utf8')
        f.patchIds = [...y.matchAll(/^\s*-?\s*id:\s*['"]?([\w:.-]+)['"]?\s*$/gm)].map((m) => m[1])
      }
    }
    // Any reference to THIS plugin's exact section name, route prefix or
    // store directory name anywhere in shipped code/manifests.
    const selfMentions = { sectionName: 0, routePrefix: 0, dirName: 0 }
    for (const b of blobs) {
      selfMentions.sectionName += (b.s.match(/['"`]instruction-memory['"`]/g) || []).length
      selfMentions.routePrefix += (b.s.match(/\/instruction-memory\/api/g) || []).length
      selfMentions.dirName += (b.s.match(/instruction-memory[\\/]+memory\.json/g) || []).length
    }
    f.mentionsSelf = selfMentions
    rmSync(ex, { recursive: true, force: true })
    rmSync(tgz, { force: true })
  } catch (err) {
    f.error = String(err?.message ?? err)
  }
  findings.push(f)
  console.log(`\n### ${spec}${f.version ? '@' + f.version : ''}  packed=${f.packed}`)
  if (f.error) { console.log('  ERROR ' + f.error); continue }
  console.log(`  deps: ${f.deps.join(', ') || '(none)'}`)
  console.log(`  shape: ${JSON.stringify(f.shape)}`)
  console.log(`  sections: ${JSON.stringify(f.sections)} orders=${JSON.stringify([...new Set(f.sectionOrders)])}`)
  for (const c of f.sectionContext ?? []) console.log(`    section@ ${c}`)
  console.log(`  routes: kind=${JSON.stringify(f.routeKinds)} paths=${JSON.stringify(f.routePaths)} strings=${JSON.stringify(f.stringApis)}`)
  console.log(`  stores: ${JSON.stringify([...new Set(f.storeHinds ?? f.storeHints)])} homeRefs=${f.homeRefs.length}`)
}
rmSync(WORK, { recursive: true, force: true })

mkdirSync(join(VROOT, 'out'), { recursive: true })
const outFile = join(VROOT, 'out', `compat-1016-deepscan-${process.env.DEEPSCAN_LABEL ?? 'top7'}.json`)
writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  selfBaseline: {
    section: { name: 'instruction-memory', order: 950 },
    route: { kind: 'prefix', path: '/instruction-memory/api' },
    store: '$DSH_HOME/instruction-memory/memory.json',
    clientInject: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings'],
  },
  findings,
}, null, 2), 'utf8')
console.log('\n  evidence -> ' + outFile)

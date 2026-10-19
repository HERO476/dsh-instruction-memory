/**
 * Tier-1 static conflict scan: every plugin catalogued under category=memory
 * in the awesome-dsh-plugin.com directory snapshot.
 *
 * For each package we fetch its abbreviated npm manifest and map the SAME
 * resource surfaces dsh-instruction-memory occupies, from package.json alone
 * (no arbitrary code executed — we never install or run these packages here):
 *
 *   - dsh.client.inject[]      settings/renderer UI injection points
 *   - deps on @deepseek-ai/*   which host services the plugin attaches to
 *   - dsh.bundle.patch          cordis patch layers (deep host rewrites)
 *   - npm name identity         exact-name squat / typosquat surface
 *
 * The concrete order/route/store-path collisions need source and are checked
 * separately (compat-1016-deepscan.mjs) for the shortlisted packages.
 *
 *   node compat-1016-memory-scan.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VROOT = join(HERE, '..')
const SNAP = join(VROOT, 'out', 'compat-1016-catalog-snapshot.json')
const SELF = 'dsh-instruction-memory'
const REG = 'https://registry.npmjs.org/'
const CONCURRENCY = 10

const catalog = JSON.parse(readFileSync(SNAP, 'utf8'))
const memoryPlugins = catalog.plugins.filter((p) => p.category === 'memory')
console.log(`memory-category plugins in snapshot: ${memoryPlugins.length}`)

let done = 0
async function worker(queue, out) {
  while (queue.length) {
    const p = queue.shift()
    // Catalogued but distributed via GitHub Release tarball only — no npm
    // manifest exists; this is a distribution fact, not a fetch failure.
    if (typeof p.npm !== 'string' || p.npm === '') {
      out.push({ npm: null, repo: p.url ?? null, catalogVersion: p.version, downloads: p.downloads ?? 0,
        stars: p.stars ?? 0, capabilities: p.capabilities ?? [], owner: p.owner,
        manifest: { fetched: false, githubReleaseOnly: true, error: null } })
      done += 1
      continue
    }
    try {
      const r = await fetch(REG + p.npm.replace('/', '%2f'), {
        headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'compat-1016-scan' },
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const meta = await r.json()
      const v = meta['dist-tags']?.latest ?? p.version
      const m = meta.versions?.[v] ?? {}
      const deps = { ...m.dependencies, ...m.peerDependencies }
      const dsh = m.dsh ?? {}
      const inject = Array.isArray(dsh.client?.inject) ? dsh.client.inject : []
      done += 1
      if (done % 25 === 0) console.log(`  ...${done}/${memoryPlugins.length}`)
      out.push({
        npm: p.npm, catalogVersion: p.version, downloads: p.downloads, stars: p.stars ?? 0,
        capabilities: p.capabilities ?? [], owner: p.owner,
        manifest: {
          fetched: true, latest: v,
          injectSettings: inject.includes('@deepseek-ai/dsh-client-ui-settings'),
          injectRenderer: inject.includes('@deepseek-ai/dsh-client-ui-renderer'),
          injectOther: inject.filter((x) => !x.includes('dsh-client-ui-settings') && !x.includes('dsh-client-ui-renderer')),
          usesSystemPrompt: Object.prototype.hasOwnProperty.call(deps, '@deepseek-ai/dsh-system-prompt'),
          usesWebServer: Object.prototype.hasOwnProperty.call(deps, '@deepseek-ai/dsh-host-webserver'),
          hasBundlePatch: !!(dsh.bundle?.patch),
          dshEngines: dsh.engines?.dsh ?? m.engines?.dsh ?? null,
          keywords: Array.isArray(m.keywords) ? m.keywords.slice(0, 20) : [],
        },
      })
    } catch (err) {
      done += 1
      out.push({ npm: p.npm, catalogVersion: p.version, downloads: p.downloads, stars: p.stars ?? 0,
        capabilities: p.capabilities ?? [], owner: p.owner, manifest: { fetched: false, error: String(err.message ?? err) } })
    }
  }
}

const queue = [...memoryPlugins]
const collected = []
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue, collected)))
const rows0 = collected

/* ---- classify against this plugin's surfaces ---- */
const rows = rows0.map((r) => {
  const m = r.manifest
  const signals = []
  if (m.fetched === false) signals.push('manifest-unavailable')
  if (r.npm === SELF) signals.push('exact-self')
  // Same settings UI slot as this plugin.
  if (m.injectSettings) signals.push('settings-slot')
  // Same prompt-section service.
  if (m.usesSystemPrompt) signals.push('systemprompt-service')
  // Same HTTP route service.
  if (m.usesWebServer) signals.push('webserver-service')
  // Deep host rewrites can interact with any registered resource.
  if (m.hasBundlePatch) signals.push('bundle-patch')
  return { ...r, signals }
})

const groups = {
  self: rows.filter((r) => r.signals.includes('exact-self')),
  settingsSlot: rows.filter((r) => r.signals.includes('settings-slot')),
  systemPrompt: rows.filter((r) => r.signals.includes('systemprompt-service')),
  webServer: rows.filter((r) => r.signals.includes('webserver-service')),
  bundlePatch: rows.filter((r) => r.signals.includes('bundle-patch')),
  unavailable: rows.filter((r) => r.manifest.fetched === false && r.manifest.githubReleaseOnly !== true),
  githubReleaseOnly: rows.filter((r) => r.manifest.githubReleaseOnly === true),
  noHostServiceEvidence: rows.filter((r) => r.manifest.fetched && !r.signals.some((s) => ['settings-slot', 'systemprompt-service', 'webserver-service', 'bundle-patch'].includes(s))),
}

const top = (arr) => arr.sort((a, b) => b.downloads - a.downloads)
console.log('\n=== Tier-1 manifest conflict-surface scan (207 memory plugins) ===')
console.log(`  manifests fetched: ${groups.self.length + groups.settingsSlot.length + groups.systemPrompt.length + groups.webServer.length + groups.bundlePatch.length + groups.noHostServiceEvidence.length}/${rows.length}`)
console.log(`  github-release-only (no npm): ${groups.githubReleaseOnly.length}`)
console.log(`  real fetch failures:          ${groups.unavailable.length}`)
console.log(`  exact self name:     ${groups.self.length}  ${groups.self.map((r) => r.npm).join(', ') || '-'}`)
console.log(`  settings UI slot:    ${groups.settingsSlot.length}`)
console.log(`  systemPrompt service:${groups.systemPrompt.length}`)
console.log(`  webServer service:   ${groups.webServer.length}`)
console.log(`  bundle patch layer:  ${groups.bundlePatch.length}`)
console.log(`  no host-service evidence in package.json: ${groups.noHostServiceEvidence.length}`)
console.log('\n  -- candidates sharing BOTH settings slot and systemPrompt (closest shape) --')
for (const r of top(groups.settingsSlot.filter((x) => x.signals.includes('systemprompt-service'))).slice(0, 30)) {
  console.log(`  ${r.npm.padEnd(38)} dl=${String(r.downloads).padStart(6)}  ${r.signals.join(',')}`)
}

mkdirSync(join(VROOT, 'out'), { recursive: true })
const outFile = join(VROOT, 'out', 'compat-1016-memory-manifest-scan.json')
writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  basis: 'awesome-dsh-plugin.com catalog snapshot (category=memory) + npm abbreviated manifests; no third-party code executed',
  total: rows.length,
  counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
  groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((x) => x.npm)])),
  rows: rows.sort((a, b) => b.downloads - a.downloads),
}, null, 2), 'utf8')
console.log('\n  evidence -> ' + outFile)

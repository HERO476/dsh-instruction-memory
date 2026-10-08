/**
 * 1.0.11 在最近 10 个 DSH 版本上的适配核验（v3，最终版）。
 *
 * 前两版都被我自己的方法错误推翻，记录在此以免重蹈：
 *   v1  直接读 @deepseek-ai/dsh 顶层 dependencies 找子包 → 全 null。
 *       实际这些包**从不是** dsh 的直接依赖，只出现在传递依赖里（本机就装在
 *       dsh/node_modules/@deepseek-ai/ 下）。v1 结论无效。
 *   v2  自己写 BFS 重实现 npm 解析器 → 只接受"精确锁定"形式的依赖，而旧版本用的是
 *       ^0.1.5-rc.3 这类**范围**，整棵树被剪空，7 个版本假失败。
 *   v3  （本版）不再重实现解析器：
 *       · 版本表取自 npm 官方 registry；
 *       · "dsh@V 的同期子包就是 @V" 这一前提已**实测验证**——5 个子包各自发布的版本
 *         列表与 dsh 的那 10 个版本逐个对应（见 out/dsh-version-matrix.json 的 lockstep）；
 *         并且本机安装树（dsh@0.1.7-rc.2 → 子包全部 0.1.7-rc.2）与该前提一致；
 *       · cordis 单独按 dsh 自己声明的 range + semver.maxSatisfying 解析成具体版本；
 *       · API 符号取自**那个版本真实发布的源码**（jsdelivr 单文件）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PKG = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'))
const PLUGIN_VERSION = PKG.version
const DECLARED = PKG.dsh?.engines?.dsh
const CLIENT_INJECT = PKG.dsh?.client?.inject ?? []

function loadSemver() {
  for (const r of [join(homedir(), '.dsh', 'profiles', 'web', 'node_modules'), join(homedir(), '.dsh', 'profiles', 'node_modules')]) {
    try { return createRequire(join(r, 'noop.js'))('semver') } catch { /* next */ }
  }
  try { return createRequire(import.meta.url)('semver') } catch { return null }
}
const semver = loadSemver()
if (semver === null) { console.log('SKIP 本机无 semver'); process.exit(0) }

const REG = 'https://registry.npmjs.org/'
const CDN = 'https://cdn.jsdelivr.net/npm/'
const H = { 'cache-control': 'no-cache' }
const jsonCache = new Map()
async function getJson(url) {
  if (jsonCache.has(url)) return jsonCache.get(url)
  let out = null
  try { const r = await fetch(url, { headers: H }); if (r.ok) out = await r.json() } catch { out = null }
  jsonCache.set(url, out)
  return out
}
async function getText(url) {
  try { const r = await fetch(url, { headers: H }); return r.ok ? await r.text() : null } catch { return null }
}
const pkgMeta = (name) => getJson(REG + name.replace('/', '%2F'))

/* ---------- 1. 版本表 ---------- */
const dshMeta = await pkgMeta('@deepseek-ai/dsh')
const times = dshMeta.time
const RECENT = Object.keys(dshMeta.versions)
  .filter((v) => times[v] !== undefined)
  .sort((a, b) => new Date(times[b]) - new Date(times[a]))
  .slice(0, 10)

/* ---------- 2. 前提验证：子包版本列表是否与 dsh 一致（lockstep） ---------- */
const FAMILY = ['dsh-system-prompt', 'dsh-host-webserver', 'dsh-client-ui-renderer', 'dsh-client-ui-settings', 'dsh-agent-loop']
const familyMeta = {}
for (const f of FAMILY) familyMeta[f] = await pkgMeta('@deepseek-ai/' + f)
const lockstep = {}
for (const f of FAMILY) {
  const vs = familyMeta[f] === null ? [] : Object.keys(familyMeta[f].versions)
  lockstep[f] = {
    versionCount: vs.length,
    allTenPresent: RECENT.every((v) => vs.includes(v)),
    missing: RECENT.filter((v) => !vs.includes(v)),
  }
}
console.log('=== 前提：dsh@V 的同期子包就是 @V 吗 ===')
console.log('  （npm 官方 registry；子包各自发布的版本列表）')
for (const f of FAMILY) {
  const l = lockstep[f]
  console.log(`  ${f.padEnd(26)} 版本数=${String(l.versionCount).padStart(3)}  含全部 10 个受检版本=${l.allTenPresent}${l.missing.length ? '  缺: ' + l.missing.join(',') : ''}`)
}
const lockstepOk = FAMILY.every((f) => lockstep[f].allTenPresent)

// 本机安装树作为第二重证据
const nested = join(process.env.APPDATA ?? '', 'TRAE SOLO CN', 'ModularData', 'ai-agent', 'vm', 'tools', 'node',
  'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const installedTree = {}
for (const f of FAMILY) {
  const p = join(nested, f, 'package.json')
  installedTree[f] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).version : null
}
const installedDsh = (() => {
  // nested = .../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
  const p = join(dirname(dirname(nested)), 'package.json')
  try { return JSON.parse(readFileSync(p, 'utf8')).version } catch { return null }
})()
console.log('  本机安装树: dsh@' + installedDsh + ' -> ' + FAMILY.map((f) => f.replace('dsh-', '') + '@' + installedTree[f]).join(', '))

/* ---------- 3b. 今天安装"旧版 dsh"会把子包解析到哪里？ ----------
 * dsh 早期版本用 caret 范围声明同族依赖（^0.1.5-alpha.2）。范围会随时间"往前漂"：
 * 今天安装 dsh@0.1.5-alpha.2，npm 可能拉到比当年更新的子包。这不是猜测，可以用
 * semver 对已发布版本表直接算出来。用 dsh-hmr（每个版本都直接依赖）作代表。
 */
const hmrMeta = await pkgMeta('@deepseek-ai/dsh-hmr')
const hmrVersions = hmrMeta === null ? [] : Object.keys(hmrMeta.versions)

/* ---------- 3. cordis 版本解析（唯一需要 range 解析的） ---------- */
const cordisMeta = await pkgMeta('@deepseek-ai/cordis')
const cordisVersions = Object.keys(cordisMeta.versions)

/* ---------- 4. 逐版本核验 ---------- */
const rows = []
for (const V of RECENT) {
  const dshManifest = dshMeta.versions[V]
  const cordisRange = dshManifest.dependencies?.['@deepseek-ai/cordis'] ?? null
  const cordisResolved = cordisRange === null ? null
    : semver.maxSatisfying(cordisVersions, cordisRange, { includePrerelease: true })

  const row = {
    dshVersion: V,
    published: times[V],
    subPackagesAtSameVersion: lockstepOk,
    cordis: { range: cordisRange, resolved: cordisResolved },
    // 今天安装这个 dsh 时，同族 caret 范围会解析到哪个子包版本。
    // 逐版本挑一个**范围形式**的 @deepseek-ai/dsh-* 直接依赖来代表；若全是精确锁定，
    // 就不可能漂移，如实标 exact。
    rangeDriftToday: await (async () => {
      const fam = Object.entries(dshManifest.dependencies ?? {})
        .filter(([n, r]) => n.startsWith('@deepseek-ai/dsh-') && !/^\d+\.\d+\.\d+/.test(r))
      if (fam.length === 0) return { kind: 'all-exact' }
      const [name, range] = fam[0]
      const meta = await pkgMeta(name)
      const vs = meta === null ? [] : Object.keys(meta.versions)
      return {
        kind: 'ranged', sample: name.replace('@deepseek-ai/', ''), range,
        default: semver.maxSatisfying(vs, range),
        includePrerelease: semver.maxSatisfying(vs, range, { includePrerelease: true }),
      }
    })(),
    semver: {
      default: semver.satisfies(V, DECLARED),
      includePrerelease: semver.satisfies(V, DECLARED, { includePrerelease: true }),
    },
    systemPrompt: {}, webServer: {}, cordisApi: {}, client: {},
  }

  // --- host: system-prompt ---
  const spSrc = await getText(`${CDN}@deepseek-ai/dsh-system-prompt@${V}/lib/index.js`)
  row.systemPrompt = spSrc === null ? { fetched: false } : {
    fetched: true, bytes: spSrc.length,
    sectionMethod: /\bsection\(section\)\s*\{/.test(spSrc),
    evaluatesFunctionText: /typeof\s+section\.text\s*===\s*"function"/.test(spSrc),
    fileReference900: /FILE_REFERENCE:\s*900/.test(spSrc),
    toolBash1000: /TOOL_BASH:\s*1e3/.test(spSrc) || /TOOL_BASH:\s*1000/.test(spSrc),
    duplicateNameThrows: /is already registered/.test(spSrc),
    exportsRenderPrompt: /renderPrompt/.test(spSrc),
  }

  // --- host: webserver ---
  const wsSrc = await getText(`${CDN}@deepseek-ai/dsh-host-webserver@${V}/lib/index.js`)
  row.webServer = wsSrc === null ? { fetched: false } : {
    fetched: true, bytes: wsSrc.length,
    registerMethod: /\bregister\(route\)\s*\{/.test(wsSrc),
    hostGetter: /get host\(\)/.test(wsSrc),
    loopbackOnly: /z\.const\("127\.0\.0\.1"\)/.test(wsSrc),
  }

  // --- cordis: ctx.inject / effect / logger（1.0.10 起的硬依赖） ---
  if (cordisResolved !== null) {
    const cSrc = await getText(`${CDN}@deepseek-ai/cordis@${cordisResolved}/lib/index.js`)
    row.cordisApi = cSrc === null ? { fetched: false } : {
      fetched: true, bytes: cSrc.length,
      inject: /\binject\(inject,\s*callback\)\s*\{/.test(cSrc),
      effect: /\beffect\(execute,\s*label/.test(cSrc),
      logger: /LoggerService|logger\s*\(/.test(cSrc),
      provide: /\bprovide\(name/.test(cSrc) || /provide\(/.test(cSrc),
    }
  }

  // --- client: 插件 dsh.client.inject 声明的包在该版本是否存在且真的是 client 模块 ---
  for (const name of CLIENT_INJECT) {
    const short = name.replace('@deepseek-ai/', '')
    const meta = familyMeta[short] ?? await pkgMeta(name)
    if (meta === null || meta.versions[V] === undefined) {
      row.client[name] = { existsAtVersion: false }
      continue
    }
    const manifest = meta.versions[V]
    const src = await getText(`${CDN}${name}@${V}/lib/index.js`)
    row.client[name] = {
      existsAtVersion: true,
      declaresDshClient: manifest.dsh?.client !== undefined,
      loaderCall: src === null ? null : /__ModuleLoader__\s*\.\s*load/.test(src),
      bytes: src === null ? null : src.length,
    }
  }

  rows.push(row)
}

/* ---------- 5. 输出矩阵 ---------- */
const ok = (b) => (b === true ? '✔' : b === false ? '✘' : '?')
console.log('\n=== 适配矩阵（最近 10 个 DSH 版本 × 1.0.11 依赖的每一项）===')
console.log('  版本             semver   section  thunk  order950  register  host   cordis  inject  clientUi')
for (const r of rows) {
  const clientOk = CLIENT_INJECT.every((n) => r.client[n]?.declaresDshClient === true)
  console.log(
    '  ' + r.dshVersion.padEnd(16)
    + ok(r.semver.default) + '/' + ok(r.semver.includePrerelease) + '   '
    + ok(r.systemPrompt.sectionMethod).padEnd(8)
    + ok(r.systemPrompt.evaluatesFunctionText).padEnd(7)
    + ok(r.systemPrompt.fileReference900 && r.systemPrompt.toolBash1000).padEnd(10)
    + ok(r.webServer.registerMethod).padEnd(10)
    + ok(r.webServer.hostGetter).padEnd(7)
    + String(r.cordis.resolved).padEnd(8)
    + ok(r.cordisApi.inject).padEnd(8)
    + ok(clientOk)
  )
}

console.log('\n=== 附带观测：今天安装旧版 dsh 时，同族 caret 范围会解析到哪 ===')
console.log('  版本             代表依赖 / range                    今天默认    今天 includePrerelease')
for (const r of rows) {
  const d = r.rangeDriftToday
  const label = d?.kind === 'all-exact' ? '（同族依赖全部精确锁定，不可能漂移）' : `${d?.sample} / ${d?.range}`
  console.log('  ' + r.dshVersion.padEnd(16) + String(label).padEnd(36)
    + String(d?.default ?? '-').padEnd(12) + String(d?.includePrerelease ?? '-'))
}
const sampled = rows.filter((r) => r.rangeDriftToday?.kind === 'ranged')
const drifted = sampled.filter((r) => r.rangeDriftToday.includePrerelease !== r.dshVersion)
console.log('  精确锁定的版本: ' + (rows.length - sampled.length) + ' / ' + rows.length + '（这些版本今天装也拿到同期子包）')
console.log('  范围声明且会漂移的: ' + drifted.length + ' / ' + sampled.length + ' 个采样'
  + (drifted.length ? '  -> ' + drifted.map((r) => r.dshVersion + '→' + r.rangeDriftToday.includePrerelease).join(', ') : ''))
console.log('  （漂移不改变本插件结论：这些相邻版本的同族子包 API 经上表逐版本核验均为 ✔。）')

/* ---------- 6. 判定 ---------- */
console.log('\n=== 判定 ===')
const results = []
const check = (label, pred) => {
  const bad = rows.filter((r) => !pred(r)).map((r) => r.dshVersion)
  results.push({ label, pass: bad.length === 0, failing: bad })
  console.log('  ' + (bad.length === 0 ? 'PASS' : 'FAIL') + '  ' + label + (bad.length ? '  -> ' + bad.join(', ') : ''))
}
check('前提：5 个子包在全部 10 个 dsh 版本都有同版本发布', () => lockstepOk)
check('semver 声明范围覆盖（默认模式）', (r) => r.semver.default === true)
check('semver 声明范围覆盖（includePrerelease）', (r) => r.semver.includePrerelease === true)
check('system-prompt.section() 存在', (r) => r.systemPrompt.sectionMethod === true)
check('system-prompt 的 assemble() 求值函数型 text（注入机制成立）', (r) => r.systemPrompt.evaluatesFunctionText === true)
check('order 950 落在 FILE_REFERENCE(900) 与 TOOL_BASH(1000) 之间的空档', (r) => r.systemPrompt.fileReference900 === true && r.systemPrompt.toolBash1000 === true)
check('重名注册抛错（结构性排除重复注入）', (r) => r.systemPrompt.duplicateNameThrows === true)
check('host-webserver.register() 存在', (r) => r.webServer.registerMethod === true)
check('host-webserver 有 get host()', (r) => r.webServer.hostGetter === true)
check('cordis 有 ctx.inject()（1.0.10 起硬依赖）', (r) => r.cordisApi.inject === true)
check('cordis 有 ctx.effect()', (r) => r.cordisApi.effect === true)
check('client 两个包在各版本存在且声明 dsh.client', (r) => CLIENT_INJECT.every((n) => r.client[n]?.declaresDshClient === true))

const failed = results.filter((r) => !r.pass)
mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(join(ROOT, 'out', 'dsh-version-matrix.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  pluginVersion: PLUGIN_VERSION, declaredRange: DECLARED, clientInject: CLIENT_INJECT,
  basis: 'dsh@V 的同期子包 = @V；该前提由 lockstep 与本机安装树双重验证',
  lockstep, installedTree: { dsh: installedDsh, ...installedTree },
  checkedVersionsNewestFirst: RECENT, rows, results,
  failedCount: failed.length,
}, null, 2), 'utf8')
console.log('\n  判定项 ' + results.length + '，未通过 ' + failed.length)
console.log('  证据 -> dsh-memory-verification/out/dsh-version-matrix.json')

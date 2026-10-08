/**
 * 宿主声明审计：dsh.engines.dsh / dsh.compatibility.dsh 是否**超范围承诺**。
 *
 * 动机：1.0.10 起插件新增了两个硬依赖 —— `ctx.inject()`（非阻塞注册路由）与
 * `webServer.host`（Host/Origin 防护）。声明范围却仍从 0.1.3-alpha.2 起。
 * 如果范围内某些旧版本没有这些 API，声明就是说了自己做不到的事。
 *
 * 做法：对**全部已发布 dsh 版本**穷举：
 *   ① 是否被声明范围接受（两种 semver 模式）
 *   ② 该版本是否有同版本的 system-prompt / host-webserver / client 包
 *   ③ 那些包在该版本的真实源码里，1.0.11 需要的符号是否存在
 *   ④ cordis 依赖名与范围 → 解析出具体版本并核验 ctx.inject / ctx.effect
 * 输出：被声明接住、但 API 缺失的版本 = 超范围承诺。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PKG = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'))
const DECLARED = PKG.dsh?.engines?.dsh
const COMPAT = PKG.dsh?.compatibility?.dsh
const CLIENT_INJECT = PKG.dsh?.client?.inject ?? []
const PLUGIN_VERSION = PKG.version

function loadSemver() {
  for (const r of [join(homedir(), '.dsh', 'profiles', 'web', 'node_modules'), join(homedir(), '.dsh', 'profiles', 'node_modules')]) {
    try { return createRequire(join(r, 'noop.js'))('semver') } catch { /* next */ }
  }
  try { return createRequire(import.meta.url)('semver') } catch { return null }
}
const semver = loadSemver()
if (semver === null) { console.log('SKIP 无 semver'); process.exit(0) }

const REG = 'https://registry.npmjs.org/'
const CDN = 'https://cdn.jsdelivr.net/npm/'
const H = { 'cache-control': 'no-cache' }
const jc = new Map()
async function gjson(url) {
  if (jc.has(url)) return jc.get(url)
  let o = null
  try { const r = await fetch(url, { headers: H }); if (r.ok) o = await r.json() } catch { o = null }
  jc.set(url, o); return o
}
async function gtext(url) {
  try { const r = await fetch(url, { headers: H }); return r.ok ? await r.text() : null } catch { return null }
}
const meta = (n) => gjson(REG + n.replace('/', '%2F'))

console.log('插件版本    : ' + PLUGIN_VERSION)
console.log('engines.dsh : ' + DECLARED)
console.log('compat 一致 : ' + (DECLARED === COMPAT))

const dsh = await meta('@deepseek-ai/dsh')
const times = dsh.time
const ALL = Object.keys(dsh.versions).filter((v) => times[v] !== undefined)
  .sort((a, b) => new Date(times[b]) - new Date(times[a]))

const FAMILY = ['dsh-system-prompt', 'dsh-host-webserver', 'dsh-client-ui-renderer', 'dsh-client-ui-settings']
const familyVersions = {}
for (const f of FAMILY) {
  const m = await meta('@deepseek-ai/' + f)
  familyVersions[f] = m === null ? [] : Object.keys(m.versions)
}
const cordisScoped = await meta('@deepseek-ai/cordis')
const cordisPlain = await meta('cordis')

console.log('\n已发布 dsh 版本共 ' + ALL.length + ' 个；以下逐个核验\n')

const rows = []
for (const V of ALL) {
  const man = dsh.versions[V]
  const acceptedDefault = semver.satisfies(V, DECLARED)
  const acceptedPre = semver.satisfies(V, DECLARED, { includePrerelease: true })
  const INCLUDED = acceptedDefault || acceptedPre
  const AUDIT_OUTSIDE = process.argv.includes('--include-outside')
  if (!INCLUDED && !AUDIT_OUTSIDE) {
    rows.push({ V, published: times[V], accepted: false, note: '声明范围之外（不承诺，默认不核验）' })
    continue
  }
  const row0 = INCLUDED ? {} : { outsideDeclaredRange: true }

  // cordis 依赖（老版本可能用非 scoped 的 cordis）
  const depCordisScoped = man.dependencies?.['@deepseek-ai/cordis'] ?? null
  const depCordisPlain = man.dependencies?.cordis ?? null
  let cordisResolved = null
  let cordisFamily = null
  if (depCordisScoped !== null && cordisScoped !== null) {
    cordisFamily = '@deepseek-ai/cordis'
    cordisResolved = semver.maxSatisfying(Object.keys(cordisScoped.versions), depCordisScoped, { includePrerelease: true })
  } else if (depCordisPlain !== null && cordisPlain !== null) {
    cordisFamily = 'cordis'
    cordisResolved = semver.maxSatisfying(Object.keys(cordisPlain.versions), depCordisPlain, { includePrerelease: true })
  }

  const row = {
    ...row0,
    V, published: times[V], acceptedDefault, acceptedPre,
    family: {}, cordis: { dep: depCordisScoped ?? depCordisPlain, family: cordisFamily, resolved: cordisResolved },
    api: {},
  }

  // 同版本家族包是否存在 + API
  const sp = familyVersions['dsh-system-prompt'].includes(V)
  const ws = familyVersions['dsh-host-webserver'].includes(V)
  row.family['system-prompt@V'] = sp
  row.family['host-webserver@V'] = ws
  for (const n of CLIENT_INJECT) {
    const short = n.replace('@deepseek-ai/', '')
    row.family[short + '@V'] = (familyVersions[short] ?? []).includes(V)
  }

  if (sp) {
    const s = await gtext(`${CDN}@deepseek-ai/dsh-system-prompt@${V}/lib/index.js`)
    row.api.section = s === null ? null : /\bsection\(section\)\s*\{/.test(s)
    row.api.thunk = s === null ? null : /typeof\s+section\.text\s*===\s*"function"/.test(s)
  }
  if (ws) {
    const s = await gtext(`${CDN}@deepseek-ai/dsh-host-webserver@${V}/lib/index.js`)
    row.api.register = s === null ? null : /\bregister\(route\)\s*\{/.test(s)
    row.api.hostGetter = s === null ? null : /get host\(\)/.test(s)
  }
  if (cordisResolved !== null && cordisFamily !== null) {
    const s = await gtext(`${CDN}${cordisFamily}@${cordisResolved}/lib/index.js`)
    row.api.inject = s === null ? null : /\binject\(inject,\s*callback\)\s*\{/.test(s)
    row.api.effect = s === null ? null : /\beffect\(execute,\s*label/.test(s)
  }
  rows.push(row)
}

/* ---------- 表格 ---------- */
const y = (b) => (b === true ? '✔' : b === false ? '✘' : b === null || b === undefined ? '·' : '?')
console.log('版本              semver  sp@V  ws@V  section thunk register hostGet  cordis          inject')
for (const r of rows) {
  if (r.accepted === false && r.outsideDeclaredRange !== true) { console.log('  ' + r.V.padEnd(17) + '（声明外，跳过）'); continue }
  console.log('  ' + ((r.outsideDeclaredRange ? '[范围外] ' : '') + r.V).padEnd(17)
    + (y(r.acceptedDefault) + '/' + y(r.acceptedPre)).padEnd(8)
    + y(r.family['system-prompt@V']).padEnd(6)
    + y(r.family['host-webserver@V']).padEnd(6)
    + y(r.api.section).padEnd(8) + y(r.api.thunk).padEnd(6) + y(r.api.register).padEnd(9) + y(r.api.hostGetter).padEnd(8)
    + String((r.cordis.family ?? '-') + '@' + (r.cordis.resolved ?? '-')).padEnd(16)
    + y(r.api.inject))
}

/* ---------- 超范围承诺判定 ---------- */
const accepted = rows.filter((r) => r.acceptedDefault === true || r.acceptedPre === true)
const overclaim = accepted.filter((r) =>
  r.api.section !== true || r.api.thunk !== true || r.api.register !== true || r.api.hostGetter !== true || r.api.inject !== true
  || Object.keys(r.family).some((k) => k.endsWith('@V') && r.family[k] !== true))
const fullyOk = accepted.filter((r) => !overclaim.includes(r))

console.log('\n=== 判定 ===')
console.log('  声明范围接受的已发布版本: ' + accepted.length)
console.log('  API 全部齐备            : ' + fullyOk.length)
console.log('  **超范围承诺**（被声明接住但 API 缺失）: ' + overclaim.length)
for (const r of overclaim) {
  const miss = []
  if (r.api.section !== true) miss.push('section()')
  if (r.api.thunk !== true) miss.push('函数型 text')
  if (r.api.register !== true) miss.push('register()')
  if (r.api.hostGetter !== true) miss.push('get host()')
  if (r.api.inject !== true) miss.push('ctx.inject()')
  for (const [k, v] of Object.entries(r.family)) if (k.endsWith('@V') && v !== true) miss.push('缺包 ' + k)
  console.log('    ' + r.V.padEnd(17) + ' 缺: ' + miss.join(', '))
}

mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(join(ROOT, 'out', 'dsh-range-audit.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION,
  declared: DECLARED, compatibility: COMPAT, declaredIdentical: DECLARED === COMPAT,
  publishedVersionCount: ALL.length, rows,
  summary: {
    accepted: accepted.length,
    fullyOk: fullyOk.map((r) => r.V),
    overclaim: overclaim.map((r) => r.V),
    outsideDeclaredRange: rows.filter((r) => r.accepted === false).map((r) => r.V),
  },
}, null, 2), 'utf8')
console.log('\n  证据 -> dsh-memory-verification/out/dsh-range-audit.json')

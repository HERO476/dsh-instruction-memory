/**
 * 偷跑审计 —— 空转(idle)决定性实验（修订版）。
 *
 * 要证伪的命题：「在没有用户任务、没有显式调用的空转状态下，插件仍会自动执行并向
 * system prompt 注入记忆内容。」
 *
 * 关键事实（使其可证伪而非循环论证）：
 *   插件把 `text: sectionText` 这个**函数**交给主机注册。它自己内部的 syncSection()
 *   直接调用闭包里的 sectionText，**不会**经由交出去的那个 spec 对象；因此
 *   `spec.text(...)` 的唯一调用者只能是"持有 spec 的一方"——也就是主机的装配器。
 *   本实验自己扮演主机，只在明确标记的"模拟装配"阶段调用它一次。
 *
 * 观察真实墙钟时间内：
 *   1. section() 注册次数；
 *   2. 空转期间存储被写次数（自建 fs.watch；读不触发，属已知局限）；
 *   3. 空转期间 spec.text 是否被求值；
 *   4. 插件是否自己调用过 assemble；
 *   5. 空转前后活动句柄集合（未清理的 timer/interval/watcher/socket 会留在这里）；
 *   6. 进程能否自行退出（有残留句柄就退不出）。
 */
import { mkdirSync, writeFileSync, rmSync, watch, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const HOME = join(ROOT, 'tmp', 'idle-home')
const IDLE_MS = 4000

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'instruction-memory'), { recursive: true })
const STORE = join(HOME, 'instruction-memory', 'memory.json')
const seed = {
  version: 1,
  enabled: true,
  budgetChars: 4000,
  entries: [{ id: 'i', title: 'IDLE', content: 'IM-IDLE-OK', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
}
writeFileSync(STORE, JSON.stringify(seed, null, 2))
process.env.DSH_HOME = HOME

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const handlesOf = () => process._getActiveHandles().map((h) => h.constructor?.name ?? typeof h)

/* ---------- 受控 ctx ---------- */
const obs = {
  sectionCalls: 0,
  specs: [],
  specTextCalls: 0,          // 只由"主机"（本脚本）在模拟装配时触发
  pluginCalledAssemble: 0,
  disposals: 0,
  loggerLines: [],
}

const ctx = {
  systemPrompt: {
    section(spec) {
      obs.sectionCalls += 1
      obs.specs.push(spec)
      return () => { obs.disposals += 1 }
    },
    assemble() {
      obs.pluginCalledAssemble += 1
      throw new Error('FATAL: the plugin must never assemble the prompt itself')
    },
  },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: () => null,                                   // 故意不给 webServer
  logger: () => ({
    info: (m) => obs.loggerLines.push('info  ' + m),
    debug: (m) => obs.loggerLines.push('debug ' + m),
  }),
}

/* ---------- 自建 watcher 观察空转期间是否被写 ---------- */
let writesDuringIdle = 0
const watcher = watch(join(HOME, 'instruction-memory'), () => { writesDuringIdle += 1 })
const mtimeBefore = statSync(STORE).mtimeMs

/* ---------- 挂载 ---------- */
// 对照模式：完全不挂载插件，跑同样的空转窗口。用来把"句柄/CPU/日志"的变化
// 归因到插件还是归因到 Node/本脚本自身——没有对照就无法断言因果。
const CONTROL = process.argv.includes('--control')
console.log('>>> 模式：' + (CONTROL ? 'CONTROL（不挂载插件）' : 'PLUGIN（挂载插件）'))

const plugin = await import('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js?v=' + Math.random())
if (!CONTROL) plugin.apply(ctx)

const deadline = Date.now() + 5000
if (!CONTROL) {
  while (!obs.loggerLines.some((l) => l.includes('mounted:')) && Date.now() < deadline) await sleep(25)
}

const afterBoot = {
  sectionCalls: obs.sectionCalls,
  specTextCalls: obs.specTextCalls,
  handles: handlesOf(),
  mtime: statSync(STORE).mtimeMs,
  loggerLines: obs.loggerLines.length,
  cpu: process.cpuUsage(),
}

/* ---------- 空转：什么都不做 ---------- */
console.log('>>> 进入 ' + IDLE_MS + 'ms 空转窗口，不做任何调用 …')
const idleStart = Date.now()
await sleep(IDLE_MS)
const idleElapsed = Date.now() - idleStart
const cpuAfter = process.cpuUsage(afterBoot.cpu)

const afterIdle = {
  sectionCalls: obs.sectionCalls,
  specTextCalls: obs.specTextCalls,
  handles: handlesOf(),
  mtime: statSync(STORE).mtimeMs,
  writesDuringIdle,
  loggerLines: obs.loggerLines.length,
  cpuUsedMs: (cpuAfter.user + cpuAfter.system) / 1000,
}

/* ---------- 模拟主机的一次装配（唯一合法的注入触发） ---------- */
const spec = obs.specs[0]
const beforeSim = obs.specTextCalls
const rendered = typeof spec?.text === 'function' ? spec.text({}) : null
obs.specTextCalls += 1
const buildBlockExpected = plugin.buildBlock({
  version: 1, enabled: seed.enabled, budgetChars: seed.budgetChars,
  entries: seed.entries.map(plugin.sanitizeEntry).filter(Boolean),
})

/* ---------- 结论表 ---------- */
const idleSectionDelta = afterIdle.sectionCalls - afterBoot.sectionCalls
const idleSpecTextDelta = afterIdle.specTextCalls - afterBoot.specTextCalls
const idleHandleDelta = afterIdle.handles.length - afterBoot.handles.length

const verdict = {
  '模式': CONTROL ? 'CONTROL（未挂载插件）' : 'PLUGIN',
  'section() 注册次数（PLUGIN 应 1 / CONTROL 应 0）': obs.sectionCalls,
  '注册的 text 是函数（thunk，应 true）': typeof spec?.text === 'function',
  'section order（应 950）': spec?.order,
  [`空转 ${IDLE_MS}ms 内 section() 新增（应 0）`]: idleSectionDelta,
  [`空转 ${IDLE_MS}ms 内 spec.text 求值（应 0）`]: idleSpecTextDelta,
  [`空转 ${IDLE_MS}ms 内存储被写（应 0）`]: afterIdle.writesDuringIdle,
  '空转期间存储 mtime 变化（应 false）': afterIdle.mtime !== afterBoot.mtime,
  '空转期间活动句柄新增（应 0）': idleHandleDelta,
  '插件是否自己调用 assemble（应 0）': obs.pluginCalledAssemble,
  [`空转 ${IDLE_MS}ms 内插件新增日志行（应 0）`]: afterIdle.loggerLines - afterBoot.loggerLines,
  [`空转 ${IDLE_MS}ms 内消耗 CPU（应 ~0ms）`]: afterIdle.cpuUsedMs.toFixed(1) + 'ms',
  '模拟一次装配后 spec.text 求值次数（应 ±1）': obs.specTextCalls - beforeSim,
  'thunk 渲染结果 = buildBlock() 输出（应 true）': rendered === buildBlockExpected,
  'thunk 渲染字符数': rendered?.length ?? null,
}

console.log('\n=== 判定表 ===')
for (const [k, v] of Object.entries(verdict)) console.log('  ' + String(k).padEnd(44) + ' : ' + v)

console.log('\n=== 活动句柄 ===')
console.log('  boot 后 : ' + JSON.stringify(afterBoot.handles))
console.log('  空转后  : ' + JSON.stringify(afterIdle.handles))

console.log('\n=== 插件日志 ===')
for (const l of obs.loggerLines) console.log('  ' + l)

const ok = CONTROL
  ? (idleSectionDelta === 0 && idleSpecTextDelta === 0 && afterIdle.writesDuringIdle === 0 && obs.sectionCalls === 0)
  : (idleSectionDelta === 0 && idleSpecTextDelta === 0 && afterIdle.writesDuringIdle === 0
    && obs.pluginCalledAssemble === 0 && rendered === buildBlockExpected)

const outName = CONTROL ? 'idle-control.json' : 'idle-probe.json'
writeFileSync(join(ROOT, 'out', outName), JSON.stringify({
  mode: CONTROL ? 'control' : 'plugin',
  idleWindowMs: IDLE_MS, idleElapsedMs: idleElapsed, afterBoot, afterIdle, verdict,
  loggerLines: obs.loggerLines, pass: ok,
}, null, 2), 'utf8')
console.log('\n原始数据 -> dsh-memory-verification/out/' + outName)
console.log(ok
  ? (CONTROL ? '对照：未挂载插件时空转同样零动作。' : '结论：空转期间插件零动作。')
  : '结论：空转期间检测到动作，需进一步归因。')

/* 关闭自己建的 watcher，让进程能自行退出；
   若仍不退出，说明有未被清理的句柄（这本身就是证据）。 */
watcher.close()
console.log('watcher closed; 若进程不自行退出即为"存在残留句柄"的证据。')

/**
 * 偷跑审计 —— 真实会话转录取证。
 *
 * 主机侧唯一注入点是 dsh-agent-loop 的 preStep() -> systemPrompt.assemble()。
 * 本脚本从真实转录里回答三个可证伪的问题：
 *   1. 每一条发给模型的 system prompt 里，记忆块出现了几次？（重复注入？）
 *   2. 每条 system prompt 之前，是否存在"刺激"（user/message、turn/start、工具结果等）？
 *      即有没有在"无任务"状态下凭空产生一次请求？
 *   3. 会话标题等辅助 LLM 请求里，是否也带了记忆块？（非用户任务的旁路注入？）
 *
 * 只读：不解压覆盖原文件，不写生产存储。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SESSION_DIR = join(DSH_HOME, 'sessions', '--D-Users-34332-AI-dsh-instruction-memory--')
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()

/* ---------- 1. 多帧 zstd 解压（一次 zstdDecompressSync 只出第一帧） ---------- */
function decompressAll(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1) }
  let merged = ''
  let ok = 0
  let bad = 0
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { merged += zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); ok++ } catch { bad++ }
  }
  return { text: merged, frames: offsets.length, ok, bad }
}

/* ---------- 2. 记忆块（用插件自己的实现渲染，避免手抄） ---------- */
const plugin = await import('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js')
const storeRaw = JSON.parse(readFileSync(join(DSH_HOME, 'instruction-memory', 'memory.json'), 'utf8'))
const storeData = {
  version: 1,
  enabled: storeRaw.enabled === true,
  budgetChars: storeRaw.budgetChars,
  entries: (storeRaw.entries ?? []).map(plugin.sanitizeEntry).filter((e) => e !== null),
}
const BLOCK = plugin.buildBlock(storeData)
const BLOCK_SHA = sha(BLOCK)

/* ---------- 3. 时间线 ---------- */
const files = readFileSync(join(SESSION_DIR, 'session-ce78e7c0-552b-435c-8e71-3d4b3662d21a', 'session.v4.jsonl.zstd'))
const { text, frames, ok, bad } = decompressAll(files)
const records = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

const t0 = records[0]?.time ?? 0
const rel = (t) => ((t - t0) / 1000).toFixed(3).padStart(8) + 's'

console.log('=== 输入 ===')
console.log('转录        : ' + join(SESSION_DIR, 'session-ce78e7c0-...', 'session.v4.jsonl.zstd'))
console.log('zstd 帧     : ' + frames + ' (解压成功 ' + ok + ', 失败 ' + bad + ')')
console.log('记录数      : ' + records.length)
console.log('记忆块      : ' + BLOCK.length + ' 字符  sha256=' + BLOCK_SHA)

const kindOf = (o) => o.type
const counts = {}
for (const r of records) counts[kindOf(r)] = (counts[kindOf(r)] ?? 0) + 1
console.log('记录类型    : ' + JSON.stringify(counts))

/* ---------- 4. 关键：system/message 与记忆块 ---------- */
const systemPrompts = []
for (const r of records) {
  if (r.type !== 'system/message') continue
  const text = (r.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  const occurrences = BLOCK === '' ? 0 : text.split(BLOCK).length - 1
  const at = text.indexOf(BLOCK)
  systemPrompts.push({
    seq: r.seq, time: r.time, rel: rel(r.time), turn: r.data.turn, step: r.data.step,
    chars: text.length, occurrences, offset: at,
    blockSha: at >= 0 ? sha(text.slice(at, at + BLOCK.length)) : null,
    promptSha: sha(text),
  })
}

console.log('\n=== A. 每次记录下来的 system prompt ===')
console.log('序号 | 相对时间 | turn/step | 字符数 | 记忆块出现次数 | 偏移')
for (const s of systemPrompts) {
  console.log(String(s.seq).padStart(4) + ' | ' + s.rel + ' | ' + s.turn + '/' + String(s.step).padStart(2) + ' | ' +
    String(s.chars).padStart(6) + ' | ' + String(s.occurrences).padStart(14) + ' | ' + s.offset)
}
const anyDup = systemPrompts.filter((s) => s.occurrences > 1)
const anyMissing = systemPrompts.filter((s) => s.occurrences === 0)
console.log('重复注入(>1)的条数 : ' + anyDup.length)
// 注意措辞：这里测的是"是否包含**当前**逐字节块"。存储变化期间，块会换成另一个
// 版本（例如第一轮 A/B 注入的标记版），此时 substring 不命中，但**注入确实发生过**。
// 因此本行不能读作"未注入"；归因见 attribution-scope.mjs。
console.log('不含当前逐字节块的条数 : ' + anyMissing.length + (anyMissing.length ? ' -> ' + JSON.stringify(anyMissing.map((s) => s.seq)) + '（需用 attribution-scope.mjs 归因，不等于"未注入"）' : ''))

/* ---------- 5. 每条 system prompt 之前是否有"刺激" ---------- */
const STIMULUS = new Set(['user/message', 'command/run', 'agent/inbox/spliced', 'goal/change', 'developer/message', 'turn/start', 'session/end-seed'])
console.log('\n=== B. 每条 system prompt 的触发来源（向前追溯最近一条刺激）===')
const traced = []
for (const s of systemPrompts) {
  const prior = records.filter((r) => r.seq < s.seq)
  const last = [...prior].reverse().find((r) => STIMULUS.has(r.type))
  const gapMs = last === undefined ? null : s.time - last.time
  traced.push({ seq: s.seq, turn: s.turn, step: s.step, trigger: last?.type ?? null, triggerSeq: last?.seq ?? null, gapMs })
  console.log('  prompt seq=' + String(s.seq).padStart(4) + ' turn/step=' + s.turn + '/' + s.step +
    '  <- ' + String(last?.type) + ' (seq=' + last?.seq + ')  间隔=' + gapMs + 'ms')
}
const orphan = traced.filter((t) => t.trigger === null)
console.log('找不到任何前瞻刺激的 system prompt: ' + orphan.length)

/* ---------- 6. 辅助 LLM 请求是否携带记忆块 ---------- */
console.log('\n=== C. 非用户任务的 LLM 请求 ===')
const llmish = records.filter((r) => /request|llm/i.test(r.type ?? ''))
for (const r of llmish) {
  const blob = JSON.stringify(r)
  console.log('  ' + String(r.seq).padStart(4) + ' ' + rel(r.time) + ' ' + r.type.padEnd(28) +
    ' 载荷=' + String(blob.length).padStart(7) + ' 含记忆块=' + (BLOCK !== '' && blob.includes(BLOCK)) +
    ' 含块首行=' + blob.includes('用户长期指令记忆'))
}

/* ---------- 7. 注入密度 ---------- */
console.log('\n=== D. 注入密度 ===')
const steps = counts['step/start'] ?? 0
const turns = counts['turn/start'] ?? 0
const users = counts['user/message'] ?? 0
console.log('turn/start     : ' + turns)
console.log('step/start     : ' + steps + '   (= 模型步数 = assemble() 调用次数)')
console.log('system/message : ' + systemPrompts.length + '   (仅在提示词变化时重新下发)')
console.log('user/message   : ' + users)
console.log('每 turn 注入次数: ' + (turns ? (steps / turns).toFixed(2) : 'n/a') + ' (= 每步注入一次，非每 turn 一次)')

/* ---------- 8. 空闲窗口：两次记录之间的最大时间间隔 ---------- */
console.log('\n=== E. 空闲窗口（相邻记录间的时间间隔）===')
const times = records.map((r) => r.time).filter((t) => typeof t === 'number')
const gaps = []
for (let i = 1; i < times.length; i++) gaps.push({ i, ms: times[i] - times[i - 1], at: records[i].type })
gaps.sort((a, b) => b.ms - a.ms)
for (const g of gaps.slice(0, 5)) {
  console.log('  ' + (g.ms / 1000).toFixed(1).padStart(7) + 's  之后紧跟 ' + g.at)
}
const idleInjection = gaps.filter((g) => g.ms > 60_000 && /system\/message|request\//.test(g.at))
console.log('间隔 >60s 之后紧接着出现 system/message 或 request 的次数: ' + idleInjection.length)

mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(join(ROOT, 'out', 'runaway-forensics.json'), JSON.stringify({
  blockChars: BLOCK.length, blockSha: BLOCK_SHA, counts, systemPrompts, traced, orphanCount: orphan.length,
  duplicateInjections: anyDup.length, missingInjections: anyMissing.length,
  steps, turns, users,
  llmRequests: llmish.map((r) => ({ seq: r.seq, type: r.type, bytes: JSON.stringify(r).length, containsBlock: BLOCK !== '' && JSON.stringify(r).includes(BLOCK) })),
  topGaps: gaps.slice(0, 5),
}, null, 2), 'utf8')
console.log('\n原始数据 -> dsh-memory-verification/out/runaway-forensics.json')

/**
 * 偷跑审计 —— 归因与范围核查。
 *
 * A. 转录里有 2 条 system prompt 不含记忆块（seq 263 / 277）。它们到底是被什么触发的？
 *    用 ①系统 prompt 的本地时间 ②我在第一轮 A/B 里通过插件路由实际发生的动作
 *    （那些动作在 out/ 下留下了带 mtime 的响应快照）做交叉对齐。
 * B. 记忆的可见范围：resolveStorePath() 只依赖 DSH_HOME，与会话/cwd 无关吗？
 *    用其它 cwd 下的会话转录验证。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()
const local = (ms) => new Date(ms).toLocaleString('sv-SE').replace('T', ' ')   // YYYY-MM-DD HH:mm:ss

function decompressAll(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const off = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { off.push(i); i = buf.indexOf(MAGIC, i + 1) }
  let out = ''
  for (let k = 0; k < off.length; k++) {
    try { out += zstdDecompressSync(buf.subarray(off[k], k + 1 < off.length ? off[k + 1] : buf.length)).toString('utf8') } catch { /* skip */ }
  }
  return out
}
const recordsOf = (file) => decompressAll(readFileSync(file)).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

/* 插件自己的渲染，避免手抄 */
const plugin = await import('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js')
const storeRaw = JSON.parse(readFileSync(join(DSH_HOME, 'instruction-memory', 'memory.json'), 'utf8'))
const data = {
  version: 1, enabled: storeRaw.enabled === true, budgetChars: storeRaw.budgetChars,
  entries: (storeRaw.entries ?? []).map(plugin.sanitizeEntry).filter(Boolean),
}
const BLOCK = plugin.buildBlock(data)

/* ================= A. 归因 ================= */
console.log('=========== A. 归因 2 条无记忆块的 system prompt ===========\n')
console.log('当前记忆块: ' + BLOCK.length + ' 字符  sha256=' + sha(BLOCK))
console.log('第一轮 A/B 中我通过插件路由实际发生的动作（文件 mtime 为客观时间戳）:')
const actions = []
for (const f of ['b1-set-options-disabled.json', 'c1-set-options-enabled.json', 'c2-save-entry-marker.json', 'c3-state-with-marker.json', 'd1-rollback-reload.json', 'd2-post-restore-state.json']) {
  const p = join(ROOT, 'out', f)
  if (!existsSync(p)) continue
  const t = statSync(p).mtimeMs
  actions.push({ file: f, time: t, local: local(t) })
  console.log('  ' + local(t) + '  ' + f)
}

const SESSION = join(DSH_HOME, 'sessions', '--D-Users-34332-AI-dsh-instruction-memory--', 'session-ce78e7c0-552b-435c-8e71-3d4b3662d21a', 'session.v4.jsonl.zstd')
const records = recordsOf(SESSION)
console.log('\n每条 system prompt 的本地时间 / 块状态 / 是否含 A/B 标记 IM-7F3A-OK:')
for (const r of records) {
  if (r.type !== 'system/message') continue
  const text = (r.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  const hasBlock = BLOCK !== '' && text.includes(BLOCK)
  const hasMarker = text.includes('IM-7F3A-OK')
  console.log('  seq=' + String(r.seq).padStart(4) + '  ' + local(r.time) + '  turn/step=' + r.data.turn + '/' + String(r.data.step).padStart(2) +
    '  chars=' + String(text.length).padStart(6) + '  含当前块=' + String(hasBlock).padEnd(5) + '  含A/B标记=' + hasMarker +
    '  sha=' + sha(text).slice(0, 12))
}

console.log('\n对齐：把每条 system prompt 放在动作时间轴上')
const timeline = [
  ...actions.map((a) => ({ t: a.time, what: 'ACTION  ' + a.file })),
  ...records.filter((r) => r.type === 'system/message').map((r) => {
    const text = (r.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    return { t: r.time, what: 'PROMPT  seq=' + r.seq + ' 含块=' + (BLOCK !== '' && text.includes(BLOCK)) + ' 含标记=' + text.includes('IM-7F3A-OK') }
  }),
].sort((a, b) => a.t - b.t)
for (const e of timeline) console.log('  ' + local(e.t) + '  ' + e.what)

/* ================= B. 范围 ================= */
console.log('\n=========== B. 记忆的可见范围（跨会话 / 跨项目）===========\n')
const { resolveStorePath } = plugin
console.log('resolveStorePath 的入参只有 env 与 home，不含 session/cwd:')
console.log('  env 无 DSH_HOME 时 -> ' + resolveStorePath({}, 'C:\\Users\\example'))
console.log('  env 有 DSH_HOME 时 -> ' + resolveStorePath({ DSH_HOME: 'D:\\alt' }, 'C:\\Users\\example'))
console.log('  -> 同一 DSH_HOME 下，任何会话、任何项目目录读到的都是同一份存储。')

const sessionsRoot = join(DSH_HOME, 'sessions')
const found = []
for (const dir of readdirSync(sessionsRoot)) {
  let entries
  try { entries = readdirSync(join(sessionsRoot, dir)) } catch { continue }
  for (const s of entries) {
    const f = join(sessionsRoot, dir, s, 'session.v4.jsonl.zstd')
    if (!existsSync(f)) continue
    let recs
    try { recs = recordsOf(f) } catch { continue }
    const sys = recs.filter((r) => r.type === 'system/message')
    if (sys.length === 0) continue
    const hit = sys.filter((r) => {
      const text = (r.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      return BLOCK !== '' && text.includes(BLOCK)
    })
    found.push({ sessionDir: dir, session: s, bytes: statSync(f).size, systemPrompts: sys.length, promptsWithBlock: hit.length, mtime: local(statSync(f).mtimeMs) })
  }
}
found.sort((a, b) => b.promptsWithBlock - a.promptsWithBlock)
console.log('\n各会话中出现"当前记忆块"的 system prompt 数:')
for (const f of found) {
  console.log('  ' + String(f.promptsWithBlock).padStart(3) + '/' + String(f.systemPrompts).padStart(3) + '  ' + f.sessionDir + '  ' + f.session.slice(0, 24) + '  mtime=' + f.mtime)
}

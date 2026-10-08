/**
 * 偷跑审计 —— 收尾取证。
 * A. 口径对齐：step/start 到底是 219 还是 232？（两次统计不一致，必须查清）
 * B. 能否直接（而非靠推断）证明 seq=395 那次"非人类发起"的 turn 也带了记忆块？
 *    线索：session-log-deepseek/delivery-accepted 记录（每条对应一次实际投递）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SESSION = join(DSH_HOME, 'sessions', '--D-Users-34332-AI-dsh-instruction-memory--', 'session-ce78e7c0-552b-435c-8e71-3d4b3662d21a', 'session.v4.jsonl.zstd')

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
const local = (ms) => new Date(ms).toLocaleString('sv-SE').replace('T', ' ')
const recs = decompressAll(readFileSync(SESSION)).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

const plugin = await import('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js')
const storeRaw = JSON.parse(readFileSync(join(DSH_HOME, 'instruction-memory', 'memory.json'), 'utf8'))
const BLOCK = plugin.buildBlock({
  version: 1, enabled: storeRaw.enabled === true, budgetChars: storeRaw.budgetChars,
  entries: (storeRaw.entries ?? []).map(plugin.sanitizeEntry).filter(Boolean),
})

console.log('=========== A. 口径对齐 ===========\n')
const counts = {}
for (const r of recs) counts[r.type] = (counts[r.type] ?? 0) + 1
console.log('  step/start 记录总数（直接计数）: ' + counts['step/start'])
console.log('  assistant/message 总数        : ' + counts['assistant/message'])
console.log('  step/end 总数                 : ' + counts['step/end'])
console.log('  turn/start 总数               : ' + counts['turn/start'])
console.log('  turn/end 总数                 : ' + counts['turn/end'])
const stepSeqs = recs.filter((r) => r.type === 'step/start').map((r) => r.seq)
console.log('  step/start 的 seq 范围        : ' + stepSeqs[0] + ' … ' + stepSeqs[stepSeqs.length - 1])
console.log('  seq 是否唯一                  : ' + (new Set(stepSeqs).size === stepSeqs.length))

// 按 turn 归属（用 seq 窗口重新算，并打印窗口边界以便核对）
const turns = recs.filter((r) => r.type === 'turn/start')
console.log('\n  按 turn 归属 step/start：')
let sum = 0
for (let i = 0; i < turns.length; i++) {
  const from = turns[i].seq
  const to = i + 1 < turns.length ? turns[i + 1].seq : Number.MAX_SAFE_INTEGER
  const n = recs.filter((r) => r.type === 'step/start' && r.seq > from && r.seq < to).length
  sum += n
  console.log('    turn seq=' + String(from).padStart(5) + ' 窗口(' + from + ',' + (to === Number.MAX_SAFE_INTEGER ? '∞' : to) + ')  step/start=' + n)
}
console.log('    合计=' + sum + '  与总数差=' + (counts['step/start'] - sum) + '（差值应为 0；若非 0 说明有 step 落在 turn 窗口之外）')
const orphan = recs.filter((r) => r.type === 'step/start' && !turns.some((t, i) => {
  const to = i + 1 < turns.length ? turns[i + 1].seq : Number.MAX_SAFE_INTEGER
  return r.seq > t.seq && r.seq < to
}))
console.log('    落在任何 turn 窗口之外的 step/start: ' + orphan.length + (orphan.length ? ' -> seq ' + orphan.map((o) => o.seq).join(',') : ''))

console.log('\n=========== B. 能否直接证明 seq=395 那次 turn 带了记忆块 ===========\n')
const deliv = recs.filter((r) => r.type === 'session-log-deepseek/delivery-accepted')
console.log('  delivery-accepted 记录数: ' + deliv.length)
console.log('  单条载荷大小范围: ' + Math.min(...deliv.map((d) => JSON.stringify(d).length)) + ' … ' + Math.max(...deliv.map((d) => JSON.stringify(d).length)) + ' 字节')
console.log('  单条样例 keys: ' + JSON.stringify(Object.keys(deliv[0]?.data ?? {})))
console.log('  样例（截断）: ' + JSON.stringify(deliv[0]).slice(0, 400))

// turn seq=395 是 (395,425) 窗口；找出该窗口内的投递记录
const inWindow = deliv.filter((d) => d.seq > 395 && d.seq < 425)
console.log('\n  turn seq=395（goal 自动续跑）窗口内的投递记录数: ' + inWindow.length)
for (const d of inWindow) {
  const blob = JSON.stringify(d)
  console.log('    seq=' + String(d.seq).padStart(5) + ' ' + local(d.time) + '  ' + blob.length + ' 字节  含记忆块=' + (BLOCK !== '' && blob.includes(BLOCK)) + '  含块标题=' + blob.includes('用户长期指令记忆'))
}

// 全量：任何投递记录里是否出现过记忆块
const anyBlock = deliv.filter((d) => BLOCK !== '' && JSON.stringify(d).includes(BLOCK))
const anyTitle = deliv.filter((d) => JSON.stringify(d).includes('用户长期指令记忆'))
console.log('\n  全部投递记录中含"完整记忆块"的: ' + anyBlock.length + ' / ' + deliv.length)
console.log('  全部投递记录中含"块标题"的    : ' + anyTitle.length + ' / ' + deliv.length)
if (anyTitle.length > 0) {
  const s = anyTitle[0]
  console.log('  首条含标题的投递: seq=' + s.seq + ' ' + local(s.time) + ' keys=' + JSON.stringify(Object.keys(s.data ?? {})))
}

writeFileSync(join(ROOT, 'out', 'delivery-probe.json'), JSON.stringify({
  counts, stepTotal: counts['step/start'], perTurnSum: sum, orphanSteps: orphan.length,
  deliveryRecords: deliv.length,
  deliveriesWithBlock: anyBlock.length,
  deliveriesWithTitle: anyTitle.length,
  goalTurnWindowDeliveries: inWindow.map((d) => ({ seq: d.seq, time: local(d.time), bytes: JSON.stringify(d).length, hasBlock: BLOCK !== '' && JSON.stringify(d).includes(BLOCK), hasTitle: JSON.stringify(d).includes('用户长期指令记忆') })),
}, null, 2), 'utf8')

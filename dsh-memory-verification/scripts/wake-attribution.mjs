/**
 * 偷跑审计 —— 唤醒来源精确化。
 *
 * 上一支脚本用"turn 窗口内有没有 user/message"判断是否无人值守，这不可靠：
 * 消息是先在 inbox 里 splice、再被 turn 消费的，user/message 记录可能落在窗口之外。
 * 这里改用权威字段：splice 载荷里每条消息自带的 `source.kind`。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
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

console.log('=========== 1. splice 载荷里每条消息的来源（权威字段 source.kind）===========\n')
for (const r of recs) {
  if (r.type !== 'agent/inbox/spliced') continue
  const inserted = r.data?.inserted ?? []
  if (inserted.length === 0) continue
  for (const m of inserted) {
    const kind = m.source?.kind ?? '(无 source)'
    const rpc = m.source?.rpcId ? ' rpcId=' + String(m.source.rpcId).slice(0, 8) : ''
    const text = (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    const head = text.replace(/\s+/g, ' ').slice(0, 46)
    console.log('  seq=' + String(r.seq).padStart(5) + ' ' + local(r.time) +
      ' target=' + String(r.data.target).padEnd(10) + ' role=' + String(m.role).padEnd(10) +
      ' source.kind=' + String(kind).padEnd(14) + rpc + '  “' + head + '…”')
  }
}

console.log('\n=========== 2. user/message 记录本身 ===========\n')
for (const r of recs.filter((x) => x.type === 'user/message')) {
  const text = (r.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  console.log('  seq=' + String(r.seq).padStart(5) + ' ' + local(r.time) + '  “' + text.replace(/\s+/g, ' ').slice(0, 60) + '…”')
}

console.log('\n=========== 3. 每个 turn 的规模与它是否触发了新的提示词下发 ===========\n')
const turns = recs.filter((x) => x.type === 'turn/start')
for (let i = 0; i < turns.length; i++) {
  const from = turns[i].seq
  const to = i + 1 < turns.length ? turns[i + 1].seq : Infinity
  const win = recs.filter((x) => x.seq > from && x.seq < to)
  const count = (t) => win.filter((x) => x.type === t).length
  console.log('  turn seq=' + String(from).padStart(5) + ' ' + local(turns[i].time) +
    '  step/start=' + String(count('step/start')).padStart(3) +
    '  assistant/message=' + String(count('assistant/message')).padStart(3) +
    '  tool/call=' + String(count('tool/call')).padStart(3) +
    '  system/message=' + count('system/message') +
    '  request/header=' + count('request/header') +
    '  turn/end=' + count('turn/end'))
}

console.log('\n=========== 4. 逐个唤醒归类 ============\n')
for (let i = 0; i < turns.length; i++) {
  const t = turns[i]
  const prior = recs.filter((x) => x.seq < t.seq && x.type === 'agent/inbox/spliced' && (x.data?.inserted ?? []).length > 0)
  const last = prior[prior.length - 1]
  if (last === undefined) { console.log('  turn seq=' + t.seq + '  <无 splice 唤醒记录>'); continue }
  const m = last.data.inserted[0]
  const kind = m.source?.kind ?? '(无 source)'
  const human = kind === 'user' || kind === 'user-approval'
  console.log('  turn seq=' + String(t.seq).padStart(5) + ' ' + local(t.time) + '  <- kind=' + String(kind).padEnd(14) +
    ' target=' + String(last.data.target).padEnd(10) + '  人类发起=' + human)
}

console.log('\n=========== 5. 是否存在"人类未发起"的 turn ============\n')
let nonHuman = 0
for (const t of turns) {
  const prior = recs.filter((x) => x.seq < t.seq && x.type === 'agent/inbox/spliced' && (x.data?.inserted ?? []).length > 0)
  const last = prior[prior.length - 1]
  if (last === undefined) continue
  const kind = last.data.inserted[0].source?.kind ?? '(无 source)'
  if (kind !== 'user' && kind !== 'user-approval') {
    nonHuman += 1
    const text = (last.data.inserted[0].content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    console.log('  turn seq=' + String(t.seq).padStart(5) + ' ' + local(t.time) + '  kind=' + kind +
      '  载荷首行=“' + text.replace(/\s+/g, ' ').slice(0, 70) + '”')
  }
}
console.log('  合计非人类发起的 turn：' + nonHuman + ' / ' + turns.length)

/**
 * 偷跑审计 —— 最后两块证据。
 *
 * A. 启动即执行？进程 boot、尚无任何会话时，插件是否已经在做磁盘动作
 *    （读存储 / 首次运行创建空存储）？——这决定"无任务仍自动执行"这句话是否成立。
 * B. 轮次由什么唤醒？逐条检查转录里的 agent/inbox/spliced，判断是否存在
 *    "没有任何人类输入却被唤醒"的轮次。
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

/* ================= A. boot 期的磁盘动作 ================= */
console.log('=========== A. 进程 boot、零会话时插件做了什么 ===========\n')

const HOME = join(ROOT, 'tmp', 'boot-home')
function mountAt(home, label) {
  return new Promise(async (resolve) => {
    process.env.DSH_HOME = home
    const store = join(home, 'instruction-memory', 'memory.json')
    const before = existsSync(store)
    const sections = []
    const lines = []
    const ctx = {
      systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
      inject: () => null,
      logger: () => ({ info: (m) => lines.push('info  ' + m), debug: (m) => lines.push('debug ' + m) }),
    }
    const mod = await import('file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js?v=' + Math.random())
    mod.apply(ctx)
    const deadline = Date.now() + 3000
    while (!lines.some((l) => l.includes('mounted:')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const after = existsSync(store)
    console.log('  [' + label + ']')
    console.log('    存储文件挂载前存在 : ' + before)
    console.log('    存储文件挂载后存在 : ' + after
      + (before === false && after === false
        ? '   <-- 惰性创建：boot 未写文件（本次变更后的预期行为）'
        : before === false && after === true
          ? '   <-- 旧行为：boot 就创建了空文件（若看到这行说明回归）'
          : ''))
    if (after) {
      const raw = readFileSync(store, 'utf8')
      console.log('    文件内容行数/大小 : ' + raw.split('\n').length + ' 行 / ' + raw.length + ' 字节')
      console.log('    条目数             : ' + (JSON.parse(raw).entries?.length ?? 0))
    }
    console.log('    注册的 prompt 段落 : ' + sections.length + (sections.length ? '（内容为空则不注册）' : '  <-- 空存储不注册，注入为 0'))
    console.log('    插件日志           : ' + JSON.stringify(lines))
    resolve()
  })
}

rmSync(HOME, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true })
await mountAt(HOME, '全新 DSH_HOME，无任何会话')

const HOME2 = join(ROOT, 'tmp', 'boot-home2')
rmSync(HOME2, { recursive: true, force: true }); mkdirSync(join(HOME2, 'instruction-memory'), { recursive: true })
writeFileSync(join(HOME2, 'instruction-memory', 'memory.json'), JSON.stringify({
  version: 1, enabled: true, budgetChars: 4000,
  entries: [{ id: 'b', title: 'BOOT', content: 'IM-BOOT', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 1 }],
}, null, 2))
await mountAt(HOME2, '已有存储，但同样零会话')

/* ================= B. 轮次唤醒来源 ================= */
console.log('\n=========== B. 轮次由什么唤醒 ===========\n')

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

const SESSION = join(DSH_HOME, 'sessions', '--D-Users-34332-AI-dsh-instruction-memory--', 'session-ce78e7c0-552b-435c-8e71-3d4b3662d21a', 'session.v4.jsonl.zstd')
const records = decompressAll(readFileSync(SESSION)).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const local = (ms) => new Date(ms).toLocaleString('sv-SE').replace('T', ' ')

const turns = records.filter((r) => r.type === 'turn/start')
console.log('turn/start 共 ' + turns.length + ' 次。每次之前最近的"唤醒事件"：')
const WAKE = new Set(['user/message', 'agent/inbox/spliced', 'goal/change', 'developer/message', 'command/run', 'session/end-seed', 'subagent/catalog'])
for (const t of turns) {
  const prior = records.filter((r) => r.seq < t.seq && WAKE.has(r.type))
  const last = prior[prior.length - 1]
  const delta = last === undefined ? null : t.time - last.time
  console.log('  turn seq=' + String(t.seq).padStart(5) + '  ' + local(t.time) +
    '  <- ' + String(last?.type).padEnd(22) + ' (seq=' + last?.seq + ')  +' + delta + 'ms')
}

console.log('\nagent/inbox/spliced 的载荷形状（判断唤醒来源）：')
for (const r of records.filter((x) => x.type === 'agent/inbox/spliced')) {
  const d = r.data ?? {}
  const keys = Object.keys(d)
  const preview = JSON.stringify(d).slice(0, 210)
  console.log('  seq=' + String(r.seq).padStart(5) + '  ' + local(r.time) + '  keys=' + JSON.stringify(keys) + '  ' + preview)
}

console.log('\n是否存在"没有任何 user/message 的 turn"：')
let anyUnattended = 0
for (const t of turns) {
  const next = turns.find((x) => x.seq > t.seq)
  const windowRecords = records.filter((r) => r.seq > t.seq && (next === undefined || r.seq < next.seq))
  const hasUser = windowRecords.some((r) => r.type === 'user/message')
  const hasInbox = windowRecords.some((r) => r.type === 'agent/inbox/spliced')
  if (!hasUser) { anyUnattended += 1; console.log('  turn seq=' + t.seq + ' 无 user/message（hasInbox=' + hasInbox + '）') }
}
console.log('  结果：' + anyUnattended + ' 个无人值守 turn')

/**
 * STEP 4/5 evidence: does the LIVE system prompt of a real DSH task run carry
 * the instruction-memory block, byte for byte, rendered by the plugin's own
 * buildBlock() from the production memory.json?
 *
 * Read-only: it never writes the store or the transcript.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const PLUGIN = 'file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js'
const STORE = 'C:/Users/34332/.dsh/instruction-memory/memory.json'
const TRANSCRIPT = 'D:/Users/34332/AI/dsh-instruction-memory/dsh-memory-verification/transcript/session.v4.jsonl'

const { buildBlock, sanitizeEntry } = await import(PLUGIN)

const raw = JSON.parse(readFileSync(STORE, 'utf8'))
const normalised = {
  version: 1,
  enabled: raw.enabled === true,
  budgetChars: raw.budgetChars,
  entries: (Array.isArray(raw.entries) ? raw.entries : []).map(sanitizeEntry).filter((e) => e !== null),
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()

const ON = buildBlock(normalised)
const OFF = buildBlock({ ...normalised, enabled: false })
const EMPTY = buildBlock({ ...normalised, entries: [] })

console.log('=== A. prompt section text rendered by the plugin (pure function) ===')
console.log('memory ON   : chars=' + ON.length + '  sha256=' + sha(ON))
console.log('memory OFF  : chars=' + OFF.length + '  sha256=' + sha(OFF) + '  (enabled:false)')
console.log('no entries  : chars=' + EMPTY.length + '  sha256=' + sha(EMPTY) + '  (entries:[])')
console.log('ON === OFF ? ' + (ON === OFF) + '   ON === "" ? ' + (ON === ''))
console.log('\n--- rendered ON block ---\n' + ON + '\n--- end ---')

console.log('\n=== B. live system prompts recorded in the real session transcript ===')
const lines = readFileSync(TRANSCRIPT, 'utf8').split('\n').filter((l) => l.trim() !== '')
const systems = []
for (const l of lines) {
  const o = JSON.parse(l)
  if (o.type !== 'system/message') continue
  const text = (o.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  systems.push({ seq: o.seq, turn: o.data.turn, step: o.data.step, text })
}
console.log('system/message records: ' + systems.length)

let allPass = true
const report = []
for (const s of systems) {
  const idx = s.text.indexOf(ON)
  const present = idx >= 0
  const before = present ? s.text.slice(0, idx) : ''
  // Which prompt section immediately precedes the block?
  const prevHeading = before.split('\n').filter((x) => x.trim() !== '').pop() ?? '(session head)'
  const after = present ? s.text.slice(idx + ON.length) : ''
  const nextHeading = after.split('\n').find((x) => x.trim() !== '') ?? '(end)'
  // The block must appear exactly once.
  const occurrences = s.text.split(ON).length - 1
  const line = {
    seq: s.seq,
    step: s.step,
    promptChars: s.text.length,
    promptSha: sha(s.text),
    blockFound: present,
    occurrences,
    blockOffset: idx,
    precededBy: prevHeading.slice(0, 80),
    followedBy: nextHeading.slice(0, 80),
  }
  report.push(line)
  if (!present || occurrences !== 1) allPass = false
  console.log(JSON.stringify(line, null, 2))
}

console.log('\n=== C. verdict ===')
console.log('every recorded system prompt contains the block exactly once: ' + allPass)

writeFileSync(
  'D:/Users/34332/AI/dsh-instruction-memory/dsh-memory-verification/out/live-check.json',
  JSON.stringify({ store: raw, shaOn: sha(ON), shaOff: sha(OFF), onChars: ON.length, block: ON, systems: report, allPass }, null, 2),
  'utf8',
)

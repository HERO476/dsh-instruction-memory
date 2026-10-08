/**
 * Supporting measurements:
 *  - assembly-path cost (is there any I/O or timeout exposure in the injection path?)
 *  - prompt-prefix stability across steps (the plugin's cacheability claim)
 *  - determinism of the rendered block
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const HOST_URL = 'file:///D:/Users/34332/AI/dsh-instruction-memory/lib/index.js'
const { buildBlock, sanitizeEntry } = await import(HOST_URL)

const raw = JSON.parse(readFileSync('C:/Users/34332/.dsh/instruction-memory/memory.json', 'utf8'))
const data = {
  version: 1,
  enabled: raw.enabled === true,
  budgetChars: raw.budgetChars,
  entries: (raw.entries ?? []).map(sanitizeEntry).filter(Boolean),
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()

// 1. cost of one assembly
const N = 20000
const t0 = process.hrtime.bigint()
for (let i = 0; i < N; i++) buildBlock(data)
const t1 = process.hrtime.bigint()
const totalMs = Number(t1 - t0) / 1e6
console.log('=== assembly path cost ===')
console.log('buildBlock x' + N + ': ' + totalMs.toFixed(1) + ' ms total, ' + (totalMs / N * 1000).toFixed(2) + ' us/assembly')
console.log('block chars: ' + buildBlock(data).length)

// 2. determinism
const renders = new Set()
for (let i = 0; i < 50; i++) renders.add(sha(buildBlock(data)))
console.log('\n=== determinism ===')
console.log('distinct sha256 across 50 renders: ' + renders.size + ' (1 == byte-identical)')
const roundTrip = buildBlock(JSON.parse(JSON.stringify(data)))
console.log('render of a JSON round-tripped state is identical: ' + (roundTrip === buildBlock(data)))

// 3. prompt-prefix stability in the real transcript
console.log('\n=== prompt prefix stability across live steps ===')
const lines = readFileSync('D:/Users/34332/AI/dsh-instruction-memory/dsh-memory-verification/transcript/session.v4.jsonl', 'utf8').split('\n').filter((l) => l.trim() !== '')
const recs = []
for (const l of lines) {
  const o = JSON.parse(l)
  if (o.type !== 'system/message') continue
  const text = (o.data.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  recs.push({ step: o.data.step, text })
}
const block = buildBlock(data)
const rows = recs.map((r) => {
  const idx = r.text.indexOf(block)
  return {
    step: r.step,
    blockOffset: idx,
    prefixChars: idx,
    prefixSha256: idx >= 0 ? sha(r.text.slice(0, idx)) : null,
    blockSha256: idx >= 0 ? sha(r.text.slice(idx, idx + block.length)) : null,
    promptChars: r.text.length,
  }
})
console.log(JSON.stringify(rows, null, 2))
const samePrefix = rows.length > 1 && rows.every((r) => r.prefixSha256 === rows[0].prefixSha256)
const sameBlock = rows.length > 1 && rows.every((r) => r.blockSha256 === rows[0].blockSha256)
console.log('prefix before the memory block is byte-identical across steps: ' + samePrefix)
console.log('the memory block itself is byte-identical across steps: ' + sameBlock)

writeFileSync('D:/Users/34332/AI/dsh-instruction-memory/dsh-memory-verification/out/measurements.json', JSON.stringify({
  assemblyCostUs: totalMs / N * 1000, renders: N, distinctRenders: renders.size, prefixRows: rows, samePrefix, sameBlock,
}, null, 2), 'utf8')

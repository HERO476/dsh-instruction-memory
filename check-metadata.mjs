/**
 * Pre-publish guard: refuse to publish while identity placeholders remain.
 *
 *   node check-metadata.mjs
 *
 * Runs automatically via the `prepublishOnly` script, so `npm publish` aborts
 * rather than shipping a package whose repository/author fields — or whose
 * LICENSE copyright line — still say TODO.
 */
import { readFileSync } from 'node:fs'

const FILES = ['package.json', 'LICENSE']
const hits = []

for (const file of FILES) {
  let text
  try {
    text = readFileSync(new URL('./' + file, import.meta.url), 'utf8')
  } catch {
    hits.push(file + ': missing')
    continue
  }
  for (const line of text.split('\n')) {
    if (line.includes('TODO')) hits.push(file + ': ' + line.trim())
  }
}

if (hits.length > 0) {
  console.error('发布前检查失败——以下占位符尚未替换：\n')
  for (const hit of hits) console.error('  ' + hit)
  console.error('\n替换后重试：package.json 的 repository / homepage / bugs / author，以及 LICENSE 的版权行。')
  process.exit(1)
}

console.log('元数据检查通过：没有残留占位符。')

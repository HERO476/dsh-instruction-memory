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

// 1.4.4 shipped with `"dsh-instruction-memory": "^1.4.3"` inside its own
// `dependencies`: `npm install`/pnpm then pulled a second, older copy of the
// plugin into the profile. The package has no runtime dependencies at all, so
// a self-dependency is always an accident (usually a stray `npm install <self>`
// run inside the repo). Refuse to publish that shape.
let manifest
try {
  manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
} catch (err) {
  console.error('package.json 无法解析：' + String(err && err.message ? err.message : err))
  process.exit(1)
}
if (manifest.dependencies !== undefined && Object.hasOwn(manifest.dependencies, manifest.name)) {
  console.error('发布前检查失败：package.json 依赖了自身（' + manifest.name + '）。')
  console.error('删除 `dependencies` 里的自依赖后重试（本插件没有运行时依赖）。')
  process.exit(1)
}

console.log('元数据检查通过：没有残留占位符，也没有自依赖。')

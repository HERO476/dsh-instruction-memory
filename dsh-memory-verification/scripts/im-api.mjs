/**
 * Thin client for dsh-instruction-memory's real same-origin JSON route.
 *
 *   node im-api.mjs state
 *   node im-api.mjs set-options '{"enabled":false}'
 *   node im-api.mjs save-entry '{"entry":{...}}'
 *   node im-api.mjs raw '{"method":"delete-entry","args":{"id":"im-x"}}'
 *
 * Arguments are passed as separate argv entries (never inline quotes) because
 * PowerShell strips embedded double quotes when forwarding to a native command.
 * The running DSH web server answers on /instruction-memory/api — the exact
 * path the settings page uses, so every call exercises the production plugin.
 */
import { writeFileSync, readFileSync } from 'node:fs'

const url = process.env.IM_API_URL ?? 'http://127.0.0.1:8080/instruction-memory/api'
const [kind, payload] = process.argv.slice(2)

// PowerShell strips embedded double quotes when forwarding an argument to a
// native command, so inline JSON cannot survive the shell. Payloads therefore
// arrive as `@<path-to-json-file>`, or as a bare word that contains no quotes.
const load = (p) => {
  if (p === undefined) throw new Error('missing payload for ' + kind)
  if (p.startsWith('@')) return JSON.parse(readFileSync(p.slice(1), 'utf8'))
  return JSON.parse(p)
}

let body
if (kind === 'raw') body = payload.startsWith('@') ? readFileSync(payload.slice(1), 'utf8') : payload
else if (kind === 'state') body = JSON.stringify({ method: 'state' })
else if (kind === 'reload') body = JSON.stringify({ method: 'reload' })
else if (kind === 'set-options') body = JSON.stringify({ method: 'set-options', args: load(payload) })
else if (kind === 'save-entry') body = JSON.stringify({ method: 'save-entry', args: load(payload) })
else if (kind === 'delete-entry') body = JSON.stringify({ method: 'delete-entry', args: load(payload) })
else if (kind === 'import-data') body = JSON.stringify({ method: 'import-data', args: load(payload) })
else if (kind === 'file') body = readFileSync(payload, 'utf8')
else throw new Error('usage: im-api.mjs <state|reload|set-options|save-entry|delete-entry|import-data|file> [@jsonfile|file]')

const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
const text = await res.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  parsed = { raw: text }
}

const sn = parsed?.snapshot
const summary = {
  httpStatus: res.status,
  ok: parsed?.ok ?? null,
  saved: parsed?.saved ?? null,
  message: parsed?.message ?? null,
  storagePath: sn?.storage?.path ?? null,
  storageError: sn?.storage?.error ?? null,
  storageWarning: sn?.storage?.warning ?? null,
  injectionRegistered: sn?.injection?.registered ?? null,
  injectionChars: sn?.injection?.chars ?? null,
  injectionError: sn?.injection?.error ?? null,
  enabled: sn?.data?.enabled ?? null,
  budgetChars: sn?.data?.budgetChars ?? null,
  entryCount: sn?.data?.entries?.length ?? null,
  entries: sn?.data?.entries?.map((e) => ({
    id: e.id, title: e.title, mode: e.mode, priority: e.priority, enabled: e.enabled, contentChars: e.content.length,
  })) ?? null,
  previewSha256: sn?.preview !== undefined
    ? (await import('node:crypto')).createHash('sha256').update(sn.preview, 'utf8').digest('hex').toUpperCase()
    : null,
  preview: sn?.preview ?? null,
}
console.log(JSON.stringify(summary, null, 2))
if (process.env.IM_OUT) writeFileSync(process.env.IM_OUT, JSON.stringify({ request: body, response: parsed }, null, 2), 'utf8')

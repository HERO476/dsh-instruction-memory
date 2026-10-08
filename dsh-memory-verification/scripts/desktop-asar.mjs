/**
 * Minimal read-only ASAR inspector for the DSH desktop app.
 *
 *   node desktop-asar.mjs list  [subpath]        list entries under a path
 *   node desktop-asar.mjs cat   <path>           print a file from the archive
 *   node desktop-asar.mjs hash  <path>           print the sha256 of a file
 *   node desktop-asar.mjs versions               every @deepseek-ai package + version
 *   node desktop-asar.mjs extract <path> <dest>  copy one file out of the archive
 *
 * app.asar is not a directory, so ordinary path access cannot see inside it.
 * The format is a small pickle header followed by a JSON directory tree and the
 * concatenated file bodies; file offsets are relative to the end of the header.
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ARCHIVE =
  process.env.DSH_ASAR ??
  'D:\\Users\\34332\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'

function openArchive(archive) {
  const fd = openSync(archive, 'r')
  // Header layout, confirmed against the real bytes:
  //   u32 @0  = 4                      (size of the length pickle)
  //   u32 @4  = jsonLength + 8         (size of the payload pickle)
  //   u32 @8  = jsonLength + 4         (string size incl. its length prefix)
  //   u32 @12 = jsonLength             (the JSON we want)
  //   @16 ... = the JSON directory tree
  // File bodies begin at 16 + jsonLength, rounded up to 4 bytes.
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const jsonLength = head.readUInt32LE(12)
  if (jsonLength <= 0 || 16 + jsonLength > statSync(archive).size) {
    throw new Error('implausible asar header length: ' + jsonLength)
  }
  const jsonBuf = Buffer.alloc(jsonLength)
  readSync(fd, jsonBuf, 0, jsonLength, 16)
  const text = jsonBuf.toString('utf8')
  if (!text.startsWith('{')) throw new Error('asar header is not JSON: ' + text.slice(0, 40))
  const header = JSON.parse(text)
  const baseOffset = 16 + Math.ceil(jsonLength / 4) * 4
  return { fd, baseOffset, header }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix + '/' + name
    if (entry.files !== undefined) walk(entry, path, out)
    else out.set(path, entry)
  }
  return out
}

function load(archive = ARCHIVE) {
  const { fd, baseOffset, header } = openArchive(archive)
  const files = walk(header, '', new Map())
  return { fd, baseOffset, files }
}

function readEntry(ctx, path) {
  const entry = ctx.files.get(path)
  if (entry === undefined) throw new Error('not in archive: ' + path)
  const buf = Buffer.alloc(entry.size)
  readSync(ctx.fd, buf, 0, entry.size, ctx.baseOffset + Number(entry.offset))
  return buf
}

const [command, ...args] = process.argv.slice(2)
const ctx = load()

switch (command) {
  case 'list': {
    const prefix = args[0] ?? ''
    const paths = [...ctx.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.replace(prefix, '').replace(/^\//, ''))
      .filter((p) => p !== '' && !p.includes('/'))
    paths.sort()
    for (const p of paths) console.log(p)
    console.log('# ' + paths.length + ' entries directly under ' + JSON.stringify(prefix))
    break
  }
  case 'cat':
    process.stdout.write(readEntry(ctx, args[0]).toString('utf8'))
    break
  case 'hash':
    console.log(createHash('sha256').update(readEntry(ctx, args[0])).digest('hex').toUpperCase())
    break
  case 'hashtree': {
    // One "<relative path><TAB><sha256>" line per file under a prefix, so the
    // archived copy can be compared file-by-file against an npm tarball.
    const prefix = args[0].replace(/\/$/, '') + '/'
    const rows = [...ctx.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .sort()
      .map((p) => p.slice(prefix.length) + '\t'
        + createHash('sha256').update(readEntry(ctx, p)).digest('hex').toUpperCase())
    for (const row of rows) console.log(row)
    console.error('# ' + rows.length + ' files under ' + prefix)
    break
  }
  case 'extract': {
    mkdirSync(dirname(args[1]), { recursive: true })
    writeFileSync(args[1], readEntry(ctx, args[0]))
    console.log('wrote ' + args[1])
    break
  }
  case 'versions': {
    const pkgs = new Map()
    for (const path of ctx.files.keys()) {
      const m = /^\/dsh\/node_modules\/@deepseek-ai\/([^/]+)\/package\.json$/.exec(path)
      if (m === null) continue
      try {
        const manifest = JSON.parse(readEntry(ctx, path).toString('utf8'))
        pkgs.set(manifest.name ?? '@deepseek-ai/' + m[1], manifest.version ?? '(no version)')
      } catch {
        pkgs.set('@deepseek-ai/' + m[1], '(unparseable)')
      }
    }
    const names = [...pkgs.keys()].sort()
    for (const name of names) console.log(name.padEnd(48) + pkgs.get(name))
    console.log('# ' + names.length + ' @deepseek-ai packages inside the archive')
    break
  }
  default:
    console.error('usage: list | cat <p> | hash <p> | extract <p> <dest> | versions')
    process.exit(2)
}

closeSync(ctx.fd)

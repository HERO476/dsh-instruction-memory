/**
 * dsh-instruction-memory — feedback mailer (Host side, zero dependencies).
 *
 * The settings page must be able to send a problem report / suggestion to the
 * maintainer. There is no email dependency in this package and deliberately no
 * new one: this module speaks just enough SMTP (RFC 5321) over `node:net` /
 * `node:tls` to deliver one plain-text message to one fixed recipient.
 *
 * Design constraints that shaped the code below:
 *
 *   - The recipient and the credentials NEVER come from the browser. They are
 *     read from the environment or from a config file next to the store (see
 *     `feedbackConfigFrom`), so the page can only send to a destination the
 *     operator chose. A user-typed "to" field would turn the settings route into
 *     an open relay for anyone who can reach it.
 *   - The message body is our own composed text, never raw HTML: no header
 *     injection is possible from the feedback fields (they land in the body and
 *     are sanitised), and the SMTP DATA phase is clean ASCII/base64.
 *   - Credentials are refused on an unencrypted connection. If the server
 *     advertises STARTTLS we upgrade; if it does not and a username is set, the
 *     send fails instead of leaking the password. A local smart-host without
 *     authentication (the usual dev setup) still works over plain TCP.
 *   - Every failure throws an Error with a message written for the user; the
 *     caller decides whether to show it and how much of it to log.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'

/** The question kinds the form offers. Kept in one place for both halves. */
export const FEEDBACK_TYPES = Object.freeze(['bug', 'suggestion', 'other'])

/** Human labels used in the mail subject and body. */
export const FEEDBACK_TYPE_LABELS = Object.freeze({
  bug: '问题反馈（Bug）',
  suggestion: '功能建议',
  other: '其他',
})

/**
 * Every ceiling the feedback form enforces. Published on the snapshot so the
 * Client can enforce the same numbers while typing; the Host still re-validates
 * because a request can be forged past any UI.
 */
export const FEEDBACK_LIMITS = Object.freeze({
  maxTitle: 120,
  maxBody: 4000,
  maxContact: 200,
  maxLocale: 40,
  maxTimezone: 64,
  maxUserAgent: 300,
  maxVersion: 64,
  maxSubject: 180,
})

/** Environment variables the operator can use instead of the config file. */
export const FEEDBACK_ENV = Object.freeze({
  to: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_TO',
  from: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_FROM',
  host: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_HOST',
  port: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_PORT',
  secure: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_SECURE',
  user: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_USER',
  pass: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_PASS',
  /**
   * A URL-shaped SMTP credential that other tools on this machine already keep
   * (`smtps://user:pass@host:port`). Supported as a fallback source so the
   * operator does not have to duplicate a working credential into the plugin's
   * own variables; explicit DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_* still win.
   */
  smtpUrl: 'DSH_CRB_SMTP_URL',
  config: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_CONFIG',
  cooldown: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_COOLDOWN_MS',
  secret: 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SECRET',
})

/**
 * At-rest protection for the recipient address. The config file may store
 * `toEncrypted` instead of `to`; the key comes from the environment, never from
 * the file, so a copy of the JSON alone does not reveal the mailbox.
 *
 * Honest scope: this protects the config file at rest (screenshots, accidental
 * commits, backups). It cannot hide the address from the SMTP server or from
 * anyone who can read the same user's environment — a mail envelope has to
 * carry the recipient in clear text. TLS protects the wire, not the file.
 */
const ENCRYPTED_PREFIX = 'im1:'
const MIN_SECRET_LENGTH = 16
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

/** How long a successful send blocks the next one (anti double-click / spam). */
export const DEFAULT_FEEDBACK_COOLDOWN_MS = 30_000
const MAX_FEEDBACK_COOLDOWN_MS = 10 * 60_000

/** SMTP defaults: implicit TLS on 465, STARTTLS on 587. */
const DEFAULT_SECURE_PORT = 465
const DEFAULT_PLAIN_PORT = 587
const SMTP_TIMEOUT_MS = 20_000

/** One mailbox check. Deliberately permissive: the SMTP server is the authority. */
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+$/

const textOf = (value) => (typeof value === 'string' ? value.trim() : '')
const envText = (env, name) => (env !== null && typeof env === 'object' && typeof env[name] === 'string' ? env[name].trim() : '')
/**
 * A config-file scalar. JSON files naturally carry `"port": 587` and
 * `"secure": true`; treating those as absent (only strings accepted) silently
 * fell back to the default port and to plaintext, so numbers and booleans are
 * stringified here and validated by the same code path as environment strings.
 */
const scalarText = (value) => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

/**
 * Remove control characters that could forge a new header or an SMTP command.
 * Newlines inside the body are legitimate and survive; every other field is
 * collapsed to one line.
 */
function oneLine(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function cutText(value, max) {
  const text = String(value === null || value === undefined ? '' : value)
  return text.length > max ? text.slice(0, max) : text
}

/** Body keeps its paragraph breaks, but no NUL / stray control bytes. */
function bodyText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

/**
 * Validate one submitted feedback form.
 *
 * Returns either `{ ok: true, value }` (trimmed, control characters removed) or
 * `{ ok: false, message }` with a user-facing Chinese reason. The Client mirrors
 * these rules; this copy is the authoritative one.
 */
export function normalizeFeedback(input, limits = FEEDBACK_LIMITS) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: '反馈内容格式不正确' }
  }
  const type = oneLine(input.type).toLowerCase()
  if (!FEEDBACK_TYPES.includes(type)) {
    return { ok: false, message: '请选择有效的问题类型' }
  }
  const title = oneLine(input.title)
  if (title === '') return { ok: false, message: '请填写反馈标题' }
  if (title.length > limits.maxTitle) {
    return { ok: false, message: '反馈标题不能超过 ' + limits.maxTitle + ' 个字符' }
  }
  const body = bodyText(input.body)
  if (body.length < 5) return { ok: false, message: '请补充详细描述（至少 5 个字符）' }
  if (body.length > limits.maxBody) {
    return { ok: false, message: '详细描述不能超过 ' + limits.maxBody + ' 个字符' }
  }
  const contact = oneLine(input.contact)
  if (contact.length > limits.maxContact) {
    return { ok: false, message: '联系方式不能超过 ' + limits.maxContact + ' 个字符' }
  }
  return { ok: true, value: { type, title, body, contact } }
}

/** Parse a boolean-ish config value without JS's surprising `Boolean('0')`. */
function boolOf(value, fallback) {
  if (typeof value === 'boolean') return value
  const text = textOf(value).toLowerCase()
  if (text === '') return fallback
  if (['1', 'true', 'yes', 'on', 'ssl', 'tls'].includes(text)) return true
  if (['0', 'false', 'no', 'off', 'plain', 'none'].includes(text)) return false
  return fallback
}

function deriveKey(secret, salt) {
  // scrypt is deliberately slow: a short operator paraphrase is not a
  // high-entropy key, so a plain hash would make guessing cheap.
  return scryptSync(secret, salt, 32)
}

function assertSecret(secret) {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error('反馈加密密钥至少需要 ' + MIN_SECRET_LENGTH + ' 个字符（' + FEEDBACK_ENV.secret + '）')
  }
}

/**
 * Encrypt one recipient for `toEncrypted` in feedback.json.
 *
 * Format: `im1:` + base64(salt[16] | iv[12] | tag[16] | ciphertext). AES-256-GCM
 * authenticates the payload, so a truncated or edited file fails to decrypt
 * instead of silently yielding a different address.
 */
export function encryptRecipient(address, secret) {
  const clean = textOf(address)
  if (!EMAIL_RE.test(clean)) throw new Error('收件邮箱格式不正确，无法加密')
  const phrase = textOf(secret)
  assertSecret(phrase)
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(phrase, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ENCRYPTED_PREFIX + Buffer.concat([salt, iv, tag, ciphertext]).toString('base64')
}

/** Decrypt a `toEncrypted` value. Any tampering or a wrong secret is an error. */
export function decryptRecipient(payload, secret) {
  const raw = textOf(payload)
  if (!raw.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error('反馈收件邮箱密文格式不正确，应为 ' + ENCRYPTED_PREFIX + '…')
  }
  const phrase = textOf(secret)
  assertSecret(phrase)
  const packed = Buffer.from(raw.slice(ENCRYPTED_PREFIX.length), 'base64')
  if (packed.length <= SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error('反馈收件邮箱密文格式不正确，应为 ' + ENCRYPTED_PREFIX + '…')
  }
  const salt = packed.subarray(0, SALT_BYTES)
  const iv = packed.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES)
  const tag = packed.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES)
  const ciphertext = packed.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES)
  let clear
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(phrase, salt), iv)
    decipher.setAuthTag(tag)
    clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('无法解密反馈收件邮箱：密钥不匹配或密文已损坏')
  }
  if (!EMAIL_RE.test(clear)) throw new Error('解密后的反馈收件邮箱格式不正确')
  return clear
}

const URL_TRUE = new Set(['1', 'true', 'yes', 'on', 'ssl', 'tls'])
const URL_FALSE = new Set(['0', 'false', 'no', 'off', 'plain', 'none'])

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/**
 * Parse the shared URL-shaped SMTP credential (`DSH_CRB_SMTP_URL`), e.g.
 * `smtps://user%40qq.com:authcode@smtp.qq.com:465?from=user%40qq.com`.
 *
 * Rules: the scheme is smtp or smtps; smtps always means implicit TLS, while
 * smtp:// means STARTTLS unless `?secure=1`/`?secure=0` overrides it (a bare
 * smtp:// URL on port 465 is treated as implicit TLS, the common provider
 * convention). Username and password are percent-decoded, so a mailbox `@` and
 * punctuation in an app password must be URL-encoded by whoever writes the URL.
 * Errors never echo the URL: it carries a password.
 */
export function parseSmtpUrl(value) {
  const raw = textOf(value)
  if (raw === '') return { ok: false, message: 'SMTP URL 为空' }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: 'SMTP URL 无法解析（应为 smtp://user:pass@host:port，特殊字符需 URL 编码）' }
  }
  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'smtp:' && protocol !== 'smtps:') {
    return { ok: false, message: 'SMTP URL 必须以 smtp:// 或 smtps:// 开头' }
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, message: 'SMTP URL 不应包含路径部分' }
  }
  const host = url.hostname.trim()
  if (host === '') return { ok: false, message: 'SMTP URL 缺少主机名' }

  const secureText = textOf(url.searchParams.get('secure') || '').toLowerCase()
  let secure
  if (protocol === 'smtps:') {
    secure = true
  } else if (secureText !== '') {
    if (URL_TRUE.has(secureText)) secure = true
    else if (URL_FALSE.has(secureText)) secure = false
    else return { ok: false, message: 'SMTP URL 的 secure 参数无法识别（用 1 或 0）' }
  } else {
    secure = url.port === String(DEFAULT_SECURE_PORT)
  }

  const port = url.port === '' ? (secure ? DEFAULT_SECURE_PORT : DEFAULT_PLAIN_PORT) : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'SMTP URL 的端口无效' }
  }

  const user = safeDecode(url.username)
  if (user === null) return { ok: false, message: 'SMTP URL 的用户名 URL 编码无效' }
  const pass = safeDecode(url.password)
  if (pass === null) return { ok: false, message: 'SMTP URL 的密码 URL 编码无效' }
  if (user === '' && pass !== '') {
    return { ok: false, message: 'SMTP URL 含密码但缺少用户名' }
  }
  const from = safeDecode(textOf(url.searchParams.get('from') || ''))
  if (from === null) return { ok: false, message: 'SMTP URL 的 from 参数 URL 编码无效' }

  return { ok: true, config: { host, port, secure, user, pass, from } }
}

/**
 * Merge the environment and the optional `feedback.json` into one validated
 * config. Environment variables win field by field, so an operator can keep the
 * destination in a file and inject only the password from the environment (or
 * the other way round). The shared `DSH_CRB_SMTP_URL` sits between the plugin's
 * explicit SMTP variables and the file: one working credential already on the
 * machine can be reused without copying it anywhere.
 *
 * `configPath` is used only in error messages, never read here — the caller owns
 * the filesystem, this module stays pure and testable.
 */
export function feedbackConfigFrom(options = {}) {
  const env = options.env !== null && typeof options.env === 'object' ? options.env : {}
  const file = options.file !== null && typeof options.file === 'object' && !Array.isArray(options.file) ? options.file : {}
  const fileSmtp = file.smtp !== null && typeof file.smtp === 'object' && !Array.isArray(file.smtp) ? file.smtp : {}
  const configPath = textOf(options.configPath)

  let to = envText(env, FEEDBACK_ENV.to) || textOf(file.to)
  const encryptedTo = textOf(file.toEncrypted)
  const secret = envText(env, FEEDBACK_ENV.secret)
  const explicitHost = envText(env, FEEDBACK_ENV.host)

  let urlConfig = null
  const urlText = envText(env, FEEDBACK_ENV.smtpUrl)
  if (urlText !== '') {
    const parsed = parseSmtpUrl(urlText)
    if (parsed.ok) urlConfig = parsed.config
    // An invalid shared URL is only fatal when it is the only server source;
    // an explicit DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_HOST wins over it.
    else if (explicitHost === '') return { ok: false, message: parsed.message + '（环境变量 ' + FEEDBACK_ENV.smtpUrl + '）' }
  }

  const from = envText(env, FEEDBACK_ENV.from)
    || (urlConfig === null ? '' : urlConfig.from)
    || textOf(file.from)
  const host = explicitHost
    || (urlConfig === null ? '' : urlConfig.host)
    || textOf(fileSmtp.host)
  const portText = envText(env, FEEDBACK_ENV.port)
    || (urlConfig === null ? '' : String(urlConfig.port))
    || scalarText(fileSmtp.port)
  const secureText = envText(env, FEEDBACK_ENV.secure)
    || (urlConfig === null ? '' : (urlConfig.secure ? '1' : '0'))
    || scalarText(fileSmtp.secure)
  const user = envText(env, FEEDBACK_ENV.user)
    || (urlConfig === null ? '' : urlConfig.user)
    || textOf(fileSmtp.user)
  const pass = envText(env, FEEDBACK_ENV.pass) !== ''
    ? envText(env, FEEDBACK_ENV.pass)
    : ((urlConfig === null ? '' : urlConfig.pass) || textOf(fileSmtp.pass))

  const setupHint = '请通过环境变量 ' + FEEDBACK_ENV.to + ' / ' + FEEDBACK_ENV.host
    + '（或复用 ' + FEEDBACK_ENV.smtpUrl + '）配置'
    + (configPath === '' ? '' : '，或写入 ' + configPath)

  if (to === '' && encryptedTo !== '') {
    if (secret === '') {
      return {
        ok: false,
        message: '反馈收件邮箱已加密，但未设置 ' + FEEDBACK_ENV.secret
          + '（至少 ' + MIN_SECRET_LENGTH + ' 个字符），无法解密。',
      }
    }
    try {
      to = decryptRecipient(encryptedTo, secret)
    } catch (err) {
      return { ok: false, message: err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err) }
    }
  }

  if (to === '') return { ok: false, message: '尚未配置反馈收件邮箱。' + setupHint + '。' }
  if (!EMAIL_RE.test(to)) return { ok: false, message: '反馈收件邮箱格式不正确，请检查收件人配置' }
  if (host === '') return { ok: false, message: '尚未配置 SMTP 服务器。' + setupHint + '。' }

  const secure = boolOf(secureText, false)
  let port = secure ? DEFAULT_SECURE_PORT : DEFAULT_PLAIN_PORT
  if (portText !== '') {
    const parsed = Number(portText)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { ok: false, message: 'SMTP 端口无效：' + portText }
    }
    port = parsed
  }

  // A From is required by SMTP. It does not have to be an alias the server
  // accepts (that is the server's policy), but it must be one mailbox.
  const fromAddress = from !== '' ? from : (user !== '' && EMAIL_RE.test(user) ? user : to)
  if (!EMAIL_RE.test(fromAddress)) {
    return { ok: false, message: '反馈发件邮箱格式不正确，请检查 FROM 配置' }
  }
  if (user === '' && pass !== '') {
    return { ok: false, message: '已配置 SMTP 密码但缺少 SMTP 用户名（' + FEEDBACK_ENV.user + '）' }
  }

  return {
    ok: true,
    config: {
      to,
      from: fromAddress,
      smtp: { host, port, secure, user, pass },
    },
  }
}

/** The cooldown between two accepted sends, clamped to a sane range. */
export function feedbackCooldownMs(env = process.env) {
  const raw = envText(env, FEEDBACK_ENV.cooldown)
  if (raw === '') return DEFAULT_FEEDBACK_COOLDOWN_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FEEDBACK_COOLDOWN_MS
  return Math.min(Math.round(parsed), MAX_FEEDBACK_COOLDOWN_MS)
}

const UNKNOWN = '未知'

function envField(value, max) {
  const text = oneLine(value)
  return text === '' ? UNKNOWN : cutText(text, max)
}

/**
 * Compose the plain-text mail. The environment block is built on the Host from
 * what the Host itself can see (plugin version, Node, platform) plus the few
 * presentation facts the panel reports (locale, time zone, user agent). It NEVER
 * carries instruction content: the form text is the only user text included.
 */
export function buildFeedbackMessage(options = {}) {
  const feedback = options.feedback !== null && typeof options.feedback === 'object' ? options.feedback : {}
  const environment = options.environment !== null && typeof options.environment === 'object' ? options.environment : {}
  const limits = FEEDBACK_LIMITS
  const type = FEEDBACK_TYPES.includes(feedback.type) ? feedback.type : 'other'
  const label = FEEDBACK_TYPE_LABELS[type]
  const title = oneLine(feedback.title)
  const contact = oneLine(feedback.contact)
  const body = bodyText(feedback.body)

  const subjectFull = '[指令记忆反馈] ' + label + ' · ' + title
  const subject = subjectFull.length > limits.maxSubject
    ? subjectFull.slice(0, limits.maxSubject - 1) + '…'
    : subjectFull

  const envLines = [
    '插件版本：' + envField(environment.pluginVersion, limits.maxVersion),
    'DSH 版本：' + envField(environment.dshVersion, limits.maxVersion),
    'Node：' + envField(environment.node, limits.maxVersion),
    '平台：' + envField(environment.platform, 32) + ' / ' + envField(environment.arch, 32),
    '界面语言：' + envField(environment.locale, limits.maxLocale),
    '时区：' + envField(environment.timezone, limits.maxTimezone),
    '浏览器：' + envField(environment.userAgent, limits.maxUserAgent),
    '提交时间：' + (options.now instanceof Date ? options.now : new Date()).toISOString(),
  ]

  const lines = [
    '反馈类型：' + label,
    '标题：' + title,
    '联系方式：' + (contact === '' ? '（未填写）' : contact),
    '',
    '--- 反馈正文 ---',
    body,
    '',
    '--- 运行环境（自动附带）---',
    ...envLines,
  ]

  return {
    subject,
    text: lines.join('\n'),
    messageId: randomUUID() + '@' + messageDomain(options.from),
    // Only a bare, valid address becomes Reply-To. Free-form contact text must
    // never reach a header: a newline there would inject a header.
    replyTo: EMAIL_RE.test(contact) ? contact : '',
  }
}

/** The Message-ID domain, derived from the From address (never user input). */
function messageDomain(from) {
  const address = textOf(from)
  const at = address.lastIndexOf('@')
  if (at === -1) return 'dsh.local'
  const domain = address.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, '')
  return domain === '' ? 'dsh.local' : domain
}

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64')
const encodeWord = (value) => '=?UTF-8?B?' + b64(oneLine(value)) + '?='

/** RFC 5322 headers + base64 body. Base64 never needs dot-stuffing. */
export function buildRawMail(options = {}) {
  const from = textOf(options.from)
  const to = textOf(options.to)
  const now = options.now instanceof Date ? options.now : new Date()
  const messageId = textOf(options.messageId) || (randomUUID() + '@' + messageDomain(from))
  const subject = oneLine(options.subject)
  const replyTo = oneLine(options.replyTo)
  const body64 = b64(options.text).replace(/(.{76})/g, '$1\r\n')
  const headers = [
    'From: ' + encodeWord('DSH 指令记忆反馈') + ' <' + from + '>',
    'To: <' + to + '>',
  ]
  if (EMAIL_RE.test(replyTo)) headers.push('Reply-To: <' + replyTo + '>')
  headers.push(
    'Subject: ' + encodeWord(subject),
    'Date: ' + now.toUTCString(),
    'Message-ID: <' + messageId + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: dsh-instruction-memory',
  )
  return { raw: headers.join('\r\n') + '\r\n\r\n' + body64 + '\r\n', messageId }
}

/**
 * One SMTP connection, framed around two operations the protocol needs:
 * a line reader (responses are CRLF-delimited and may be multi-line) and a
 * writer that resolves when the bytes are queued.
 */
function createChannel(socket, timeoutMs) {
  const state = { buffer: '', lines: [], waiters: [], error: null }

  const fail = (err) => {
    if (state.error === null) state.error = err
    const waiters = state.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(state.error)
  }
  const onData = (chunk) => {
    state.buffer += chunk.toString('utf8')
    for (;;) {
      const index = state.buffer.indexOf('\r\n')
      if (index === -1) return
      const line = state.buffer.slice(0, index)
      state.buffer = state.buffer.slice(index + 2)
      const waiter = state.waiters.shift()
      if (waiter !== undefined) waiter.resolve(line)
      else state.lines.push(line)
    }
  }
  const onError = (err) => fail(err instanceof Error ? err : new Error(String(err)))
  const onClose = () => fail(new Error('SMTP 连接已关闭'))
  const onTimeout = () => {
    fail(new Error('SMTP 操作超时（' + timeoutMs + ' ms）'))
    socket.destroy()
  }

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)
  if (typeof socket.setTimeout === 'function') socket.setTimeout(timeoutMs, onTimeout)
  socket.resume()

  const readLine = () => new Promise((resolve, reject) => {
    if (state.lines.length > 0) {
      resolve(state.lines.shift())
      return
    }
    if (state.error !== null) {
      reject(state.error)
      return
    }
    state.waiters.push({ resolve, reject })
  })

  const write = (text) => new Promise((resolve, reject) => {
    if (state.error !== null) {
      reject(state.error)
      return
    }
    socket.write(text, 'utf8', (err) => (err ? reject(err) : resolve()))
  })

  const readResponse = async () => {
    const first = await readLine()
    const match = /^(\d{3})([ -])(.*)$/.exec(first)
    if (match === null) throw new Error('SMTP 响应无法解析：' + cutText(first, 120))
    const code = Number(match[1])
    const lines = [match[3]]
    if (match[2] === '-') {
      for (;;) {
        const next = await readLine()
        const nextMatch = /^(\d{3})([ -])(.*)$/.exec(next)
        if (nextMatch === null) throw new Error('SMTP 多行响应无法解析：' + cutText(next, 120))
        lines.push(nextMatch[3])
        if (nextMatch[2] === ' ') break
      }
    }
    return { code, lines }
  }

  const dispose = () => {
    socket.removeListener('data', onData)
    socket.removeListener('close', onClose)
    socket.removeListener('error', onError)
    if (typeof socket.setTimeout === 'function') socket.setTimeout(0)
    // Keep the socket's own error path quiet: callers destroy it after dispose,
    // and a late ECONNRESET with no listener would crash the host process.
    socket.on('error', () => {})
  }

  return { readResponse, write, dispose }
}

const smtpError = (what, response) =>
  new Error('SMTP ' + what + ' 失败（' + response.code + '）：' + cutText(response.lines.join(' '), 300))

async function expectCode(channel, codes, what) {
  const response = await channel.readResponse()
  const accepted = Array.isArray(codes) ? codes : [codes]
  if (!accepted.includes(response.code)) throw smtpError(what, response)
  return response
}

async function command(channel, line, codes, what) {
  await channel.write(line + '\r\n')
  return expectCode(channel, codes, what)
}

/** EHLO; returns the capability lines the server advertised. */
async function hello(channel, name) {
  const response = await command(channel, 'EHLO ' + name, 250, 'EHLO')
  return response.lines.map((line) => line.trim())
}

async function authenticate(channel, smtp, caps) {
  const capabilityText = caps.join(' ').toUpperCase()
  const canLogin = /\bLOGIN\b/.test(capabilityText)
  const canPlain = /\bPLAIN\b/.test(capabilityText)
  const fail = (response) => new Error('SMTP 认证失败（' + response.code + '）：'
    + cutText(response.lines.join(' '), 300)
    + '。请检查用户名 / 密码；Gmail、QQ 邮箱等服务需要「应用专用密码」，不能用登录密码。')

  if (canLogin || !canPlain) {
    await command(channel, 'AUTH LOGIN', 334, 'AUTH LOGIN')
    await command(channel, b64(smtp.user), 334, 'AUTH LOGIN 用户名')
    const done = await (async () => {
      await channel.write(b64(smtp.pass) + '\r\n')
      return channel.readResponse()
    })()
    if (done.code !== 235) throw fail(done)
    return
  }
  await channel.write('AUTH PLAIN ' + b64('\u0000' + smtp.user + '\u0000' + smtp.pass) + '\r\n')
  const done = await channel.readResponse()
  if (done.code !== 235) throw fail(done)
}

/** Open the transport socket; resolves once it is connectable (and, for TLS, verified). */
function openSocket(smtp, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = smtp.secure
      ? tlsConnect({ host: smtp.host, port: smtp.port, servername: smtp.host })
      : netConnect({ host: smtp.host, port: smtp.port })
    const event = smtp.secure ? 'secureConnect' : 'connect'
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('SMTP 连接超时（' + timeoutMs + ' ms）：' + smtp.host + ':' + smtp.port))
    }, timeoutMs)
    socket.once(event, () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error('无法连接 SMTP 服务器 ' + smtp.host + ':' + smtp.port + '：' + (err && err.message ? err.message : String(err))))
    })
  })
}

/** Upgrade an established plain socket with STARTTLS (certificate checked). */
function upgradeSocket(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secureSocket = tlsConnect({ socket, servername: host })
    const timer = setTimeout(() => {
      secureSocket.destroy()
      reject(new Error('SMTP TLS 握手超时（' + timeoutMs + ' ms）'))
    }, timeoutMs)
    secureSocket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(secureSocket)
    })
    secureSocket.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error('SMTP TLS 握手失败：' + (err && err.message ? err.message : String(err))))
    })
  })
}

/**
 * Deliver one already-composed message.
 *
 * Returns `{ messageId, accepted, response }` on success. Throws an Error whose
 * message is safe to show to the user (it never contains the password).
 */
export async function sendSmtpMail(options = {}) {
  const smtp = options.smtp !== null && typeof options.smtp === 'object' ? options.smtp : {}
  const host = textOf(smtp.host)
  const port = Number(smtp.port)
  const from = textOf(options.from)
  const to = textOf(options.to)
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP 配置不完整（host / port）')
  }
  if (from === '' || to === '') throw new Error('SMTP 配置不完整（from / to）')

  const mail = buildRawMail({
    from,
    to,
    subject: options.subject,
    text: options.text,
    messageId: options.messageId,
    replyTo: options.replyTo,
    now: options.now,
  })
  const timeoutMs = SMTP_TIMEOUT_MS
  const clientName = (hostname() || 'dsh.local').replace(/[^A-Za-z0-9.-]/g, '').slice(0, 63) || 'dsh.local'

  let socket = await openSocket({ host, port, secure: smtp.secure === true }, timeoutMs)
  let channel = createChannel(socket, timeoutMs)
  try {
    await expectCode(channel, 220, '服务端欢迎')
    let caps = await hello(channel, clientName)

    let encrypted = smtp.secure === true
    if (!encrypted && caps.some((line) => /^STARTTLS\b/i.test(line))) {
      await command(channel, 'STARTTLS', 220, 'STARTTLS')
      channel.dispose()
      socket = await upgradeSocket(socket, host, timeoutMs)
      channel = createChannel(socket, timeoutMs)
      caps = await hello(channel, clientName)
      encrypted = true
    }

    if (textOf(smtp.user) !== '') {
      if (!encrypted) {
        throw new Error('SMTP 服务器未提供 STARTTLS，已拒绝在明文连接上发送账号密码。请把 '
          + 'DSH_INSTRUCTION_MEMORY_FEEDBACK_SMTP_SECURE 设为 1（465 端口）或改用支持 STARTTLS 的服务。')
      }
      await authenticate(channel, { user: textOf(smtp.user), pass: typeof smtp.pass === 'string' ? smtp.pass : '' }, caps)
    }

    await command(channel, 'MAIL FROM:<' + from + '>', 250, 'MAIL FROM')
    await command(channel, 'RCPT TO:<' + to + '>', [250, 251], 'RCPT TO')
    await command(channel, 'DATA', 354, 'DATA')
    await channel.write(mail.raw + '.\r\n')
    const accepted = await expectCode(channel, 250, '邮件投递')
    try {
      await command(channel, 'QUIT', 221, 'QUIT')
    } catch {
      // The message is already accepted; a missing QUIT reply is not a failure.
    }
    return { messageId: mail.messageId, accepted: to, response: accepted.lines.join(' ') }
  } finally {
    channel.dispose()
    // Add an error listener before destroy: a socket destroyed mid-TLS can emit
    // ECONNRESET synchronously, and an unhandled 'error' would take the host down.
    socket.on('error', () => {})
    socket.destroy()
  }
}

/**
 * Operator helper: `node lib/mailer.js encrypt-to <email>` prints the
 * `toEncrypted` value to paste into feedback.json. The secret is read from the
 * environment and never printed, so it does not end up in shell history.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'encrypt-to') {
    try {
      console.log(encryptRecipient(rest[0] === undefined ? '' : rest[0], process.env[FEEDBACK_ENV.secret] || ''))
    } catch (err) {
      console.error(err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err))
      process.exitCode = 1
    }
  } else {
    console.error('用法：node lib/mailer.js encrypt-to <email>')
    console.error('密钥从环境变量 ' + FEEDBACK_ENV.secret + ' 读取（至少 ' + MIN_SECRET_LENGTH + ' 个字符）。')
    process.exitCode = 2
  }
}

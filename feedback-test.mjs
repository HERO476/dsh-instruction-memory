/**
 * Feedback mail suite: unit coverage for lib/mailer.js plus an END-TO-END send
 * through the real Host route against a local, scripted SMTP server.
 *
 * No network and no credentials: the fake server listens on 127.0.0.1 and the
 * "operator config" is injected through the same environment variables a real
 * deployment would use. That keeps the test honest about the wiring (route →
 * config merge → SMTP dialogue) without needing a live mailbox.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

const SCRATCH = join(process.cwd(), '.test-dsh-home-feedback-p' + process.pid)
process.env.DSH_HOME = SCRATCH

const PACKAGE_VERSION = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version

const {
  FEEDBACK_ENV,
  FEEDBACK_LIMITS,
  SMTP_TOTAL_TIMEOUT_MS,
  buildFeedbackMessage,
  buildRawMail,
  decryptRecipient,
  encryptRecipient,
  feedbackConfigFrom,
  feedbackCooldownMs,
  normalizeFeedback,
  parseSmtpUrl,
  sendSmtpMail,
  smtpAuthMechanisms,
} = await import(new URL('./lib/mailer.js', import.meta.url).href)
const host = await import(new URL('./lib/index.js', import.meta.url).href)

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) console.log('::error::' + label + (detail === undefined ? '' : ' | ' + String(detail).slice(0, 200)))
}

process.on('uncaughtException', (err) => {
  process.exitCode = 1
  console.log('::error::uncaught: ' + String(err && err.stack ? err.stack : err).slice(0, 400))
})
process.on('unhandledRejection', (err) => {
  process.exitCode = 1
  console.log('::error::unhandledRejection: ' + String(err && err.stack ? err.stack : err).slice(0, 400))
})

/* ---------------- a scripted SMTP peer ---------------- */

function startFakeSmtp(options = {}) {
  const state = { commands: [], data: '', mailFrom: '', rcptTo: '', auth: null, connections: 0 }
  const caps = Array.isArray(options.caps) ? options.caps : ['AUTH LOGIN PLAIN', 'SIZE 10485760']
  const server = createServer((socket) => {
    state.connections += 1
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.write('220 fake.local ESMTP ready\r\n')
    // A misbehaving peer: a long line with no CRLF at all.
    if (options.floodBytes) socket.write('A'.repeat(options.floodBytes))
    let buffer = ''
    let inData = false
    let authStep = 0
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) return
          state.data += buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 2.0.0 queued as test\r\n')
          continue
        }
        const nl = buffer.indexOf('\r\n')
        if (nl === -1) return
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 2)
        state.commands.push(line)
        const upper = line.toUpperCase()
        if (authStep === 1) {
          state.auth = { user: Buffer.from(line, 'base64').toString('utf8') }
          authStep = 2
          socket.write('334 UGFzc3dvcmQ6\r\n')
          continue
        }
        if (authStep === 2) {
          state.auth.pass = Buffer.from(line, 'base64').toString('utf8')
          authStep = 0
          socket.write('235 2.7.0 accepted\r\n')
          continue
        }
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          // Without STARTTLS on purpose: the client must refuse to send
          // credentials here (covered by the auth test below).
          socket.write(['250-fake.local', ...caps.map((cap) => '250-' + cap), '250 OK'].join('\r\n') + '\r\n')
          continue
        }
        if (upper === 'AUTH LOGIN') {
          authStep = 1
          socket.write('334 VXNlcm5hbWU6\r\n')
          continue
        }
        if (upper.startsWith('MAIL FROM:')) {
          state.mailFrom = line.slice('MAIL FROM:'.length).trim()
          socket.write('250 2.1.0 ok\r\n')
          continue
        }
        if (upper.startsWith('RCPT TO:')) {
          state.rcptTo = line.slice('RCPT TO:'.length).trim()
          socket.write('250 2.1.5 ok\r\n')
          continue
        }
        if (upper === 'DATA') {
          inData = true
          socket.write('354 end with <CRLF>.<CRLF>\r\n')
          continue
        }
        if (upper === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n')
          socket.end()
          continue
        }
        socket.write('500 5.5.1 unrecognized\r\n')
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        state,
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const decodeBody = (raw) => {
  const split = raw.indexOf('\r\n\r\n')
  if (split === -1) return ''
  return Buffer.from(raw.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
}

/* ---------------- the real Host, behind the real route ---------------- */

/** Mount the real Host once per call: a fresh mount also has a fresh cool-down. */
function mountHost() {
  let mounted = null
  const ctx = {
    systemPrompt: { section: () => () => {} },
    inject: (deps, callback) => {
      callback({
        webServer: { register: (route) => { mounted = route.handler; return () => {} } },
        effect: (fn) => { fn(); return () => {} },
      })
      return null
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
  }
  host.apply(ctx)
  return mounted
}

let handler = mountHost()

async function rawRoute(body) {
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
    setEncoding() {},
    destroy() {},
    on(event, callback) { (listeners[event] = listeners[event] || []).push(callback); return this },
    fire() {
      for (const cb of listeners.data || []) cb(body)
      for (const cb of listeners.end || []) cb()
    },
  }
  const out = { status: 0, body: '' }
  const res = {
    writeHead(status) { out.status = status },
    end(chunk) { out.body = chunk || '' },
    on() {},
  }
  handler(req, res)
  req.fire()
  const deadline = Date.now() + 15000
  for (;;) {
    if (out.body !== '') return { status: out.status, body: JSON.parse(out.body) }
    if (Date.now() > deadline) throw new Error('feedback route never responded')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const send = async (args) => rawRoute(JSON.stringify({ method: 'send-feedback', args }))

/* ---------------- unit: validation rules ---------------- */

check('feedback: null payload is refused with a reason',
  normalizeFeedback(null).ok === false && normalizeFeedback(null).message.length > 0)
check('feedback: an unknown type is refused',
  normalizeFeedback({ type: 'spam', title: 't', body: 'long enough' }).ok === false)
check('feedback: an empty title is refused',
  normalizeFeedback({ type: 'bug', title: '   ', body: 'long enough' }).ok === false)
check('feedback: a body shorter than 5 characters is refused',
  normalizeFeedback({ type: 'bug', title: 't', body: 'abcd' }).ok === false)
check('feedback: an over-long contact is refused',
  normalizeFeedback({ type: 'bug', title: 't', body: 'long enough', contact: 'x'.repeat(FEEDBACK_LIMITS.maxContact + 1) }).ok === false)

const valid = normalizeFeedback({ type: ' SUGGESTION ', title: '  加一个反馈按钮  ', body: '  希望设置页能直接发邮件。\r\n谢谢  ', contact: ' me@example.com ' })
check('feedback: a valid form is trimmed and normalised',
  valid.ok === true && valid.value.type === 'suggestion' && valid.value.title === '加一个反馈按钮'
  && valid.value.body === '希望设置页能直接发邮件。\n谢谢' && valid.value.contact === 'me@example.com',
  JSON.stringify(valid))

check('feedback: a title carrying a newline cannot forge a header',
  normalizeFeedback({ type: 'bug', title: 'x\r\nBcc: evil@example.com', body: 'long enough' }).value.title.indexOf('\r') === -1
  && normalizeFeedback({ type: 'bug', title: 'x\r\nBcc: evil@example.com', body: 'long enough' }).value.title.indexOf('\n') === -1)

/* ---------------- unit: config merge ---------------- */

const noConfig = feedbackConfigFrom({ env: {}, file: null, configPath: '/tmp/feedback.json' })
check('config: missing recipient names the environment variable and the file path',
  noConfig.ok === false && noConfig.message.includes(FEEDBACK_ENV.to) && noConfig.message.includes('/tmp/feedback.json'),
  noConfig.message)

const envOnly = feedbackConfigFrom({
  env: {
    [FEEDBACK_ENV.to]: 'maintainer@example.com',
    [FEEDBACK_ENV.host]: 'smtp.example.com',
    [FEEDBACK_ENV.secure]: '1',
    [FEEDBACK_ENV.user]: 'bot@example.com',
    [FEEDBACK_ENV.pass]: 'secret',
  },
})
check('config: environment-only setup defaults to implicit TLS on 465 and From=user',
  envOnly.ok === true && envOnly.config.smtp.secure === true && envOnly.config.smtp.port === 465
  && envOnly.config.from === 'bot@example.com',
  JSON.stringify(envOnly))

const merged = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.pass]: 'from-env' },
  file: { to: 'file@example.com', smtp: { host: 'smtp.example.com', port: 2525, user: 'file-user@example.com', pass: 'file-pass' } },
})
check('config: env overrides one field and the file supplies the rest',
  merged.ok === true && merged.config.to === 'file@example.com' && merged.config.smtp.port === 2525
  && merged.config.smtp.pass === 'from-env' && merged.config.smtp.user === 'file-user@example.com',
  JSON.stringify(merged))

/* ---------------- unit: shared DSH_CRB_SMTP_URL ---------------- */

const sharedUrlConfig = feedbackConfigFrom({
  env: {
    [FEEDBACK_ENV.to]: 'maintainer@example.com',
    [FEEDBACK_ENV.smtpUrl]: 'smtps://bot%40example.com:p%40ss@smtp.example.com:465',
  },
})
check('config: DSH_CRB_SMTP_URL supplies host, port, user and password',
  sharedUrlConfig.ok === true && sharedUrlConfig.config.smtp.host === 'smtp.example.com'
  && sharedUrlConfig.config.smtp.port === 465 && sharedUrlConfig.config.smtp.secure === true
  && sharedUrlConfig.config.smtp.user === 'bot@example.com' && sharedUrlConfig.config.smtp.pass === 'p@ss',
  JSON.stringify(sharedUrlConfig.ok ? sharedUrlConfig.config.smtp : sharedUrlConfig))

const urlPlain465 = parseSmtpUrl('smtp://bot:secret@smtp.example.com:465')
check('url: smtp:// on 465 infers implicit TLS and on 587 stays STARTTLS',
  urlPlain465.ok === true && urlPlain465.config.secure === true
  && parseSmtpUrl('smtp://bot:secret@smtp.example.com:587').config.secure === false)
check('url: secure=0 overrides the 465 inference',
  parseSmtpUrl('smtp://bot:secret@smtp.example.com:465?secure=0').config.secure === false)
check('url: a from parameter is carried for the envelope sender',
  parseSmtpUrl('smtp://bot:secret@smtp.example.com:587?from=bot%40example.com').config.from === 'bot@example.com')
check('url: a malformed URL is refused without echoing its password',
  (() => { const bad = parseSmtpUrl('smtps://bot:secret@smtp.example.com:notaport'); return bad.ok === false && !bad.message.includes('secret') })(),
  parseSmtpUrl('smtps://bot:secret@smtp.example.com:notaport').message)
const urlPrecedence = feedbackConfigFrom({
  env: {
    [FEEDBACK_ENV.to]: 'maintainer@example.com',
    [FEEDBACK_ENV.smtpUrl]: 'smtps://url-user:pw@smtp.example.com:465',
    [FEEDBACK_ENV.host]: 'explicit.example.com',
    [FEEDBACK_ENV.user]: 'explicit-user@example.com',
  },
})
check('config: explicit SMTP_HOST/USER beat the shared URL field by field',
  urlPrecedence.ok === true && urlPrecedence.config.smtp.host === 'explicit.example.com'
  && urlPrecedence.config.smtp.user === 'explicit-user@example.com'
  && urlPrecedence.config.smtp.pass === 'pw',
  JSON.stringify(urlPrecedence.ok ? urlPrecedence.config.smtp : urlPrecedence))
const invalidUrlOnly = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.to]: 'maintainer@example.com', [FEEDBACK_ENV.smtpUrl]: 'https://nope' },
})
check('config: an invalid shared URL alone is reported with the variable name',
  invalidUrlOnly.ok === false && invalidUrlOnly.message.includes(FEEDBACK_ENV.smtpUrl), invalidUrlOnly.message)

check('config: an invalid port is reported',
  feedbackConfigFrom({ env: { [FEEDBACK_ENV.to]: 'a@b.c', [FEEDBACK_ENV.host]: 'h', [FEEDBACK_ENV.port]: '70000' } }).ok === false)
check('config: a password without a username is refused',
  feedbackConfigFrom({ env: { [FEEDBACK_ENV.to]: 'a@b.c', [FEEDBACK_ENV.host]: 'h', [FEEDBACK_ENV.pass]: 'p' } }).ok === false)

// Regression: port/secure were fixed to accept JSON scalars, but `pass` kept
// going through the string-only path, so a numeric app password was dropped and
// surfaced as an unexplainable wrong-password failure.
const numericPassConfig = feedbackConfigFrom({
  env: {},
  file: {
    to: 'maintainer@example.com',
    smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'bot@example.com', pass: 1234567890123456 },
  },
})
check('config: a numeric smtp.pass in the JSON file is stringified, not dropped',
  numericPassConfig.ok === true && numericPassConfig.config.smtp.pass === '1234567890123456'
  && numericPassConfig.config.smtp.user === 'bot@example.com',
  JSON.stringify(numericPassConfig.ok ? numericPassConfig.config.smtp : numericPassConfig))

const objectPassConfig = feedbackConfigFrom({
  env: {},
  file: { to: 'maintainer@example.com', smtp: { host: 'smtp.example.com', user: 'bot@example.com', pass: { secret: 'x' } } },
})
check('config: a non-scalar smtp.pass is refused with the field name',
  objectPassConfig.ok === false && objectPassConfig.message.includes('smtp.pass'), objectPassConfig.message)

// Regression: EMAIL_RE used to accept control bytes and non-ASCII, which would
// leave as raw SMTP commands / 8-bit headers.
const controlByteTo = feedbackConfigFrom({ env: { [FEEDBACK_ENV.to]: 'a\u0000b@example.com', [FEEDBACK_ENV.host]: 'h' } })
check('config: a control byte in the recipient is refused',
  controlByteTo.ok === false && controlByteTo.message.includes('反馈收件邮箱'), controlByteTo.message)
const nonAsciiTo = feedbackConfigFrom({ env: { [FEEDBACK_ENV.to]: '收件人@example.com', [FEEDBACK_ENV.host]: 'h' } })
check('config: a non-ASCII recipient is refused with a readable reason',
  nonAsciiTo.ok === false && nonAsciiTo.message.includes('非 ASCII'), nonAsciiTo.message)
const nonAsciiFrom = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.to]: 'a@b.c', [FEEDBACK_ENV.host]: 'h', [FEEDBACK_ENV.from]: '发件人@example.com' },
})
check('config: a non-ASCII sender is refused with a readable reason',
  nonAsciiFrom.ok === false && nonAsciiFrom.message.includes('反馈发件邮箱'), nonAsciiFrom.message)

check('config: cooldown defaults to 30s and accepts 0',
  feedbackCooldownMs({}) === 30000 && feedbackCooldownMs({ [FEEDBACK_ENV.cooldown]: '0' }) === 0)
check('config: an unparsable cooldown falls back to the default',
  feedbackCooldownMs({ [FEEDBACK_ENV.cooldown]: 'soon' }) === 30000)

/* ---------------- unit: encrypted recipient ---------------- */

const plainRecipient = 'maintainer@example.com'
const testSecret = 'feedback-test-secret-0123456789'
const cipherText = encryptRecipient(plainRecipient, testSecret)
check('crypto: the ciphertext is prefixed and hides the address',
  cipherText.startsWith('im1:') && !cipherText.includes('maintainer'), cipherText.slice(0, 24))
check('crypto: the right secret round-trips', decryptRecipient(cipherText, testSecret) === plainRecipient)
let wrongSecretError = ''
try { decryptRecipient(cipherText, 'a-wrong-secret-000000') } catch (err) { wrongSecretError = String(err && err.message) }
check('crypto: a wrong secret is refused with a user-facing reason',
  wrongSecretError.includes('无法解密'), wrongSecretError)
let tamperedError = ''
try { decryptRecipient(cipherText.slice(0, -6), testSecret) } catch (err) { tamperedError = String(err && err.message) }
check('crypto: a truncated payload is refused', tamperedError !== '', tamperedError)
let shortSecretError = ''
try { encryptRecipient(plainRecipient, 'short') } catch (err) { shortSecretError = String(err && err.message) }
check('crypto: a too-short secret is refused', shortSecretError.includes('至少'), shortSecretError)

const encryptedConfig = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.secret]: testSecret, [FEEDBACK_ENV.host]: 'smtp.example.com' },
  file: { toEncrypted: cipherText },
})
check('config: an encrypted recipient is decrypted with the environment secret',
  encryptedConfig.ok === true && encryptedConfig.config.to === plainRecipient, JSON.stringify(encryptedConfig))

const missingSecret = feedbackConfigFrom({
  env: {},
  file: { toEncrypted: cipherText, smtp: { host: 'smtp.example.com' } },
})
check('config: an encrypted recipient without a secret explains what is missing',
  missingSecret.ok === false && missingSecret.message.includes(FEEDBACK_ENV.secret), missingSecret.message)

const wrongSecretConfig = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.secret]: 'another-secret-000000000', [FEEDBACK_ENV.host]: 'smtp.example.com' },
  file: { toEncrypted: cipherText },
})
check('config: a wrong secret is reported instead of a generic failure',
  wrongSecretConfig.ok === false && wrongSecretConfig.message.includes('无法解密'), wrongSecretConfig.message)

// Regression: a leftover plaintext `to` silently beat `toEncrypted`, so the
// operator believed the address was encrypted while it sat in the file in clear.
const bothRecipients = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.secret]: testSecret, [FEEDBACK_ENV.host]: 'smtp.example.com' },
  file: { to: 'maintainer@example.com', toEncrypted: cipherText },
})
check('config: to together with toEncrypted is refused instead of preferring the plaintext',
  bothRecipients.ok === false && bothRecipients.message.includes('toEncrypted'), bothRecipients.message)
const brokenCipherWithPlaintext = feedbackConfigFrom({
  env: { [FEEDBACK_ENV.secret]: testSecret, [FEEDBACK_ENV.host]: 'smtp.example.com' },
  file: { to: 'maintainer@example.com', toEncrypted: 'im1:not-a-ciphertext' },
})
check('config: a broken ciphertext is not hidden behind a plaintext to',
  brokenCipherWithPlaintext.ok === false && brokenCipherWithPlaintext.message.includes('toEncrypted'),
  brokenCipherWithPlaintext.message)

/* ---------------- unit: message composition ---------------- */

const composed = buildFeedbackMessage({
  feedback: { type: 'bug', title: '反馈按钮没反应', body: '点了以后没有任何提示。', contact: '' },
  environment: { pluginVersion: '1.3.3', dshVersion: '0.9.0', node: 'v22.0.0', platform: 'win32', arch: 'x64', locale: 'zh-CN', timezone: 'Asia/Shanghai', userAgent: 'test-agent' },
  from: 'bot@example.com',
  to: 'maintainer@example.com',
  now: new Date('2026-01-02T03:04:05Z'),
})
check('mail: subject names the plugin, the kind and the title',
  composed.subject.includes('[指令记忆反馈]') && composed.subject.includes('问题反馈（Bug）') && composed.subject.includes('反馈按钮没反应'),
  composed.subject)
check('mail: body carries the report and the automatic environment block',
  composed.text.includes('点了以后没有任何提示。') && composed.text.includes('插件版本：1.3.3')
  && composed.text.includes('Node：v22.0.0') && composed.text.includes('联系方式：（未填写）'),
  composed.text)
check('mail: an empty contact emits no Reply-To', composed.replyTo === '', composed.replyTo)

const withContact = buildFeedbackMessage({
  feedback: { type: 'bug', title: '想直接回复我', body: '联系方式是邮箱。', contact: 'reporter@example.com' },
  environment: {},
  from: 'bot@example.com',
  to: 'maintainer@example.com',
})
check('mail: an email contact becomes the Reply-To address', withContact.replyTo === 'reporter@example.com', withContact.replyTo)

const replyRaw = buildRawMail({
  from: 'bot@example.com',
  to: 'maintainer@example.com',
  replyTo: 'reporter@example.com',
  subject: 's',
  text: 't',
})
check('mail: Reply-To is written as its own header for a bare address',
  replyRaw.raw.includes('\r\nReply-To: <reporter@example.com>\r\n'), replyRaw.raw.slice(0, 260))
check('mail: free-form contact text never becomes a Reply-To header',
  !buildRawMail({ from: 'bot@example.com', to: 'a@b.c', replyTo: 'wechat: reporter', subject: 's', text: 't' }).raw.includes('Reply-To:'))
check('mail: a contact containing CRLF cannot inject a header',
  !buildRawMail({ from: 'bot@example.com', to: 'a@b.c', replyTo: 'a@b.c\r\nX-Injected: 1', subject: 's', text: 't' }).raw.includes('X-Injected:'))

const raw = buildRawMail({ from: 'bot@example.com', to: 'maintainer@example.com', subject: '你好', text: 'line one\nline two', now: new Date('2026-01-02T03:04:05Z') })
check('mail: headers are RFC 5322 encoded and the body is base64',
  raw.raw.includes('To: <maintainer@example.com>') && raw.raw.includes('Subject: =?UTF-8?B?')
  && raw.raw.includes('Content-Transfer-Encoding: base64') && decodeBody(raw.raw).includes('line two'),
  raw.raw.slice(0, 120))
check('mail: a From domain without an @ still yields a usable Message-ID',
  /^[0-9a-f-]+@dsh\.local$/.test(buildRawMail({ from: 'nobody', to: 'a@b.c', subject: 's', text: 't' }).messageId))

/* ---------------- unit: header safety and protocol details ---------------- */

const headerError = (options) => {
  try {
    buildRawMail(options)
    return ''
  } catch (err) {
    return String(err && err.message ? err.message : err)
  }
}
check('mail: a From carrying CRLF is refused by the formatter itself',
  headerError({ from: 'bot@example.com\r\nBcc: evil@example.com', to: 'a@b.c', subject: 's', text: 't' }).includes('换行符'),
  headerError({ from: 'bot@example.com\r\nBcc: evil@example.com', to: 'a@b.c', subject: 's', text: 't' }))
check('mail: a control byte in the envelope is refused by the formatter itself',
  headerError({ from: 'bot@example.com', to: 'a\u0000b@example.com', subject: 's', text: 't' }).includes('控制字符'),
  headerError({ from: 'bot@example.com', to: 'a\u0000b@example.com', subject: 's', text: 't' }))

const longSubject = '反馈'.repeat(40)
const longRaw = buildRawMail({ from: 'bot@example.com', to: 'maintainer@example.com', subject: longSubject, text: 'x' })
const subjectLine = longRaw.raw.split('\r\n').find((line) => line.startsWith('Subject: ')) || ''
const subjectWords = subjectLine.slice('Subject: '.length).split(' ')
check('mail: a long subject is split into RFC 2047 words of at most 75 characters',
  subjectWords.length > 1 && subjectWords.every((word) => word.length <= 75),
  subjectWords.length + ' words, longest ' + Math.max(...subjectWords.map((word) => word.length)))
check('mail: the split subject decodes back to the original text',
  subjectWords.map((word) => Buffer.from(word.replace('=?UTF-8?B?', '').replace(/\?=$/, ''), 'base64').toString('utf8')).join('') === longSubject)

check('smtp: AUTH mechanisms come from the AUTH capability line only',
  smtpAuthMechanisms(['fake.local', 'AUTH PLAIN', 'X-LOGIN-POLICY']).join(',') === 'PLAIN'
  && smtpAuthMechanisms(['fake.local', 'AUTH=LOGIN PLAIN']).join(',') === 'LOGIN,PLAIN'
  && smtpAuthMechanisms(['fake.local', 'AUTH LOGIN']).join(',') === 'LOGIN'
  && smtpAuthMechanisms(['fake.local']).length === 0
  && smtpAuthMechanisms(null).length === 0,
  JSON.stringify(smtpAuthMechanisms(['fake.local', 'AUTH PLAIN', 'X-LOGIN-POLICY'])))
check('smtp: the overall delivery ceiling is 60s, so the panel never waits forever',
  SMTP_TOTAL_TIMEOUT_MS === 60000, String(SMTP_TOTAL_TIMEOUT_MS))

let preConnectError = ''
try {
  await sendSmtpMail({
    smtp: { host: '127.0.0.1', port: 1, secure: false, user: '', pass: '' },
    from: 'bot@example.com',
    to: 'not-an-address',
    subject: 's',
    text: 't',
  })
} catch (err) {
  preConnectError = String(err && err.message ? err.message : err)
}
check('smtp: an invalid recipient is refused before any connection is opened',
  preConnectError.includes('收件邮箱格式不正确'), preConnectError)

/* ---------------- e2e: plain SMTP delivery (no auth) ---------------- */

const smtp = await startFakeSmtp()
try {
  const delivered = await sendSmtpMail({
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: '', pass: '' },
    from: 'reporter@example.com',
    to: 'maintainer@example.com',
    subject: composed.subject,
    text: composed.text,
    replyTo: 'reporter@example.com',
  })
  check('smtp: a plain delivery completes and reports the recipient',
    delivered.messageId.length > 0 && delivered.accepted === 'maintainer@example.com', JSON.stringify(delivered))
  check('smtp: the dialogue used MAIL FROM / RCPT TO / DATA / QUIT',
    smtp.state.commands.includes('MAIL FROM:<reporter@example.com>')
    && smtp.state.commands.includes('RCPT TO:<maintainer@example.com>')
    && smtp.state.commands.includes('DATA') && smtp.state.commands.includes('QUIT'),
    JSON.stringify(smtp.state.commands))
  check('smtp: the delivered body carries the composed UTF-8 text',
    decodeBody(smtp.state.data).includes('反馈按钮没反应') && decodeBody(smtp.state.data).includes('插件版本：1.3.3'))
  check('smtp: Reply-To travels with the delivered message',
    smtp.state.data.includes('Reply-To: <reporter@example.com>'), smtp.state.data.slice(0, 240))
} finally {
  await smtp.close()
}

/* ---------------- e2e: credentials over plaintext are refused ---------------- */

const plainAuth = await startFakeSmtp()
try {
  let message = ''
  try {
    await sendSmtpMail({
      smtp: { host: '127.0.0.1', port: plainAuth.port, secure: false, user: 'bot@example.com', pass: 'secret' },
      from: 'bot@example.com',
      to: 'maintainer@example.com',
      subject: 's',
      text: 't',
    })
  } catch (err) {
    message = String(err && err.message ? err.message : err)
  }
  check('smtp: a server without STARTTLS never receives the password',
    message.includes('STARTTLS') && plainAuth.state.auth === null && plainAuth.state.connections === 1,
    message)
} finally {
  await plainAuth.close()
}

/* ---------------- e2e: an endless response line is bounded ---------------- */

const flooding = await startFakeSmtp({ floodBytes: 200000 })
try {
  let message = ''
  try {
    await sendSmtpMail({
      smtp: { host: '127.0.0.1', port: flooding.port, secure: false, user: '', pass: '' },
      from: 'bot@example.com',
      to: 'maintainer@example.com',
      subject: 's',
      text: 't',
    })
  } catch (err) {
    message = String(err && err.message ? err.message : err)
  }
  check('smtp: an endless response line is cut off instead of growing without limit',
    message.includes('响应过长'), message)
} finally {
  await flooding.close()
}

/* ---------------- e2e: the Host route ---------------- */

const saved = {}
for (const name of Object.values(FEEDBACK_ENV)) saved[name] = process.env[name]
const clearFeedbackEnv = () => {
  for (const name of Object.values(FEEDBACK_ENV)) delete process.env[name]
}

await mkdir(SCRATCH, { recursive: true })
const routeSmtp = await startFakeSmtp()
try {
  clearFeedbackEnv()
  const unconfigured = await send({ type: 'bug', title: 't', body: 'long enough' })
  check('route: an unconfigured host reports the missing recipient instead of throwing',
    unconfigured.status === 200 && unconfigured.body.ok === false
    && unconfigured.body.message.includes(FEEDBACK_ENV.to), JSON.stringify(unconfigured.body))

  const badConfigPath = join(SCRATCH, 'feedback-broken.json')
  await writeFile(badConfigPath, '{ not json', 'utf8')
  process.env[FEEDBACK_ENV.config] = badConfigPath
  const broken = await send({ type: 'bug', title: 't', body: 'long enough' })
  check('route: a malformed config file is reported, not ignored',
    broken.body.ok === false && broken.body.message.includes('不是有效的 JSON'), JSON.stringify(broken.body))
  delete process.env[FEEDBACK_ENV.config]

  process.env[FEEDBACK_ENV.to] = 'maintainer@example.com'
  process.env[FEEDBACK_ENV.from] = 'reporter@example.com'
  process.env[FEEDBACK_ENV.host] = '127.0.0.1'
  process.env[FEEDBACK_ENV.port] = String(routeSmtp.port)
  process.env[FEEDBACK_ENV.secure] = '0'
  process.env[FEEDBACK_ENV.cooldown] = '0'

  const invalid = await send({ type: 'bug', title: '', body: 'long enough' })
  check('route: an invalid form is refused before any SMTP connection',
    invalid.body.ok === false && invalid.body.message.includes('请填写反馈标题') && routeSmtp.state.connections === 0,
    JSON.stringify(invalid.body))

  const accepted = await send({
    type: 'bug',
    title: '反馈按钮没反应',
    body: '点了以后没有任何提示，控制台也没有报错。',
    contact: 'reporter@example.com',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    userAgent: 'feedback-test',
  })
  check('route: a configured host sends the mail and reports success',
    accepted.body.ok === true && accepted.body.message.includes('已发送'), JSON.stringify(accepted.body))
  const deliveredText = decodeBody(routeSmtp.state.data)
  check('route: the mail reached the configured mailbox with the report text',
    routeSmtp.state.rcptTo === '<maintainer@example.com>' && deliveredText.includes('反馈按钮没反应')
    && deliveredText.includes('界面语言：zh-CN') && deliveredText.includes('时区：Asia/Shanghai'),
    deliveredText.slice(0, 160))
  check('route: the automatic environment block carries the real plugin version',
    deliveredText.includes('插件版本：' + PACKAGE_VERSION), deliveredText.slice(0, 200))
  check('route: the contact email becomes Reply-To on the wire',
    routeSmtp.state.data.includes('Reply-To: <reporter@example.com>'), routeSmtp.state.data.slice(0, 240))

  // Encrypted recipient: Host decrypts `toEncrypted` from the config file with
  // the environment secret, so the JSON alone never names the mailbox.
  const encryptedConfigPath = join(SCRATCH, 'feedback-encrypted.json')
  await writeFile(encryptedConfigPath, JSON.stringify({
    toEncrypted: cipherText,
    smtp: { host: '127.0.0.1', port: routeSmtp.port, secure: false },
  }), 'utf8')
  delete process.env[FEEDBACK_ENV.to]
  process.env[FEEDBACK_ENV.config] = encryptedConfigPath
  process.env[FEEDBACK_ENV.secret] = testSecret
  const encryptedAccepted = await send({
    type: 'suggestion',
    title: '加密收件人',
    body: '配置里的收件邮箱应当是密文。',
  })
  check('route: a toEncrypted config sends to the decrypted mailbox',
    encryptedAccepted.body.ok === true && routeSmtp.state.rcptTo === '<' + plainRecipient + '>',
    JSON.stringify(encryptedAccepted.body))

  delete process.env[FEEDBACK_ENV.config]
  delete process.env[FEEDBACK_ENV.secret]
  process.env[FEEDBACK_ENV.to] = 'maintainer@example.com'

  process.env[FEEDBACK_ENV.cooldown] = '60000'
  const throttled = await send({ type: 'bug', title: 'second', body: 'long enough' })
  check('route: a second send inside the cool-down is refused without touching SMTP',
    throttled.body.ok === false && throttled.body.message.includes('过于频繁') && routeSmtp.state.connections === 2,
    JSON.stringify(throttled.body))

  // Regression: the cool-down used to be stamped only *after* the await, so two
  // requests arriving together both passed the check and both delivered. A fresh
  // mount starts with an empty window, which is exactly that situation.
  const previousHandler = handler
  handler = mountHost()
  try {
    const connectionsBefore = routeSmtp.state.connections
    const dataBefore = routeSmtp.state.data.length
    const [first, second] = await Promise.all([
      send({ type: 'bug', title: '并发提交甲', body: '两个请求同时到达时只应发送一封。' }),
      send({ type: 'bug', title: '并发提交乙', body: '第二封不应该被投递出去。' }),
    ])
    const answers = [first.body, second.body]
    const accepted = answers.filter((answer) => answer.ok === true).length
    const refused = answers.filter((answer) => answer.ok === false && answer.message.includes('过于频繁')).length
    check('route: two concurrent sends deliver exactly one mail',
      accepted === 1 && refused === 1, JSON.stringify(answers))
    check('route: the refused concurrent request never opened an SMTP connection',
      routeSmtp.state.connections === connectionsBefore + 1,
      String(routeSmtp.state.connections - connectionsBefore))
    const arrived = decodeBody(routeSmtp.state.data.slice(dataBefore))
    check('route: only one of the concurrent reports reached the wire',
      arrived.includes('并发提交') && (arrived.includes('并发提交甲') !== arrived.includes('并发提交乙')),
      arrived.slice(0, 120))
  } finally {
    handler = previousHandler
  }
} finally {
  await routeSmtp.close()
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? (process.exitCode || 0) : 1)

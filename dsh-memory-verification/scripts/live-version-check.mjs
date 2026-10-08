/**
 * 判定"活着的"DSH 宿主加载的是哪一版插件代码。
 *
 * 为什么需要它：profile 的 node_modules/dsh-instruction-memory 是指向本仓库的
 * junction，所以宿主进程加载的是**启动那一刻**磁盘上的源码。改了代码不等于改了
 * 运行中的进程；只比对文件哈希会得出错误结论。
 *
 * 判据是 1.0.10 独有的可观测行为：路由带 Host/Origin 防护，外来 Host 必须 403。
 * 修复前的代码对该请求返回 200。
 *
 *   node live-version-check.mjs
 */
import http from 'node:http'

const PORT = Number(process.env.IM_PORT ?? 8080)

function request(host, path = '/instruction-memory/api') {
  return new Promise((resolve) => {
    const body = JSON.stringify({ method: 'state' })
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path,
      method: 'POST',
      setHost: false,
      headers: {
        'content-type': 'application/json',
        Host: host,
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: text }))
    })
    req.on('error', (err) => resolve({ status: 0, body: String(err.message) }))
    req.write(body)
    req.end()
  })
}

const loopback = await request(`127.0.0.1:${PORT}`)
const foreign = await request(`evil.com:${PORT}`)
const localhostOrigin = await request(`127.0.0.1:${PORT}`)

let version
if (foreign.status === 403) version = '1.0.10+ (Host/Origin guard active)'
else if (foreign.status === 200) version = 'pre-1.0.10 (no Host guard)'
else version = 'unknown'

const parsed = (() => { try { return JSON.parse(foreign.body) } catch { return null } })()

console.log('宿主进程加载的插件版本判定')
console.log('  Host=127.0.0.1 -> HTTP ' + loopback.status)
console.log('  Host=evil.com  -> HTTP ' + foreign.status + (parsed?.message ? '  ' + parsed.message : ''))
console.log('  => ' + version)
console.log('')
console.log('说明：改代码不会影响已在运行的进程（junction 指向仓库，源码在启动时读取）。')
console.log('      要让它加载磁盘上的最新源码，必须重启 DSH。')
console.log('      注意此检查本身会对 /instruction-memory/api 发起真实请求（只读 state 与一次被拒的请求）。')

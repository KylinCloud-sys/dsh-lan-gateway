/**
 * dsh-lan-gateway — 局域网网关插件
 *
 * 目的：DSH 桌面端本体固定绑在 127.0.0.1:3080（本地与内嵌窗口照常使用），
 * 本插件额外监听 0.0.0.0:3081，把请求反向代理到 127.0.0.1:3080，
 * 让虚拟局域网和家庭局域网上的设备也能打开同一个 DSH。
 *
 * 为什么不直接让 DSH 绑 0.0.0.0：DSH 的 webserver 显式拒绝通配地址，
 * 只接受单个具体网卡 IP；一次 listen 无法同时覆盖回环和局域网地址。
 *
 * 关于 Host：DSH 的 /api 和首页都有 Host/Origin 信任栅栏，且浏览器 cookie
 * 是按 Host 头签发的（authority 参与 cookie 名）。网关把上游 Host 统一改写成
 * 127.0.0.1:3080，既过栅栏，也保证同一浏览器内 cookie 不错位。
 * 因此需要在宿主 connection 行配置 trustedHosts: ['127.0.0.1:3080']。
 *
 * @module dsh-lan-gateway
 */
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { Schema } from './schema.js'
/** 插件标识，供 profile 配置树引用。 */
export const name = 'lan-gateway'

/**
 * Live settings schema. Keep the upstream endpoint outside editable settings:
 * it is an invariant of the DSH gateway integration.
 */
const Listener = Schema.object({
  host: Schema.string().min(1).max(253).required(),
  port: Schema.number().min(1).max(65535).step(1).required(),
})
export const Config = Schema.object({
  listeners: Schema.array(Listener).default([{ host: '0.0.0.0', port: 3081 }]).volatile(),
  // Legacy configuration remains honored when the new editable field is absent.
  listenHosts: Schema.array(Schema.string()).default(['0.0.0.0']),
  listenHost: Schema.string(),
  listenPort: Schema.number().default(3081),
  upstreamHost: Schema.const('127.0.0.1').default('127.0.0.1'),
  upstreamPort: Schema.const(3080).default(3080),
})

/** 默认配置；旧版地址列表与共享端口会自动映射为独立的监听入口。 */
export const DEFAULTS = {
  // 默认监听所有网卡。想缩小暴露面时把它改成具体地址列表，例如
  // ['10.x.x.x', '192.168.0.x']，这样只在指定网段可达。
  listenHosts: ['0.0.0.0'],
  listenPort: 3081,
  upstreamHost: '127.0.0.1',
  upstreamPort: 3080,
}

/**
 * 归一化监听地址列表。
 *
 * 同时接受 `listenHosts`（数组）与旧版的 `listenHost`（单个字符串），
 * 后者保留是为了不破坏已有配置。去重并保持书写顺序。
 *
 * @param raw - 原始配置对象。
 * @returns 非空的地址数组。
 */
function normalizeHosts(raw) {
  const candidate = raw.listenHosts ?? raw.listenHost ?? DEFAULTS.listenHosts
  const list = Array.isArray(candidate) ? candidate : [candidate]
  const hosts = []
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error('lan-gateway: listenHosts 必须是非空字符串数组')
    }
    const host = item.trim()
    if (!hosts.includes(host)) hosts.push(host)
  }
  if (hosts.length === 0) throw new Error('lan-gateway: listenHosts 至少要提供一个监听地址')
  return hosts
}

/** Validate listeners on the Host before persistence, including cross-row conflicts. */
export function resolveConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw }
  const upstreamHost = config.upstreamHost ?? DEFAULTS.upstreamHost
  const upstreamPort = config.upstreamPort ?? DEFAULTS.upstreamPort
  if ((raw.upstreamHost !== undefined && upstreamHost !== DEFAULTS.upstreamHost) || (raw.upstreamPort !== undefined && Number(upstreamPort) !== 3080)) {
    throw new Error('lan-gateway: 终点固定为 127.0.0.1:3080，不允许修改')
  }
  const value = typeof raw.listeners?.get === 'function' ? raw.listeners.get() : raw.listeners
  const listeners = Array.isArray(value)
    ? value
    : normalizeHosts(raw).map((host) => ({ host, port: Number(config.listenPort) }))
  if (!Array.isArray(listeners)) throw new Error('lan-gateway: listeners 必须是数组')
  config.listeners = listeners.map((item) => {
    const host = typeof item?.host === 'string' ? item.host.trim() : ''
    const port = item?.port
    if (!host || /[\s/\\?#@]/u.test(host) || (net.isIP(host) === 0 && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(host))) {
      throw new Error('lan-gateway: 监听地址应为 IP 或主机名，不带协议、路径和端口')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3080) {
      throw new Error('lan-gateway: 监听端口必须是 1-65535 的整数，且不能占用终点端口 3080')
    }
    return { host: host.toLowerCase(), port }
  })
  for (let i = 0; i < config.listeners.length; i++) {
    const a = config.listeners[i]
    for (const b of config.listeners.slice(0, i)) {
      if (a.port === b.port && (a.host === b.host || ['0.0.0.0', '::'].includes(a.host) || ['0.0.0.0', '::'].includes(b.host))) {
        throw new Error('lan-gateway: 同一端口的监听地址重复或与通配地址冲突')
      }
    }
  }
  config.upstreamHost = DEFAULTS.upstreamHost
  config.upstreamPort = 3080
  return config
}

// Preserve the Schemastery object metadata used by settings, while performing
// migration and full Host-only validation at the Standard Schema boundary.
Object.defineProperty(Config, '~standard', { value: {
  version: 1,
  vendor: 'dsh-lan-gateway',
  validate(raw) {
    try {
      const normalized = resolveConfig(raw ?? {})
      const result = Config.validate({ ...(raw ?? {}), listeners: normalized.listeners })
      return result.issues ? result : { value: result.value }
    } catch (error) {
      return { issues: [{ message: error.message, path: [] }] }
    }
  },
} })

/** 逐跳（hop-by-hop）头：转发时必须剥离，由两端各自管理。 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/** 去掉逐跳头，返回新对象（不改原 headers）。 */
function stripHopByHop(headers) {
  const out = { ...headers }
  for (const key of HOP_BY_HOP) delete out[key]
  return out
}

/**
 * 该响应是否值得 gzip。
 *
 * DSH 的 webserver 带有 compression 配置，但它的客户端 bundle 路由实测**不压缩**：
 * 首页要拉约 11.8MB 原始 JS，经带宽受限的内网穿透隧道往往传到一半就断开。
 * 这些内容压缩率很高（约 4:1），在网关补一层 gzip 是收益最大的一处优化。
 *
 * 只处理文本类内容；已带 content-encoding 的响应、SSE 流、以及客户端未声明
 * 支持 gzip 的请求一律原样透传。
 *
 * @param req - 客户端请求（读取 Accept-Encoding）。
 * @param upstreamRes - 上游响应（读取 Content-Type / Content-Encoding）。
 * @returns 是否应该压缩。
 */
function shouldCompress(req, upstreamRes) {
  if (upstreamRes.headers['content-encoding'] !== undefined) return false
  const type = String(upstreamRes.headers['content-type'] ?? '')
  const compressible = /^(?:text\/|application\/(?:javascript|json|xml|wasm|x-javascript)|image\/svg\+xml)/iu.test(type)
  if (!compressible) return false
  // SSE 是长连接流，压缩会破坏逐条推送的时序。
  if (/text\/event-stream/iu.test(type)) return false
  const accept = String(req.headers['accept-encoding'] ?? '')
  return /\bgzip\b/iu.test(accept)
}

/**
 * 挂载网关。
 * @param ctx - Cordis 插件上下文。
 * @param config - 校验后的配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const authority = `${config.upstreamHost}:${config.upstreamPort}`
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128 })

  /**
   * 取本次进程的启动 token，返回**站内相对**的带 token 根路径。
   *
   * DSH 的浏览器认证按访问地址（authority）签发 cookie：cookie 名 = cookieName(Host)。
   * 网关把上游 Host 统一改写成 127.0.0.1:3080，所以外部设备手里不会有这个 authority 的
   * cookie，首次打开必然 401。这里利用 connection 服务的公开方法 authenticatedUrl()
   * 拿到本进程 token，让浏览器跳一次 `/?token=...`，DSH 就会按（改写后的）Host
   * 签发 cookie，此后所有请求都能命中。
   *
   * 必须返回相对路径：若返回绝对地址 http://127.0.0.1:3080/，手机会去连它自己。
   *
   * @returns 形如 `/?token=xxx` 的相对地址，或 undefined（服务未就绪）。
   */
  function tokenRedirectLocation() {
    let connection
    try {
      // 懒查找：插件挂载时 connection 服务未必已就绪，每次请求现取。
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      return undefined
    }
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return undefined
    try {
      const url = new URL(connection.authenticatedUrl(`http://${authority}/`))
      return `${url.pathname}${url.search}`
    } catch {
      return undefined
    }
  }

  /** 请求是否已带 token 参数：带了就不再跳，避免 401 → 跳转 → 401 的死循环。 */
  function hasToken(req) {
    try {
      return new URL(req.url ?? '/', 'http://gateway.invalid').searchParams.has('token')
    } catch {
      return false
    }
  }

  /**
   * 把「本设备自己来源」的 Origin / Referer 改写成上游权威。
   *
   * DSH 的浏览器信任栅栏会逐字比较 Origin 与 Host：
   *   isSameAuthorityOrigin(origin, host) 要求 origin.host === host.host
   * 网关把 Host 改写成 127.0.0.1:3080 后，浏览器发来的
   * `Origin: http://<局域网IP>:3081` 就对不上了，DSH 判定为跨站请求并返回 **403**。
   * 表现是页面能打开、但所有 POST/RPC 全部失败（插件激活失败、进不去主页）。
   *
   * 只改写与原始 Host 同源的 Origin：第三方来源一律保持原样，不伪造信任。
   *
   * @param headers - 已复制的请求头对象（就地修改）。
   * @param originalHost - 浏览器原始请求的 Host 值。
   */
  function rewriteSelfOrigin(headers, originalHost) {
    const isOurs = (value) => {
      try {
        const parsed = new URL(value)
        const ours = new URL(`http://${originalHost}`)
        return parsed.host === ours.host
      } catch {
        return false
      }
    }
    if (typeof headers.origin === 'string' && isOurs(headers.origin)) {
      headers.origin = `http://${authority}`
    }
    if (typeof headers.referer === 'string' && isOurs(headers.referer)) {
      try {
        const referer = new URL(headers.referer)
        referer.host = authority
        referer.protocol = 'http:'
        headers.referer = referer.href
      } catch {
        delete headers.referer
      }
    }
  }

  /** 改写请求头：Host 统一成上游权威，丢弃浏览器自带的 X-Forwarded-*。 */
  function rewriteHeaders(req) {
    const originalHost = req.headers.host
    const headers = stripHopByHop(req.headers)
    // 统一 Host：DSH 按它做信任判定和 cookie 签发，必须与 trustedHosts 一致。
    headers.host = authority
    // Origin 必须跟着 Host 一起改，否则信任栅栏会判成跨站（403）。
    if (originalHost) rewriteSelfOrigin(headers, originalHost)
    delete headers['x-forwarded-for']
    delete headers['x-forwarded-host']
    delete headers['x-forwarded-proto']
    return headers
  }

  /** 单个 HTTP 请求的处理：转发到上游，必要时介入 401。 */
  function handleRequest(req, res) {
    const upstream = http.request(
      {
        host: config.upstreamHost,
        port: config.upstreamPort,
        method: req.method,
        path: req.url,
        headers: rewriteHeaders(req),
        agent,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502
        // 401 = 该设备没有 DSH 的会话 cookie。仅对页面 GET 做一次带 token 的跳转；
        // /api 的 401 交给前端，跳转对它没有意义，还会破坏请求语义。
        const isPageGet = req.method === 'GET' && !(req.url ?? '').startsWith('/api')
        if (status === 401 && isPageGet && !hasToken(req)) {
          const location = tokenRedirectLocation()
          if (location !== undefined) {
            upstreamRes.resume()
            res.writeHead(303, {
              'cache-control': 'no-store',
              location,
              'referrer-policy': 'no-referrer',
            })
            res.end()
            return
          }
        }
        // 其余情况（含认证服务未就绪、已带 token 仍 401）一律原样透传，绝不吞掉 401。
        if (shouldCompress(req, upstreamRes)) {
          // DSH 不压缩客户端 bundle（实测首页约 11.8MB 原样下发），
          // 经带宽受限的隧道必然传不完。这里补一层 gzip，约压到 1/4。
          const headers = stripHopByHop(upstreamRes.headers)
          delete headers['content-length']
          headers['content-encoding'] = 'gzip'
          headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding'
          res.writeHead(status, upstreamRes.statusMessage, headers)
          const gzip = zlib.createGzip({ level: 6 })
          gzip.on('error', () => {
            upstreamRes.destroy()
            if (!res.destroyed) res.destroy()
          })
          // 客户端提前断开时别继续压缩，省 CPU。
          res.on('close', () => {
            if (!res.writableFinished) gzip.destroy()
          })
          upstreamRes.pipe(gzip).pipe(res)
          return
        }
        res.writeHead(status, upstreamRes.statusMessage, stripHopByHop(upstreamRes.headers))
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end(`lan-gateway: 上游 ${authority} 不可用（${error.code ?? error.message}）`)
    })
    // 客户端提前断开时取消上游请求，避免连接泄漏。
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }

  // WebSocket / SSE 升级：DSH 远程流走 upgrade，必须原样透传头部与首包。
  // 注意：升级请求绝不能剥 hop-by-hop 头——Upgrade 与 Connection 正是升级语义本身。
  function handleUpgrade(req, socket, head) {
    const originalHost = req.headers.host
    const headers = { ...req.headers }
    headers.host = authority
    // 升级握手同样过信任栅栏，Origin 必须同步改写。
    if (originalHost) rewriteSelfOrigin(headers, originalHost)
    delete headers['x-forwarded-for']
    delete headers['x-forwarded-host']
    delete headers['x-forwarded-proto']
    const target = net.connect(config.upstreamPort, config.upstreamHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`)
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`)
        }
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) target.write(head)
      socket.pipe(target).pipe(socket)
    })
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
    socket.setNoDelay(true)
  }

  // Cordis 的 logger 是按名字取的服务：ctx.logger('name') 返回带 info/warn/error 的 logger。
  const logger = ctx.logger?.('lan-gateway')

  /** Keep unchanged listeners alive, including active SSE/WebSocket sessions. */
  const servers = new Map()
  let disposed = false
  let pending = Promise.resolve()

  function closeListener(record) {
    return new Promise((resolve) => {
      for (const socket of record.sockets) socket.destroy()
      record.server.closeAllConnections?.()
      record.server.close(() => resolve())
    })
  }

  /**
   * 在某个具体地址上建立监听。
   *
   * 每个地址一个 http.Server：同一端口绑定不同 IP 互不冲突，
   * 因此可以只监听指定网段，不必暴露 0.0.0.0。
   *
   * **单个地址失败不拖垮整体**：网卡未就绪、VPN 未连接时该地址会报
   * EADDRNOTAVAIL，这里只记日志，其余地址照常工作，DSH 也不受影响。
   *
   * @param host - 要绑定的具体地址。
   */
  function listenOn(host, port) {
    const server = http.createServer(handleRequest)
    const sockets = new Set()
    const key = JSON.stringify([host, port])
    const record = { server, sockets }
    servers.set(key, record)
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('upgrade', handleUpgrade)
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 70_000
    server.on('error', (error) => {
      if (servers.get(key) === record) servers.delete(key)
      logger?.error?.(`监听 ${host}:${port} 失败：${error.code ?? error.message}（其余地址不受影响）`)
    })
    server.listen(port, host, () => {
      logger?.info?.(`网关已启动：${host}:${port} -> ${authority}`)
    })
  }

  async function reconcile(listeners) {
    const desired = new Map(listeners.map((item) => [JSON.stringify([item.host, item.port]), item]))
    const closing = []
    for (const [key, record] of servers) {
      if (desired.has(key)) continue
      servers.delete(key)
      closing.push(closeListener(record))
    }
    await Promise.all(closing)
    if (disposed) return
    for (const [key, { host, port }] of desired) {
      if (!servers.has(key)) listenOn(host, port)
    }
  }

  pending = reconcile(config.listeners)
  ctx.on('loader/volatile-update', () => {
    try {
      const next = resolveConfig(rawConfig).listeners
      pending = pending.then(() => reconcile(next)).catch((error) => logger?.error?.(error))
    } catch (error) {
      logger?.error?.(error)
    }
  })

  // Optional settings policy: only expose schema-declared live fields.
  ctx.effect(() => async () => {
    disposed = true
    await pending
    agent.destroy()
    await Promise.all([...servers.values()].map(closeListener))
    servers.clear()
  }, 'lan-gateway: servers')
}

export default { name, Config, apply, inject: [] }

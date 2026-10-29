/**
 * dsh-lan-gateway — 局域网网关插件
 *
 * 目的：DSH 桌面端本体保持在回环地址（默认 127.0.0.1:3080，也允许 0 让系统
 * 随机分配端口），本插件额外监听用户配置的入口地址，把请求反向代理到本体，
 * 让虚拟局域网和家庭局域网上的设备也能打开同一个 DSH。
 *
 * 为什么不直接让 DSH 绑 0.0.0.0：DSH 的 webserver 显式拒绝通配地址，
 * 只接受单个具体网卡 IP；一次 listen 无法同时覆盖回环和局域网地址。
 *
 * 关于终点：**终点不做成配置项**，而是每次请求从宿主的 webServer 服务读取
 * 实际绑定的地址/端口/协议。这样 DSH 用 port: 0 随机端口、临时换端口、或启用
 * TLS 时，网关都自动跟随，不需要跟着改配置，也没有办法把它指向别处。
 *
 * 关于 Host：DSH 的 /api 和首页都有 Host/Origin 信任栅栏，且浏览器 cookie
 * 是按 Host 头签发的（authority 参与 cookie 名）。网关把上游 Host 统一改写成
 * 终点的真实 authority，既过栅栏（回环地址不限端口），也保证同一浏览器内
 * cookie 不错位。
 *
 * @module dsh-lan-gateway
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { Schema } from './schema.js'
/** 插件标识，供 profile 配置树引用。 */
export const name = 'lan-gateway'

/**
 * Live settings schema. Only the listener list is editable: the upstream
 * endpoint is derived from the host's own webserver at request time.
 */
const Listener = Schema.object({
  host: Schema.string().min(1).max(253).required(),
  port: Schema.number().min(1).max(65535).step(1).required(),
})
export const Config = Schema.object({
  listeners: Schema.array(Listener).default([{ host: '0.0.0.0', port: 3081 }]).volatile(),
  // Runtime-only action nonce. The settings page increments it to request an immediate retry.
  rebindNonce: Schema.number().min(0).step(1).default(0).volatile(),
  // Legacy configuration remains honored when the new editable field is absent.
  listenHosts: Schema.array(Schema.string()).default(['0.0.0.0']),
  listenHost: Schema.string(),
  listenPort: Schema.number().default(3081),
})

/** 默认配置；旧版地址列表与共享端口会自动映射为独立的监听入口。 */
export const DEFAULTS = {
  // 默认监听所有网卡。想缩小暴露面时把它改成具体地址列表，例如
  // ['10.x.x.x', '192.168.0.x']，这样只在指定网段可达。
  listenHosts: ['0.0.0.0'],
  listenPort: 3081,
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
  // 终点在请求时从宿主 webServer 读取，不再是一个配置项。旧配置里的
  // upstreamHost/upstreamPort 过去只能等于 127.0.0.1:3080，这里静默丢弃。
  delete config.upstreamHost
  delete config.upstreamPort
  const value = typeof raw.listeners?.get === 'function' ? raw.listeners.get() : raw.listeners
  const listeners = Array.isArray(value)
    ? value
    : normalizeHosts(raw).map((host) => ({ host, port: Number(config.listenPort) }))
  if (!Array.isArray(listeners)) throw new Error('lan-gateway: listeners 必须是数组')
  config.rebindNonce = Number(readVolatileValue(raw.rebindNonce) ?? 0)
  if (!Number.isInteger(config.rebindNonce) || config.rebindNonce < 0) {
    throw new Error('lan-gateway: rebindNonce 必须是非负整数')
  }
  config.listeners = listeners.map((item) => {
    const host = typeof item?.host === 'string' ? item.host.trim() : ''
    const port = item?.port
    if (!host || /[\s/\\?#@]/u.test(host) || (net.isIP(host) === 0 && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(host))) {
      throw new Error('lan-gateway: 监听地址应为 IP 或主机名，不带协议、路径和端口')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('lan-gateway: 监听端口必须是 1-65535 的整数')
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
  return config
}

// Preserve the Schemastery object metadata used by settings, while performing
// migration and full Host-only validation at the Standard Schema boundary.
function readVolatileValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

Object.defineProperty(Config, '~standard', { value: {
  version: 1,
  vendor: 'dsh-lan-gateway',
  validate(raw) {
    try {
      const input = { ...(raw ?? {}) }
      // 终点已改为运行时跟随宿主 webServer：旧的 upstreamHost/upstreamPort
      // 直接丢弃，别让它们留在 fiber.config 里（否则设置页要显示两个永远为
      // 3080 的死字段，保存时还会被判成不可编辑字段）。
      delete input.upstreamHost
      delete input.upstreamPort
      const normalized = resolveConfig(input)
      const result = Config.validate({
        ...input,
        listeners: normalized.listeners,
        rebindNonce: readVolatileValue(input.rebindNonce),
      })
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
export function apply(ctx, rawConfig, options = {}) {
  const config = resolveConfig(rawConfig)
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })
  // 终点是本机回环到本机回环；DSH 启用 TLS 时通常用自签证书，网关不承担
  // 对外证书校验职责（对外由用户自己的反向代理负责），因此不拒绝自签。
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, rejectUnauthorized: false })

  /** 终点兜底值：webServer 服务尚未就绪时使用。 */
  const FALLBACK_ENDPOINT = { host: '127.0.0.1', port: 3080, protocol: 'http:', authority: '127.0.0.1:3080' }

  /**
   * 读取宿主 webServer 的实际监听信息。
   *
   * DSH 的 webserver 允许 `port: 0`（内核随机分配），也允许换端口、启用 TLS；
   * 这些都不该让网关跟着改配置，所以终点**不做配置项**，每次请求现取。
   * 懒查找的理由和 connection 一样：插件挂载时这些服务未必已就绪。
   *
   * @returns `{host, port, protocol, authority}`，其中 authority 是 Host 头要用的
   * `host:port`；返回 undefined 表示本体还没 listen 完成。
   */
  function upstreamEndpoint(useFallback = true) {
    let server
    try {
      server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    } catch {
      server = undefined
    }
    if (server === undefined) return useFallback ? FALLBACK_ENDPOINT : undefined
    const host = server.host
    const port = server.port
    if (typeof host !== 'string' || typeof port !== 'number') return undefined
    const protocol = server.protocol === 'https:' ? 'https:' : 'http:'
    let authority = `${host}:${String(port)}`
    try {
      authority = new URL(server.getOrigin()).host
    } catch {
      // 带 zone id 的地址无法表达成 URL，退回裸拼接（Host 头仍可用）。
    }
    return { host, port, protocol, authority }
  }

  /**
   * 把「本设备自己来源」的 Origin / Referer 改写成终点权威。
   *
   * DSH 的浏览器信任栅栏会逐字比较 Origin 与 Host：
   *   isSameAuthorityOrigin(origin, host) 要求 origin.host === host.host
   * 网关把 Host 改写成终点 authority 后，浏览器发来的
   * `Origin: http://<局域网IP>:3081` 就对不上了，DSH 判定为跨站请求并返回 **403**。
   * 表现是页面能打开、但所有 POST/RPC 全部失败（插件激活失败、进不去主页）。
   *
   * 只改写与原始 Host 同源的 Origin：第三方来源一律保持原样，不伪造信任。
   *
   * @param headers - 已复制的请求头对象（就地修改）。
   * @param originalHost - 浏览器原始请求的 Host 值。
   * @param target - 本次请求的终点。
   */
  function rewriteSelfOrigin(headers, originalHost, target) {
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
      headers.origin = `${target.protocol}//${target.authority}`
    }
    if (typeof headers.referer === 'string' && isOurs(headers.referer)) {
      try {
        const referer = new URL(headers.referer)
        referer.host = target.authority
        referer.protocol = target.protocol
        headers.referer = referer.href
      } catch {
        delete headers.referer
      }
    }
  }

  /** 改写请求头：Host 统一成终点权威，丢弃浏览器自带的 X-Forwarded-*。 */
  function rewriteHeaders(req, target) {
    const originalHost = req.headers.host
    const headers = stripHopByHop(req.headers)
    // 统一 Host：DSH 按它做信任判定和 cookie 签发，必须与终点真实 authority 一致。
    headers.host = target.authority
    // Origin 必须跟着 Host 一起改，否则信任栅栏会判成跨站（403）。
    if (originalHost) rewriteSelfOrigin(headers, originalHost, target)
    delete headers['x-forwarded-for']
    delete headers['x-forwarded-host']
    delete headers['x-forwarded-proto']
    return headers
  }

  /**
   * 取本次进程的启动 token，返回**站内相对**的带 token 根路径。
   *
   * DSH 的浏览器认证按访问地址（authority）签发 cookie：cookie 名 = cookieName(Host)。
   * 网关把上游 Host 统一改写成终点 authority，所以外部设备手里不会有这个 authority 的
   * cookie，首次打开必然 401。这里利用 connection 服务的公开方法 authenticatedUrl()
   * 拿到本进程 token，让浏览器跳一次 `/?token=...`，DSH 就会按（改写后的）Host
   * 签发 cookie，此后所有请求都能命中。
   *
   * 必须返回相对路径：若返回绝对地址，手机会去连它自己。
   *
   * @param target 本次请求的终点，见 {@link upstreamEndpoint}。
   * @returns 形如 `/?token=xxx` 的相对地址，或 undefined（服务未就绪）。
   */
  function tokenRedirectLocation(target) {
    let connection
    try {
      // 懒查找：插件挂载时 connection 服务未必已就绪，每次请求现取。
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      return undefined
    }
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return undefined
    try {
      const url = new URL(connection.authenticatedUrl(`${target.protocol}//${target.authority}/`))
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


  /** 终点还没 listen 时的统一应答，避免把浏览器晾在那儿。 */
  function respondUpstreamPending(res) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
    res.end('lan-gateway: DSH 本体尚未监听，请稍后重试')
  }

  /** 单个 HTTP 请求的处理：转发到上游，必要时介入 401。 */
  function handleRequest(req, res) {
    const target = upstreamEndpoint()
    if (target === undefined) {
      respondUpstreamPending(res)
      return
    }
    const transport = target.protocol === 'https:' ? https : http
    const upstream = transport.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: rewriteHeaders(req, target),
        agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502
        // 401 = 该设备没有 DSH 的会话 cookie。仅对页面 GET 做一次带 token 的跳转；
        // /api 的 401 交给前端，跳转对它没有意义，还会破坏请求语义。
        const isPageGet = req.method === 'GET' && !(req.url ?? '').startsWith('/api')
        if (status === 401 && isPageGet && !hasToken(req)) {
          const location = tokenRedirectLocation(target)
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
      res.end(`lan-gateway: 上游 ${target.authority} 不可用（${error.code ?? error.message}）`)
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
    const endpoint = upstreamEndpoint()
    if (endpoint === undefined) {
      socket.destroy()
      return
    }
    const originalHost = req.headers.host
    const headers = { ...req.headers }
    headers.host = endpoint.authority
    // 升级握手同样过信任栅栏，Origin 必须同步改写。
    if (originalHost) rewriteSelfOrigin(headers, originalHost, endpoint)
    delete headers['x-forwarded-for']
    delete headers['x-forwarded-host']
    delete headers['x-forwarded-proto']
    const secure = endpoint.protocol === 'https:'
    const peer = secure
      ? tls.connect({
        host: endpoint.host,
        port: endpoint.port,
        servername: net.isIP(endpoint.host) === 0 ? endpoint.host : undefined,
        rejectUnauthorized: false,
      })
      : net.connect(endpoint.port, endpoint.host)
    peer.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`)
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`)
        }
      }
      peer.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) peer.write(head)
      socket.pipe(peer).pipe(socket)
    })
    peer.on('error', () => socket.destroy())
    socket.on('error', () => peer.destroy())
    socket.setNoDelay(true)
  }

  // Cordis 的 logger 是按名字取的服务：ctx.logger('name') 返回带 info/warn/error 的 logger。
  const logger = ctx.logger?.('lan-gateway')

  /** 每个配置入口保留一个生命周期对象；失败入口也留在表里，供重试和手动重绑。 */
  const entries = new Map()
  const lastListenErrors = new Map()
  let currentRebindNonce = Number(readVolatileValue(config.rebindNonce) ?? 0)
  let disposed = false
  let pending = Promise.resolve()

  const createServer = options.createServer ?? ((handler) => http.createServer(handler))
  const retryDelay = options.retryDelay ?? ((attempt) => Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1))))
  const retryableError = (error) => error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAI_AGAIN'

  function entryKey(host, port) {
    return JSON.stringify([host, port])
  }

  function clearRetry(entry) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  function closeEntry(entry) {
    clearRetry(entry)
    entry.generation++
    const server = entry.server
    entry.server = undefined
    entry.listening = false
    for (const socket of entry.sockets) socket.destroy()
    entry.sockets.clear()
    if (server === undefined) return Promise.resolve()
    server.closeAllConnections?.()
    if (!entry.wasListening) {
      try { server.close() } catch { /* server.listen 失败后可能不是 running */ }
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
    })
  }

  /** DSH 本体未 ready 时的 fallback 不能用于冲突判断。 */
  function upstreamConflict(host, port) {
    // 必须用"真实终点"：本体还没就绪时 upstreamEndpoint() 会返回兜底值，
    // 拿兜底值判冲突会把用户配置的 3080 入口误判成重复而永久跳过。
    const endpoint = upstreamEndpoint(false)
    if (endpoint === undefined || endpoint.port !== port) return undefined
    const wildcard = (value) => value === '0.0.0.0' || value === '::'
    if (endpoint.host === host || wildcard(host) || wildcard(endpoint.host)) return endpoint
    return undefined
  }

  function reportListenFailure(key, signature, level, message) {
    if (lastListenErrors.get(key) === signature) return
    lastListenErrors.set(key, signature)
    logger?.[level]?.(message)
  }

  function scheduleRetry(entry) {
    if (disposed || entry.timer !== undefined || entry.listening || entry.server !== undefined) return
    const generation = entry.generation
    entry.attempt += 1
    // 退避计算必须是"纯"的：retryDelay 抛错或返回非法值时不能让异常逃出
    // error 事件调用栈，否则该入口会卡在既没监听、也没定时器的状态。
    let delay
    try {
      delay = Number(retryDelay(entry.attempt))
    } catch {
      delay = 30_000
    }
    if (!Number.isFinite(delay) || delay < 0) delay = 30_000
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (disposed || entries.get(entry.key) !== entry || entry.generation !== generation) return
      pending = pending.then(() => attemptBind(entry)).catch((error) => logger?.error?.(error))
    }, delay)
    entry.timer.unref?.()
  }

  /**
   * 为一条监听入口发起一次绑定尝试。
   *
   * 失败分三类：
   * - 地址暂时不可用（`EADDRNOTAVAIL` / `EAI_AGAIN`）：网卡/VPN 还没上线，
   *   安排退避重试，入口保留在表里；
   * - 端口被占（`EADDRINUSE`）或权限/参数错误：重试无意义，只记一次日志，
   *   入口保留但不再自动重试，等改配置或手动重建；
   * - 本次尝试已经过期（入口被删除、被替换、插件已卸载）：静默收尾。
   *
   * 无论走哪条路径，`entry.server` 都会被清空、Promise 都会 resolve，
   * `reconcile()` 的串行队列不会被一次失败的绑定卡死。
   */
  function attemptBind(entry) {
    if (disposed || entries.get(entry.key) !== entry || entry.listening || entry.server !== undefined) return Promise.resolve()
    const conflict = upstreamConflict(entry.host, entry.port)
    if (conflict !== undefined) {
      reportListenFailure(entry.key, `conflict:${conflict.authority}`, 'warn', `监听入口 ${entry.host}:${entry.port} 与 DSH 本体地址重复（本体本次为 ${conflict.authority}），该入口已跳过，请换一个端口`)
      return Promise.resolve()
    }
    let server
    try {
      server = createServer(handleRequest)
    } catch (error) {
      reportListenFailure(entry.key, error.code ?? error.message, 'error', `监听 ${entry.host}:${entry.port} 失败：${error.code ?? error.message}（其余地址不受影响）`)
      return Promise.resolve()
    }

    entry.server = server
    entry.wasListening = false
    const generation = entry.generation
    const sockets = entry.sockets

    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }

      /** 本次尝试是否仍然代表当前配置。 */
      const stillCurrent = () => !disposed && entries.get(entry.key) === entry && entry.generation === generation

      const onListening = () => {
        if (!stillCurrent()) {
          try { server.close() } catch { /* 过期尝试，忽略关闭失败 */ }
          finish()
          return
        }
        // 成功时清掉可能残留的重试定时器：error 与 listening 理论上互斥，
        // 但定时器一旦留下，之后就会重绑一次已经健康的入口。
        clearRetry(entry)
        const recovered = entry.attempt > 0
        entry.server = server
        entry.listening = true
        entry.wasListening = true
        entry.attempt = 0
        lastListenErrors.delete(entry.key)
        const endpoint = upstreamEndpoint()
        logger?.info?.(recovered
          ? `网关监听已恢复：${entry.host}:${entry.port} -> ${endpoint?.authority ?? 'DSH 本体（尚未监听）'}`
          : `网关已启动：${entry.host}:${entry.port} -> ${endpoint?.authority ?? 'DSH 本体（尚未监听）'}`)
        finish()
      }

      /** 统一的失败收尾：清理状态、按错误类型决定是否重试。 */
      const onBindError = (error) => {
        // 已监听成功后的运行期错误：不拆掉 server，避免打断 SSE/WebSocket。
        if (entry.listening) {
          reportListenFailure(entry.key, `runtime:${error.code ?? error.message}`, 'error', `监听 ${entry.host}:${entry.port} 运行时错误：${error.code ?? error.message}`)
          return
        }
        if (!stillCurrent()) {
          try { server.close() } catch { /* 过期尝试，忽略关闭失败 */ }
          finish()
          return
        }
        if (entry.server === server) entry.server = undefined
        const code = error.code ?? error.message
        if (error.code === 'EADDRINUSE') {
          const endpoint = upstreamEndpoint()
          const message = endpoint !== undefined && endpoint.port === entry.port
            ? `监听 ${entry.host}:${entry.port} 失败：该端口正被 DSH 本体占用（本次 ${endpoint.authority}），请换一个监听端口`
            : `监听 ${entry.host}:${entry.port} 失败：${code}（不会自动重试，请检查端口占用）`
          reportListenFailure(entry.key, `permanent:${code}:${endpoint?.authority ?? ''}`, 'error', message)
        } else if (retryableError(error)) {
          reportListenFailure(entry.key, `retry:${code}`, 'error', `监听 ${entry.host}:${entry.port} 失败：${code}；将在后台自动重试`)
          scheduleRetry(entry)
        } else {
          reportListenFailure(entry.key, `permanent:${code}`, 'error', `监听 ${entry.host}:${entry.port} 失败：${code}（不会自动重试，请检查地址/权限）`)
        }
        try { server.close() } catch { /* listen 失败后通常已经不是 running */ }
        finish()
      }

      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      server.on('upgrade', handleUpgrade)
      server.keepAliveTimeout = 65_000
      server.headersTimeout = 70_000
      server.on('error', onBindError)

      try {
        server.listen(entry.port, entry.host, onListening)
      } catch (error) {
        // listen() 也能同步抛错（非法端口、已 destroy 的 server 等）。
        // 不接住就会留下 entry.server 已赋值但永不回调的"假绑定"，
        // 重试和关闭都会被它挡住。
        onBindError(error)
      }
    })
  }
  async function reconcile(listeners, forceRetry = false) {
    const desired = new Map(listeners.map((item) => [entryKey(item.host, item.port), item]))
    const closing = []
    for (const [key, entry] of entries) {
      if (desired.has(key)) continue
      entries.delete(key)
      lastListenErrors.delete(key)
      closing.push(closeEntry(entry))
    }
    await Promise.all(closing)
    if (disposed) return
    for (const [key, { host, port }] of desired) {
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { key, host, port, server: undefined, sockets: new Set(), listening: false, wasListening: false, timer: undefined, attempt: 0, generation: 0 }
        entries.set(key, entry)
      }
      if (forceRetry && !entry.listening) {
        clearRetry(entry)
        entry.attempt = 0
      }
      if (!entry.listening && entry.server === undefined && entry.timer === undefined) await attemptBind(entry)
    }
  }

  pending = reconcile(config.listeners).catch((error) => logger?.error?.(error))
  ctx.on('loader/volatile-update', () => {
    try {
      const nextConfig = resolveConfig(rawConfig)
      const nextListeners = nextConfig.listeners
      const nextNonce = Number(readVolatileValue(rawConfig.rebindNonce) ?? 0)
      const forceRetry = nextNonce !== currentRebindNonce
      currentRebindNonce = nextNonce
      pending = pending.then(() => reconcile(nextListeners, forceRetry)).catch((error) => logger?.error?.(error))
    } catch (error) {
      logger?.error?.(error)
    }
  })

  ctx.effect(() => async () => {
    disposed = true
    for (const entry of entries.values()) clearRetry(entry)
    // 先关服务再等队列：在途的 listen 会因为 close 立刻收到错误回调，
    // attemptBind 里 disposed 的判断会把它静默收尾，await pending 才不会挂住。
    await Promise.all([...entries.values()].map(closeEntry))
    entries.clear()
    lastListenErrors.clear()
    await pending
    httpAgent.destroy()
    httpsAgent.destroy()
  }, 'lan-gateway: servers')
}

export default { name, Config, apply, inject: [] }

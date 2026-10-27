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
/** 插件标识，供 profile 配置树引用。 */
export const name = 'lan-gateway'

/**
 * 默认配置。
 * 这里不依赖 @deepseek-ai/schemastery：插件以 link/junction 安装时，
 * 从 D: 盘解析不到宿主 node_modules 下的 schemastery，纯对象配置更稳。
 *
 * 注意：本插件**刻意不导出 `Config`**。cordis 在挂载插件时会执行
 * `runtime.Config["~standard"].validate(config)`，只有标准 schema 才带 `~standard`；
 * 导出一个普通函数会让它在启动时抛 TypeError，导致插件挂载失败。
 * 没有 `Config` 时 cordis 原样放行配置，校验统一由 apply() 里的 resolveConfig() 完成。
 */
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

/** 合并并校验配置：端口必须是 1-65535 的整数，地址必须是非空字符串。 */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  for (const key of ['listenPort', 'upstreamPort']) {
    const value = Number(config[key])
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`lan-gateway: ${key} 必须是 1-65535 的整数，收到 ${JSON.stringify(config[key])}`)
    }
    config[key] = value
  }
  if (typeof config.upstreamHost !== 'string' || config.upstreamHost.trim() === '') {
    throw new Error('lan-gateway: upstreamHost 必须是非空字符串')
  }
  config.listenHosts = normalizeHosts(raw ?? {})
  return config
}

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

  /** 已建立的监听器，卸载时逐个关闭。 */
  const servers = []

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
  function listenOn(host) {
    const server = http.createServer(handleRequest)
    server.on('upgrade', handleUpgrade)
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 70_000
    server.on('error', (error) => {
      logger?.error?.(`监听 ${host}:${config.listenPort} 失败：${error.code ?? error.message}（其余地址不受影响）`)
    })
    server.listen(config.listenPort, host, () => {
      logger?.info?.(`网关已启动：${host}:${config.listenPort} -> ${authority}`)
    })
    servers.push(server)
  }

  for (const host of config.listenHosts) listenOn(host)

  // 插件卸载时关闭全部监听与连接池。
  ctx.effect(() => () => {
    agent.destroy()
    return Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections?.()
            server.close(() => resolve())
          }),
      ),
    )
  }, 'lan-gateway: servers')
}

export default { name, apply, inject: [] }

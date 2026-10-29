/**
 * End-to-end check of the proxy path against a live upstream.
 *
 * The point of this test is the part that is easy to get wrong: the gateway must
 * derive its upstream from the host's `webServer` service **on every request**,
 * so it keeps working when DSH listens on `port: 0` (kernel-chosen port) or moves
 * to another port — with no gateway configuration change.
 *
 * Runs with plain Node (global fetch, no dependencies).
 */
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { apply, Config, resolveConfig } from '../lib/index.js'

const results = []
function check(name, run) {
  try {
    run()
    results.push([true, name])
  } catch (error) {
    results.push([false, `${name} :: ${error.message}`])
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Echo back what the upstream actually received. */
function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ host: req.headers.host, url: req.url, method: req.method }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** Grab a port that is free right now, then release it for the gateway to bind. */
function freePort() {
  const probe = http.createServer()
  return new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Minimal Cordis context: only what the plugin actually touches. */
function fakeContext(webServerRef) {
  const logs = []
  const handlers = new Map()
  const record = (level) => (message) => logs.push(`${level}: ${message}`)
  let cleanup
  return {
    logs,
    handlers,
    async dispose() {
      await cleanup?.()
    },
    ctx: {
      get(name) {
        if (name === 'webServer') return webServerRef.current
        return undefined
      },
      on(name, handler) { handlers.set(name, handler) },
      effect(factory) { cleanup = factory() },
      logger: () => ({ info: record('info'), warn: record('warn'), error: record('error') }),
    },
  }
}

function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('condition was not reached in time'))
      setTimeout(poll, 5)
    }
    poll()
  })
}

class FakeServer extends EventEmitter {
  constructor(attempts, failCode, alwaysFail = false) {
    super()
    this.attempts = attempts
    this.failCode = failCode
    this.alwaysFail = alwaysFail
    this.bound = false
  }

  listen(_port, _host, callback) {
    this.attempts.count++
    if ((this.alwaysFail || this.attempts.count === 1) && this.failCode !== undefined) {
      setImmediate(() => this.emit('error', { code: this.failCode }))
    } else {
      this.bound = true
      setImmediate(callback)
    }
  }

  close(callback) {
    this.bound = false
    callback?.()
  }

  closeAllConnections() {}
}

async function waitForListener(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`)
      if (response.ok) return response.json()
    } catch {
      // 还没起来，继续等。
    }
    if (Date.now() > deadline) throw new Error(`listener ${port} never came up`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const upstreamA = await startUpstream()
const upstreamB = await startUpstream()
const listenerPort = await freePort()

const webServer = {
  current: {
    host: '127.0.0.1',
    port: upstreamA.port,
    protocol: 'http:',
    getOrigin: () => `http://127.0.0.1:${String(upstreamA.port)}`,
  },
}
const { ctx, logs } = fakeContext(webServer)
const config = resolveConfig({ listeners: [{ host: '127.0.0.1', port: listenerPort }] })
apply(ctx, config)

const first = await waitForListener(listenerPort)

check('gateway forwards to the port the host actually bound', () => {
  assert(first.host === `127.0.0.1:${String(upstreamA.port)}`, `Host seen by upstream = ${first.host}`)
  assert(first.url === '/ping', `path seen by upstream = ${first.url}`)
})

// DSH restarts or is reconfigured: same listener, brand-new upstream port.
await closeServer(upstreamA.server)
webServer.current = {
  host: '127.0.0.1',
  port: upstreamB.port,
  protocol: 'http:',
  getOrigin: () => `http://127.0.0.1:${String(upstreamB.port)}`,
}
const second = await waitForListener(listenerPort)

check('gateway follows a moved upstream without touching its own config', () => {
  assert(second.host === `127.0.0.1:${String(upstreamB.port)}`, `Host seen by upstream = ${second.host}`)
})

check('gateway reports the listener it brought up', () => {
  assert(logs.some((line) => line.includes(String(listenerPort))), `logs = ${logs.join(' | ')}`)
})

await closeServer(upstreamB.server)

const retryAttempts = { count: 0 }
const retryWebServer = {
  current: {
    host: '127.0.0.1',
    port: 39999,
    protocol: 'http:',
    getOrigin: () => 'http://127.0.0.1:39999',
  },
}
const retryContext = fakeContext(retryWebServer)
apply(retryContext.ctx, resolveConfig({ listeners: [{ host: '198.51.100.7', port: 3097 }] }), {
  retryDelay: () => 10,
  createServer: () => new FakeServer(retryAttempts, 'EADDRNOTAVAIL'),
})
// 等到"恢复"日志真正出现，而不是只等尝试次数——第二次 listen 的成功回调
// 是异步的，只数尝试次数会在回调前就断言，导致偶发失败。
await waitUntil(() => retryContext.logs.some((line) => line.includes('网关监听已恢复')), 2000)
check('failed address is retried and can recover after the interface appears', () => {
  assert(retryAttempts.count >= 2, `attempts = ${retryAttempts.count}`)
  assert(retryContext.logs.some((line) => line.includes('网关监听已恢复')), `logs = ${retryContext.logs.join(' | ')}`)
})

const manualAttempts = { count: 0 }
const manualContext = fakeContext(retryWebServer)
const manualConfig = Config['~standard'].validate({ listeners: [{ host: '198.51.100.8', port: 3098 }], rebindNonce: 0 }).value
apply(manualContext.ctx, manualConfig, {
  retryDelay: () => 10_000,
  createServer: () => new FakeServer(manualAttempts, 'EADDRINUSE'),
})
await waitUntil(() => manualAttempts.count >= 1, 1000)
check('non-transient bind failure does not retry by itself', () => {
  assert(manualAttempts.count === 1, `attempts = ${manualAttempts.count}`)
})
manualConfig.rebindNonce[Symbol.for('cosmokit.volatile.write')](1)
manualContext.handlers.get('loader/volatile-update')()
await waitUntil(() => manualAttempts.count >= 2, 1000)
check('manual rebind retries a failed entry', () => {
  assert(manualAttempts.count >= 2, `attempts = ${manualAttempts.count}`)
  assert(manualContext.logs.some((line) => line.includes('网关已启动')), `logs = ${manualContext.logs.join(' | ')}`)
})

const cancelledAttempts = { count: 0 }
const cancelledContext = fakeContext(retryWebServer)
const cancelledConfig = Config['~standard'].validate({ listeners: [{ host: '198.51.100.9', port: 3099 }] }).value
apply(cancelledContext.ctx, cancelledConfig, {
  retryDelay: () => 30,
  createServer: () => new FakeServer(cancelledAttempts, 'EADDRNOTAVAIL', true),
})
await waitUntil(() => cancelledAttempts.count === 1, 1000)
cancelledConfig.listeners[Symbol.for('cosmokit.volatile.write')]([])
cancelledContext.handlers.get('loader/volatile-update')()
await new Promise((resolve) => setTimeout(resolve, 60))
check('removing a failed listener cancels its stale retry', () => {
  assert(cancelledAttempts.count === 1, `attempts = ${cancelledAttempts.count}`)
})

const disposedAttempts = { count: 0 }
const disposedContext = fakeContext(retryWebServer)
apply(disposedContext.ctx, resolveConfig({ listeners: [{ host: '198.51.100.10', port: 3100 }] }), {
  retryDelay: () => 30,
  createServer: () => new FakeServer(disposedAttempts, 'EADDRNOTAVAIL', true),
})
await waitUntil(() => disposedAttempts.count === 1, 1000)
await disposedContext.dispose()
await new Promise((resolve) => setTimeout(resolve, 60))
check('disposing the plugin cancels pending retries', () => {
  assert(disposedAttempts.count === 1, `attempts = ${disposedAttempts.count}`)
})

const healthyCreates = { count: 0 }
const healthyAttempts = { count: 0 }
const healthyContext = fakeContext(retryWebServer)
const healthyConfig = Config['~standard'].validate({ listeners: [
  { host: '198.51.100.11', port: 3101 },
  { host: '198.51.100.12', port: 3102 },
] }).value
apply(healthyContext.ctx, healthyConfig, {
  retryDelay: () => 10,
  createServer: () => {
    healthyCreates.count++
    return new FakeServer(healthyAttempts)
  },
})
await waitUntil(() => healthyCreates.count === 2, 1000)
healthyConfig.rebindNonce[Symbol.for('cosmokit.volatile.write')](1)
healthyContext.handlers.get('loader/volatile-update')()
await new Promise((resolve) => setTimeout(resolve, 30))
check('manual rebind does not restart healthy listeners', () => {
  assert(healthyCreates.count === 2, `server creations = ${healthyCreates.count}`)
})

// 本体还没就绪时，upstreamEndpoint() 会返回 127.0.0.1:3080 兜底值。冲突判定
// 必须用真实终点，否则用户配置的 3080 入口会被误判成"与本体重复"而永久跳过。
const notReadyAttempts = { count: 0 }
const notReadyContext = fakeContext({ current: undefined })
apply(notReadyContext.ctx, resolveConfig({ listeners: [{ host: '198.51.100.13', port: 3080 }] }), {
  retryDelay: () => 10,
  createServer: () => new FakeServer(notReadyAttempts),
})
await waitUntil(() => notReadyContext.logs.some((line) => line.includes('网关已启动')), 2000)
check('a listener on 3080 is not a conflict before the host webserver is ready', () => {
  assert(notReadyAttempts.count === 1, `attempts = ${notReadyAttempts.count}`)
  assert(!notReadyContext.logs.some((line) => line.includes('与 DSH 本体地址重复')), `logs = ${notReadyContext.logs.join(' | ')}`)
  assert(notReadyContext.logs.some((line) => line.includes('网关已启动')), `logs = ${notReadyContext.logs.join(' | ')}`)
})
await notReadyContext.dispose()

await retryContext.dispose()
await manualContext.dispose()
await cancelledContext.dispose()
await healthyContext.dispose()
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed) process.exitCode = 1
// 插件注册的 effect 是空实现，这里直接结束进程释放监听。
setTimeout(() => process.exit(failed ? 1 : 0), 50)

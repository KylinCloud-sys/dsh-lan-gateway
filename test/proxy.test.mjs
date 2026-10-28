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
import { apply, resolveConfig } from '../lib/index.js'

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
  const record = (level) => (message) => logs.push(`${level}: ${message}`)
  return {
    logs,
    ctx: {
      get(name) {
        if (name === 'webServer') return webServerRef.current
        return undefined
      },
      on() {},
      effect() { return () => {} },
      logger: () => ({ info: record('info'), warn: record('warn'), error: record('error') }),
    },
  }
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
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed) process.exitCode = 1
// 插件注册的 effect 是空实现，这里直接结束进程释放监听。
setTimeout(() => process.exit(failed ? 1 : 0), 50)

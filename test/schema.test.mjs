/**
 * Regression checks for the gateway settings schema.
 *
 * Runs with plain Node — no dependencies are installed, because the plugin is
 * self-contained on purpose (a `git` install must work without a build step).
 * The helpers below mirror what the DSH Host does with this schema:
 *
 *   - `@deepseek-ai/cosmokit` identifies a live value by the global symbol
 *     `Symbol.for('cosmokit.volatile.write')` and commits saves through
 *     `ref[write](next.get())`.
 *   - `@deepseek-ai/dsh-settings` projects `plainConfig` / `volatileForm` into
 *     the form the settings page renders.
 *
 * Run: node test/schema.test.mjs
 */
import { Config, resolveConfig } from '../lib/index.js'

const WRITE = Symbol.for('cosmokit.volatile.write')

/** Mirror of cosmokit `isVolatile`. */
const isVolatile = (value) => typeof value === 'object' && value !== null && WRITE in value

/** Mirror of cosmokit `updateVolatile`. */
const updateVolatile = (target, source) => target[WRITE](source.get())

/** Mirror of dsh-settings `plainConfig`. */
function plainConfig(value) {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  return value
}

/** Mirror of dsh-settings `volatileForm`: undefined means "no settings page". */
function volatileForm(schema) {
  if (schema.meta.volatile) return schema
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === void 0 ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', meta: {}, dict }
  }
  return undefined
}

/** Mirror of dsh-settings `isVolatilePath`. */
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** What Cordis does on activation: standard-schema validation. */
const activate = (raw) => {
  const result = Config['~standard'].validate(raw)
  assert(result.issues === undefined, `unexpected issues: ${JSON.stringify(result.issues)}`)
  return result.value
}
const reject = (raw, message) => {
  const result = Config['~standard'].validate(raw)
  assert(result.issues !== undefined, message)
  return result.issues[0].message
}

check('settings page is exposed (volatileForm is defined)', () => {
  const form = volatileForm(Config)
  assert(form !== undefined, 'no volatile field -> settings page would be hidden')
  assert('listeners' in form.dict, 'listeners missing from the projected form')
})

check('upstream endpoint is never editable', () => {
  const form = volatileForm(Config)
  assert(!('upstreamHost' in form.dict), 'upstreamHost must stay fixed')
  assert(!('upstreamPort' in form.dict), 'upstreamPort must stay fixed')
  assert(!('listenHosts' in form.dict), 'legacy listenHosts must not be editable')
})

check('listeners value is a live reference, not a plain array', () => {
  const live = activate({ listeners: [{ host: '0.0.0.0', port: 3081 }] })
  assert(isVolatile(live.listeners), 'listeners must implement the cosmokit volatile protocol')
  assert(typeof live.listeners.get === 'function', 'listeners must expose get()')
})

check('saving keeps the rows (empty-list regression)', () => {
  const live = activate({ listeners: [{ host: '0.0.0.0', port: 3081 }] })
  const candidate = activate({ listeners: [{ host: '192.0.2.10', port: 3090 }, { host: '198.51.100.5', port: 3091 }] })
  updateVolatile(live.listeners, candidate.listeners)

  const plain = plainConfig(live)
  assert(Array.isArray(plain.listeners), `listeners is ${typeof plain.listeners}, not an array`)
  assert(same(plain.listeners, [{ host: '192.0.2.10', port: 3090 }, { host: '198.51.100.5', port: 3091 }]), `readback = ${JSON.stringify(plain.listeners)}`)
  assert(same(JSON.parse(JSON.stringify(plain)).listeners, plain.listeners), 'rows do not survive JSON transport')
})

check('an empty listener list round-trips (gateway disabled)', () => {
  const live = activate({ listeners: [] })
  assert(same(plainConfig(live).listeners, []), 'empty listeners must stay []')
})

check('runtime config sees the committed value', () => {
  const live = activate({ listeners: [{ host: '0.0.0.0', port: 3081 }] })
  const candidate = activate({ listeners: [{ host: '192.0.2.10', port: 3090 }] })
  updateVolatile(live.listeners, candidate.listeners)
  assert(same(resolveConfig(live).listeners, [{ host: '192.0.2.10', port: 3090 }]), 'reconcile would use a stale list')
})

check('listeners is a declared volatile path for mutate()', () => {
  assert(isVolatilePath(Config, ['listeners']) === true, 'listeners must be editable live')
  assert(isVolatilePath(Config, ['listenPort']) === false, 'legacy fields must not be editable')
  assert(isVolatilePath(Config, ['upstreamPort']) === false, 'upstream must not be editable')
})

check('serialized schema is the {uid, refs} graph the Host rehydrates', () => {
  const json = Config.toJSON()
  assert(typeof json.uid === 'number' && json.refs && typeof json.refs === 'object', 'expected {uid, refs}')
  const root = json.refs[json.uid]
  assert(root.type === 'object', 'root must be an object node')
  assert(json.refs[root.dict.listeners] !== undefined, 'dict entries must reference uids')
  assert(json.refs[root.dict.listeners].type === 'array', 'listeners must be an array node')
  assert(json.refs[root.dict.listeners].meta.volatile === true, 'listeners must serialize as volatile')
  assert(typeof json.refs[root.dict.listeners].inner === 'number', 'array nodes must reference their item schema')
})

check('the upstream port cannot be used as a listener port', () => {
  assert(/3080/u.test(reject({ listeners: [{ host: '0.0.0.0', port: 3080 }] }, 'port 3080 must be rejected')), 'message should name 3080')
})

check('wildcard and duplicate conflicts are rejected', () => {
  reject({ listeners: [{ host: '0.0.0.0', port: 3081 }, { host: '192.0.2.10', port: 3081 }] }, 'wildcard conflict must be rejected')
  reject({ listeners: [{ host: '::1', port: 3081 }, { host: '::1', port: 3081 }] }, 'duplicate listener must be rejected')
})

check('hosts must be bare addresses, ports must be in range', () => {
  reject({ listeners: [{ host: 'http://192.0.2.10', port: 3081 }] }, 'scheme in host must be rejected')
  reject({ listeners: [{ host: '192.0.2.10', port: 0 }] }, 'port 0 must be rejected')
  reject({ listeners: [{ host: '192.0.2.10', port: 65536 }] }, 'port 65536 must be rejected')
  reject({ listeners: [{ host: '', port: 3081 }] }, 'empty host must be rejected')
})

check('the upstream endpoint is fixed', () => {
  reject({ upstreamPort: 3088 }, 'upstreamPort must be rejected')
  reject({ upstreamHost: '0.0.0.0' }, 'upstreamHost must be rejected')
})

check('legacy listenHosts/listenPort still migrate', () => {
  const migrated = activate({ listenHosts: ['192.0.2.10', '127.0.0.1'], listenPort: 3099 })
  assert(same(migrated.listeners.get(), [{ host: '192.0.2.10', port: 3099 }, { host: '127.0.0.1', port: 3099 }]), `migration = ${JSON.stringify(migrated.listeners.get())}`)
})

check('defaults apply when the entry has no config', () => {
  const plain = plainConfig(activate({}))
  assert(same(plain.listeners, [{ host: '0.0.0.0', port: 3081 }]), `defaults = ${JSON.stringify(plain.listeners)}`)
  assert(plain.upstreamHost === '127.0.0.1' && plain.upstreamPort === 3080, 'upstream defaults must stay fixed')
})

for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed) process.exit(1)

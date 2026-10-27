/**
 * Minimal Standard Schema-compatible implementation used by the plugin.
 * It intentionally covers only the schema operations needed by Config, so a
 * local link installation does not depend on a host-provided schemastery.
 */

const VOLATILE = Symbol('dsh-lan-gateway.volatile')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = (value) => {
  if (Array.isArray(value)) return value.map(clone)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}
const issue = (message, path = []) => ({ message, path })
let nextUid = 1

class SchemaNode {
  constructor(type, options = {}) {
    this.type = type
    this.options = options
    this.meta = {}
    this.uid = nextUid++
    // dsh-settings inspects these public fields when projecting volatile forms.
    if (options.dict) this.dict = options.dict
    if (options.inner) this.inner = options.inner
  }

  default(value) { const next = this.copy(); next.meta.default = clone(value); return next }
  volatile() { const next = this.copy(); next.meta.volatile = true; return next }
  required() { const next = this.copy(); next.meta.required = true; return next }
  min(value) { const next = this.copy(); next.meta.min = value; return next }
  max(value) { const next = this.copy(); next.meta.max = value; return next }
  step(value) { const next = this.copy(); next.meta.step = value; return next }
  copy() { const next = new SchemaNode(this.type, this.options); next.meta = { ...this.meta }; return next }
  get '~standard'() {
    return { version: 1, vendor: 'dsh-lan-gateway', validate: (value) => this.validate(value) }
  }

  toJSON() {
    const refs = {}
    const visit = (node) => {
      if (refs[node.uid]) return node.uid
      const result = { type: node.type, meta: { ...node.meta } }
      refs[node.uid] = result
      if (node.options.dict) result.dict = Object.fromEntries(Object.entries(node.options.dict).map(([key, value]) => [key, visit(value)]))
      if (node.options.inner) result.inner = visit(node.options.inner)
      if (node.options.value !== undefined) result.value = node.options.value
      return node.uid
    }
    const uid = visit(this)
    return { uid, refs }
  }

  validate(value, path = []) {
    if (value === undefined || value === null) {
      if (this.meta.required) return { issues: [issue('required value is missing', path)] }
      if ('default' in this.meta) value = clone(this.meta.default)
      else return { value }
    }
    let result
    switch (this.type) {
      case 'object': {
        if (!isObject(value)) return { issues: [issue('expected object', path)] }
        result = {}
        for (const [key, child] of Object.entries(this.options.dict)) {
          const checked = child.validate(value[key], [...path, key])
          if (checked.issues) return checked
          if (checked.value !== undefined) result[key] = checked.value
        }
        for (const [key, item] of Object.entries(value)) if (!(key in this.options.dict)) result[key] = item
        break
      }
      case 'array': {
        if (!Array.isArray(value)) return { issues: [issue('expected array', path)] }
        result = []
        for (let index = 0; index < value.length; index++) {
          const checked = this.options.inner.validate(value[index], [...path, index])
          if (checked.issues) return checked
          result.push(checked.value)
        }
        break
      }
      case 'string':
        if (typeof value !== 'string') return { issues: [issue('expected string', path)] }
        if (this.meta.min !== undefined && value.length < this.meta.min) return { issues: [issue(`string length must be >= ${this.meta.min}`, path)] }
        if (this.meta.max !== undefined && value.length > this.meta.max) return { issues: [issue(`string length must be <= ${this.meta.max}`, path)] }
        result = value
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return { issues: [issue('expected finite number', path)] }
        if (this.meta.min !== undefined && value < this.meta.min) return { issues: [issue(`number must be >= ${this.meta.min}`, path)] }
        if (this.meta.max !== undefined && value > this.meta.max) return { issues: [issue(`number must be <= ${this.meta.max}`, path)] }
        if (this.meta.step && (value - (this.meta.min ?? 0)) % this.meta.step !== 0) return { issues: [issue(`number must use step ${this.meta.step}`, path)] }
        result = value
        break
      case 'const':
        if (value !== this.options.value) return { issues: [issue(`expected ${this.options.value}`, path)] }
        result = value
        break
      case 'any': result = value; break
      default: return { issues: [issue(`unsupported schema type ${this.type}`, path)] }
    }
    return { value: this.meta.volatile ? volatile(result) : result }
  }
}

function volatile(value) {
  const box = function getValue() { return box.value }
  box.value = value
  box.get = () => box.value
  box[ VOLATILE ] = true
  return box
}

function make(type, options) { return new SchemaNode(type, options) }

const Schema = {
  object(dict) { return make('object', { dict }) },
  array(inner) { return make('array', { inner: from(inner) }) },
  string() { return make('string') },
  number() { return make('number') },
  const(value) { return make('const', { value }) },
  any() { return make('any') },
  from(value) { return from(value) },
}
function from(value) { return value instanceof SchemaNode ? value : Schema.any() }

export { Schema, SchemaNode, VOLATILE, volatile }

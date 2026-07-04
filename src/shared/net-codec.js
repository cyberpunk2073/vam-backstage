/**
 * Wire codec for the remote (client-server) transport. Mirrors the subset of
 * structured-clone semantics the IPC boundary actually relies on: primitives,
 * plain objects/arrays, `BigInt`, and binary (`Buffer`/`Uint8Array`, used by
 * thumbnails + avatars).
 *
 * We deliberately do NOT use a `JSON.stringify` replacer: `stringify` invokes a
 * value's own `toJSON()` *before* the replacer runs, and both `Buffer` and
 * `Date` define one — so a replacer would see `{type:'Buffer',data:[…]}` /
 * an ISO string and could neither tag binary nor detect a `Date`. Instead we
 * walk the value ourselves, tag the special types, and pass a JSON-clean tree
 * to `stringify`. Any non-plain object we don't recognize (Map, Set, Date,
 * class instance, function) throws instead of silently mangling — unknown
 * types fail loud the first time they cross the wire.
 *
 * Both sides that use this codec run with Node integration (main process and
 * the preload), so `Buffer` is available for base64 in either direction.
 */

function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function encodeVal(v) {
  if (v === null || v === undefined) return v
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return v
  if (t === 'bigint') return { __t: 'bigint', value: v.toString() }
  if (t === 'function' || t === 'symbol') throw new TypeError(`net-codec: cannot serialize ${t}`)

  if (v instanceof Uint8Array) {
    // Covers Node Buffer too (Buffer extends Uint8Array). Slice to the view's
    // own window so a pooled Buffer doesn't leak neighbouring bytes.
    return { __t: 'buffer', base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') }
  }
  if (Array.isArray(v)) return v.map(encodeVal)
  if (isPlainObject(v)) {
    const out = {}
    for (const k of Object.keys(v)) out[k] = encodeVal(v[k])
    return out
  }

  const name = v.constructor?.name || Object.prototype.toString.call(v)
  throw new TypeError(`net-codec: cannot serialize non-plain object (${name})`)
}

function decodeVal(v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(decodeVal)
  if (v.__t === 'buffer') return Uint8Array.from(Buffer.from(v.base64, 'base64'))
  if (v.__t === 'bigint') return BigInt(v.value)
  const out = {}
  for (const k of Object.keys(v)) out[k] = decodeVal(v[k])
  return out
}

export function encode(value) {
  return JSON.stringify(encodeVal(value))
}

export function decode(text) {
  return decodeVal(JSON.parse(text))
}

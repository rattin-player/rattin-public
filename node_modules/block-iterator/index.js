/**
 * @param {any[]} chunks
 * @param {number} size
 * @returns {string | Uint8Array}
 */
function concat (chunks, size) {
  if (typeof chunks[0] === 'string') return chunks.join('')
  if (typeof chunks[0] === 'number') return new Uint8Array(chunks)
  const b = new Uint8Array(size)
  let offset = 0
  for (let i = 0, l = chunks.length; i < l; i++) {
    const chunk = chunks[i]
    b.set(chunk, offset)
    offset += chunk.byteLength || chunk.length
  }

  return b
}

/**
 * Transform an async iterable into equally-sized blocks.
 * @param {AsyncIterable<import('./index').InputValue> | Iterable<import('./index').InputValue>} iterator - The async iterable to read from
 * @param {number | import('./index').BlockIteratorOptions} [size=512] - Block size in bytes or options object
 * @param {import('./index').BlockIteratorOptions} [opts={}] - Options object
 * @returns {AsyncGenerator<import('./index').InputValue, void, unknown>}
 */
module.exports = async function * (iterator, size = 512, opts = {}) {
  if (typeof size === 'object') {
    opts = size
    size = opts.size || 512
  }
  let { nopad, zeroPadding = true } = opts

  if (nopad) zeroPadding = false

  /** @type {any[]} */
  let buffered = []
  let bufferedBytes = 0

  for await (const value of iterator) {
    bufferedBytes += value.byteLength || value.length || 1
    buffered.push(value)

    if (bufferedBytes >= size) {
      const b = concat(buffered, bufferedBytes)
      let offset = 0

      while (bufferedBytes >= size) {
        yield b.slice(offset, offset + size)
        bufferedBytes -= size
        offset += size
      }

      buffered = [b.slice(offset, b.length)]
    }
  }
  if (bufferedBytes) yield concat(buffered, zeroPadding ? size : bufferedBytes)
}

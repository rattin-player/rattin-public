export interface BlockIteratorOptions {
  /**
   * Block size in bytes. Can also be passed as the second argument.
   */
  size?: number;
  /**
   * If true, the last block will not be padded to the full size.
   * @deprecated Use `zeroPadding: false` instead.
   */
  nopad?: boolean;
  /**
   * If true (default), the last block will be zero-padded to the full size.
   * If false, the last block will be the remaining bytes without padding.
   * @default true
   */
  zeroPadding?: boolean;
}

export type InputValue =
  | string
  | number
  | Uint8Array
  | ArrayLike<number>
  | { byteLength: number }
  | { length: number }

/**
 * Transform an async iterable into equally-sized blocks.
 *
 * @param iterator - The async iterable to read from (can yield strings, numbers, or Uint8Arrays)
 * @param size - Block size in bytes (default: 512)
 * @param opts - Options object
 * @returns An async generator yielding blocks of the specified size
 *
 * @example
 * ```js
 * import blockIterator from 'block-iterator'
 *
 * for await (const block of blockIterator(asyncIterable, 1024)) {
 *   console.log(block) // Uint8Array of 1024 bytes
 * }
 * ```
 */
declare function blockIterator(
  iterator: AsyncIterable<InputValue> | Iterable<InputValue>,
  size?: number,
  opts?: BlockIteratorOptions
): AsyncGenerator<string | Uint8Array, void, unknown>;

/**
 * Transform an async iterable into equally-sized blocks.
 *
 * @param iterator - The async iterable to read from (can yield strings, numbers, or Uint8Arrays)
 * @param opts - Options object (must include `size` property)
 * @returns An async generator yielding blocks of the specified size
 */
declare function blockIterator(
  iterator: AsyncIterable<InputValue> | Iterable<InputValue>,
  opts: BlockIteratorOptions & { size: number }
): AsyncGenerator<string | Uint8Array, void, unknown>;

export default blockIterator;
export = blockIterator;

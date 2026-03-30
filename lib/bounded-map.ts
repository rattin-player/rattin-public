// lib/bounded-map.ts
// A Map subclass that evicts the oldest entries when size exceeds maxSize.
// Used for caches that should not grow without bound (seekIndexCache, probeCache).

export class BoundedMap<V> extends Map<string, V> {
  private _maxSize: number;

  constructor(maxSize: number = 50) {
    super();
    this._maxSize = maxSize;
  }

  set(key: string, value: V): this {
    // If key already exists, delete first so it moves to end (most recent)
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    // Evict oldest entries if over limit
    while (super.size > this._maxSize) {
      const oldest = super.keys().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return this;
  }

  get maxSize(): number {
    return this._maxSize;
  }
}

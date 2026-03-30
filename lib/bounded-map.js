// lib/bounded-map.js
// A Map subclass that evicts the oldest entries when size exceeds maxSize.
// Used for caches that should not grow without bound (seekIndexCache, probeCache).

export class BoundedMap extends Map {
  constructor(maxSize = 50) {
    super();
    this._maxSize = maxSize;
  }

  set(key, value) {
    // If key already exists, delete first so it moves to end (most recent)
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    // Evict oldest entries if over limit
    while (super.size > this._maxSize) {
      const oldest = super.keys().next().value;
      super.delete(oldest);
    }
    return this;
  }

  get maxSize() {
    return this._maxSize;
  }
}

/**
 * A least-recently-used map bounded by total size and by entry count. When
 * either bound is passed, the least recently used entries are dropped first.
 */
export class LruByBytes<V> {
  private readonly entries = new Map<string, V>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly sizeOf: (value: V) => number;

  constructor(options: { maxBytes: number; maxEntries: number; sizeOf: (value: V) => number }) {
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries;
    this.sizeOf = options.sizeOf;
  }

  /** The entry for `key`, now the most recently used, or undefined when absent. */
  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.entries.has(key)) {
      this.bytes -= this.sizeOf(this.entries.get(key) as V);
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += this.sizeOf(value);
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldestKey);
      this.bytes -= this.sizeOf(oldest);
    }
  }
}

/**
 * Minimal in-memory Blob store for unit tests.
 *
 * `FakeKV` keeps a raw `Map<string, string>` of object paths plus counters so
 * tests can assert how many reads (`get`) and list lookups (`list`) a code path
 * performed. `asKV` adapts it to the `BlobStore` shape used by the domain
 * modules.
 */

export class FakeKV {
  /** Raw string store keyed by full object path. */
  readonly store = new Map<string, string>();

  /** Number of `get` calls. */
  reads = 0;

  /** Number of `list` calls. */
  lookups = 0;

  /** Number of `put` calls. */
  writes = 0;

  /** Number of `delete` calls. */
  deletes = 0;

  /** Seed a JSON value (serialized like `kvPutJson`). */
  seed(key: string, value: unknown): this {
    this.store.set(key, JSON.stringify(value));
    return this;
  }

  /** Seed a raw string value (for index objects that store bare ids). */
  seedRaw(key: string, value: string): this {
    this.store.set(key, value);
    return this;
  }
}

/** Adapt a `FakeKV` to the `BlobStore` interface used by domain modules. */
export function asKV(fake: FakeKV): BlobStore {
  return {
    async get(key: string): Promise<string | null> {
      fake.reads += 1;
      return fake.store.has(key) ? (fake.store.get(key) as string) : null;
    },
    async put(key: string, value: string): Promise<void> {
      fake.writes += 1;
      fake.store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      fake.deletes += 1;
      fake.store.delete(key);
    },
    async list(options?: BlobListOptions): Promise<BlobListResult> {
      fake.lookups += 1;
      const prefix = options?.prefix ?? '';
      const objects = [...fake.store.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((key) => ({ key }));
      return { objects };
    },
  } as unknown as BlobStore;
}

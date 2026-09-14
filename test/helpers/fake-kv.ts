/**
 * Minimal in-memory KV namespace for unit tests.
 *
 * `FakeKV` keeps a raw `Map<string, string>` plus counters so tests can assert
 * how many reads (`get`) and list lookups (`list`) a code path performed.
 * `asKV` adapts it to the `KVNamespace` shape used by the domain modules.
 */

export class FakeKV {
  /** Raw string store keyed by full KV key. */
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

  /** Seed a raw string value (for index keys that store bare ids). */
  seedRaw(key: string, value: string): this {
    this.store.set(key, value);
    return this;
  }
}

/** Adapt a `FakeKV` to the `KVNamespace` interface used by domain modules. */
export function asKV(fake: FakeKV): KVNamespace {
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
    async list(options?: KVListOptions): Promise<KVListResult> {
      fake.lookups += 1;
      const prefix = options?.prefix ?? '';
      const names = [...fake.store.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort();
      return {
        keys: names.map((name) => ({ name })),
        list_complete: true,
        cursor: undefined,
      };
    },
  } as unknown as KVNamespace;
}

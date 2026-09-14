/**
 * Blob-storage JSON and prefix-list helpers.
 *
 * All domain modules read and write through these helpers so serialization and
 * prefix scans stay consistent. EdgeOne Makers Blob storage differs from the
 * previous Cloudflare KV namespace in three ways this module absorbs:
 *
 * - listing is unordered and has no cursor pagination → results are sorted here;
 * - there is no atomic read-modify-write → `kvUpdateJson` re-reads, mutates and
 *   writes back with retries;
 * - there is no prefix batch delete → `kvDeletePrefix` lists then deletes.
 *
 * Values are stored as JSON strings; index keys (e.g. `gateway_key_hash/<hash>`)
 * store raw id strings and are read with `db.get` directly by the owning module.
 */

/** How many times a read-modify-write is retried before giving up. */
const UPDATE_ATTEMPTS = 3;
const UPDATE_RETRY_BASE_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read and parse a JSON value. Missing keys and malformed JSON return null. */
export async function kvGetJson<T>(db: BlobStore, key: string): Promise<T | null> {
  const raw = await db.get(key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Serialize and store a JSON value. */
export async function kvPutJson(db: BlobStore, key: string, value: unknown): Promise<void> {
  await db.put(key, JSON.stringify(value));
}

/** Delete a single key. */
export async function kvDelete(db: BlobStore, key: string): Promise<void> {
  await db.delete(key);
}

/**
 * List every key name under a prefix.
 *
 * Blob storage returns the whole matching set in one unordered page (no cursor),
 * so we sort the result to give callers a stable, lexicographic order — the
 * `analytics/<minute>` and `key_usage/<key>/<date>` prefixes rely on it.
 */
export async function kvListKeys(db: BlobStore, prefix: string): Promise<string[]> {
  const result = await db.list({ prefix });
  return result.objects
    .map((object) => object.key)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

/** List and parse every JSON value under a prefix. Malformed rows are dropped. */
export async function kvListJson<T>(db: BlobStore, prefix: string): Promise<T[]> {
  const keys = await kvListKeys(db, prefix);
  const rows: Array<T | null> = await Promise.all(keys.map((key) => kvGetJson<T>(db, key)));
  return rows.filter((row): row is T => row !== null);
}

/**
 * Delete every key under a prefix. Returns the number of deleted keys.
 * Blob storage cannot delete a prefix in one call, so each key is removed
 * individually after the (indexed) listing.
 */
export async function kvDeletePrefix(db: BlobStore, prefix: string): Promise<number> {
  const keys = await kvListKeys(db, prefix);
  for (const key of keys) await db.delete(key);
  return keys.length;
}

/**
 * Read-modify-write a JSON document.
 *
 * Blob storage has no atomic increment or compare-and-set. Accumulation is done
 * by re-reading the authoritative aggregation document, applying `mutate`, and
 * writing it back, retrying transient failures. Concurrent writers on other
 * isolates can still race inside the retry window — the same bounded overshoot
 * the previous KV-backed implementation already accepted; the per-isolate
 * ledgers in `src/gateway/key-quota.ts` and `src/gateway/usage-recorder.ts`
 * keep the write rate (and therefore that window) small.
 */
export async function kvUpdateJson<T>(
  db: BlobStore,
  key: string,
  mutate: (current: T | null) => T,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
    try {
      const current = await kvGetJson<T>(db, key);
      const next = mutate(current);
      await kvPutJson(db, key, next);
      return next;
    } catch (error) {
      lastError = error;
      if (attempt < UPDATE_ATTEMPTS - 1) await delay(UPDATE_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('kvUpdateJson failed');
}

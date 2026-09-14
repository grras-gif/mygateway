/**
 * KV JSON and prefix-list helpers.
 *
 * All domain modules read and write through these helpers so serialization and
 * prefix pagination stay consistent. Values are stored as JSON strings; index
 * keys (e.g. `gateway_key_hash:<hash>`) store raw id strings and are read with
 * `db.get` directly by the owning module.
 */

/** Read and parse a JSON value. Missing keys and malformed JSON return null. */
export async function kvGetJson<T>(db: KVNamespace, key: string): Promise<T | null> {
  const raw = await db.get(key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Serialize and store a JSON value. */
export async function kvPutJson(db: KVNamespace, key: string, value: unknown): Promise<void> {
  await db.put(key, JSON.stringify(value));
}

/** Delete a single key. */
export async function kvDelete(db: KVNamespace, key: string): Promise<void> {
  await db.delete(key);
}

/** List every key name under a prefix, following cursors to completion. */
export async function kvListKeys(db: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await db.list({ prefix, cursor });
    for (const entry of page.keys) names.push(entry.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/** List and parse every JSON value under a prefix. Malformed rows are dropped. */
export async function kvListJson<T>(db: KVNamespace, prefix: string): Promise<T[]> {
  const keys = await kvListKeys(db, prefix);
  const rows: Array<T | null> = await Promise.all(keys.map((key) => kvGetJson<T>(db, key)));
  return rows.filter((row): row is T => row !== null);
}

/** Delete every key under a prefix. Returns the number of deleted keys. */
export async function kvDeletePrefix(db: KVNamespace, prefix: string): Promise<number> {
  const keys = await kvListKeys(db, prefix);
  await Promise.all(keys.map((key) => db.delete(key)));
  return keys.length;
}
